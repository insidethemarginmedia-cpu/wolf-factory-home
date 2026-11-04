import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SOURCE_PIN_EXIT,
  FACTORY_BRANCH,
  assertSourcePin,
  classifySourcePin,
  classifyPublicationAdmission,
  classifyGitTransportFailure,
  redactGitOutput,
  readLiveSource,
  verifySourcePin,
  admitPublication,
} from '../scripts/wolf-factory-source-pin.mjs';

const PIN = 'a'.repeat(39) + '1';
const OLD = 'ee2d8ba15cd99d8788409c00c2fec3b1cd052370';
const NEW = '4c9726d2a964ad32b01263b4a5e3b9a7014660fe';
const env = { WOLF_FACTORY_REPO_TOKEN: 'fixture-repository-token', WOLF_FACTORY_EXPECTED_SHA: PIN };

function live({ remoteHead, status }) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (/\/git\/ref\/heads\//.test(url)) return { ok: true, json: async () => ({ ref: `refs/heads/${FACTORY_BRANCH}`, object: { sha: remoteHead } }) };
    if (/\/compare\//.test(url)) return { ok: true, json: async () => ({ status, total_commits: 1 }) };
    throw Error('UNEXPECTED_URL');
  };
  return { fetchImpl, calls };
}

const git = (head, push = { status: 0, stderr: '' }) => {
  const calls = [];
  const spawn = (command, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'rev-parse') return { status: 0, stdout: head + '\n', stderr: '' };
    return push;
  };
  return { spawn, calls };
};

test('a malformed pin can never be treated as a source identity', () => {
  for (const bad of ['', 'unknown', '4c9726d2', 'Z'.repeat(40), null]) assert.throws(() => assertSourcePin(bad), /SOURCE_PIN_MALFORMED/);
});

test('a checkout that does not match the pin is refused before any transport', async () => {
  const { fetchImpl } = live({ remoteHead: NEW, status: 'identical' });
  const { spawn, calls } = git(OLD);
  const result = await admitPublication({ env: { ...env, WOLF_FACTORY_EXPECTED_SHA: NEW }, fetchImpl, spawn });
  assert.equal(result.state, 'STALE_CHECKOUT_REFUSED');
  assert.equal(result.exitCode, SOURCE_PIN_EXIT.SOURCE_PIN_CHECKOUT_MISMATCH);
  assert.equal(result.publicationRefused, true);
  assert.equal(calls.includes('push --dry-run origin HEAD:refs/heads/' + FACTORY_BRANCH), false);
});

test('identical pin, live head and checkout verify without writing', async () => {
  const { fetchImpl } = live({ remoteHead: NEW, status: 'identical' });
  const result = await verifySourcePin({ env: { ...env, WOLF_FACTORY_EXPECTED_SHA: NEW }, fetchImpl, spawn: git(NEW).spawn });
  assert.equal(result.state, 'PIN_VERIFIED_IN_SYNC');
  assert.equal(result.exitCode, SOURCE_PIN_EXIT.SOURCE_PIN_OK);
  assert.equal(result.refUpdated, false);
});

// Regression for run 41751367852: a pin that is an ancestor of the live branch
// is a stale source pin, not concurrent branch advancement.
test('a live branch ahead of the pin is reported as STALE_PINNED_SOURCE, never as concurrency', async () => {
  const { fetchImpl } = live({ remoteHead: NEW, status: 'ahead' });
  const result = await verifySourcePin({ env: { ...env, WOLF_FACTORY_EXPECTED_SHA: OLD }, fetchImpl, spawn: git(OLD).spawn });
  assert.equal(result.state, 'STALE_PINNED_SOURCE');
  assert.equal(result.exitCode, SOURCE_PIN_EXIT.SOURCE_PIN_STALE);
  assert.equal(result.compareStatus, 'ahead');
  assert.equal(result.publicationRefused, true);
});

test('publication admission distinguishes stale pin from concurrent advancement', async () => {
  const ahead = await admitPublication({ env, fetchImpl: live({ remoteHead: NEW, status: 'ahead' }).fetchImpl, spawn: git(PIN).spawn });
  assert.equal(ahead.state, 'CONCURRENT_BRANCH_ADVANCED');
  assert.equal(ahead.exitCode, SOURCE_PIN_EXIT.SOURCE_PIN_CONCURRENCY);
  const behind = classifyPublicationAdmission({ expectedSha: PIN, localHead: PIN, remoteHead: NEW, compareStatus: 'behind' });
  assert.equal(behind.state, 'PUBLICATION_FAST_FORWARD_ADMITTED');
  assert.equal(behind.admitted, true);
  assert.equal(behind.refUpdated, false);
});

test('an unpublished pin is blocked for mission admission and admitted only as a fast-forward', async () => {
  const verify = classifySourcePin({ expectedSha: PIN, localHead: PIN, remoteHead: NEW, compareStatus: 'behind' });
  assert.equal(verify.state, 'PIN_UNPUBLISHED_SOURCE');
  assert.equal(verify.exitCode, SOURCE_PIN_EXIT.SOURCE_PIN_UNPUBLISHED);
  assert.equal(verify.publicationRefused, true);
});

test('divergent history is refused and never merged', async () => {
  const verify = classifySourcePin({ expectedSha: PIN, localHead: PIN, remoteHead: NEW, compareStatus: 'diverged' });
  assert.equal(verify.state, 'REMOTE_CONCURRENCY_DIVERGED');
  assert.equal(verify.exitCode, SOURCE_PIN_EXIT.SOURCE_PIN_CONCURRENCY);
  const admit = classifyPublicationAdmission({ expectedSha: PIN, localHead: PIN, remoteHead: NEW, compareStatus: 'diverged' });
  assert.equal(admit.state, 'DIVERGENT_HISTORY_REFUSED');
  assert.equal(admit.automaticMerge, false);
  assert.equal(admit.forcePush, false);
});

test('an unreadable live head fails closed without a publication attempt', async () => {
  const malformed = await verifySourcePin({ env, fetchImpl: live({ remoteHead: null }).fetchImpl, spawn: git(PIN).spawn });
  assert.equal(malformed.state, 'SOURCE_REF_DENIED');
  assert.equal(malformed.exitCode, SOURCE_PIN_EXIT.SOURCE_PIN_DENIED);
  const unresolved = await verifySourcePin({ env, fetchImpl: async () => { throw Error('OFFLINE'); }, spawn: git(PIN).spawn });
  assert.equal(unresolved.state, 'SOURCE_REF_UNRESOLVED');
  assert.equal(unresolved.exitCode, SOURCE_PIN_EXIT.SOURCE_PIN_DENIED);
  const denied = await readLiveSource({ expectedSha: PIN, env, fetchImpl: async () => ({ ok: false, status: 403, body: { cancel: async () => {} } }) });
  assert.equal(denied.state, 'SOURCE_REF_DENIED');
  const missing = await readLiveSource({ expectedSha: PIN, env: {}, fetchImpl: async () => { throw Error('NETWORK_USED'); } });
  assert.equal(missing.state, 'BLOCKED');
  assert.deepEqual(missing.missing, ['WOLF_FACTORY_REPO_TOKEN']);
});

test('a transport failure is classified by what Git said, not by branch ancestry', () => {
  const cases = [
    ['git@github.com: Permission denied (publickey).', 128, 'AUTHENTICATION_FAILED'],
    ['remote: Permission to donraposo1-source/project-wolf.git denied', 128, 'WRITE_ACCESS_DENIED'],
    ['fatal: shallow update not allowed', 1, 'SHALLOW_HISTORY_DENIED'],
    ['! [rejected] HEAD -> feat (non-fast-forward)', 1, 'NON_FAST_FORWARD_REJECTED'],
    ['fatal: could not resolve host: github.com', 128, 'TRANSPORT_UNAVAILABLE'],
    ['fatal: something else entirely broke', 129, 'GENUINE_GIT_DEFECT'],
  ];
  for (const [stderr, exitCode, state] of cases) assert.equal(classifyGitTransportFailure(stderr, exitCode).state, state);
  assert.equal(classifyGitTransportFailure('', 0).state, 'TRANSPORT_AUTHORIZED');
});

test('an admitted publication proves transport authority with a dry run only', async () => {
  const { spawn, calls } = git(PIN, { status: 0, stderr: 'Everything up-to-date\n' });
  const result = await admitPublication({ env, fetchImpl: live({ remoteHead: PIN, status: 'identical' }).fetchImpl, spawn });
  assert.equal(result.state, 'ALREADY_UP_TO_DATE');
  assert.equal(result.exitCode, SOURCE_PIN_EXIT.SOURCE_PIN_OK);
  assert.equal(result.transportState, 'TRANSPORT_AUTHORIZED');
  assert.deepEqual(calls, ['rev-parse HEAD', 'push --dry-run origin HEAD:refs/heads/' + FACTORY_BRANCH]);
});

test('a rejected dry run is reported without claiming the ref moved', async () => {
  const { spawn } = git(PIN, { status: 128, stderr: 'remote: Permission to x denied to y\nfatal: unable to access' });
  const result = await admitPublication({ env, fetchImpl: live({ remoteHead: PIN, status: 'identical' }).fetchImpl, spawn });
  assert.equal(result.state, 'WRITE_ACCESS_DENIED');
  assert.equal(result.exitCode, SOURCE_PIN_EXIT.SOURCE_PIN_DENIED);
  assert.equal(result.publicationRefused, true);
  assert.equal(result.refUpdated, false);
});

test('receipts and logs never contain the repository credential', async () => {
  const { spawn } = git(PIN, { status: 128, stderr: 'fatal: unable to access https://x-access-token:' + env.WOLF_FACTORY_REPO_TOKEN + '@github.com/repo' });
  const logged = [];
  const original = console.log;
  console.log = value => logged.push(String(value));
  try {
    const result = await admitPublication({ env, fetchImpl: live({ remoteHead: PIN, status: 'identical' }).fetchImpl, spawn });
    assert.equal(JSON.stringify(result).includes(env.WOLF_FACTORY_REPO_TOKEN), false);
  } finally {
    console.log = original;
  }
  assert.equal(logged.join('\n').includes(env.WOLF_FACTORY_REPO_TOKEN), false);
  assert.equal(redactGitOutput('fatal https://user:' + env.WOLF_FACTORY_REPO_TOKEN + '@github.com/x', env.WOLF_FACTORY_REPO_TOKEN).includes(env.WOLF_FACTORY_REPO_TOKEN), false);
});

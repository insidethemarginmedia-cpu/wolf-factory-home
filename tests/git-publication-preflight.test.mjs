import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  CANONICAL_BRANCH,
  CANONICAL_REPOSITORY,
  MINIMUM_VERIFIED_FACTORY_SHA,
  advanceCompareAndSwapLease,
  authorizeSyntheticEngineeringScope,
  classifyGitPublicationResult,
  cleanupSshPublicationCredential,
  installCompareAndSwapPrePushGuard,
  isAuthorizedSyntheticReceiptFilename,
  normalizeOpenSshPrivateKey,
  prepareSshPublicationCredential,
  publishCompareAndSwapCommit,
  redactGitPublicationOutput,
  resolveAdmittedPrivateSource,
  verifyAuthorizedGitPublication,
  verifyRemotePublishedCommit,
} from '../scripts/git-publication-preflight.mjs';

const WORKFLOW_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../.github/workflows/private-controller-preflight.yml',
);

function generateThrowawayEd25519Key(dir) {
  const keyPath = path.join(dir, 'ephemeral-test-ed25519');
  const res = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-q'], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 0);
  const content = fs.readFileSync(keyPath, 'utf8');
  fs.rmSync(keyPath, {force: true});
  fs.rmSync(keyPath + '.pub', {force: true});
  return content;
}

function initCanonicalRepo(dir, branch = CANONICAL_BRANCH) {
  spawnSync('git', ['init', '-b', branch], {cwd: dir});
  spawnSync('git', ['config', 'user.email', 'wolf-test@example.invalid'], {cwd: dir});
  spawnSync('git', ['config', 'user.name', 'Wolf Test'], {cwd: dir});
  fs.writeFileSync(path.join(dir, 'fixture.txt'), 'deterministic-fixture\n');
  spawnSync('git', ['add', 'fixture.txt'], {cwd: dir});
  spawnSync('git', ['commit', '-m', 'fixture'], {cwd: dir});
  return spawnSync('git', ['rev-parse', 'HEAD'], {cwd: dir, encoding: 'utf8'}).stdout.trim();
}

test('read-only credentials and missing auth are rejected safely as WRITE_ACCESS_DENIED', () => {
  const readOnlyCases = [
    'remote: Write access to repository not granted.\nfatal: unable to access \'https://github.com/donraposo1-source/project-wolf.git/\': The requested URL returned error: 403\n',
    'ERROR: Permission to donraposo1-source/project-wolf.git denied to deploy key\nfatal: Could not read from remote repository.\n',
    'git@github.com: Permission denied (publickey).\r\nfatal: Could not read from remote repository.\n',
    'fatal: Authentication failed for \'https://github.com/donraposo1-source/project-wolf.git/\'\n',
    'fatal: could not read Username for \'https://github.com\': terminal prompts disabled\n',
    'remote: Repository not found.\nfatal: repository \'https://github.com/donraposo1-source/project-wolf.git/\' not found\n',
  ];
  for (const stderr of readOnlyCases) {
    assert.equal(
      classifyGitPublicationResult({status: 128, stderr}),
      'WRITE_ACCESS_DENIED',
      `expected WRITE_ACCESS_DENIED for: ${stderr}`,
    );
  }
});

test('SSH host verification, invalid SSH key, protected branch, shallow, non-fast-forward and timeout are distinguished', () => {
  assert.equal(
    classifyGitPublicationResult({
      status: 128,
      stderr:
        'No ED25519 host key is known for github.com and you have requested strict checking.\r\nHost key verification failed.\r\nfatal: Could not read from remote repository.\n',
    }),
    'SSH_HOST_VERIFICATION_FAILED',
  );
  assert.equal(
    classifyGitPublicationResult({
      status: 128,
      stderr:
        'Load key "/tmp/wolf-publication-key": error in libcrypto\r\ngit@github.com: Permission denied (publickey).\r\n',
    }),
    'SSH_KEY_INVALID',
  );
  assert.equal(
    classifyGitPublicationResult({
      status: 1,
      stderr:
        'remote: error: GH006: Protected branch update failed for refs/heads/feat/factory-real-worker-m1-20261006.\n ! [remote rejected] HEAD -> feat/factory-real-worker-m1-20261006 (protected branch hook declined)\n',
    }),
    'BRANCH_PROTECTION_DENIED',
  );
  assert.equal(
    classifyGitPublicationResult({
      status: 1,
      stderr:
        ' ! [remote rejected] HEAD -> feat/factory-real-worker-m1-20261006 (push declined due to repository rule violations)\n',
    }),
    'BRANCH_PROTECTION_DENIED',
  );
  assert.equal(
    classifyGitPublicationResult({
      status: 1,
      stderr:
        ' ! [remote rejected] HEAD -> feat/factory-real-worker-m1-20261006 (shallow update not allowed)\n',
    }),
    'SHALLOW_HISTORY_DENIED',
  );
  assert.equal(
    classifyGitPublicationResult({
      status: 1,
      stderr:
        ' ! [rejected]        HEAD -> feat/factory-real-worker-m1-20261006 (fetch first)\nerror: failed to push some refs\n',
    }),
    'CONCURRENT_BRANCH_ADVANCED',
  );
  assert.equal(
    classifyGitPublicationResult({
      status: null,
      stderr: '',
      signal: 'SIGTERM',
      errorCode: 'ETIMEDOUT',
    }),
    'GIT_PUBLICATION_TIMEOUT',
  );
  assert.equal(
    classifyGitPublicationResult({status: 0, stderr: 'Everything up-to-date\n'}),
    'AUTHORIZED',
  );
});

test('secret redaction prevents leakage of tokens, headers, Base64 credentials, SSH keys and temp paths', () => {
  const token = 'SYNTHETIC_FINE_TOKEN_VALUE_987654321';
  const ghPat = 'github_pat_11AAABBBCCC0123456789_ syntheticTailTokenData999'.replace(' ', '');
  const keyBodyLine = 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZWQyNTUxOQ==';
  const fakeKey = `-----BEGIN OPENSSH PRIVATE KEY-----\n${keyBodyLine}\n-----END OPENSSH PRIVATE KEY-----`;
  const basicB64 = Buffer.from('x-access-token:' + token).toString('base64');
  const rawStderr = [
    `Authorization: Bearer ${token}`,
    `Authorization: Basic ${basicB64}`,
    `https://x-access-token:${token}@github.com/donraposo1-source/project-wolf.git`,
    `x-access-token:${ghPat}@github.com`,
    fakeKey,
    `Load key "/tmp/runner-secret-dir/wolf-publication-key": invalid format`,
  ].join('\n');

  const redacted = redactGitPublicationOutput(rawStderr, {
    WOLF_FACTORY_REPO_TOKEN: `  ${token}  `,
    WOLF_FACTORY_DEPLOY_KEY: fakeKey,
    RUNNER_TEMP: '/tmp/runner-secret-dir',
  });

  for (const forbidden of [
    token,
    ghPat,
    basicB64,
    keyBodyLine,
    'BEGIN OPENSSH PRIVATE KEY',
    '/tmp/runner-secret-dir',
  ]) {
    assert.equal(
      redacted.includes(forbidden),
      false,
      `redacted output must never contain ${forbidden}`,
    );
  }
});

test('SSH deploy key preparation normalizes CRLF, validates key via ssh-keygen, blocks duplicates and cleans up on error', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-ssh-prep-'));
  try {
    const validKey = generateThrowawayEd25519Key(tmp);
    const crlfKey = validKey.replace(/\n/g, '\r\n');
    const ghEnv = path.join(tmp, 'github.env');
    fs.writeFileSync(ghEnv, '');

    const prepared = prepareSshPublicationCredential({
      env: {WOLF_FACTORY_DEPLOY_KEY: crlfKey},
      runnerTemp: tmp,
      githubEnvPath: ghEnv,
    });
    assert.equal(prepared.state, 'SCOPED_SSH_PUBLICATION_PREPARED');
    const writtenKey = fs.readFileSync(path.join(tmp, 'wolf-publication-key'), 'utf8');
    assert.equal(writtenKey.includes('\r'), false);
    assert.equal(fs.statSync(path.join(tmp, 'wolf-publication-key')).mode & 0o777, 0o600);
    const envOut = fs.readFileSync(ghEnv, 'utf8');
    assert.match(envOut, /WOLF_FACTORY_GIT_TRANSPORT=ssh-deploy-key/);
    assert.match(envOut, /StrictHostKeyChecking=yes/);

    // Duplicate materialization without cleanup must fail closed without clobbering existing key
    assert.throws(
      () =>
        prepareSshPublicationCredential({
          env: {WOLF_FACTORY_DEPLOY_KEY: validKey},
          runnerTemp: tmp,
          githubEnvPath: ghEnv,
        }),
      /DUPLICATE_SSH_KEY_MATERIALIZATION/,
    );
    assert.equal(fs.existsSync(path.join(tmp, 'wolf-publication-key')), true);
    cleanupSshPublicationCredential({runnerTemp: tmp});

    // Corrupt key must fail ssh-keygen validation and leave no residue
    assert.throws(
      () =>
        prepareSshPublicationCredential({
          env: {
            WOLF_FACTORY_DEPLOY_KEY:
              '-----BEGIN OPENSSH PRIVATE KEY-----\ncorrupt-payload\n-----END OPENSSH PRIVATE KEY-----',
          },
          runnerTemp: tmp,
          githubEnvPath: ghEnv,
        }),
      /PUBLICATION_DEPLOY_KEY_INVALID/,
    );
    assert.equal(fs.existsSync(path.join(tmp, 'wolf-publication-key')), false);
    assert.equal(fs.existsSync(path.join(tmp, 'wolf-publication-known-hosts')), false);

    assert.throws(() => normalizeOpenSshPrivateKey(''), /PUBLICATION_DEPLOY_KEY_REQUIRED/);
    cleanupSshPublicationCredential({runnerTemp: tmp});
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

test('publication preflight rejects main, wrong branch, wrong remote and duplicate publication before network IO', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-preflight-guard-'));
  try {
    const repoDir = path.join(tmp, 'repo');
    fs.mkdirSync(repoDir);
    const headSha = initCanonicalRepo(repoDir);
    spawnSync(
      'git',
      ['remote', 'add', 'origin', `git@github.com:${CANONICAL_REPOSITORY}.git`],
      {cwd: repoDir},
    );

    // 1. Rejects main target branch immediately
    assert.throws(
      () =>
        verifyAuthorizedGitPublication({
          cwd: repoDir,
          targetBranch: 'main',
          env: {WOLF_FACTORY_GIT_TRANSPORT: 'ssh-deploy-key'},
        }),
      /UNAUTHORIZED_TARGET_BRANCH/,
    );

    // 2. Rejects transport / remote URL mismatch before git push
    assert.throws(
      () =>
        verifyAuthorizedGitPublication({
          cwd: repoDir,
          env: {WOLF_FACTORY_GIT_TRANSPORT: 'https-token'},
        }),
      /UNAUTHORIZED_GIT_REMOTE/,
    );

    // 3. Rejects duplicate publication when commit is already recorded in receipt journal
    const journalPath = path.join(tmp, 'publication-journal.json');
    fs.writeFileSync(
      journalPath,
      JSON.stringify([
        {
          repository: CANONICAL_REPOSITORY,
          branch: CANONICAL_BRANCH,
          headSha,
          published: true,
        },
      ]),
    );
    let pushInvoked = false;
    assert.throws(
      () =>
        verifyAuthorizedGitPublication({
          cwd: repoDir,
          journalPath,
          env: {WOLF_FACTORY_GIT_TRANSPORT: 'ssh-deploy-key'},
          spawnImpl: (cmd, args, opts) => {
            if (args[0] === 'push') pushInvoked = true;
            return spawnSync(cmd, args, opts);
          },
        }),
      /DUPLICATE_PUBLICATION_PREVENTED/,
    );
    assert.equal(pushInvoked, false);

    // 4. Rejects wrong local branch (e.g. main checked out locally)
    spawnSync('git', ['switch', '-c', 'main'], {cwd: repoDir});
    assert.throws(
      () =>
        verifyAuthorizedGitPublication({
          cwd: repoDir,
          env: {WOLF_FACTORY_GIT_TRANSPORT: 'ssh-deploy-key'},
        }),
      /UNAUTHORIZED_LOCAL_BRANCH/,
    );
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

test('real Git dry-run preflight authorizes fast-forward without mutating remote refs and detects CONCURRENT_BRANCH_ADVANCED', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-real-git-'));
  try {
    const bare = path.join(tmp, 'remote.git');
    const workA = path.join(tmp, 'workA');
    const workB = path.join(tmp, 'workB');
    spawnSync('git', ['init', '--bare', bare]);
    fs.mkdirSync(workA);
    initCanonicalRepo(workA);
    spawnSync('git', ['remote', 'add', 'origin', bare], {cwd: workA});

    // Dry-run against empty remote succeeds and creates NO refs on bare remote
    const okReceipt = verifyAuthorizedGitPublication({
      cwd: workA,
      env: {WOLF_FACTORY_GIT_TRANSPORT: 'ssh-deploy-key'},
      allowLocalRemoteForTesting: true,
    });
    assert.equal(okReceipt.reason, 'AUTHORIZED');
    assert.equal(okReceipt.refUpdated, false);
    const refsAfterDryRun = spawnSync('git', ['show-ref'], {cwd: bare, encoding: 'utf8'});
    assert.equal(refsAfterDryRun.stdout.trim(), '');

    // Advance remote branch via workB so workA becomes stale (non-fast-forward)
    fs.mkdirSync(workB);
    initCanonicalRepo(workB);
    fs.writeFileSync(path.join(workB, 'second.txt'), 'advance\n');
    spawnSync('git', ['add', 'second.txt'], {cwd: workB});
    spawnSync('git', ['commit', '-m', 'advance remote'], {cwd: workB});
    spawnSync('git', ['push', bare, `HEAD:refs/heads/${CANONICAL_BRANCH}`], {cwd: workB});
    const remoteTipBefore = spawnSync(
      'git',
      ['rev-parse', `refs/heads/${CANONICAL_BRANCH}`],
      {cwd: bare, encoding: 'utf8'},
    ).stdout.trim();

    assert.throws(
      () =>
        verifyAuthorizedGitPublication({
          cwd: workA,
          env: {WOLF_FACTORY_GIT_TRANSPORT: 'ssh-deploy-key'},
          allowLocalRemoteForTesting: true,
        }),
      err => {
        assert.equal(err.message, 'CONCURRENT_BRANCH_ADVANCED');
        assert.equal(err.diagnostic.refUpdated, false);
        return true;
      },
    );
    const remoteTipAfter = spawnSync(
      'git',
      ['rev-parse', `refs/heads/${CANONICAL_BRANCH}`],
      {cwd: bare, encoding: 'utf8'},
    ).stdout.trim();
    assert.equal(remoteTipAfter, remoteTipBefore);
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

test('pinned admission rejects unexpected remote advancement even when a normal fast-forward push would succeed', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-pinned-cas-'));
  try {
    const bare = path.join(tmp, 'remote.git');
    const work = path.join(tmp, 'work');
    spawnSync('git', ['init', '--bare', bare]);
    fs.mkdirSync(work);
    const base = initCanonicalRepo(work);
    spawnSync('git', ['remote', 'add', 'origin', bare], {cwd: work});
    spawnSync('git', ['push', 'origin', `HEAD:refs/heads/${CANONICAL_BRANCH}`], {cwd: work});
    const options = {cwd: work, env: {WOLF_FACTORY_GIT_TRANSPORT: 'ssh-deploy-key', WOLF_FACTORY_EXPECTED_SHA: base}, allowLocalRemoteForTesting: true};
    assert.equal(verifyAuthorizedGitPublication(options).reason, 'AUTHORIZED');
    fs.writeFileSync(path.join(work, 'concurrent.txt'), 'unexpected remote advancement\n');
    spawnSync('git', ['add', '.'], {cwd: work});
    spawnSync('git', ['commit', '-m', 'concurrent writer'], {cwd: work});
    spawnSync('git', ['push', 'origin', `HEAD:refs/heads/${CANONICAL_BRANCH}`], {cwd: work});
    const advanced = spawnSync('git', ['rev-parse', 'HEAD'], {cwd: work, encoding: 'utf8'}).stdout.trim();
    fs.writeFileSync(path.join(work, 'candidate.txt'), 'candidate descendant\n');
    spawnSync('git', ['add', '.'], {cwd: work});
    spawnSync('git', ['commit', '-m', 'candidate'], {cwd: work});
    assert.equal(spawnSync('git', ['push', '--dry-run', 'origin', `HEAD:refs/heads/${CANONICAL_BRANCH}`], {cwd: work}).status, 0);
    assert.throws(() => verifyAuthorizedGitPublication(options), error => {
      assert.equal(error.message, 'REMOTE_COMMIT_SHA_MISMATCH');
      assert.equal(error.diagnostic.reason, 'REMOTE_COMMIT_SHA_MISMATCH');
      assert.equal(error.diagnostic.exitCode, 0);
      return true;
    });
    assert.equal(spawnSync('git', ['rev-parse', `refs/heads/${CANONICAL_BRANCH}`], {cwd: bare, encoding: 'utf8'}).stdout.trim(), advanced);
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

test('workflow YAML inline publication preflight and SSH preparation blocks remain synchronized and syntax-valid', () => {
  const workflowRaw = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  assert.equal(
    workflowRaw.includes('HEAD:refs/heads/main'),
    false,
    'workflow must never dry-run or push to main',
  );

  // Extract inline NODE heredocs for "Verify authorized branch publication with no ref update"
  const verifyBlocks = [
    ...workflowRaw.matchAll(
      /- name: Verify authorized branch publication with no ref update[\s\S]*?node --input-type=module <<'NODE'\n([\s\S]*?)\n\s*NODE/g,
    ),
  ].map(m =>
    m[1]
      .split('\n')
      .map(line => line.trim())
      .join('\n'),
  );
  assert.equal(
    verifyBlocks.length,
    2,
    'expected both integrated-factory and runner-loss-recover preflight steps',
  );
  assert.equal(
    verifyBlocks[0],
    verifyBlocks[1],
    'integrated-factory and runner-loss-recover preflight logic must match identically',
  );

  // Syntax-check the extracted inline module with node --check via temp file
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-wf-syntax-'));
  try {
    const inlineFile = path.join(tmp, 'inline-preflight.mjs');
    fs.writeFileSync(inlineFile, verifyBlocks[0] + '\n');
    const syntax = spawnSync(process.execPath, ['--check', inlineFile], {encoding: 'utf8'});
    assert.equal(syntax.status, 0, syntax.stderr);

    // Execute the exact extracted workflow script in a wrong-remote repo and confirm fail-closed exit
    const repoDir = path.join(tmp, 'repo');
    fs.mkdirSync(repoDir);
    initCanonicalRepo(repoDir);
    spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/someone/wrong.git'], {
      cwd: repoDir,
    });
    const runWrongRemote = spawnSync(process.execPath, [inlineFile], {
      cwd: repoDir,
      encoding: 'utf8',
      env: {...process.env, WOLF_FACTORY_GIT_TRANSPORT: 'https-token'},
    });
    assert.notEqual(runWrongRemote.status, 0);
    assert.match(runWrongRemote.stderr, /UNAUTHORIZED_GIT_REMOTE/);
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

test('independent remote commit SHA verification succeeds on exact remote ref and fails closed on mismatch or main', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-remote-sha-'));
  try {
    const bare = path.join(tmp, 'remote.git');
    const work = path.join(tmp, 'work');
    spawnSync('git', ['init', '--bare', bare]);
    fs.mkdirSync(work);
    const firstSha = initCanonicalRepo(work);
    spawnSync('git', ['remote', 'add', 'origin', bare], {cwd: work});
    spawnSync('git', ['push', 'origin', `HEAD:refs/heads/${CANONICAL_BRANCH}`], {cwd: work});

    const verified = verifyRemotePublishedCommit({
      expectedSha: firstSha,
      cwd: work,
      env: {WOLF_FACTORY_GIT_TRANSPORT: 'ssh-deploy-key'},
      allowLocalRemoteForTesting: true,
    });
    assert.equal(verified.verified, true);
    assert.equal(verified.commitSha, firstSha);

    const wrongSha = firstSha.startsWith('a')
      ? 'b' + firstSha.slice(1)
      : 'a' + firstSha.slice(1);
    assert.throws(
      () =>
        verifyRemotePublishedCommit({
          expectedSha: wrongSha,
          cwd: work,
          env: {WOLF_FACTORY_GIT_TRANSPORT: 'ssh-deploy-key'},
          allowLocalRemoteForTesting: true,
        }),
      /REMOTE_COMMIT_SHA_MISMATCH/,
    );
    assert.throws(
      () =>
        verifyRemotePublishedCommit({
          expectedSha: firstSha,
          cwd: work,
          targetBranch: 'main',
          allowLocalRemoteForTesting: true,
        }),
      /UNAUTHORIZED_TARGET_BRANCH/,
    );
    assert.throws(
      () =>
        verifyRemotePublishedCommit({
          expectedSha: firstSha,
          cwd: work,
          env: {WOLF_FACTORY_GIT_TRANSPORT: 'ssh-deploy-key'},
          allowLocalRemoteForTesting: false,
        }),
      /UNAUTHORIZED_GIT_REMOTE/,
    );
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

test('synthetic engineering scope and receipt allowlist admit OMEGA and WOLF_WAKEUP missions and deny unauthorized paths', () => {
  assert.deepEqual(
    authorizeSyntheticEngineeringScope({
      missionId: 'WOLF_WAKEUP_MANUAL_40606320022',
      changedFiles: ['docs/factory-acceptance/wolf-wakeup-manual-40606320022.py'],
    }),
    {
      authorized: true,
      reason: 'SYNTHETIC_ENGINEERING_SCOPE_AUTHORIZED',
      missionId: 'WOLF_WAKEUP_MANUAL_40606320022',
      target: 'docs/factory-acceptance/wolf-wakeup-manual-40606320022.py',
    },
  );
  assert.equal(
    authorizeSyntheticEngineeringScope({
      missionId: 'WOLF_WAKEUP_SCHEDULE_ACCEPTANCE_V1',
      changedFiles: ['docs/factory-acceptance/wolf-wakeup-schedule-acceptance-v1.py'],
    }).authorized,
    true,
  );
  assert.equal(
    authorizeSyntheticEngineeringScope({
      missionId: 'OMEGA_A_40601088303',
      changedFiles: ['docs/factory-acceptance/omega-40601088303-a.py'],
    }).authorized,
    true,
  );

  for (const deniedCase of [
    {
      missionId: 'WOLF_WAKEUP_MANUAL_40606320022',
      changedFiles: ['docs/factory-acceptance/wolf-wakeup-manual-99999999999.py'],
    },
    {
      missionId: 'WOLF_WAKEUP_MANUAL_40606320022',
      changedFiles: [
        'docs/factory-acceptance/wolf-wakeup-manual-40606320022.py',
        '.github/workflows/private-controller-preflight.yml',
      ],
    },
    {
      missionId: 'WOLF_WAKEUP_MANUAL_40606320022',
      changedFiles: ['docs/factory-acceptance/../secret.py'],
    },
    {
      missionId: 'PROD_MISSION_1',
      changedFiles: ['infra/autonomy/resident-entrypoint.mjs'],
    },
    {
      missionId: 'WOLF_WAKEUP_MANUAL_40606320022',
      changedFiles: [],
    },
  ]) {
    assert.deepEqual(authorizeSyntheticEngineeringScope(deniedCase), {
      authorized: false,
      reason: 'GROQ_SYNTHETIC_ENGINEERING_SCOPE_DENIED',
    });
  }

  assert.equal(
    isAuthorizedSyntheticReceiptFilename('WOLF_WAKEUP_MANUAL_40606320022-provider.json'),
    true,
  );
  assert.equal(
    isAuthorizedSyntheticReceiptFilename('WOLF_WAKEUP_SCHEDULE_ACCEPTANCE_V1-verifiers.json'),
    true,
  );
  assert.equal(isAuthorizedSyntheticReceiptFilename('OMEGA_C_40238444987-remote.json'), true);
  assert.equal(isAuthorizedSyntheticReceiptFilename('../secret-provider.json'), false);
  assert.equal(isAuthorizedSyntheticReceiptFilename('MAIN_1-provider.json'), false);
});

test('workflow enforces use_publication_deploy_key for integrated publication and reconciled wakeup journals preserve safety invariants', () => {
  const workflowRaw = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  assert.match(
    workflowRaw,
    /use_publication_deploy_key:\s*\n\s*description:[^\n]+\n\s*type:\s*boolean\s*\n\s*default:\s*true/,
  );
  assert.match(workflowRaw, /PUBLICATION_DEPLOY_KEY_SELECTION_REQUIRED=true/);
  assert.equal((workflowRaw.match(/WOLF_REMOTE_COMMIT_VERIFIED=/g) || []).length, 3);
  assert.match(workflowRaw, /WOLF_WAKEUP_MANUAL_\[0-9\]\+/);

  const rootDir = path.resolve(path.dirname(WORKFLOW_PATH), '../..');
  const j40605467853 = JSON.parse(
    fs.readFileSync(
      path.join(rootDir, 'docs/checkpoints/night-shift/WOLF_WAKEUP_MANUAL_40605467853.json'),
      'utf8',
    ),
  );
  assert.equal(j40605467853.state, 'SUSPENDED');
  assert.equal(j40605467853.externalEffectState, 'NO_MISSION_EFFECTS_VERIFIED');
  assert.equal(j40605467853.automaticRetry, false);

  const j40606320022 = JSON.parse(
    fs.readFileSync(
      path.join(rootDir, 'docs/checkpoints/night-shift/WOLF_WAKEUP_MANUAL_40606320022.json'),
      'utf8',
    ),
  );
  assert.equal(j40606320022.state, 'SUSPENDED');
  assert.equal(j40606320022.externalEffectState, 'UNKNOWN_UNTIL_RECONCILED');
  assert.equal(j40606320022.automaticRetry, false);

  const j40613194518 = JSON.parse(
    fs.readFileSync(
      path.join(rootDir, 'docs/checkpoints/night-shift/WOLF_WAKEUP_MANUAL_40613194518.json'),
      'utf8',
    ),
  );
  assert.equal(j40613194518.state, 'COMPLETED');
  const latestPublishedPrivateSha = j40613194518.checkpoint.commitSha;
  assert.match(latestPublishedPrivateSha, /^[a-f0-9]{40}$/);
  const expectedShaPins = [
    ...workflowRaw.matchAll(/WOLF_FACTORY_EXPECTED_SHA:\s*([a-f0-9]{40})/g),
  ].map(m => m[1]);
  // Historical read-only source diagnostic remains pinned; mission pins are admitted at runtime.
  assert.deepEqual(expectedShaPins, ['ff0a29aae8179d9c4a0c57d5772ae58f282c5ea6']);
  assert.equal(latestPublishedPrivateSha, MINIMUM_VERIFIED_FACTORY_SHA);
  assert.equal(
    workflowRaw.includes(MINIMUM_VERIFIED_FACTORY_SHA),
    false,
    'zero static mutable 58127da1 pins may remain in private-controller-preflight.yml',
  );
  assert.equal(
    (workflowRaw.match(/--force-with-lease=refs\/heads\//g) || []).length,
    2,
    'both integrated-factory and runner-loss-recover preflight blocks must enforce --force-with-lease CAS',
  );
});

test('resolveAdmittedPrivateSource resolves authorized HEAD, locks pre-admitted SHA, and rejects non-fast-forward or unauthorized sources', async () => {
  const s0 = MINIMUM_VERIFIED_FACTORY_SHA;
  const s1 = '7111111111111111111111111111111111111111';
  const s2 = '8222222222222222222222222222222222222222';

  await assert.rejects(
    () => resolveAdmittedPrivateSource({env: {}}),
    /PRIVATE_SOURCE_CREDENTIAL_REQUIRED/,
  );

  await assert.rejects(
    () =>
      resolveAdmittedPrivateSource({
        env: {WOLF_FACTORY_REPO_TOKEN: 'tok'},
        expectedBranch: 'main',
      }),
    /UNAUTHORIZED_TARGET_BRANCH/,
  );

  const locked = await resolveAdmittedPrivateSource({
    env: {WOLF_FACTORY_REPO_TOKEN: 'tok', WOLF_FACTORY_ADMITTED_SHA: s1},
    missionId: 'OMEGA_C_40699999999',
    leaseFence: 3,
    fetchImpl: () => {
      throw Error('MUST_NOT_FETCH_WHEN_LOCKED');
    },
  });
  assert.equal(locked.mode, 'LOCKED_UPSTREAM_ADMISSION');
  assert.equal(locked.admittedSha, s1);
  assert.equal(locked.leaseFence, 3);

  const makeMockFetch = ({headSha, compareStatus = 'ahead', behindBy = 0, aheadBy = 1, isPrivate = true}) =>
    async url => {
      const u = String(url);
      if (u.endsWith(`/repos/${CANONICAL_REPOSITORY}`)) {
        return {
          status: 200,
          async json() {
            return {full_name: CANONICAL_REPOSITORY, private: isPrivate};
          },
        };
      }
      if (u.endsWith(`/repos/${CANONICAL_REPOSITORY}/git/ref/heads/${CANONICAL_BRANCH}`)) {
        return {
          status: 200,
          async json() {
            return {ref: `refs/heads/${CANONICAL_BRANCH}`, object: {type: 'commit', sha: headSha}};
          },
        };
      }
      if (u.includes(`/compare/${s0}...${headSha}`)) {
        return {
          status: 200,
          async json() {
            return {status: compareStatus, behind_by: behindBy, ahead_by: aheadBy};
          },
        };
      }
      return {status: 404, async json() { return {}; }};
    };

  const atFloor = await resolveAdmittedPrivateSource({
    env: {WOLF_FACTORY_REPO_TOKEN: 'tok'},
    fetchImpl: makeMockFetch({headSha: s0}),
  });
  assert.equal(atFloor.mode, 'DYNAMIC_HEAD_ADMISSION');
  assert.equal(atFloor.admittedSha, s0);
  assert.equal(atFloor.aheadBy, 0);

  const advanced1 = await resolveAdmittedPrivateSource({
    env: {WOLF_FACTORY_REPO_TOKEN: 'tok'},
    fetchImpl: makeMockFetch({headSha: s1, aheadBy: 1}),
  });
  assert.equal(advanced1.admittedSha, s1);
  assert.equal(advanced1.aheadBy, 1);

  const advanced2 = await resolveAdmittedPrivateSource({
    env: {WOLF_FACTORY_REPO_TOKEN: 'tok'},
    fetchImpl: makeMockFetch({headSha: s2, aheadBy: 2}),
  });
  assert.equal(advanced2.admittedSha, s2);
  assert.equal(advanced2.aheadBy, 2);

  await assert.rejects(
    () =>
      resolveAdmittedPrivateSource({
        env: {WOLF_FACTORY_REPO_TOKEN: 'tok'},
        fetchImpl: makeMockFetch({headSha: s2, compareStatus: 'diverged', behindBy: 1, aheadBy: 2}),
      }),
    /PRIVATE_SOURCE_LINEAGE_NOT_FAST_FORWARD/,
  );

  await assert.rejects(
    () =>
      resolveAdmittedPrivateSource({
        env: {WOLF_FACTORY_REPO_TOKEN: 'tok'},
        fetchImpl: makeMockFetch({headSha: s1, isPrivate: false}),
      }),
    /PRIVATE_SOURCE_REPOSITORY_MISMATCH/,
  );
});

test('two sequential synthetic commits succeed without manual SHA updates while concurrent branch changes, stale fences, and unknown-effect replays fail closed', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-seq-cas-'));
  try {
    const bareRemote = path.join(tmp, 'project-wolf.git');
    const seedDir = path.join(tmp, 'seed');
    const journalPath = path.join(tmp, 'publication-journal.json');
    spawnSync('git', ['init', '--bare', bareRemote]);
    fs.mkdirSync(seedDir);
    const s0 = initCanonicalRepo(seedDir);
    spawnSync('git', ['remote', 'add', 'origin', bareRemote], {cwd: seedDir});
    spawnSync('git', ['push', 'origin', `HEAD:refs/heads/${CANONICAL_BRANCH}`], {cwd: seedDir});

    const getRemoteTip = () =>
      spawnSync('git', ['rev-parse', `refs/heads/${CANONICAL_BRANCH}`], {
        cwd: bareRemote,
        encoding: 'utf8',
      }).stdout.trim();

    const makeLiveRemoteFetch = floorSha => async url => {
      const u = String(url);
      const currentTip = getRemoteTip();
      if (u.endsWith(`/repos/${CANONICAL_REPOSITORY}`)) {
        return {
          status: 200,
          async json() {
            return {full_name: CANONICAL_REPOSITORY, private: true};
          },
        };
      }
      if (u.endsWith(`/repos/${CANONICAL_REPOSITORY}/git/ref/heads/${CANONICAL_BRANCH}`)) {
        return {
          status: 200,
          async json() {
            return {
              ref: `refs/heads/${CANONICAL_BRANCH}`,
              object: {type: 'commit', sha: currentTip},
            };
          },
        };
      }
      if (u.includes(`/compare/${floorSha}...${currentTip}`)) {
        const isAnc = spawnSync(
          'git',
          ['merge-base', '--is-ancestor', floorSha, currentTip],
          {cwd: bareRemote},
        );
        const countRes = spawnSync(
          'git',
          ['rev-list', '--count', `${floorSha}..${currentTip}`],
          {cwd: bareRemote, encoding: 'utf8'},
        );
        const ahead = Number.parseInt(String(countRes.stdout || '0').trim(), 10) || 0;
        return {
          status: 200,
          async json() {
            return isAnc.status === 0
              ? {status: 'ahead', behind_by: 0, ahead_by: ahead}
              : {status: 'diverged', behind_by: 1, ahead_by: ahead};
          },
        };
      }
      return {status: 404, async json() { return {}; }};
    };

    const checkoutAtSha = (dir, sha) => {
      fs.mkdirSync(dir);
      spawnSync('git', ['init'], {cwd: dir});
      spawnSync('git', ['config', 'user.email', 'test@wolf.local'], {cwd: dir});
      spawnSync('git', ['config', 'user.name', 'Wolf Test'], {cwd: dir});
      spawnSync('git', ['remote', 'add', 'origin', bareRemote], {cwd: dir});
      spawnSync('git', ['fetch', '--depth=1', 'origin', sha], {cwd: dir});
      spawnSync('git', ['checkout', '-b', CANONICAL_BRANCH, 'FETCH_HEAD'], {cwd: dir});
    };

    // === MISSION 1 (OMEGA_A_5001): Admits S0 dynamically, commits S1, publishes via CAS ===
    const admission1 = await resolveAdmittedPrivateSource({
      env: {WOLF_FACTORY_REPO_TOKEN: 'tok', WOLF_FACTORY_MIN_VERIFIED_SHA: s0},
      minVerifiedSha: s0,
      missionId: 'OMEGA_A_5001',
      leaseFence: 1,
      fetchImpl: makeLiveRemoteFetch(s0),
    });
    assert.equal(admission1.admittedSha, s0);

    const run1Dir = path.join(tmp, 'runner-1');
    const lease1Path = path.join(tmp, 'lease-1.json');
    checkoutAtSha(run1Dir, admission1.admittedSha);
    installCompareAndSwapPrePushGuard({
      cwd: run1Dir,
      leaseFilePath: lease1Path,
      expectedRemoteSha: admission1.admittedSha,
      leaseFence: 1,
      missionId: admission1.missionId,
    });
    assert.equal(
      spawnSync('git', ['status', '--porcelain'], {cwd: run1Dir, encoding: 'utf8'}).stdout.trim(),
      '',
    );

    const preflight1 = verifyAuthorizedGitPublication({
      cwd: run1Dir,
      env: {WOLF_FACTORY_GIT_TRANSPORT: 'ssh-deploy-key'},
      expectedRemoteSha: admission1.admittedSha,
      missionId: admission1.missionId,
      allowLocalRemoteForTesting: true,
      journalPath,
    });
    assert.equal(preflight1.reason, 'AUTHORIZED');
    assert.equal(preflight1.casEnforced, undefined);

    const target1 = path.join(run1Dir, 'docs/factory-acceptance/omega-5001-a.py');
    fs.mkdirSync(path.dirname(target1), {recursive: true});
    fs.writeFileSync(target1, 'def add(a, b):\n    return a + b\n');
    spawnSync('git', ['add', 'docs/factory-acceptance/omega-5001-a.py'], {cwd: run1Dir});
    spawnSync('git', ['commit', '-m', 'Mission OMEGA_A_5001 synthetic repair'], {cwd: run1Dir});

    const pub1 = publishCompareAndSwapCommit({
      cwd: run1Dir,
      env: {WOLF_FACTORY_GIT_TRANSPORT: 'ssh-deploy-key'},
      expectedRemoteSha: admission1.admittedSha,
      missionId: 'OMEGA_A_5001',
      checkpointId: 'wolf-cp-seq-1',
      leaseFence: 1,
      leaseState: {activeFence: 1},
      journalPath,
      allowLocalRemoteForTesting: true,
    });
    const s1 = pub1.commitSha;
    assert.notEqual(s1, s0);
    assert.equal(getRemoteTip(), s1);

    // Idempotency: duplicate replay of Mission 1 returns existing receipt without pushing again
    const replay1 = publishCompareAndSwapCommit({
      cwd: run1Dir,
      env: {WOLF_FACTORY_GIT_TRANSPORT: 'ssh-deploy-key'},
      expectedRemoteSha: admission1.admittedSha,
      missionId: 'OMEGA_A_5001',
      checkpointId: 'wolf-cp-seq-1',
      leaseFence: 1,
      leaseState: {activeFence: 1},
      journalPath,
      allowLocalRemoteForTesting: true,
    });
    assert.equal(replay1.alreadyCompleted, true);
    assert.equal(replay1.commitSha, s1);
    assert.equal(getRemoteTip(), s1);

    // === MISSION 2 (OMEGA_B_5002): ZERO manual SHA pin changes — admits S1 automatically, commits S2, publishes via CAS ===
    const admission2 = await resolveAdmittedPrivateSource({
      env: {WOLF_FACTORY_REPO_TOKEN: 'tok', WOLF_FACTORY_MIN_VERIFIED_SHA: s0},
      minVerifiedSha: s0,
      missionId: 'OMEGA_B_5002',
      leaseFence: 2,
      fetchImpl: makeLiveRemoteFetch(s0),
    });
    assert.equal(admission2.admittedSha, s1);
    assert.equal(admission2.aheadBy, 1);

    const run2Dir = path.join(tmp, 'runner-2');
    const lease2Path = path.join(tmp, 'lease-2.json');
    checkoutAtSha(run2Dir, admission2.admittedSha);
    installCompareAndSwapPrePushGuard({
      cwd: run2Dir,
      leaseFilePath: lease2Path,
      expectedRemoteSha: admission2.admittedSha,
      leaseFence: 2,
      missionId: admission2.missionId,
    });

    // Re-running preflight for already-published Mission 1 is blocked before IO
    assert.throws(
      () =>
        verifyAuthorizedGitPublication({
          cwd: run2Dir,
          env: {WOLF_FACTORY_GIT_TRANSPORT: 'ssh-deploy-key'},
          expectedRemoteSha: admission2.admittedSha,
          missionId: admission1.missionId,
          allowLocalRemoteForTesting: true,
          journalPath,
        }),
      /DUPLICATE_PUBLICATION_PREVENTED/,
    );

    const preflight2 = verifyAuthorizedGitPublication({
      cwd: run2Dir,
      env: {WOLF_FACTORY_GIT_TRANSPORT: 'ssh-deploy-key'},
      expectedRemoteSha: admission2.admittedSha,
      missionId: admission2.missionId,
      allowLocalRemoteForTesting: true,
      journalPath,
    });
    assert.equal(preflight2.reason, 'AUTHORIZED');

    const target2 = path.join(run2Dir, 'docs/factory-acceptance/omega-5002-b.py');
    fs.mkdirSync(path.dirname(target2), {recursive: true});
    fs.writeFileSync(target2, 'def normalize(v):\n    return " ".join(v.strip().lower().split())\n');
    spawnSync('git', ['add', 'docs/factory-acceptance/omega-5002-b.py'], {cwd: run2Dir});
    spawnSync('git', ['commit', '-m', 'Mission OMEGA_B_5002 synthetic repair'], {cwd: run2Dir});

    // Stale lease fence fails closed before Git push
    assert.throws(
      () =>
        publishCompareAndSwapCommit({
          cwd: run2Dir,
          env: {WOLF_FACTORY_GIT_TRANSPORT: 'ssh-deploy-key'},
          expectedRemoteSha: admission2.admittedSha,
          missionId: 'OMEGA_B_5002',
          checkpointId: 'wolf-cp-seq-2',
          leaseFence: 1,
          leaseState: {activeFence: 2},
          journalPath,
          allowLocalRemoteForTesting: true,
        }),
      /STALE_LEASE_FENCE_REJECTED/,
    );
    assert.equal(getRemoteTip(), s1);

    const pub2 = publishCompareAndSwapCommit({
      cwd: run2Dir,
      env: {WOLF_FACTORY_GIT_TRANSPORT: 'ssh-deploy-key'},
      expectedRemoteSha: admission2.admittedSha,
      missionId: 'OMEGA_B_5002',
      checkpointId: 'wolf-cp-seq-2',
      leaseFence: 2,
      leaseState: {activeFence: 2},
      journalPath,
      allowLocalRemoteForTesting: true,
    });
    const s2 = pub2.commitSha;
    assert.notEqual(s2, s1);
    assert.equal(getRemoteTip(), s2);

    // Advance local CAS lease fence and verify stale fence rejection
    const advancedLease = advanceCompareAndSwapLease({
      leaseFilePath: lease2Path,
      previousExpectedSha: s1,
      nextExpectedSha: s2,
      minLeaseFence: 2,
      nextLeaseFence: 3,
      missionId: 'OMEGA_C_5003',
    });
    assert.equal(advancedLease.expectedRemoteSha, s2);
    assert.equal(advancedLease.leaseFence, 3);
    assert.throws(
      () =>
        advanceCompareAndSwapLease({
          leaseFilePath: lease2Path,
          previousExpectedSha: s2,
          nextExpectedSha: s2,
          minLeaseFence: 2,
          nextLeaseFence: 2,
        }),
      /STALE_LEASE_FENCE_REJECTED/,
    );

    // === CONCURRENT BRANCH CHANGE REJECTION: Mission 3 admits S2, outsider advances remote to S_ext, CAS rejects Mission 3 ===
    const admission3 = await resolveAdmittedPrivateSource({
      env: {WOLF_FACTORY_REPO_TOKEN: 'tok', WOLF_FACTORY_MIN_VERIFIED_SHA: s0},
      minVerifiedSha: s0,
      missionId: 'OMEGA_C_5003',
      leaseFence: 3,
      fetchImpl: makeLiveRemoteFetch(s0),
    });
    assert.equal(admission3.admittedSha, s2);

    const run3Dir = path.join(tmp, 'runner-3');
    const lease3Path = path.join(tmp, 'lease-3.json');
    checkoutAtSha(run3Dir, admission3.admittedSha);
    installCompareAndSwapPrePushGuard({
      cwd: run3Dir,
      leaseFilePath: lease3Path,
      expectedRemoteSha: admission3.admittedSha,
      leaseFence: 3,
      missionId: admission3.missionId,
    });
    const target3 = path.join(run3Dir, 'docs/factory-acceptance/omega-5003-c.py');
    fs.mkdirSync(path.dirname(target3), {recursive: true});
    fs.writeFileSync(target3, 'def clamp(v):\n    return max(0, min(1, v))\n');
    spawnSync('git', ['add', 'docs/factory-acceptance/omega-5003-c.py'], {cwd: run3Dir});
    spawnSync('git', ['commit', '-m', 'Mission OMEGA_C_5003 candidate'], {cwd: run3Dir});

    // Simulate concurrent external writer advancing remote branch to sExt
    const outsiderDir = path.join(tmp, 'outsider');
    checkoutAtSha(outsiderDir, s2);
    fs.writeFileSync(path.join(outsiderDir, 'concurrent.txt'), 'unexpected concurrent write\n');
    spawnSync('git', ['add', 'concurrent.txt'], {cwd: outsiderDir});
    spawnSync('git', ['commit', '-m', 'Concurrent writer commit'], {cwd: outsiderDir});
    spawnSync('git', ['push', 'origin', `HEAD:refs/heads/${CANONICAL_BRANCH}`], {cwd: outsiderDir});
    const sExt = getRemoteTip();
    assert.notEqual(sExt, s2);

    assert.throws(
      () =>
        publishCompareAndSwapCommit({
          cwd: run3Dir,
          env: {WOLF_FACTORY_GIT_TRANSPORT: 'ssh-deploy-key'},
          expectedRemoteSha: admission3.admittedSha,
          missionId: 'OMEGA_C_5003',
          checkpointId: 'wolf-cp-seq-3',
          leaseFence: 3,
          leaseState: {activeFence: 3},
          journalPath,
          allowLocalRemoteForTesting: true,
        }),
      /CONCURRENT_BRANCH_ADVANCED/,
    );
    assert.equal(getRemoteTip(), sExt);

    // Suspended mission with UNKNOWN_UNTIL_RECONCILED external effect is never replayed
    const suspendedJournal = path.join(tmp, 'suspended-journal.json');
    fs.writeFileSync(
      suspendedJournal,
      JSON.stringify([
        {
          missionId: 'WOLF_WAKEUP_MANUAL_40612336952',
          state: 'SUSPENDED',
          externalEffectState: 'UNKNOWN_UNTIL_RECONCILED',
          automaticRetry: false,
        },
      ]),
    );
    assert.throws(
      () =>
        publishCompareAndSwapCommit({
          cwd: run3Dir,
          env: {WOLF_FACTORY_GIT_TRANSPORT: 'ssh-deploy-key'},
          expectedRemoteSha: sExt,
          missionId: 'WOLF_WAKEUP_MANUAL_40612336952',
          leaseFence: 4,
          journalPath: suspendedJournal,
          allowLocalRemoteForTesting: true,
        }),
      /UNKNOWN_EXTERNAL_EFFECT_REPLAY_DENIED/,
    );
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

// P0-C protection of the original Mission B (run 41040712384). Read-only assertions:
// the durable records are frozen byte-for-byte, no public surface can target the original
// run, and the observed external effect stays UNKNOWN — it is never rewritten into a
// terminal or negative-creation disposition, and no retry is ever authorized.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import * as diagnostic from '../scripts/boxxkite-service-diagnostic.mjs';

const repoRoot = new URL('..', import.meta.url);
const readRecord = rel => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const digestOf = value => crypto.createHash('sha256').update(value).digest('hex');
const git = (args) => {
  try { return execFileSync('git', args, {cwd: repoRoot, encoding: 'utf8'}); }
  catch (error) { if (error.status === 1) return ''; throw error; } // grep/log exit 1 on zero matches
};
const trackedFilesMatching = pattern => git(['grep', '-l', pattern]).trim().split('\n').filter(Boolean);

const INTENT_REL = '../docs/checkpoints/runner-loss/41040712384-b-intent.json';
const READY_REL = '../docs/checkpoints/runner-loss/41040712384.json';
const PAIR_INTENT_REL = '../docs/checkpoints/night-shift/operations/WOLF_PAIR_41040712384_INTENT.json';
const PAIR_READY_REL = '../docs/checkpoints/night-shift/operations/WOLF_PAIR_41040712384_READY.json';

// Sealed digests of the four immutable records as published during run 41040712384.
// Any rewrite of any record breaks these values; updating them is a deliberate,
// reviewable act and is forbidden while the external effect remains UNKNOWN.
const SEALED_RECORD_DIGESTS = new Map([
  ['docs/checkpoints/runner-loss/41040712384-b-intent.json', 'ac53264ffa0acb130a9b364d41d38b00134ddcbaed8570cb23335acc935baf6b'],
  ['docs/checkpoints/runner-loss/41040712384.json', 'f67b11090fadf00e849676b791fc80f03e56ad5f1bbd0c8dadd6291b81bcb20d'],
  ['docs/checkpoints/night-shift/operations/WOLF_PAIR_41040712384_INTENT.json', 'ef0c31f6c4692796d5d6cb3713437a46630bab2dda8e258fd514468a0351e181'],
  ['docs/checkpoints/night-shift/operations/WOLF_PAIR_41040712384_READY.json', 'f7acaf0c496d81d45a8c1c1496d011f36993c409c26fe64069b678d34e6442d7'],
]);

const intent = JSON.parse(readRecord(INTENT_REL));
const ready = JSON.parse(readRecord(READY_REL));
const runId = intent.runId;
const missionId = intent.missionId;

test('the four durable Mission B records are byte-identical to the sealed originals', () => {
  assert.equal(runId, '41040712384');
  assert.equal(missionId, 'OMEGA_B_' + runId);
  for (const [rel, sealed] of SEALED_RECORD_DIGESTS) {
    assert.equal(digestOf(fs.readFileSync(new URL('../' + rel, import.meta.url))), sealed, rel + ' must never be rewritten while the effect is UNKNOWN');
  }
});

test('the durable intent still declares INTENT, fence 1, an unreplayed persisted checkpoint A and the original owner', () => {
  assert.equal(intent.schema, 'WolfDurablePairExecutionIntent/v1');
  assert.equal(intent.state, 'INTENT', 'the intent must never be edited into another state');
  assert.match(intent.executionKey, /^[a-f0-9]{64}$/);
  assert.equal(intent.fencingToken, 1);
  assert.equal(intent.owner, 'wolf-cross-job:' + runId + ':runner-loss-recover');
  assert.equal(intent.checkpointA.state, 'PERSISTED');
  assert.equal(intent.checkpointA.replayed, false);
  assert.equal(intent.checkpointA.missionId, 'OMEGA_A_' + runId);
  assert.equal(intent.checkpointA.commitSha, ready.checkpointA.commitSha, 'both records must name the same checkpoint A commit');
});

test('the fenced Git receipt still authenticates the preserved intent record it points at', () => {
  const receipt = JSON.parse(readRecord(PAIR_INTENT_REL));
  assert.equal(receipt.schema, 'WolfFencedGitReceipt/v1');
  assert.equal(receipt.recordPath, 'docs/checkpoints/runner-loss/41040712384-b-intent.json');
  assert.equal(receipt.recordDigest, digestOf(JSON.stringify(intent)), 'the receipt digest must still match the compact JSON of the intent');
  assert.equal(receipt.fencingToken, intent.fencingToken);
  assert.equal(receipt.owner, intent.owner);
  assert.equal(receipt.authorityDigest, intent.authorityDigest);
});

test('the READY continuation keeps the original mission pending with a terminated origin and a sealed envelope', () => {
  assert.equal(ready.schema, 'WolfDurablePairContinuation/v1');
  assert.equal(ready.state, 'NEXT_READY', 'the continuation must never be edited into a terminal state');
  assert.equal(ready.manifest.workflowID, 'wolf-cross-job-' + runId);
  assert.equal(ready.manifest.crossJobContinuation, true);
  assert.equal(ready.manifest.restartAfterMissionA, true);
  assert.equal(ready.origin.originalProcessTerminated, true);
  assert.equal(ready.origin.job, 'integrated-factory');
  assert.deepEqual(ready.envelope.context, {workflowID: 'wolf-cross-job-' + runId, runID: runId, sourceSha: ready.manifest.baseSha});
  assert.match(ready.envelope.payloadSha256, /^[a-f0-9]{64}$/);
  assert.equal(ready.envelope.algorithm, 'aes-256-gcm+scrypt+gzip');
  const pairReady = JSON.parse(readRecord(PAIR_READY_REL));
  assert.equal(pairReady.schema, 'WolfFencedGitReceipt/v1');
  assert.equal(pairReady.recordPath, 'docs/checkpoints/runner-loss/41040712384.json');
  assert.equal(pairReady.recordDigest, digestOf(JSON.stringify(ready)), 'the READY receipt digest must still match the compact JSON of the continuation');
});

test('no new disposition record for the original run can appear unnoticed', () => {
  const allowed = new Set([
    ...SEALED_RECORD_DIGESTS.keys(),
    'docs/checkpoints/omega/WOLF-OMEGA-P2-20261031.handoff.md',
    'docs/checkpoints/omega/WOLF-OMEGA-P2-20261031.inventory.json',
    'docs/checkpoints/omega/WOLF-OMEGA-P4-20261031.handoff.md',
    'docs/checkpoints/omega/WOLF-OMEGA-P4-20261031.inventory.json',
    'tests/boxxkite-service-diagnostic.test.mjs',
    'tests/omega-b-preservation.test.mjs', // this guard itself embeds the run id in the sealed-record paths
    'tests/runner-loss-two-job-contract.test.mjs', // reads the sealed intent by path to derive the protected identity at runtime
  ]);
  const referencing = trackedFilesMatching(runId);
  for (const rel of SEALED_RECORD_DIGESTS.keys()) assert.ok(referencing.includes(rel), rel + ' must not be deleted');
  for (const rel of referencing) assert.ok(allowed.has(rel), 'unexpected file references the protected run: ' + rel + ' (a new FINAL/disposition record requires explicit authorization)');
});

test('no machine-readable surface asserts a terminal or negative-creation disposition for the original mission', () => {
  const forbidden = /NOT_CREATED|SANDBOX_NOT_CREATED|CREATE_CONFIRMED|MISSION_B_COMPLETED|EFFECT_VERIFIED_CREATED/;
  for (const rel of trackedFilesMatching(missionId)) {
    if (rel.endsWith('.md')) continue; // narrative handoffs quote the prohibition itself
    const text = fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
    assert.equal(forbidden.test(text), false, rel + ' must not convert NO_MATCH_OBSERVED into a creation disposition');
    if (rel.startsWith('docs/checkpoints/runner-loss/') || rel.startsWith('docs/checkpoints/night-shift/operations/')) {
      assert.equal(/"state":\s*"(?:COMPLETED|FINAL)"/.test(text), false, rel + ' must not declare the mission complete');
    }
  }
});

test('no workflow or script in the public runtime can target the original run or its execution identity', () => {
  assert.equal(git(['grep', '-l', runId, '--', '.github', 'scripts']).trim(), '', 'no workflow or script may hardcode the protected run');
  assert.equal(git(['grep', '-l', missionId, '--', '.github', 'scripts']).trim(), '', 'no workflow or script may hardcode the protected mission');
  const keyCarriers = trackedFilesMatching(intent.executionKey);
  for (const rel of keyCarriers) {
    assert.ok(['docs/checkpoints/runner-loss/41040712384-b-intent.json', 'docs/checkpoints/omega/WOLF-OMEGA-P2-20261031.inventory.json'].includes(rel),
      'the execution identity must not spread beyond the sealed intent and its P2 inventory: ' + rel);
  }
});

test('zero-match reconciliation of the original label stays NO_MATCH_OBSERVED/UNKNOWN and authorizes no retry', async () => {
  assert.equal(typeof diagnostic.reconcileBoxxkiteCreate, 'function');
  const listing = Array.from({length: 39}, (_, i) => ({id: 'sandbox-' + i, label: 'OMEGA_A_9000000' + String(1000 + i), status: 'active'}));
  let calls = 0;
  const result = await diagnostic.reconcileBoxxkiteCreate({
    label: missionId, env: {BOXXKITE_API_KEY: 'fixture'},
    fetchImpl: async () => { calls++; return new Response(JSON.stringify(listing)); },
  });
  assert.equal(calls, 1, 'reconciliation is a single read-only listing');
  assert.equal(result.state, 'NO_MATCH_OBSERVED');
  assert.equal(result.matches.length, 0);
  assert.equal(result.listingCount, 39);
  assert.equal(result.createOutcome, 'UNKNOWN', 'zero observed matches must never be reported as a proven absence of creation');
  assert.equal(result.automaticRetryAuthorized, false);
  assert.equal(result.sandboxCreated, false);
  assert.equal(result.mutationPerformed, false);
  assert.equal(result.inferencePerformed, false);
});

test('when history is available, the records are unchanged since their sealing commits', () => {
  const seals = new Map([
    ['docs/checkpoints/runner-loss/41040712384-b-intent.json', '329967c718264c30842f26e363628657c15eed19'],
    ['docs/checkpoints/runner-loss/41040712384.json', '572c45050b9637a203ddbcd8f132687ce76e3349'],
    ['docs/checkpoints/night-shift/operations/WOLF_PAIR_41040712384_INTENT.json', 'f567816a42f082a42d483d5b581208ad5f21ee86'],
    ['docs/checkpoints/night-shift/operations/WOLF_PAIR_41040712384_READY.json', '5531148454a3e1b1d7e9ecaa205bf5b19a28c2ec'],
  ]);
  const available = sha => {
    try { execFileSync('git', ['cat-file', '-e', sha + '^{commit}'], {cwd: repoRoot, stdio: 'ignore'}); return true; }
    catch { return false; }
  };
  let checked = 0;
  for (const [rel, seal] of seals) {
    if (!available(seal)) continue; // shallow CI checkout: the digest pins above remain the authoritative guard
    assert.equal(git(['diff', '--stat', seal, '--', rel]).trim(), '', rel + ' changed after its sealing commit ' + seal);
    checked++;
  }
  // Chain identities observable from history: the receipts name the commits that sealed the records.
  const receipt = JSON.parse(readRecord(PAIR_INTENT_REL));
  const chains = [
    [receipt.publishedCommit, 'docs/checkpoints/runner-loss/41040712384-b-intent.json'],
    [intent.continuationRevision, 'docs/checkpoints/night-shift/operations/WOLF_PAIR_41040712384_READY.json'],
  ];
  for (const [seal, rel] of chains) {
    if (!available(seal)) continue;
    assert.equal(git(['log', '--format=%H', '-1', '--', rel]).trim(), seal, 'the last commit touching ' + rel + ' must be the sealed publication commit');
    checked++;
  }
  if (checked > 0) assert.ok(checked >= 4, 'history-backed verification should cover every sealed record when history exists');
});

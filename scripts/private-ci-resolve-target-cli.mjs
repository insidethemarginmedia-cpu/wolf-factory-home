// Resolves the acceptance target for one run.
//
//   node scripts/private-ci-resolve-target-cli.mjs resolve --out <file>
//
// Prints the resolution and writes it to `--out` so later steps read a file rather
// than re-resolving against a moving ref. The verdict is in the output, not in the
// exit code: a STALE target is a successful resolution of a bad situation.
import fs from 'node:fs';
import path from 'node:path';

import {credentialForRole} from './private-ci-app-auth.mjs';
import {resolveTarget, targetVerdict} from './private-ci-resolve-target.mjs';

export const RESOLVE_EXIT = Object.freeze({OK: 0, USAGE: 2, BLOCKED: 79});

const SAFE_TARGET_REASONS = new Set([
  'NO_READER_CREDENTIAL', 'REPOSITORY_INVALID', 'PR_NUMBER_INVALID',
  'PR_STATE_UNVERIFIED', 'PR_UNREADABLE', 'PR_HEAD_UNRESOLVED',
  'PR_HEAD_CHANGED_DURING_RESOLUTION', 'TARGET_UNRESOLVED',
  'TARGET_IDENTITY_UNESTABLISHED', 'PIN_NO_LONGER_PR_HEAD',
  'PR_HEAD_RELATION_UNVERIFIED', 'PR_NOT_OPEN', 'TREE_IDENTITY_UNRESOLVED',
  'TREE_IDENTITY_MISMATCH', 'PERSISTED_VERDICT_NOT_ACCEPTED', 'TARGET_NOT_EXECUTION_SHA',
]);

/** A public run-log projection; private PR number, repository and commit IDs stay local. */
export function buildPublicTargetAggregate(target = {}, verdict = {}) {
  const states = new Set(['RESOLVED', 'BLOCKED', 'CURRENT', 'STALE', 'UNKNOWN', 'ACCEPTED']);
  const relations = new Set(['CURRENT', 'STALE', 'UNKNOWN']);
  return {
    state: states.has(verdict.state) ? verdict.state : states.has(target.state) ? target.state : 'UNKNOWN',
    relation: relations.has(target.relation) ? target.relation : null,
    treeIdentical: typeof target.treeIdentity?.identical === 'boolean'
      ? target.treeIdentity.identical
      : typeof verdict.treeIdentical === 'boolean' ? verdict.treeIdentical : null,
    acceptanceValid: verdict.acceptanceValid === true,
    reason: SAFE_TARGET_REASONS.has(verdict.reason) ? verdict.reason : null,
    credentialsPrinted: false,
  };
}

export async function resolveTargetCli(argv = [], {
  env = process.env,
  fetchImpl = globalThis.fetch,
  stdout = text => process.stdout.write(text),
} = {}) {
  const command = argv[0];
  const flag = name => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  if (command === 'gate') {
    const input = flag('--in') ?? env.WOLF_CI_TARGET_OUTPUT;
    const expectedSha = String(flag('--execution-sha') ?? env.WOLF_CI_SHA ?? '').trim().toLowerCase();
    let parsed = null;
    try { parsed = input ? JSON.parse(fs.readFileSync(input, 'utf8')) : null; } catch { parsed = null; }
    if (!parsed || typeof parsed !== 'object' || !parsed.target) {
      stdout(JSON.stringify({state: 'BLOCKED', acceptanceValid: false, reason: 'TARGET_OUTPUT_UNAVAILABLE', credentialsPrinted: false}) + '\n');
      return RESOLVE_EXIT.BLOCKED;
    }
    if (!/^[0-9a-f]{40}$/.test(expectedSha)) {
      stdout(JSON.stringify({state: 'BLOCKED', acceptanceValid: false, reason: 'EXECUTION_SHA_REQUIRED', credentialsPrinted: false}) + '\n');
      return RESOLVE_EXIT.BLOCKED;
    }
    // Recompute the verdict at the execution boundary; do not trust a precomputed
    // boolean in the file as authority. Also bind both admitted and pinned identities
    // to the exact SHA the checkout step will execute.
    const verdict = targetVerdict(parsed.target);
    const exactExecution = verdict.acceptanceValid === true
      && parsed.verdict?.acceptanceValid === true
      && parsed.target.pinnedSha === expectedSha
      && parsed.target.prHead === expectedSha;
    if (!exactExecution) {
      const reason = verdict.acceptanceValid !== true
        ? (verdict.reason ?? 'TARGET_NOT_ACCEPTED')
        : parsed.verdict?.acceptanceValid !== true
          ? 'PERSISTED_VERDICT_NOT_ACCEPTED'
          : 'TARGET_NOT_EXECUTION_SHA';
      stdout(JSON.stringify(buildPublicTargetAggregate(parsed.target, {
        state: 'BLOCKED',
        acceptanceValid: false,
        reason,
      })) + '\n');
      return RESOLVE_EXIT.BLOCKED;
    }
    stdout(JSON.stringify(buildPublicTargetAggregate(parsed.target, {
      state: 'ACCEPTED',
      acceptanceValid: true,
      reason: null,
    })) + '\n');
    return RESOLVE_EXIT.OK;
  }

  if (command !== 'resolve') {
    stdout(JSON.stringify({state: 'BLOCKED', reason: 'RESOLVE_COMMAND_REQUIRED'}) + '\n');
    return RESOLVE_EXIT.USAGE;
  }

  const reader = credentialForRole('reader', {env});
  const target = await resolveTarget({
    token: reader.token ?? '',
    repository: flag('--repository') ?? env.WOLF_CI_REPOSITORY,
    pr: flag('--pr') ?? env.WOLF_CI_PR,
    pinnedSha: flag('--pinned') ?? env.WOLF_CI_SHA,
    fetchImpl,
  });

  const verdict = targetVerdict(target);
  const output = {target, verdict, credentialSource: reader.source, credentialsPrinted: false};

  const out = flag('--out') ?? env.WOLF_CI_TARGET_OUTPUT;
  if (out) {
    fs.mkdirSync(path.dirname(out), {recursive: true});
    fs.writeFileSync(out, JSON.stringify(output, null, 2), {mode: 0o600});
  }

  stdout(JSON.stringify(buildPublicTargetAggregate(target, verdict)) + '\n');
  return RESOLVE_EXIT.OK;
}

// Direct invocation. Without this the command prints nothing and exits 0, which
// the workflow would read as a successful resolution of nothing - a silent failure
// in the same family as the ones this pipeline exists to prevent.
const invokedDirectly = process.argv[1] && new URL('file://' + process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  resolveTargetCli(process.argv.slice(2)).then(code => process.exit(code));
}

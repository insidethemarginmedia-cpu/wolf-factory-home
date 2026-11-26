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
      stdout(JSON.stringify({
        state: 'BLOCKED',
        acceptanceValid: false,
        reason,
        prHead: parsed.target.prHead ?? null,
        pinnedSha: parsed.target.pinnedSha ?? null,
        executionSha: expectedSha,
        credentialsPrinted: false,
      }) + '\n');
      return RESOLVE_EXIT.BLOCKED;
    }
    stdout(JSON.stringify({
      state: 'ACCEPTED',
      acceptanceValid: true,
      reason: null,
      prHead: parsed.target.prHead,
      pinnedSha: parsed.target.pinnedSha,
      executionSha: expectedSha,
      treeIdentical: true,
      credentialsPrinted: false,
    }) + '\n');
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

  stdout(JSON.stringify({
    state: target.state,
    relation: target.relation ?? null,
    prHead: target.prHead ?? null,
    pinnedSha: target.pinnedSha ?? null,
    treeIdentical: target.treeIdentity?.identical ?? null,
    acceptanceValid: verdict.acceptanceValid,
    reason: verdict.reason ?? target.reason ?? null,
    credentialSource: reader.source,
    credentialsPrinted: false,
  }) + '\n');
  return RESOLVE_EXIT.OK;
}

// Direct invocation. Without this the command prints nothing and exits 0, which
// the workflow would read as a successful resolution of nothing - a silent failure
// in the same family as the ones this pipeline exists to prevent.
const invokedDirectly = process.argv[1] && new URL('file://' + process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  resolveTargetCli(process.argv.slice(2)).then(code => process.exit(code));
}

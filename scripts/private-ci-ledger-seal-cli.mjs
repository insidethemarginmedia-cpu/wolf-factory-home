// Seals the durable retirement ledger and publishes its trusted head anchor.
//
//   node scripts/private-ci-ledger-seal-cli.mjs seal --in <ledger> --anchor-out <file>
//
// Two artefacts, both published to the retirement branch:
//
//   .wolf-ci/retirement-ledger.jsonl   the sealed, hash-chained ledger
//   .wolf-ci/retirement-head.json      the anchor: how long the ledger should be
//
// The anchor is what makes truncation detectable. Reading the expectation from the
// ledger itself would be circular - a ledger cannot vouch for its own length - so
// the expectation lives beside it and is only ever advanced by a run that appended.
import fs from 'node:fs';
import path from 'node:path';

import {verifyLedger, migrateLegacyLedger, buildHeadAnchor, compareToAnchor, hardenedRetirementVerdict} from './private-ci-retirement-integrity.mjs';

export const SEAL_EXIT = Object.freeze({OK: 0, USAGE: 2, FAILED: 1});

export function sealCli(argv = [], {env = process.env, stdout = text => process.stdout.write(text), now = Date.now()} = {}) {
  const command = argv[0];
  const flag = name => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  if (command !== 'seal') {
    stdout(JSON.stringify({state: 'FAILED', reason: 'SEAL_COMMAND_REQUIRED'}) + '\n');
    return SEAL_EXIT.USAGE;
  }

  const input = flag('--in') ?? env.WOLF_CI_RETIREMENT_LEDGER_FILE;
  const anchorOut = flag('--anchor-out') ?? env.WOLF_CI_RETIREMENT_ANCHOR_FILE;
  const sealedOut = flag('--out') ?? input;
  const existingAnchorFile = flag('--anchor-in') ?? env.WOLF_CI_RETIREMENT_ANCHOR_IN;

  let text = '';
  try {
    text = fs.readFileSync(input, 'utf8');
  } catch {
    text = '';
  }

  // Migrate first: a legacy ledger is not tamper-evident, and sealing it is what
  // makes every later append verifiable. The retirement record itself is preserved.
  const migration = migrateLegacyLedger(text);
  const finalText = migration.migrated ? migration.text : text;

  const verification = verifyLedger(finalText);
  if (verification.state !== 'INTACT') {
    stdout(JSON.stringify({
      state: 'FAILED',
      reason: 'LEDGER_NOT_INTACT',
      integrity: verification.state,
      integrityReason: verification.reason ?? null,
      credentialsPrinted: false,
    }) + '\n');
    return SEAL_EXIT.FAILED;
  }

  // Compare against the previously published anchor, if any, before overwriting it.
  let previousAnchor = null;
  if (existingAnchorFile) {
    try {
      previousAnchor = JSON.parse(fs.readFileSync(existingAnchorFile, 'utf8'));
    } catch {
      previousAnchor = null;
    }
  }
  const anchorCheck = compareToAnchor(verification, previousAnchor);

  const anchor = buildHeadAnchor(verification, {commit: env.GITHUB_SHA ?? null, now});
  fs.writeFileSync(sealedOut, finalText, {mode: 0o600});
  if (anchorOut) {
    fs.mkdirSync(path.dirname(anchorOut), {recursive: true});
    fs.writeFileSync(anchorOut, JSON.stringify(anchor, null, 2) + '\n', {mode: 0o600});
  }

  const verdict = hardenedRetirementVerdict(finalText, {anchor});
  stdout(JSON.stringify({
    state: 'SEALED',
    migratedRecords: migration.migrated ? migration.count : 0,
    sequence: verification.sequence,
    head: verification.head,
    anchorConsistent: anchorCheck.consistent,
    anchorReason: anchorCheck.reason,
    retired: verdict.retired,
    safeToFallBack: verdict.safeToFallBack,
    credentialsPrinted: false,
  }) + '\n');
  return SEAL_EXIT.OK;
}

const invokedDirectly = process.argv[1] && new URL('file://' + process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  process.exit(sealCli(process.argv.slice(2)));
}

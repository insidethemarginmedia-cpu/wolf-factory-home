// Live proof that durable retirement is enforced, not merely recorded.
//
// Run inside a workflow that has NO per-run retirement flag of its own. It fetches
// the ledger branch from the real API, runs the credential selector with an empty
// environment (so no per-run flag is set), and reports what the selector decides.
//
// The point is the counterfactual: this run never computed a retirement decision,
// so anything that closes the fallback here can only have come from the ledger.
import {execFileSync} from 'node:child_process';
import {selectCredential} from '../private-ci-app-auth.mjs';
import {readLedgerVerdict} from '../private-ci-retirement-ledger.mjs';

const repository = process.env.GITHUB_REPOSITORY;
const branch = 'wolf-ci-retirement';
const path = '.wolf-ci/retirement-ledger.jsonl';

let ledgerText = null;
try {
  const encoded = execFileSync('gh', ['api', `repos/${repository}/contents/${path}?ref=${branch}`, '--jq', '.content'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  ledgerText = Buffer.from(encoded, 'base64').toString('utf8');
} catch {
  ledgerText = null;
}

const verdict = readLedgerVerdict(ledgerText);

// A PAT is present in the environment, because that is what makes the test
// meaningful: the selector must refuse a credential that exists.
const env = {WOLF_FACTORY_REPO_TOKEN: process.env.WOLF_FACTORY_REPO_TOKEN ?? 'present-but-unusable'};
const selection = selectCredential('reader', {env, ledgerText});

const output = {
  ledger: {state: verdict.state, retired: verdict.retired, since: verdict.since, sinceCommit: verdict.sinceCommit, evidenceCount: verdict.evidenceCount},
  perRunFlagPresent: false,
  selector: {source: selection.source, reason: selection.reason ?? null, retirementSource: selection.retirementSource ?? null, withheldCredential: selection.withheldCredential ?? null},
  // The claim under test. A retired ledger with a present PAT must yield 'none'.
  enforcedByLedgerAlone: verdict.retired === true && selection.source === 'none' && selection.reason === 'PAT_FALLBACK_RETIRED',
  credentialsPrinted: false,
};

process.stdout.write(JSON.stringify(output) + '\n');
process.exit(output.enforcedByLedgerAlone ? 0 : 1);

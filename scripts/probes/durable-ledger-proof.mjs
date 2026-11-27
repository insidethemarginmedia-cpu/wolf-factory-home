// Live proof that durable retirement evidence (ledger + anchor) is enforced
// without a per-run flag.
//
// The selector is given the same bytes the runtime hydrated. Missing or unreadable
// storage is not relabelled as an observed retirement: it still withholds PAT
// fallback because this proof requires an anchor, and reports that distinction.
import {execFileSync} from 'node:child_process';
import {selectCredential} from '../private-ci-app-auth.mjs';
import {readLedgerVerdict} from '../private-ci-retirement-ledger.mjs';

const repository = process.env.GITHUB_REPOSITORY;
const branch = 'wolf-ci-retirement';
const readContents = path => {
  const encoded = execFileSync('gh', ['api', `repos/${repository}/contents/${path}?ref=${branch}`, '--jq', '.content'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  return Buffer.from(encoded, 'base64').toString('utf8');
};

let ledgerText = null;
let anchorText = null;
try { ledgerText = readContents('.wolf-ci/retirement-ledger.jsonl'); } catch {}
try { anchorText = readContents('.wolf-ci/retirement-head.json'); } catch {}

const ledger = readLedgerVerdict(ledgerText);
let anchorState = 'UNAVAILABLE';
try {
  const anchor = JSON.parse(anchorText ?? '');
  anchorState = anchor && typeof anchor === 'object' ? 'READ' : 'UNREADABLE';
} catch {
  anchorState = 'UNREADABLE';
}

// The PAT is present to make this adversarial: a missing token cannot prove the
// selector enforced retirement. The per-run flag is explicitly unset.
const env = {
  WOLF_FACTORY_REPO_TOKEN: process.env.WOLF_FACTORY_REPO_TOKEN ?? 'present-but-unusable',
  WOLF_CI_RETIREMENT_REQUIRE_ANCHOR: 'true',
};
const selection = selectCredential('reader', {env, ledgerText, anchorText});
const patFallbackDenied = selection.source === 'none';
const enforcedByDurableRetirement = ledger.retired === true
  && selection.source === 'none'
  && selection.reason === 'PAT_FALLBACK_RETIRED';

const output = {
  ledger: {
    state: ledger.state,
    retired: ledger.retired,
    since: ledger.since,
    sinceCommit: ledger.sinceCommit,
    evidenceCount: ledger.evidenceCount,
  },
  anchor: {state: anchorState},
  perRunFlagPresent: false,
  selector: {
    source: selection.source,
    reason: selection.reason ?? null,
    retirementSource: selection.retirementSource ?? null,
    withheldCredential: selection.withheldCredential ?? null,
  },
  patFallbackDenied,
  enforcedByDurableRetirement,
  credentialsPrinted: false,
};

process.stdout.write(JSON.stringify(output) + '\n');
process.exit(patFallbackDenied ? 0 : 1);

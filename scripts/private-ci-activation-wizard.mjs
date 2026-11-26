// Former Wolf Factory App activation wizard.
//
// Its setup flow has been withdrawn. This module can only render a static blocked
// notice; the CLI emits a machine-readable refusal. It no longer creates a form,
// lists secret names, or provides account/install links.
import {pathToFileURL} from 'node:url';

export const ACTIVATION_STATUS = 'WITHDRAWN';
export const ACCOUNTS = Object.freeze([]);
export const WIZARD_STEPS = Object.freeze([]);

export function secretInstructions() {
  return [];
}

export function buildWizardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>App activation withdrawn — Wolf Factory Home</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 52rem; margin: 3rem auto; padding: 0 1.25rem; }
  .blocked { border-left: 4px solid #d29922; padding: 1rem 1.25rem; background: #d2992214; }
</style>
</head>
<body>
<h1>Former App activation flow withdrawn</h1>
<div class="blocked"><strong>BLOCKED / NOT AUTHORIZED.</strong> This page does not create or install a GitHub App and does not request secrets. Do not use earlier forms to create duplicate infrastructure, change repository settings, or dispatch a mission.</div>
<p>The listener and bridge are not on the default branch. The executor pin, authoritative Factory/Compute callback contract, durable recovery owner, and required approvals remain unresolved. No private-worker acceptance is claimed. EUR_SPEND=0.</p>
<p>See <a href="../integration-contract.md">the current blocked integration contract</a>. Never send credential values to an agent or public artifact.</p>
</body>
</html>
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify({
    state: 'BLOCKED',
    reason: 'APP_ACTIVATION_WITHDRAWN',
    authorizedActions: [],
    credentialsPrinted: false,
    dispatchAuthorized: false,
  }) + '\n');
  process.exitCode = 78;
}

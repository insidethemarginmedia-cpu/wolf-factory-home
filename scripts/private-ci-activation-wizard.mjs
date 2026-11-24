// Wolf Factory Automation — Founder Activation Wizard.
//
// One page, four steps, generated from the same source of truth the runtime uses
// (the manifest module and the installation mapper), so the wizard cannot drift
// from what the workflow actually expects.
//
// It contains no secret, no key and no token: it publishes links, names and
// expected values only. The one value it never knows is the private key, which
// GitHub shows once, to the Founder, and never to the agent.

import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildAppManifest, APP_NAME} from './private-ci-app-manifest.mjs';
import {AUTHORIZED_REPOSITORIES, ROLES} from './private-ci-app-installations.mjs';

export const ACCOUNTS = Object.freeze([
  {login: 'donraposo1-source', type: 'User', repository: 'donraposo1-source/project-wolf', purpose: 'private Factory (source, dispatch, checks)'},
  {login: 'insidethemarginmedia-cpu', type: 'User', repository: 'insidethemarginmedia-cpu/wolf-factory-home', purpose: 'public bridge (this repository)'},
]);

export const WIZARD_STEPS = Object.freeze([
  {id: 'create', title: 'Create the App'},
  {id: 'install', title: 'Install on both personal accounts'},
  {id: 'ids', title: 'Read the installation IDs'},
  {id: 'secrets', title: 'Store the four values'},
]);

const escapeHtml = value => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * The exact secret names to store, and — importantly — which of them will hold
 * the *same* value. A personal account cannot host three installations of one
 * App, so the three role secrets share one ID by design.
 */
export function secretInstructions() {
  return [
    {
      name: 'WOLF_FACTORY_APP_ID',
      where: 'App settings page, "App ID" field',
      note: 'Not a secret in the cryptographic sense, but never published either.',
    },
    {
      name: 'WOLF_FACTORY_APP_PRIVATE_KEY',
      where: 'The .pem GitHub downloads when the App is created',
      note: 'Paste the whole file including the BEGIN and END lines. This is the only value the agent must never see.',
    },
    {
      name: 'WOLF_FACTORY_READER_INSTALLATION_ID',
      where: 'The installation URL for the Factory account',
      note: 'Repeats the same ID as publisher and dispatcher, deliberately: one App, one installation per personal account.',
    },
    {
      name: 'WOLF_FACTORY_PUBLISHER_INSTALLATION_ID',
      where: 'The installation URL for the Factory account',
      note: 'Repeats the reader ID. This is expected, not a mistake.',
    },
    {
      name: 'WOLF_FACTORY_DISPATCHER_INSTALLATION_ID',
      where: 'The installation URL for the Factory account',
      note: 'Repeats the reader ID. This is expected, not a mistake.',
    },
  ];
}

export function buildWizardHtml({manifest = buildAppManifest()} = {}) {
  const manifestJson = escapeHtml(JSON.stringify(manifest, null, 2));
  const accounts = ACCOUNTS.map(account => `
      <tr>
        <td><code>${escapeHtml(account.login)}</code></td>
        <td>${escapeHtml(account.type)}</td>
        <td><code>${escapeHtml(account.repository)}</code></td>
        <td>${escapeHtml(account.purpose)}</td>
      </tr>`).join('');
  const secrets = secretInstructions().map(item => `
      <tr>
        <td><code>${escapeHtml(item.name)}</code></td>
        <td>${escapeHtml(item.where)}</td>
        <td>${escapeHtml(item.note)}</td>
      </tr>`).join('');
  const repositories = Object.keys(AUTHORIZED_REPOSITORIES).map(repo => `<li><code>${escapeHtml(repo)}</code></li>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(APP_NAME)} — activation</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.55 ui-sans-serif, system-ui, sans-serif; max-width: 62rem; margin: 2.5rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.6rem; margin-bottom: .25rem; }
  h2 { font-size: 1.15rem; margin-top: 2rem; border-bottom: 1px solid #8884; padding-bottom: .3rem; }
  table { border-collapse: collapse; width: 100%; margin: .75rem 0; }
  th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid #8883; vertical-align: top; }
  th { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; opacity: .7; }
  code { font-family: ui-monospace, monospace; font-size: .88em; }
  .warn { border-left: 3px solid #d29922; padding: .6rem .9rem; background: #d2992214; margin: 1rem 0; }
  .ok { border-left: 3px solid #2ea043; padding: .6rem .9rem; background: #2ea04314; margin: 1rem 0; }
  ol li, ul li { margin: .35rem 0; }
  pre { overflow-x: auto; background: #8881; padding: .8rem; font-size: .78rem; }
  .step { font-weight: 600; }
</style>
</head>
<body>
<h1>${escapeHtml(APP_NAME)} — activation</h1>
<p>Four steps, about five minutes. Everything below is either a link or a value you copy; nothing here needs judgement.</p>

<div class="warn">
<strong>Both accounts are personal accounts, not organizations.</strong>
So every link on this page is a personal-account link. The organization URLs used
earlier did not apply to either account.
</div>

<h2>What this creates</h2>
<table>
  <thead><tr><th>Account</th><th>Type</th><th>Repository</th><th>Role</th></tr></thead>
  <tbody>${accounts}</tbody>
</table>
<p>The App is installed once per account, restricted to these repositories:</p>
<ul>${repositories}</ul>
<p>Permissions requested: <code>contents: read</code>, <code>metadata: read</code>, <code>checks: write</code>, <code>actions: write</code>. Each token asks for only the subset its role needs.</p>

<div class="warn">
<strong>The App must be public.</strong> GitHub only allows a private App to be
installed on the account that owns it. Since this App must be installed on two
personal accounts, "Any account" is required. It is still restricted by
installation to the two repositories above, so being publicly installable does not
grant access to anything.
</div>

<h2><span class="step">Step 1</span> — Create the App</h2>
<ol>
  <li>Open <a href="https://github.com/settings/apps/new">https://github.com/settings/apps/new</a> while signed in as <code>insidethemarginmedia-cpu</code>.</li>
  <li>Fill the form from the manifest below. If you prefer, the form on
      <code>wolf-factory-automation.html</code> is pre-filled — but it must be submitted
      from that signed-in session, so check the account first.</li>
  <li>Under <strong>Where can this GitHub App be installed?</strong> choose <strong>Any account</strong>.</li>
  <li>Create it. GitHub then shows the <strong>App ID</strong> and downloads a <strong>.pem private key</strong>.</li>
</ol>
<pre>${manifestJson}</pre>

<h2><span class="step">Step 2</span> — Install on both accounts</h2>
<ol>
  <li>Install on <code>donraposo1-source</code>: <a href="https://github.com/apps/wolf-factory-automation/installations/new">https://github.com/apps/wolf-factory-automation/installations/new</a></li>
  <li>If the install page opens an existing installation instead of a chooser, use
      <a href="https://github.com/apps/wolf-factory-automation/installations/select_target">the account chooser</a>.</li>
  <li>Select <strong>Only select repositories</strong> → <code>project-wolf</code>. Never "All repositories".</li>
  <li>Repeat for <code>insidethemarginmedia-cpu</code>, selecting only <code>wolf-factory-home</code>.</li>
</ol>
<div class="warn">
"All repositories" on a personal account grants access to <em>every</em> repository
that account owns. The run reports such an installation as over-scoped and refuses it.
</div>

<h2><span class="step">Step 3</span> — Read the installation IDs</h2>
<p>Open <a href="https://github.com/settings/installations">https://github.com/settings/installations</a>
and look at each Configure link. The number at the end is the installation ID:</p>
<pre>https://github.com/settings/installations/&lt;INSTALLATION_ID&gt;</pre>
<p>You need the Factory ID. The Home ID is useful for the audit but is not required.</p>

<h2><span class="step">Step 4</span> — Store the values</h2>
<p>At <a href="https://github.com/insidethemarginmedia-cpu/wolf-factory-home/settings/secrets/actions">Settings → Secrets and variables → Actions</a>:</p>
<table>
  <thead><tr><th>Secret</th><th>Value</th><th>Note</th></tr></thead>
  <tbody>${secrets}</tbody>
</table>
<div class="ok">
<strong>Why the three installation IDs are equal.</strong> A GitHub App is installed
once per account. One App on two personal accounts is two installations, so the
three Factory roles share the Factory installation ID. The secrets have distinct
names because each role is independent; the value repeats because there is only
one installation to point at.
</div>

<h2>Then</h2>
<p>Reply that the App is installed. The next run mints App tokens, publishes the
private check through the App's own <code>checks:write</code> token — no status PAT
needed — dispatches the Home workflow, and reports:</p>
<pre>authentication.mode   = github-app
authRecovery.state    = VERIFIED
privateStatusCheck.state = PUBLISHED</pre>
<p>The PAT and deploy-key fallbacks stay in place until that run is green.</p>

<h2>If something goes wrong</h2>
<ul>
  <li><code>APP_INSTALLATION_NOT_FOUND</code> — the ID is from the other account.</li>
  <li><code>APP_GRANT_DIFFERS</code> — the App was created with different permissions; recheck Step 1.</li>
  <li><code>OVER_SCOPED</code> — the install used "All repositories"; reinstall with "Only select repositories".</li>
  <li><code>APP_JWT_REJECTED</code> — the key was truncated; re-paste the whole .pem including its BEGIN and END lines.</li>
</ul>
</body>
</html>
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2];
  const html = buildWizardHtml();
  if (out) {
    fs.mkdirSync(path.dirname(out), {recursive: true});
    fs.writeFileSync(out, html);
  } else {
    process.stdout.write(html);
  }
}

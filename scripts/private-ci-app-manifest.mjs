// Generates the GitHub App Manifest that creates "Wolf Factory Automation".
//
// The manifest is the only supported way to create an App *with a private key*:
// GitHub returns the key exactly once, at conversion time, to the browser session
// that submitted the manifest. No API in this environment can do it, which is why
// the Founder's click is unavoidable and why this file exists: the click carries
// the entire, already-minimal configuration.
//
// The permissions here are the union of the three roles, because one App holds one
// permission set. Least privilege is enforced per *token* at mint time instead:
// the reader token asks for contents:read only, the publisher for checks:write
// only, the dispatcher for actions:write only. See ROLE_PERMISSIONS.

const PERMISSIONS = Object.freeze({
  contents: 'read',
  metadata: 'read',
  checks: 'write',
  actions: 'write',
});

// The exact repositories the App may reach. Nothing else is requested, so a
// compromise of the App cannot touch an unrelated repository.
const REPOSITORIES = Object.freeze(['project-wolf', 'wolf-factory-home']);

export const APP_NAME = 'Wolf Factory Automation';
export const MANIFEST_ENDPOINTS = Object.freeze({
  personal: 'https://github.com/settings/apps/new',
  organization: 'https://github.com/organizations/{org}/settings/apps/new',
});

/**
 * Builds the manifest. `publicBase` is the public repository's raw URL: the App
 * posts its setup callback there, and a public URL is the only one GitHub can
 * reach without exposing private infrastructure.
 */
export function buildAppManifest({
  name = APP_NAME,
  publicBase = 'https://github.com/insidethemarginmedia-cpu/wolf-factory-home',
  redirectUrl,
  webhookUrl,
  repositories = REPOSITORIES,
} = {}) {
  if (!name || typeof name !== 'string') throw Error('MANIFEST_NAME_REQUIRED');
  const callback = redirectUrl ?? publicBase + '/actions';
  const manifest = {
    name,
    description: 'Least-privilege CI authentication for the Wolf Factory bridge.',
    url: publicBase,
    // No webhook is registered: the bridge is pull-based, and an unverified
    // endpoint would be an attack surface with no benefit.
    hook_attributes: hookUrl(webhookUrl),
    redirect_url: callback,
    // Deliberately public: the App itself is not private source, and a public
    // App listing makes the installation auditable.
    public: true,
    default_permissions: {...PERMISSIONS},
    default_events: [],
    request_oauth_on_install: false,
    setup_on_update: false,
  };
  // `repository_selection` is set by the installer, not the manifest; the two
  // repositories are named in the installation instructions instead.
  manifest.repositories_hint = [...repositories];
  return manifest;
}

const hookUrl = value => (value ? {url: value, active: false} : {active: false});

/**
 * A single self-contained HTML page that submits the manifest. It is inert until
 * the Founder opens it in a browser: the form posts to GitHub, GitHub redirects
 * back with a code, and the conversion is what yields the App ID and the key.
 */
export function buildManifestForm({manifest, organization = null, action = null} = {}) {
  const target = action ?? (organization
    ? MANIFEST_ENDPOINTS.organization.replace('{org}', organization)
    : MANIFEST_ENDPOINTS.personal);
  const payload = JSON.stringify(manifest, null, 2);
  const escaped = payload.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Create Wolf Factory Automation</title></head>
<body>
<h1>Create Wolf Factory Automation</h1>
<p>This form creates one GitHub App with the minimum permissions the bridge needs,
on the two repositories the bridge uses. Nothing is sent anywhere until you press
the button.</p>
<form method="post" action="${target}">
  <input type="hidden" name="manifest" value="${escaped}">
  <button type="submit">Create the App on GitHub</button>
</form>
<h2>The manifest, in full</h2>
<pre>${escaped}</pre>
</body>
</html>
`;
}

if (import.meta.url === 'file://' + process.argv[1]) {
  const org = process.argv.includes('--org')
    ? process.argv[process.argv.indexOf('--org') + 1]
    : null;
  const manifest = buildAppManifest();
  process.stdout.write(buildManifestForm({manifest, organization: org}));
}

// ---------------------------------------------------------------------------
// Pre-flight for a real installation.
//
// Run after the App exists and before the secrets are stored: it reads what the
// App actually was granted and refuses to proceed if it exceeds the minimum. A
// silently over-privileged App is the failure mode this exists to catch.
// ---------------------------------------------------------------------------

// The ceiling. Anything a real App grants outside this map is excess authority.
export const PERMISSION_CEILING = Object.freeze({
  contents: 'read',
  metadata: 'read',
  checks: 'write',
  actions: 'write',
  // Implied by installation tokens and unavoidable; not extra authority.
  administration: 'none',
  members: 'none',
});

const RANK = Object.freeze({none: 0, read: 1, write: 2});

/**
 * Compares granted permissions with the ceiling.
 * Returns `{state: 'WITHIN_MINIMUM' | 'EXCESS' | 'INSUFFICIENT', excess, missing}`.
 */
export function auditGrantedPermissions(granted = {}, ceiling = PERMISSION_CEILING) {
  const excess = [];
  const missing = [];
  for (const [name, level] of Object.entries(granted)) {
    const allowed = ceiling[name] ?? 'none';
    if ((RANK[level] ?? 99) > (RANK[allowed] ?? 0)) excess.push({permission: name, granted: level, allowed});
    if (level === 'write' && !['checks', 'actions'].includes(name)) excess.push({permission: name, granted: level, allowed: 'read-or-none'});
  }
  for (const name of ['contents', 'metadata']) {
    if ((RANK[granted[name]] ?? 0) < RANK.read) missing.push({permission: name, needed: 'read'});
  }
  const state = excess.length ? 'EXCESS' : missing.length ? 'INSUFFICIENT' : 'WITHIN_MINIMUM';
  return {state, excess, missing};
}

/**
 * Extracts the facts the bridge needs from a converted manifest.
 * The private key is returned separately and never placed in the summary.
 */
export function readConversion(payload = {}) {
  const {pem, id, slug, owner, permissions, events, html_url: htmlUrl} = payload;
  const summary = {
    state: 'CONVERTED',
    appId: id ?? null,
    slug: slug ?? null,
    owner: owner?.login ?? null,
    htmlUrl: htmlUrl ?? null,
    permissions: permissions ?? {},
    events: Array.isArray(events) ? events.length : null,
    hasPrivateKey: typeof pem === 'string' && pem.length > 0,
    credentialsPrinted: false,
  };
  const audit = auditGrantedPermissions(summary.permissions);
  return {summary: {...summary, audit: audit.state, excess: audit.excess, missing: audit.missing}, privateKey: typeof pem === 'string' && pem.length > 0 ? pem : null};
}

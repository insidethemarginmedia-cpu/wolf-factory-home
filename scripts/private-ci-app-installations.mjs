// Installation mapping for Wolf Factory Automation.
//
// The App is installed on two *personal* accounts, one repository each:
//   donraposo1-source/project-wolf        (private Factory)
//   insidethemarginmedia-cpu/wolf-factory-home (public bridge)
//
// Because a personal account has no organization-level installation, there is
// one installation per account and therefore one installation per repository.
// Two consequences drive this module:
//
//   1. Installation IDs must be *reused* across roles. Insisting on three
//      distinct IDs would demand an installation that does not exist.
//   2. An installation is only acceptable when it was created with "Only select
//      repositories". An "all repositories" install on a personal account grants
//      every repository that account owns, which is exactly what least privilege
//      forbids.

export const AUTHORIZED_REPOSITORIES = Object.freeze({
  'donraposo1-source/project-wolf': {purpose: 'private-factory', visibility: 'private'},
  'insidethemarginmedia-cpu/wolf-factory-home': {purpose: 'public-bridge', visibility: 'public'},
});

export const ROLES = Object.freeze(['reader', 'publisher', 'dispatcher']);

// Which installation each role must use. The reader and dispatcher act on the
// private Factory; the publisher writes checks on the same private commit, so all
// three share the Factory installation. The Home installation exists so the same
// App identity can be audited on both accounts, not because a role needs it.
export const ROLE_TARGET_REPOSITORY = Object.freeze({
  reader: 'donraposo1-source/project-wolf',
  publisher: 'donraposo1-source/project-wolf',
  dispatcher: 'donraposo1-source/project-wolf',
  home: 'insidethemarginmedia-cpu/wolf-factory-home',
});

export const INSTALL_MAP_STATES = Object.freeze({
  MAPPED: 'MAPPED',
  INCOMPLETE: 'INCOMPLETE',
  OVER_SCOPED: 'OVER_SCOPED',
  UNAUTHORIZED: 'UNAUTHORIZED',
});

/**
 * Maps real installation payloads to the secret each role needs.
 *
 * `installations` is the array from `GET /user/installations` (or
 * `GET /app/installations` with an App JWT) — only the fields below are read:
 *   {id, account: {login, type}, repository_selection, repositories?}
 *
 * Returns presence and identity metadata only. No token, key or secret value ever
 * enters the result, so it is safe to publish.
 */
export function mapInstallations(installations = [], {requiredRepository = AUTHORIZED_REPOSITORIES} = {}) {
  const byAccount = new Map();
  const unauthorized = [];
  const overScoped = [];

  for (const installation of Array.isArray(installations) ? installations : []) {
    const owner = installation?.account?.login;
    const id = Number(installation?.id);
    if (!owner || !Number.isSafeInteger(id) || id <= 0) continue;

    // A repository named in `repositories` must be one we authorised. An install
    // that reaches an unrelated repository is reported, never silently used.
    const listed = Array.isArray(installation.repositories)
      ? installation.repositories.map(repo => `${owner}/${repo.name ?? repo}`)
      : [];
    const outside = listed.filter(full => !Object.hasOwn(requiredRepository, full));
    if (outside.length) unauthorized.push({account: owner, installationId: id, repositories: outside});

    // "all" on a personal account means every repository the user owns.
    if (installation.repository_selection === 'all') {
      overScoped.push({account: owner, installationId: id, reason: 'REPOSITORY_SELECTION_ALL'});
    }

    // One installation per account: keep the first, prefer a `selected` one.
    const existing = byAccount.get(owner);
    if (!existing || (existing.repository_selection !== 'selected' && installation.repository_selection === 'selected')) {
      byAccount.set(owner, {id, account: owner, type: installation.account?.type ?? null, repository_selection: installation.repository_selection ?? null, repositories: listed});
    }
  }

  // Resolve each role to the installation that owns its repository.
  const roles = {};
  const missing = [];
  for (const role of ROLES) {
    const repository = ROLE_TARGET_REPOSITORY[role];
    const owner = repository.split('/')[0];
    const installation = byAccount.get(owner);
    if (!installation) {
      missing.push({role, repository, reason: 'NO_INSTALLATION_FOR_ACCOUNT', account: owner});
      continue;
    }
    // When the installation lists its repositories, the target must be among them.
    if (installation.repositories.length && !installation.repositories.includes(repository)) {
      missing.push({role, repository, reason: 'REPOSITORY_NOT_IN_INSTALLATION', account: owner});
      continue;
    }
    roles[role] = {installationId: String(installation.id), account: owner, repository, repositorySelection: installation.repository_selection};
  }

  const home = (() => {
    const owner = ROLE_TARGET_REPOSITORY.home.split('/')[0];
    const installation = byAccount.get(owner);
    if (!installation) return {state: 'MISSING', account: owner, repository: ROLE_TARGET_REPOSITORY.home};
    return {state: 'PRESENT', account: owner, installationId: String(installation.id), repository: ROLE_TARGET_REPOSITORY.home, repositorySelection: installation.repository_selection};
  })();

  const distinctIds = new Set(Object.values(roles).map(entry => entry.installationId));
  const missingIds = ROLES.length - Object.keys(roles).length;

  const state = unauthorized.length
    ? INSTALL_MAP_STATES.UNAUTHORIZED
    : overScoped.length
      ? INSTALL_MAP_STATES.OVER_SCOPED
      : missing.length || home.state === 'MISSING'
        ? INSTALL_MAP_STATES.INCOMPLETE
        : INSTALL_MAP_STATES.MAPPED;

  return {
    state,
    roles,
    home,
    accounts: [...byAccount.values()].map(entry => ({account: entry.account, type: entry.type, installationId: String(entry.id), repositorySelection: entry.repository_selection})),
    // Reported so an operator can see that reuse is intended, not an oversight.
    distinctInstallations: distinctIds.size,
    reusedAcrossRoles: ROLES.length - distinctIds.size,
    missing,
    unauthorized,
    overScoped,
    // The secrets to store: one per *distinct* installation, not one per role.
    secrets: buildSecretPlan(roles),
    credentialsPrinted: false,
  };
}

/**
 * Emits the secret assignments for a mapped result.
 *
 * Roles sharing an installation share an ID. Each role keeps its own secret name
 * so the workflow never has to guess, but the values repeat deliberately — a
 * personal account cannot host three installations of one App.
 */
export function buildSecretPlan(roles = {}) {
  const plan = {};
  for (const role of ROLES) {
    const entry = roles[role];
    if (!entry) continue;
    plan[`WOLF_FACTORY_${role.toUpperCase()}_INSTALLATION_ID`] = {value: entry.installationId, account: entry.account, shared: null};
  }
  // Mark the shared ones after the fact, so the intent is visible.
  const counts = new Map();
  for (const [key, entry] of Object.entries(plan)) counts.set(entry.value, (counts.get(entry.value) ?? 0) + 1);
  for (const [key, entry] of Object.entries(plan)) {
    if (counts.get(entry.value) > 1) {
      plan[key] = {...entry, shared: 'reused-across-roles-for-this-account'};
    }
  }
  return plan;
}

/**
 * A single App cannot be private and installed on two personal accounts.
 * GitHub allows a private App to be installed only on its owning account, so
 * multi-account use requires a public App. This is a hard requirement, not a
 * preference, and it is asserted here so no later change quietly breaks it.
 */
export function assertInstallableAcrossAccounts(manifest = {}) {
  if (manifest.public !== true) {
    throw Error('APP_MUST_BE_PUBLIC_FOR_MULTI_ACCOUNT_INSTALL');
  }
  return true;
}

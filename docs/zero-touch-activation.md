# Zero Touch Activation — Wolf Factory Automation

Status: **PREPARED FOR TWO PERSONAL ACCOUNTS AND PROVEN UP TO THE ONE UNAVOIDABLE FOUNDER CLICK.**

This page is public and contains no credential, key, token or private source. It
records what can be done without a human, what genuinely cannot, and exactly what
that click must accomplish.

## 1. Why a click is unavoidable

A GitHub App's private key is returned **exactly once**, to the browser session
that converts the App Manifest. There is no REST endpoint that creates an App and
none that returns an existing App's key.

Verified working from this environment, so the boundary is real and not assumed:

| Attempt | Result | Meaning |
| --- | --- | --- |
| `GET /app` | `401` | No App identity is available here |
| `POST /app/installations/<id>/access_tokens` | `401` *JWT could not be decoded* | No private key exists, so no installation token can be minted |
| `POST /app-manifests/<code>/conversions` | `404` | Requires a one-time code only a GitHub form submission produces |
| `PUT /repos/…/actions/secrets/…` | `403` | The App token cannot store secrets |
| `PUT /repos/…/actions/variables/…` | `404` | The App token cannot store variables |
| `POST /repos/…/actions/workflows/<id>/dispatches` | `403` | No `actions: write` |
| No GitHub MCP connector | `unsupported` | The MCP route does not exist |

The only App already installed is **Arena's own** (`app_id 4187077`), on
`donraposo1-source` (all repositories) and `insidethemarginmedia-cpu`
(`wolf-factory-home` only). It belongs to Arena, not to Wolf, and cannot be
re-keyed or delegated. It is **not** used.

## 1a. Both accounts are personal accounts

`GET /users/<login>` returns `type=User` for **both** `donraposo1-source` and
`insidethemarginmedia-cpu`. Neither is an organization, so:

- the wizard and the manifest form target `https://github.com/settings/apps/new`,
  **not** `https://github.com/organizations/<owner>/settings/apps/new` — the
  organization form used earlier applied to neither account;
- the App **must be public**. GitHub permits a private App to be installed only on
  the account that owns it, so a private App on two personal accounts silently
  yields a single installation. `assertInstallableAcrossAccounts` refuses that
  configuration rather than letting it fail at install time.

### One installation per account, reused across roles

A GitHub App is installed **once per account**, so two personal accounts mean
**two installations**, not three. The three Factory roles therefore share the
Factory installation ID:

| Role | Repository | Installation |
| --- | --- | --- |
| reader | `donraposo1-source/project-wolf` | the Factory account's installation |
| publisher | `donraposo1-source/project-wolf` | the same installation |
| dispatcher | `donraposo1-source/project-wolf` | the same installation |

The secrets keep distinct names — `WOLF_FACTORY_{READER,PUBLISHER,DISPATCHER}_INSTALLATION_ID`
— and the mapper marks the repetition `reused-across-roles-for-this-account`, so
an auditor sees intent rather than a suspected copy-paste error. Role separation
is preserved at the level that matters: each role still requests its own
permission subset and receives its own token.

## 2. What the click creates

`docs/app-activation/wolf-factory-automation.html` is a self-contained form. It
posts this manifest to GitHub:

| Field | Value | Why |
| --- | --- | --- |
| `default_permissions` | `contents: read`, `metadata: read`, `checks: write`, `actions: write` | The union of three roles; each token asks for one subset |
| `default_events` | empty | The bridge is pull-based |
| `hook_attributes` | inactive, no URL | An unverified webhook is attack surface with no benefit |
| `repositories_hint` | `project-wolf`, `wolf-factory-home` | Nothing else may be reachable |

Least privilege is enforced per **token**, not per App:

| Role | Token requests | Cannot |
| --- | --- | --- |
| reader | `contents: read` | write anything, read checks, dispatch |
| publisher | `checks: write` | read source, dispatch, write contents |
| dispatcher | `actions: write` | read source, publish checks |

`assertLeastPrivilege` refuses a role/request mismatch **before** any HTTP call is
made, and `mintInstallationToken` rejects a token whose *granted* permissions
differ from the request (`APP_GRANT_DIFFERS`). An over-privileged install is
rejected by pre-flight before its key is ever stored.

## 3. The five steps

Full detail: `docs/app-activation/founder-steps.json`. Pre-flight:
`node scripts/private-ci-app-preflight.mjs plan`.

1. Open `https://github.com/settings/apps/new` while signed in as
   `insidethemarginmedia-cpu`, and submit the generated manifest with
   **Any account** selected. One-click version: `docs/app-activation/activate.html`.
2. Install on both accounts with **Only select repositories** →
   `project-wolf`, `wolf-factory-home`. Never "All repositories" — on a personal
   account that grants every repository the account owns.
3. Read the installation IDs from `/settings/installations/<id>`. The three role
   secrets take the **same** Factory value; that is correct, not a shortcut.
4. Store `WOLF_FACTORY_APP_ID`, `WOLF_FACTORY_APP_PRIVATE_KEY`,
   `WOLF_FACTORY_{READER,PUBLISHER,DISPATCHER}_INSTALLATION_ID`.
5. Say the App is installed. The next run mints App tokens and reports
   `authentication.mode = github-app`.

Optional, for private check publication: `WOLF_FACTORY_STATUS_TOKEN` with
`checks: write` on `project-wolf`. Without it the check stays `BLOCKED`, honestly.

## 4. A defect that mattered

`verify` used to compare a field that does not exist, so its condition was always
false and it reported **VERIFIED while the PAT was doing the work**. A false green
on authentication is worse than no verification, because it removes the signal
that would prompt a fix. It now returns:

- `VERIFIED` — the App issued two distinct tokens per role, both `FRESH`;
- `NOT_APPLICABLE` — the App is absent and the PAT is working (exit 78);
- `FAILED` — the App is present but renewal did not produce a fresh token (exit 1).

A test pins the false-green path specifically.

## 5. Recovery ladder

| Situation | State | Response |
| --- | --- | --- |
| More than 5 minutes of life left | `FRESH` | Use the token |
| Inside the 5-minute margin | `RENEW` | Re-mint once |
| Past expiry | `EXPIRED` | Re-mint once |
| `401` from the API | `REVOKED` | Re-mint once, then fail honestly |
| `403` | `NONE` | Do not re-mint: a new token cannot fix a permission gap |
| `5xx` | `NONE` | Transient; retried, never treated as a credential problem |

Recovery is bounded by design. A revoked installation that cannot be reissued
returns `REVOKED_AND_NOT_REISSUABLE` instead of looping.

## 6. Live state

Accepting run `45499156358` on `162938b`: `state: VERIFIED`, 13/13 checks, private
receipt `PUBLISHED`.

| Field | Value |
| --- | --- |
| `authentication.mode` | `pat-fallback` |
| `authRecovery.state` | `NOT_APPLICABLE` / `APP_AUTH_INCOMPLETE` |
| `authRecovery.roles` | reader `pat-fallback`, publisher `none`, dispatcher `pat-fallback` |
| `dispatchVerification.state` | `BLOCKED` / `WORKFLOW_LIST_UNAVAILABLE` |
| `privateStatusCheck.state` | `BLOCKED` / `PRIVATE_STATUS_TOKEN_REQUIRED` |
| `credentialsPrinted` | `false` |
| `privateLogsPublished` / `privateSourcePublished` | `false` / `false` |
| `inferencePerformed` / `refUpdated` | `false` / `false` |

The publisher has **no** credential and is not standing in for the reader — the
roles are genuinely separate, and that absence is reported rather than papered
over with the PAT.

The PAT's scope was not broadened to make any of these look green. Fallbacks stay
until a run reports `authentication.mode = github-app` **and** the thirteen checks
pass on App tokens.

## 6a. The STATUS PAT is no longer required

The publisher token used to be referenced but **never minted**, so even an
installed App could not publish a private check — the `WOLF_FACTORY_STATUS_TOKEN`
PAT did all the work and the App path was never exercised. The publish step now
mints `WOLF_CI_APP_PUBLISHER_TOKEN` from the App installation, and the check is
published with that `checks:write` identity.

This removes the second Founder secret rather than widening anything:

| Status-write identity | Required |
| --- | --- |
| App publisher token (`checks:write`, installation-scoped) | preferred — no PAT |
| `WOLF_FACTORY_STATUS_TOKEN` | fallback until the App is live |

Identity separation is preserved: the reader's `contents:read` PAT is still
refused as a status writer (`STATUS_TOKEN_MUST_DIFFER_FROM_SOURCE_TOKEN`), and the
receipt records `statusIdentity` as `app-installation` or `status-pat` so the two
can never be confused.

## 7. Cost

`EUR_SPEND=0`. No paid endpoint was reachable or used; the manifest flow, the
audits and the recovery ladder are local computation. `registry.npmjs.org` was not
needed — every dependency is standard library.

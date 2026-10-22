# wolf-factory-home

Bounded public runner for the existing private Factory. The application source, database snapshots, provider responses and private test logs remain outside this repository.

The observed Node/PostgreSQL runtime proof is recorded in docs/checkpoints/WOLF-20261022-PUBLIC-RUNTIME.json. The original probe is manual-only so integration commits do not repeat it.

## Private-controller preflight

Changes to the preflight workflow, script or tests on feat/public-runtime-probe-20261022 trigger:
1. Credential-free negative security tests.
2. A read-only service-access check, restricted to this repository, branch and owner actor.

No pull-request or fork trigger receives service credentials. Checkout credentials are not persisted. Missing configuration stops with exit 78 before network access. Success verifies metadata only: it does not fetch private code, invoke AI, run missions, publish code or prove durable recovery.

Required Actions repository secrets:
- OPENROUTER_API_KEY: inference-only service key with USD spending limit zero, no management privileges.
- WOLF_FACTORY_REPO_TOKEN: short-lived GitHub App installation token, or an owner-issued fine-grained service token restricted to the private application repository. Contents: read and implicit metadata read suffice for this preflight. Contents: write is additionally needed only for later approved-branch publication and private backup persistence. No Actions, Workflows, Administration or Secrets permissions are needed.

Provision through GitHub Settings → Secrets and variables → Actions → New repository secret:
https://github.com/insidethemarginmedia-cpu/wolf-factory-home/settings/secrets/actions

Existing GitHub secrets cannot be retrieved or automatically shared by changing repository visibility. Never put credential values in issues, commits, workflow inputs, logs or public artifacts. After authorized provisioning, rerun the failed service-access job on the reviewed commit.

The source branch and repository are fixed inside the preflight. Source hashes and remote error bodies are not printed. The observed live result must still be checked; tests using fixture responses do not prove authenticated access.

This is bounded push-driven execution. Continuous operation, real missions and cross-job database recovery are not yet verified.

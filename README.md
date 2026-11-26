# wolf-factory-home

Bounded public runner for the existing private Factory. Application source, database snapshots, provider responses and private test logs remain outside this repository.

The historical public-runtime proof is archived in `docs/checkpoints/WOLF-20261022-PUBLIC-RUNTIME.json`; it is not current private-worker or mission acceptance evidence.

## Current integration status: blocked / not activated

The private mission listener and reusable bridge are present only in the open engineering PR, not on the default branch. The configured executor SHA does not resolve in this repository. The authoritative Factory/Compute request and callback contract, durable execution/recovery owner, and required approvals are still unresolved.

No mission was dispatched, no private worker or authenticated callback ran, and no production write or paid inference occurred. `EUR_SPEND=0`. Tests, public canaries, old receipts, HTTP success responses and green runs do not establish private-worker acceptance.

The current, non-executable contract and blockers are in [`docs/integration-contract.md`](docs/integration-contract.md). Do not dispatch or activate the bridge from this repository while those blockers remain.

## Withdrawn credential and App setup guidance

Earlier README and `docs/app-activation/` instructions proposed creating/installing a new GitHub App and adding repository secrets. Those instructions are withdrawn. They are not authorization to create duplicate infrastructure, install an App, change repository settings, add or rotate secrets, or dispatch a mission. The static pages now state this explicitly and contain no setup form.

Do not paste credentials into chat, issues, commits, workflow inputs, logs, or public artifacts. Existing secret values stay in GitHub and cannot be retrieved by this agent; no credential value is requested here. Any future credential or infrastructure change requires an approved owner and a reviewed contract first.

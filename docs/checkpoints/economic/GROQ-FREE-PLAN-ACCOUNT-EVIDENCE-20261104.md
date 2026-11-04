# Project Wolf — Groq Free Plan | Account Economic Evidence

Checkpoint date: 2026-11-04 (Europe/Lisbon)
Evidence source: founder-supplied Groq Console billing screenshot and account-specific limits text in ChatGPT.
Classification: account economic eligibility evidence, not a live remaining-quota check.

## Verified account evidence

- Groq Console context shown: Personal / Default Project; account profile shown as Inside The Margin.
- Settings > Billing > Plans: **Free**, **$0**, marked **Current Plan**.
- Settings > Limits > Chat Completions: **openai/gpt-oss-120b** with current displayed organization limits:
  - **RPM 30** (requests per minute)
  - **RPD 1,000** (requests per day)
  - **TPM 8,000** (tokens per minute)
  - **TPD 200,000** (tokens per day)
- The supplied Groq Rate Limits documentation says rate limits apply at organization level and exhausted limits return HTTP 429.
- Official documentation: https://console.groq.com/docs/rate-limits
- Account billing page: https://console.groq.com/settings/billing

## Required Project Wolf economic policy

```text
EUR_SPEND=0
COST_UNKNOWN=DENY
PAID_FALLBACK=DENY
TRIAL_CREDIT=DENY
```

## Admission boundary and next action

- **Evidence accepted:** The owner's screenshots establish that the selected account's current plan is Free ($0) and that GPT-OSS 120B has the limits shown above. Do not repeat basic plan qualification unless the plan changes.
- **Not established by this checkpoint:** the remaining real-time allowance, API credential validity, separate billing settings, or permission to execute a mission.
- **Runtime control:** verify provider authorization and current safe capacity using the existing authorized Groq adapter. Respect rate-limit 429 and retry/reset information; preserve bounded/idempotent DBOS/KCT workflow and do not replay UNKNOWN external effects.
- **No automatic mission admission:** this checkpoint documents evidence only. It does not create another Factory, worker, controller, workflow, scheduler, or cost exposure.

Security: No API key, payment data or private screenshots are included in this public-repository checkpoint.

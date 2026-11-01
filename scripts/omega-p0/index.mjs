/*
 * Wolf Omega P0 -- pre-effect boundary library, public barrel.
 *
 * This is NOT a Factory, control plane, scheduler, database or publication owner.
 * It exports pure guards intended to be wired into the EXISTING Project Wolf
 * Factory at these exact boundaries:
 *
 *   1. Omega B/C adapter, immediately before `POST /api/runs`:
 *        const gate = createPreEffectGate(existingAuthorityPorts, existingPolicy);
 *        const dispatch = withPreEffectAdmission(existingAdapter.dispatch, gate);
 *   2. Worker result boundary: verifyWorkerCompletion / evaluatePollingOutcome
 *      replace every `COMPLETED` derived from a poll loop, mock, exit code or id.
 *   3. Worker routing/fallback: assertWorkerAllowed / chooseWorker (Jules denied).
 *   4. CEZAR/Composio skill loading: loadSkill / discoverSkills.
 *   5. Qwen Code / offline npm install: installOfflineTool / verifyResumableChunks.
 *   6. Runner-loss recovery: admitRecovery / consumeNextReady / recordPublication /
 *      classifyExternalWindow / reconcileUnknownEffect.
 *
 * `existingAuthorityPorts` MUST be adapters over the EXISTING KCT/DBOS authority
 * and immutable ledger. No second authority system is defined here. All reads are
 * fail closed. No function in this barrel opens a network connection, writes
 * authority state, dispatches a mission, publishes code or claims completion.
 */
export * from './policy.mjs';
export * from './pre-effect-admission.mjs';
export * from './worker-evidence.mjs';
export * from './skill-loader.mjs';
export * from './offline-install.mjs';
export * from './recovery.mjs';

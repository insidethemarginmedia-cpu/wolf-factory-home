/*
 * FALSIFICATION FIXTURE -- NOT private Factory source.
 *
 * This is a deliberately faithful, minimal RECONSTRUCTION of the reported PR #701
 * failure class (the actual private source cannot be read from this environment):
 *   - the adapter trusts caller-supplied fence / economic declarations;
 *   - it reaches `POST /api/runs` with those declarations;
 *   - it reports COMPLETED from a finished poll loop, a mock response, an exit
 *     status or a generated remote session identifier.
 *
 * It exists only so the defect can be reproduced offline and so the hardened gate
 * can be proved necessary. It is never imported by production code.
 */
export const LEGACY_ENDPOINT = 'https://factory.internal.invalid/api/runs';

export function createLegacyDispatchAdapter({fetchImpl, endpoint = LEGACY_ENDPOINT} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('LEGACY_FIXTURE_FETCH_REQUIRED');
  let httpCalls = 0;
  return {
    get httpCalls() { return httpCalls; },
    async dispatch(request) {
      httpCalls += 1;
      const body = JSON.stringify({
        missionId: request.missionId,
        attemptId: request.attemptId,
        // Caller-supplied declarations are forwarded as if they were authority.
        fence: request.fence ?? request.declaredFence ?? 'caller-supplied',
        economicAuthorized: request.economicAuthorized ?? true,
        economicReceipt: request.economicReceipt ?? 'caller-supplied',
        model: request.model,
        body: request.body,
      });
      const response = await fetchImpl(endpoint, {
        method: 'POST', headers: {'content-type': 'application/json'}, body,
      });
      return {
        // Fabricated completion: generated session id + mock response.
        state: 'COMPLETED',
        sessionId: 'remote-session-' + String(httpCalls),
        mockResponse: response,
        httpCalls,
      };
    },
    async pollUntilComplete() {
      return {state: 'COMPLETED', reason: 'POLL_LOOP_FINISHED', sessionId: 'remote-session-generated'};
    },
  };
}

/** The "gate" a vulnerable adapter effectively used: trust everything. */
export const legacyTrustGuard = Object.freeze(async function legacyTrustGuard(request) {
  return {
    state: 'ADMITTED',
    reason: 'CALLER_DECLARATIONS_TRUSTED',
    admission: Object.freeze({
      schema: 'LegacyCallerDeclaration/v0',
      bindingDigest: 'caller-supplied',
      missionId: request.missionId,
      attemptId: request.attemptId,
      executionKey: request.executionKey,
      idempotencyKey: request.idempotencyKey,
      workflowId: request.workflowId,
      workerId: request.workerId,
      workerType: request.workerType,
      workerEndpoint: request.workerEndpoint,
      provider: request.provider,
      account: request.account,
      model: request.model,
      endpoint: request.endpoint,
      method: request.method,
      path: request.path,
      body: request.body,
      requestDigest: 'caller-supplied',
    }),
  };
});

export function mockFetchFactory() {
  let calls = 0;
  const callsMade = [];
  return {
    get calls() { return calls; },
    get callsMade() { return callsMade; },
    async fetch(url, init) {
      calls += 1;
      callsMade.push({url, init});
      return {ok: true, status: 200, mock: true};
    },
  };
}

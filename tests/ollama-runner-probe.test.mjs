import test from 'node:test';
import assert from 'node:assert/strict';
import {probeOllama} from '../scripts/ollama-runner-probe.mjs';

const env = {WOLF_OLLAMA_PROBE_ENABLED: '1', WOLF_OLLAMA_ZERO_COST_VERIFIED: '1',
  WOLF_OLLAMA_PROBE_MODEL: 'qwen2.5-coder:0.5b'};
const receipt = {model: env.WOLF_OLLAMA_PROBE_MODEL, done: true,
  response: 'WOLF_OLLAMA_PROBE_OK', eval_count: 9};
const fakeFetch = async (_url, _options) => new Response(JSON.stringify(receipt),
  {status: 200, headers: {'content-type': 'application/json'}});

test('disabled by default: no network request', async () => {
  let calls = 0;
  await assert.rejects(probeOllama({env: {}, fetchImpl: async () => {calls++;}}),
    /OLLAMA_PROBE_OPT_IN_REQUIRED/);
  assert.equal(calls, 0);
});
test('zero-cost gate is mandatory', async () => {
  await assert.rejects(probeOllama({env: {...env, WOLF_OLLAMA_ZERO_COST_VERIFIED: '0'}, fetchImpl: fakeFetch}),
    /ZERO_COST_ADMISSION_REQUIRED/);
});
test('unknown model is denied', async () => {
  await assert.rejects(probeOllama({env: {...env, WOLF_OLLAMA_PROBE_MODEL: 'llama3:70b'}, fetchImpl: fakeFetch}),
    /OLLAMA_MODEL_NOT_ALLOWED/);
});
test('unreviewed 3b model is denied before network access', async () => {
  let calls = 0;
  await assert.rejects(probeOllama({env: {...env, WOLF_OLLAMA_PROBE_MODEL: 'qwen2.5-coder:3b'},
    fetchImpl: async () => {calls++; throw new Error('NETWORK_MUST_NOT_BE_CALLED');}}),
  /OLLAMA_MODEL_NOT_ALLOWED/);
  assert.equal(calls, 0);
});
test('reviewed 1.5b model remains eligible for synthetic validation', async () => {
  const model = 'qwen2.5-coder:1.5b';
  const result = await probeOllama({env: {...env, WOLF_OLLAMA_PROBE_MODEL: model},
    fetchImpl: async () => new Response(JSON.stringify({...receipt, model}))});
  assert.equal(result.model, model);
  assert.equal(result.markerMatched, true);
  assert.equal(result.privateFactoryIntegrated, false);
});
test('remote and credential-bearing endpoints are denied', async () => {
  for (const endpoint of ['https://127.0.0.1:11434', 'http://example.org:11434',
    'http://127.0.0.1:11434/other', 'http://user:pass@127.0.0.1:11434']) {
    await assert.rejects(probeOllama({env: {...env, WOLF_OLLAMA_PROBE_ENDPOINT: endpoint}, fetchImpl: fakeFetch}),
      /OLLAMA_LOOPBACK_ONLY/);
  }
});
test('synthetic receipt is parsed but does not claim Factory integration', async () => {
  let request;
  const result = await probeOllama({env, fetchImpl: async (url, options) => {
    request = {url, options}; return fakeFetch(url, options);
  }});
  assert.equal(request.url, 'http://127.0.0.1:11434/api/generate');
  assert.equal(request.options.redirect, 'error');
  assert.equal(JSON.parse(request.options.body).stream, false);
  assert.equal(result.state, 'OLLAMA_API_RESPONSE_VALIDATED');
  assert.equal(result.markerMatched, true);
  assert.equal(result.privateFactoryIntegrated, false);
  assert.equal(result.durableMissionVerified, false);
});
test('malformed or incomplete receipt is denied', async () => {
  for (const invalid of [{...receipt, done: false}, {...receipt, model: 'other'}, {...receipt, response: ''}]) {
    await assert.rejects(probeOllama({env, fetchImpl: async () => new Response(JSON.stringify(invalid))}),
      /OLLAMA_RECEIPT_INVALID/);
  }
});
test('oversized response fails closed', async () => {
  await assert.rejects(probeOllama({env, fetchImpl: async () => new Response('x'.repeat(16385))}),
    /OLLAMA_RESPONSE_TOO_LARGE/);
});
test('HTTP failure is not inference', async () => {
  await assert.rejects(probeOllama({env, fetchImpl: async () => new Response('', {status: 503})}),
    /OLLAMA_HTTP_503/);
});

test('nonempty Ollama error field fails closed despite valid-looking receipt', async () => {
  for (const error of ['model not found', '  ', {code: 500}, true]) {
    await assert.rejects(probeOllama({env, fetchImpl: async () => new Response(JSON.stringify({...receipt, error}))}),
      /OLLAMA_RECEIPT_ERROR/);
  }
});
test('wrong marker cannot produce a validated state', async () => {
  await assert.rejects(probeOllama({env, fetchImpl: async () => new Response(JSON.stringify({...receipt, response: 'WRONG'}))}),
    /OLLAMA_MARKER_MISMATCH/);
});

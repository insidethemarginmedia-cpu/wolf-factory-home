import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, copyFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {probeOllama as probeOllamaUnreviewed} from '../scripts/ollama-runner-probe.mjs';

// Tests exercise exact source pins without fictitious APPROVED fixtures.
import {probeOllama, requireApprovedModelDigest} from '../scripts/ollama-runner-probe.mjs';
import {OLLAMA_CANDIDATE_PINS, requireCandidatePinBinding} from '../scripts/ollama-candidate-pins.mjs';

const env = {WOLF_OLLAMA_PROBE_ENABLED: '1', WOLF_OLLAMA_ZERO_COST_VERIFIED: '1',
  WOLF_OLLAMA_PROBE_MODEL: 'qwen2.5-coder:0.5b',
  OLLAMA_IMAGE_SHA256: OLLAMA_CANDIDATE_PINS.imageLinuxAmd64,
  OLLAMA_MODEL_SHA256: OLLAMA_CANDIDATE_PINS.modelManifest};
const receipt = {model: env.WOLF_OLLAMA_PROBE_MODEL, done: true,
  response: 'WOLF_OLLAMA_PROBE_OK', eval_count: 9};
const tagsReceipt = {models: [{name: env.WOLF_OLLAMA_PROBE_MODEL,
  digest: OLLAMA_CANDIDATE_PINS.modelManifest}]};
const fakeFetch = async (url, _options) => new Response(JSON.stringify(
  url.endsWith('/api/tags') ? tagsReceipt : receipt),
  {status: 200, headers: {'content-type': 'application/json'}});
const withGenerate = generate => async (url, options) =>
  url.endsWith('/api/tags') ? fakeFetch(url, options) : generate(url, options);

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
test('1.5b remains blocked without a pinned reviewed digest', async () => {
  let calls = 0;
  await assert.rejects(probeOllama({env: {...env, WOLF_OLLAMA_PROBE_MODEL: 'qwen2.5-coder:1.5b'},
    fetchImpl: async () => {calls++;}}), /OLLAMA_MODEL_DIGEST_NOT_REVIEWED/);
  assert.equal(calls, 0);
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
    if (url.endsWith('/api/generate')) request = {url, options}; return fakeFetch(url, options);
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
    await assert.rejects(probeOllama({env, fetchImpl: withGenerate(async () => new Response(JSON.stringify(invalid)))}),
      /OLLAMA_RECEIPT_INVALID/);
  }
});
test('oversized response fails closed', async () => {
  await assert.rejects(probeOllama({env, fetchImpl: withGenerate(async () => new Response('x'.repeat(16385)))}),
    /OLLAMA_RESPONSE_TOO_LARGE/);
});
test('HTTP failure is not inference', async () => {
  await assert.rejects(probeOllama({env, fetchImpl: withGenerate(async () => new Response('', {status: 503}))}),
    /OLLAMA_HTTP_503/);
});

test('nonempty Ollama error field fails closed despite valid-looking receipt', async () => {
  for (const error of ['model not found', '  ', {code: 500}, true]) {
    await assert.rejects(probeOllama({env, fetchImpl: withGenerate(async () => new Response(JSON.stringify({...receipt, error})))}),
      /OLLAMA_RECEIPT_ERROR/);
  }
});
test('wrong marker cannot produce a validated state', async () => {
  await assert.rejects(probeOllama({env, fetchImpl: withGenerate(async () => new Response(JSON.stringify({...receipt, response: 'WRONG'})))}),
    /OLLAMA_MARKER_MISMATCH/);
});

test('post-pull digest must equal independently approved immutable digest', () => {
  const approved = 'a'.repeat(64);
  assert.equal(requireApprovedModelDigest({expected: approved, observed: approved}), approved);
  assert.throws(() => requireApprovedModelDigest({expected: '', observed: approved}),
    /OLLAMA_APPROVED_MODEL_DIGEST_REQUIRED/);
  assert.throws(() => requireApprovedModelDigest({expected: approved, observed: 'b'.repeat(64)}),
    /OLLAMA_MODEL_DIGEST_MISMATCH/);
  assert.throws(() => requireApprovedModelDigest({expected: approved, observed: 'tag-is-not-digest'}),
    /OLLAMA_MODEL_DIGEST_NOT_OBSERVED/);
});

test('fetch ignoring abort cannot outlive the independent deadline', async () => {
  await assert.rejects(probeOllama({env, timeoutMs: 25,
    fetchImpl: () => new Promise(() => {})}), /OLLAMA_TIMEOUT/);
});

test('reader ignoring abort cannot outlive the independent deadline', async () => {
  const reader = {read: () => new Promise(() => {}), cancel: () => new Promise(() => {})};
  await assert.rejects(probeOllama({env, timeoutMs: 25,
    fetchImpl: withGenerate(async () => ({ok: true, body: {getReader: () => reader}}))}), /OLLAMA_TIMEOUT/);
});

test('non-cooperative reader.cancel cannot suppress a valid receipt', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(receipt));
  let calls = 0;
  const reader = {read: async () => (++calls === 1 ? {done: false, value: bytes} : {done: true}),
    cancel: () => new Promise(() => {})};
  const result = await probeOllama({env, timeoutMs: 200,
    fetchImpl: withGenerate(async () => ({ok: true, body: {getReader: () => reader}}))});
  assert.equal(result.markerMatched, true);
});

test('timeout cannot exceed the fixed 30-second maximum', async () => {
  let calls = 0;
  await assert.rejects(probeOllama({env, timeoutMs: 30001,
    fetchImpl: async () => {calls++;}}), /OLLAMA_TIMEOUT_LIMIT_EXCEEDED/);
  assert.equal(calls, 0);
});

test('any present Ollama error property fails closed, including falsy values', async () => {
  for (const error of [null, '', false, 0]) {
    await assert.rejects(
      probeOllama({env, fetchImpl: withGenerate(async () => new Response(JSON.stringify({...receipt, error})))}),
      /OLLAMA_RECEIPT_ERROR/,
      `error=${JSON.stringify(error)} must never produce a validated receipt`,
    );
  }
});

test('candidate pins are fixed in source; mutable repo variables cannot choose another digest', () => {
  assert.equal(OLLAMA_CANDIDATE_PINS.reviewStatus, 'FOUNDER_WAIVED_REGISTRY_VERIFIED');
  assert.equal(requireCandidatePinBinding({image: env.OLLAMA_IMAGE_SHA256,
    model: env.OLLAMA_MODEL_SHA256}), true);
  assert.throws(() => requireCandidatePinBinding({image: 'f'.repeat(64),
    model: env.OLLAMA_MODEL_SHA256}), /OLLAMA_CANDIDATE_PIN_BINDING_MISMATCH/);
  assert.throws(() => requireCandidatePinBinding({image: env.OLLAMA_IMAGE_SHA256,
    model: 'f'.repeat(64)}), /OLLAMA_CANDIDATE_PIN_BINDING_MISMATCH/);
});
test('administrative review variable cannot authorize an unpinned digest', async () => {
  let calls = 0;
  await assert.rejects(probeOllama({env: {...env, WOLF_OLLAMA_MODEL_DIGEST_REVIEW_PASS: 'PASS',
    OLLAMA_MODEL_SHA256: 'f'.repeat(64)}, fetchImpl: async () => {calls++;}}),
    /OLLAMA_CANDIDATE_PIN_BINDING_MISMATCH/);
  assert.equal(calls, 0);
});
test('direct probe denies mutable model digest mismatch before any fetch', async () => {
  let calls = 0;
  await assert.rejects(probeOllama({env: {...env, OLLAMA_MODEL_SHA256: 'f'.repeat(64)},
    fetchImpl: async () => {calls++;}}), /OLLAMA_CANDIDATE_PIN_BINDING_MISMATCH/);
  assert.equal(calls, 0);
});
test('direct probe rejects observed post-pull digest mismatch before generate', async () => {
  let generates = 0;
  await assert.rejects(probeOllama({env, fetchImpl: async (url) => {
    if (url.endsWith('/api/generate')) {generates++; return fakeFetch(url);}
    return new Response(JSON.stringify({models: [{name: env.WOLF_OLLAMA_PROBE_MODEL,
      digest: 'f'.repeat(64)}]}));
  }}), /OLLAMA_MODEL_DIGEST_MISMATCH/);
  assert.equal(generates, 0);
});
test('direct probe rejects tag-only identity and ambiguous model records before generate', async () => {
  for (const models of [
    [{name: env.WOLF_OLLAMA_PROBE_MODEL, digest: 'tag-is-not-digest'}],
    [{name: env.WOLF_OLLAMA_PROBE_MODEL, digest: env.OLLAMA_MODEL_SHA256},
     {name: env.WOLF_OLLAMA_PROBE_MODEL, digest: env.OLLAMA_MODEL_SHA256}],
  ]) {
    let generates = 0;
    await assert.rejects(probeOllama({env, fetchImpl: async url => {
      if (url.endsWith('/api/generate')) {generates++; return fakeFetch(url);}
      return new Response(JSON.stringify({models}));
    }}), /OLLAMA_MODEL_DIGEST_NOT_OBSERVED|OLLAMA_MODEL_NOT_OBSERVED_AFTER_PULL/);
    assert.equal(generates, 0);
  }
});
test('direct probe rejects error property on tags before generate', async () => {
  let generates = 0;
  await assert.rejects(probeOllama({env, fetchImpl: async url => {
    if (url.endsWith('/api/generate')) {generates++; return fakeFetch(url);}
    return new Response(JSON.stringify({...tagsReceipt, error: null}));
  }}), /OLLAMA_TAGS_INVALID/);
  assert.equal(generates, 0);
});

test('valid source pins permit response checks without review flag', async () => {
  const result = await probeOllama({env: {...env, WOLF_OLLAMA_MODEL_DIGEST_REVIEW_PASS: ''},
    fetchImpl: fakeFetch});
  assert.equal(result.markerMatched, true);
});

/** Public synthetic-only Ollama probe. No Project Wolf private code or credentials. */
import {pathToFileURL} from 'node:url';
import {OLLAMA_CANDIDATE_PINS, requireCandidatePinBinding} from './ollama-candidate-pins.mjs';
const PROMPT = 'Reply with exactly WOLF_OLLAMA_PROBE_OK. Do not use tools.';
const MAX_BYTES = 16384;
// Only models with reviewed licensing are eligible. 3b remains denied pending review.
const MODELS = new Set(['qwen2.5-coder:0.5b', 'qwen2.5-coder:1.5b']);

function withDeadline(promise, deadline) {
  const remaining = Math.max(0, Math.ceil(deadline - performance.now()));
  if (remaining === 0) return Promise.reject(new Error('OLLAMA_TIMEOUT'));
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('OLLAMA_TIMEOUT')), remaining);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function boundedJson(response, deadline) {
  if (!response.body?.getReader) throw new Error('OLLAMA_BODY_UNREADABLE');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await withDeadline(reader.read(), deadline);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('OLLAMA_RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
  } finally {
    // Never let a non-cooperative reader.cancel() block completion or timeout.
    void Promise.resolve().then(() => reader.cancel()).catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); }
  catch { throw new Error('OLLAMA_RESPONSE_INVALID_JSON'); }
}

/** Compare the post-pull observed model digest to a separately approved immutable digest. */
export function requireApprovedModelDigest({expected, observed}) {
  if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected))
    throw new Error('OLLAMA_APPROVED_MODEL_DIGEST_REQUIRED');
  if (typeof observed !== 'string' || !/^[0-9a-f]{64}$/.test(observed))
    throw new Error('OLLAMA_MODEL_DIGEST_NOT_OBSERVED');
  if (observed !== expected) throw new Error('OLLAMA_MODEL_DIGEST_MISMATCH');
  return observed;
}

export async function probeOllama({env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 30000} = {}) {
  if (env.WOLF_OLLAMA_PROBE_ENABLED !== '1') throw new Error('OLLAMA_PROBE_OPT_IN_REQUIRED');
  if (env.WOLF_OLLAMA_ZERO_COST_VERIFIED !== '1') throw new Error('ZERO_COST_ADMISSION_REQUIRED');
  const model = env.WOLF_OLLAMA_PROBE_MODEL;
  if (!MODELS.has(model)) throw new Error('OLLAMA_MODEL_NOT_ALLOWED');
  // Only 0.5b has a registry-provenance candidate; licensing alone is insufficient.
  if (model !== OLLAMA_CANDIDATE_PINS.modelName)
    throw new Error('OLLAMA_MODEL_DIGEST_NOT_REVIEWED');
  // Founder waives administrative review; immutable source pins and post-pull
  // observed digest comparison remain mandatory before any inference.
  if (OLLAMA_CANDIDATE_PINS.reviewStatus !== 'FOUNDER_WAIVED_REGISTRY_VERIFIED')
    throw new Error('OLLAMA_SOURCE_PROVENANCE_REQUIRED');
  requireCandidatePinBinding({
    image: env.OLLAMA_IMAGE_SHA256, model: env.OLLAMA_MODEL_SHA256,
  });
  const endpoint = env.WOLF_OLLAMA_PROBE_ENDPOINT || 'http://127.0.0.1:11434';
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('OLLAMA_ENDPOINT_INVALID'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== '11434' ||
      (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username || url.password)
    throw new Error('OLLAMA_LOOPBACK_ONLY');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw new Error('OLLAMA_TIMEOUT_LIMIT_EXCEEDED');
  const start = performance.now();
  const deadline = start + timeoutMs;
  // Pre-inference: independently observe the post-pull model digest from Ollama.
  // Name/tag and caller-provided digest are never evidence of the observed digest.
  const tagsResponse = await withDeadline(fetchImpl('http://127.0.0.1:11434/api/tags', {
    method: 'GET', signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
  }), deadline);
  if (!tagsResponse.ok) throw new Error('OLLAMA_TAGS_HTTP_' + tagsResponse.status);
  const tags = await boundedJson(tagsResponse, deadline);
  if (!tags || typeof tags !== 'object' || Object.hasOwn(tags, 'error') ||
      !Array.isArray(tags.models)) throw new Error('OLLAMA_TAGS_INVALID');
  const matches = tags.models.filter(entry => entry && entry.name === model);
  if (matches.length !== 1) throw new Error('OLLAMA_MODEL_NOT_OBSERVED_AFTER_PULL');
  requireApprovedModelDigest({
    expected: OLLAMA_CANDIDATE_PINS.modelManifest,
    observed: matches[0].digest,
  });
  const response = await withDeadline(fetchImpl('http://127.0.0.1:11434/api/generate', {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({model, prompt: PROMPT, stream: false}),
    signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
  }), deadline);
  if (!response.ok) throw new Error('OLLAMA_HTTP_' + response.status);
  const data = await boundedJson(response, deadline);
  // Ollama errors must not be promoted by otherwise valid-looking fields.
  if (data && typeof data === 'object' && Object.hasOwn(data, 'error')) {
    throw new Error('OLLAMA_RECEIPT_ERROR');
  }
  if (data?.done !== true || data.model !== model || typeof data.response !== 'string' ||
      !data.response.trim() || data.response.length > 2000) throw new Error('OLLAMA_RECEIPT_INVALID');
  if (data.response.trim() !== 'WOLF_OLLAMA_PROBE_OK') throw new Error('OLLAMA_MARKER_MISMATCH');
  return Object.freeze({state: 'OLLAMA_API_RESPONSE_VALIDATED', model,
    markerMatched: true,
    elapsedMs: Math.round(performance.now() - start),
    evalCount: Number.isSafeInteger(data.eval_count) && data.eval_count >= 0 ? data.eval_count : null,
    privateFactoryIntegrated: false, durableMissionVerified: false});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await probeOllama())); }
  catch (error) {
    console.error(JSON.stringify({state: 'BLOCKED', reason: error?.message || 'UNKNOWN',
      privateFactoryIntegrated: false, durableMissionVerified: false}));
    process.exitCode = 1;
  }
}

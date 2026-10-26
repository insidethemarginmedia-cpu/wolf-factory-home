/** Public synthetic-only Ollama probe. No Project Wolf private code or credentials. */
import {pathToFileURL} from 'node:url';
const PROMPT = 'Reply with exactly WOLF_OLLAMA_PROBE_OK. Do not use tools.';
const MAX_BYTES = 16384;
// Only models with reviewed licensing are eligible. 3b remains denied pending review.
const MODELS = new Set(['qwen2.5-coder:0.5b', 'qwen2.5-coder:1.5b']);

async function boundedJson(response) {
  if (!response.body?.getReader) throw new Error('OLLAMA_BODY_UNREADABLE');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('OLLAMA_RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); }
  catch { throw new Error('OLLAMA_RESPONSE_INVALID_JSON'); }
}

export async function probeOllama({env = process.env, fetchImpl = globalThis.fetch} = {}) {
  if (env.WOLF_OLLAMA_PROBE_ENABLED !== '1') throw new Error('OLLAMA_PROBE_OPT_IN_REQUIRED');
  if (env.WOLF_OLLAMA_ZERO_COST_VERIFIED !== '1') throw new Error('ZERO_COST_ADMISSION_REQUIRED');
  const model = env.WOLF_OLLAMA_PROBE_MODEL;
  if (!MODELS.has(model)) throw new Error('OLLAMA_MODEL_NOT_ALLOWED');
  const endpoint = env.WOLF_OLLAMA_PROBE_ENDPOINT || 'http://127.0.0.1:11434';
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('OLLAMA_ENDPOINT_INVALID'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== '11434' ||
      (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username || url.password)
    throw new Error('OLLAMA_LOOPBACK_ONLY');
  const start = performance.now();
  const response = await fetchImpl('http://127.0.0.1:11434/api/generate', {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({model, prompt: PROMPT, stream: false}),
    signal: AbortSignal.timeout(30000), redirect: 'error',
  });
  if (!response.ok) throw new Error('OLLAMA_HTTP_' + response.status);
  const data = await boundedJson(response);
  // Ollama errors must not be promoted by otherwise valid-looking fields.
  if (data && Object.hasOwn(data, 'error') && data.error !== null &&
      (typeof data.error !== 'string' || data.error !== '')) {
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

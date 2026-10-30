// Bounded transport parsing only. Does not authorize a worker, provider or mission.
const MAX_RESPONSE_BYTES = 1048576;

export async function readPrivateSourceJson(response, {maxBytes, timeoutMs = 20000} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_RESPONSE_BYTES ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20000)
    throw Error('PRIVATE_SOURCE_RESPONSE_LIMIT_INVALID');
  if (!response.body || typeof response.body.getReader !== 'function')
    throw Error('PRIVATE_SOURCE_RESPONSE_UNREADABLE');
  const reader = response.body.getReader();
  const deadline = performance.now() + timeoutMs;
  let size = 0;
  // Fixed allocation prevents unbounded chunk-array overhead from empty/tiny chunks.
  const bytes = Buffer.alloc(maxBytes);
  try {
    const declared = response.headers?.get?.('content-length');
    if (declared !== null && declared !== undefined &&
        (!/^\d+$/.test(declared) || Number(declared) > maxBytes))
      throw Error('PRIVATE_SOURCE_RESPONSE_TOO_LARGE');
    while (true) {
      const remaining = Math.ceil(deadline - performance.now());
      if (remaining <= 0) throw Error('PRIVATE_SOURCE_RESPONSE_TIMEOUT');
      let timer;
      let record;
      try {
        record = await Promise.race([
          Promise.resolve().then(() => reader.read()),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error('PRIVATE_SOURCE_RESPONSE_TIMEOUT')), remaining);
          }),
        ]);
      } finally { clearTimeout(timer); }
      if (record.done) break;
      if (!(record.value instanceof Uint8Array)) throw Error('PRIVATE_SOURCE_RESPONSE_INVALID');
      if (record.value.byteLength > maxBytes - size) throw Error('PRIVATE_SOURCE_RESPONSE_TOO_LARGE');
      bytes.set(record.value, size);
      size += record.value.byteLength;
    }
    try { return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, size))); }
    catch { throw Error('PRIVATE_SOURCE_RESPONSE_INVALID'); }
  } finally {
    // A stalled/failed cancellation must not hold the diagnostic open or expose secrets.
    void Promise.resolve().then(() => reader.cancel()).then(() => reader.releaseLock?.()).catch(() => {});
  }
}

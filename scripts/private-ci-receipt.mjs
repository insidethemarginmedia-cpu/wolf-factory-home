import {createHash, createHmac, timingSafeEqual} from 'node:crypto';

export const RECEIPT_SCHEMA = 'wolf.private-ci.receipt/v1';
export const RECEIPT_SIGNATURE_ALGORITHM = 'hmac-sha256';
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function canonical(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

export function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

export function receiptPayload(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw Error('RECEIPT_OBJECT_REQUIRED');
  const payload = {...receipt};
  delete payload.receiptHash;
  delete payload.receiptSignature;
  return payload;
}

function keyBytes(signingKey) {
  if (typeof signingKey !== 'string' || Buffer.byteLength(signingKey, 'utf8') < 32) {
    throw Error('RECEIPT_SIGNING_KEY_REQUIRED');
  }
  return Buffer.from(signingKey, 'utf8');
}

export function computeReceiptHash(receipt) {
  return createHash('sha256').update(canonicalJson(receiptPayload(receipt))).digest('hex');
}

export function signReceipt(receipt, signingKey) {
  const payload = receiptPayload(receipt);
  if (payload.schema !== RECEIPT_SCHEMA) throw Error('RECEIPT_SCHEMA_UNSUPPORTED');
  const key = keyBytes(signingKey);
  const receiptHash = createHash('sha256').update(canonicalJson(payload)).digest('hex');
  const signature = createHmac('sha256', key).update(`${RECEIPT_SCHEMA}\n${receiptHash}`).digest('hex');
  return {
    ...payload,
    receiptHash,
    receiptSignature: {algorithm: RECEIPT_SIGNATURE_ALGORITHM, value: signature},
  };
}

export function verifyReceiptSignature(receipt, signingKey) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return {valid: false, reason: 'RECEIPT_REQUIRED'};
  if (receipt.schema !== RECEIPT_SCHEMA) return {valid: false, reason: 'RECEIPT_SCHEMA_UNSUPPORTED'};
  if (!HASH_PATTERN.test(String(receipt.receiptHash ?? ''))) return {valid: false, reason: 'RECEIPT_HASH_MALFORMED'};
  if (receipt.receiptSignature?.algorithm !== RECEIPT_SIGNATURE_ALGORITHM || !HASH_PATTERN.test(String(receipt.receiptSignature?.value ?? ''))) {
    return {valid: false, reason: 'RECEIPT_SIGNATURE_REQUIRED'};
  }
  let key;
  try { key = keyBytes(signingKey); } catch { return {valid: false, reason: 'RECEIPT_SIGNING_KEY_REQUIRED'}; }
  const expectedHash = computeReceiptHash(receipt);
  const suppliedHash = Buffer.from(receipt.receiptHash, 'hex');
  const computedHash = Buffer.from(expectedHash, 'hex');
  if (suppliedHash.length !== computedHash.length || !timingSafeEqual(suppliedHash, computedHash)) {
    return {valid: false, reason: 'RECEIPT_HASH_MISMATCH'};
  }
  const expectedSignature = createHmac('sha256', key).update(`${RECEIPT_SCHEMA}\n${expectedHash}`).digest();
  const suppliedSignature = Buffer.from(receipt.receiptSignature.value, 'hex');
  if (suppliedSignature.length !== expectedSignature.length || !timingSafeEqual(suppliedSignature, expectedSignature)) {
    return {valid: false, reason: 'RECEIPT_SIGNATURE_MISMATCH'};
  }
  const sha = String(receipt.sha ?? '');
  if (!SHA_PATTERN.test(sha)) return {valid: false, reason: 'RECEIPT_SHA_MALFORMED'};
  return {valid: true, algorithm: RECEIPT_SIGNATURE_ALGORITHM, receiptHash: expectedHash};
}

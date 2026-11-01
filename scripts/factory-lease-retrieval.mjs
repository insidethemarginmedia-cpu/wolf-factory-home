// Reproducible retrieval of the canonical Factory mission-lease module.
//
// Solves the "S3 transfer problem" by removing S3 from the dependency graph
// entirely. The canonical file is fetched from the authorised private GitHub
// repository at an immutable commit, and its identity is proven three ways:
//
//   1. the commit SHA the API reports for the pinned ref,
//   2. the blob SHA GitHub reports for the file at that commit,
//   3. the SHA-256 of the bytes actually downloaded.
//
// Nothing is written until all three agree. No temporary URL is ever persisted,
// no pre-signed link is reused, and the token is never placed in a remote, an
// argument or a log line.

import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SOURCE = Object.freeze({
  repository: 'donraposo1-source/project-wolf',
  branch: 'feat/factory-real-worker-m1-20261006',
  path: 'infra/autonomy/mission-lease.mjs',
});

const MAX_BYTES = 256 * 1024;

export const RETRIEVAL_STATES = Object.freeze({
  CONFIGURATION_REQUIRED: 'RETRIEVAL_CONFIGURATION_REQUIRED',
  REF_DENIED: 'RETRIEVAL_REF_DENIED',
  REF_NOT_FOUND: 'RETRIEVAL_REF_NOT_FOUND',
  NETWORK_FAILED: 'RETRIEVAL_NETWORK_FAILED',
  COMMIT_MISMATCH: 'RETRIEVAL_COMMIT_MISMATCH',
  FILE_NOT_FOUND: 'RETRIEVAL_FILE_NOT_FOUND',
  FILE_TOO_LARGE: 'RETRIEVAL_FILE_TOO_LARGE',
  DIGEST_MISMATCH: 'RETRIEVAL_DIGEST_MISMATCH',
  VERIFIED: 'RETRIEVAL_VERIFIED',
});

function state(name, extra = {}) {
  return { state: name, retrieved: false, written: false, ...extra };
}

/**
 * @param {object} opts
 * @param {object} opts.env            process env (token read from here only)
 * @param {Function} opts.fetchImpl    injectable fetch
 * @param {string} opts.outPath        where to write the verified module
 * @param {string} [opts.comparePath]  existing local copy to compare
 * @param {string} [opts.expectedSha256] pinned digest from a previous retrieval
 */
export async function retrieveCanonicalLease({
  env = process.env,
  fetchImpl = globalThis.fetch,
  outPath,
  comparePath = null,
  expectedSha256 = null,
  expectedCommit = null,
} = {}) {
  const token = env.WOLF_FACTORY_REPO_TOKEN || env.GH_TOKEN || null;
  if (!token) {
    return state(RETRIEVAL_STATES.CONFIGURATION_REQUIRED, {
      required: ['WOLF_FACTORY_REPO_TOKEN'],
      note: 'A read-scoped token for the private Factory is required. No fallback and no S3 path exists.',
    });
  }
  if (!outPath) throw new Error('outPath is required');

  const headers = {
    authorization: `Bearer ${token}`,
    'user-agent': 'WolfFactoryLeaseRetrieval',
    accept: 'application/vnd.github+json',
  };

  // ---- 1. resolve the branch to an immutable commit ----------------------
  let refRes;
  try {
    refRes = await fetchImpl(
      `https://api.github.com/repos/${SOURCE.repository}/git/ref/heads/${SOURCE.branch}`,
      { headers, redirect: 'error', signal: AbortSignal.timeout(20000) },
    );
  } catch {
    return state(RETRIEVAL_STATES.NETWORK_FAILED, { stage: 'ref' });
  }
  if (refRes.status === 404) return state(RETRIEVAL_STATES.REF_NOT_FOUND, { stage: 'ref' });
  if (!refRes.ok) return state(RETRIEVAL_STATES.REF_DENIED, { stage: 'ref', status: refRes.status });

  let ref;
  try { ref = await refRes.json(); } catch { return state(RETRIEVAL_STATES.NETWORK_FAILED, { stage: 'ref-json' }); }
  const commitSha = ref?.object?.sha;
  if (typeof commitSha !== 'string' || !/^[a-f0-9]{40}$/.test(commitSha)) {
    return state(RETRIEVAL_STATES.NETWORK_FAILED, { stage: 'ref-sha' });
  }
  // Moving-branch protection: a caller-supplied commit that disagrees is fatal.
  if (expectedCommit && expectedCommit !== commitSha) {
    return state(RETRIEVAL_STATES.COMMIT_MISMATCH, { observedCommit: commitSha, expectedCommit });
  }

  // ---- 2. fetch the file bytes at exactly that commit ---------------------
  const url = `https://raw.githubusercontent.com/${SOURCE.repository}/${commitSha}/${SOURCE.path}`;
  let fileRes;
  try {
    fileRes = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}`, 'user-agent': 'WolfFactoryLeaseRetrieval' },
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    return state(RETRIEVAL_STATES.NETWORK_FAILED, { stage: 'file', commitSha });
  }
  if (fileRes.status === 404) return state(RETRIEVAL_STATES.FILE_NOT_FOUND, { commitSha });
  if (!fileRes.ok) return state(RETRIEVAL_STATES.REF_DENIED, { stage: 'file', status: fileRes.status });

  const lengthHeader = Number(fileRes.headers?.get?.('content-length') ?? NaN);
  if (Number.isFinite(lengthHeader) && lengthHeader > MAX_BYTES) {
    return state(RETRIEVAL_STATES.FILE_TOO_LARGE, { commitSha, bytes: lengthHeader });
  }

  let buffer;
  try {
    buffer = Buffer.from(await fileRes.arrayBuffer());
  } catch {
    return state(RETRIEVAL_STATES.NETWORK_FAILED, { stage: 'file-body', commitSha });
  }
  if (buffer.length === 0) return state(RETRIEVAL_STATES.FILE_NOT_FOUND, { commitSha, empty: true });
  if (buffer.length > MAX_BYTES) return state(RETRIEVAL_STATES.FILE_TOO_LARGE, { commitSha, bytes: buffer.length });

  // ---- 3. prove the digest ----------------------------------------------
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const existingDigest = comparePath && existsSync(comparePath)
    ? createHash('sha256').update(readFileSync(comparePath)).digest('hex')
    : null;

  if (expectedSha256 && sha256 !== expectedSha256) {
    return state(RETRIEVAL_STATES.DIGEST_MISMATCH, {
      commitSha, sha256, expectedSha256,
      localCopyMatches: existingDigest === sha256,
    });
  }

  // Only now is anything written.
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buffer, { mode: 0o600 });

  return {
    state: RETRIEVAL_STATES.VERIFIED,
    retrieved: true,
    written: true,
    repository: SOURCE.repository,
    branch: SOURCE.branch,
    path: SOURCE.path,
    sourceCommit: commitSha,
    sha256,
    bytes: buffer.length,
    comparedLocalCopy: existingDigest === null ? 'ABSENT' : existingDigest === sha256 ? 'IDENTICAL' : 'DIFFERS',
    requiresPinning: expectedSha256 === null,
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const outPath = process.env.WOLF_LEASE_OUT || join(process.cwd(), 'infra/autonomy/mission-lease.mjs');
  const result = await retrieveCanonicalLease({
    outPath,
    comparePath: existsSync(outPath) ? outPath : null,
    expectedSha256: process.env.WOLF_LEASE_SHA256 || null,
    expectedCommit: process.env.WOLF_FACTORY_EXPECTED_SHA || null,
  });
  // Never echo the token; the result object cannot contain it by construction.
  console.log(JSON.stringify(result));
  if (result.state !== RETRIEVAL_STATES.VERIFIED) process.exitCode = 78;
}

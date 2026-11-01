// Retrieval procedure for the canonical lease module: no S3, fail-closed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { retrieveCanonicalLease, RETRIEVAL_STATES, SOURCE } from '../scripts/factory-lease-retrieval.mjs';
import { makeWorkspace } from '../infra/autonomy/test-support/fixtures.mjs';

const COMMIT = 'a'.repeat(40);
const BODY = 'export function claimMission(){}\nexport function assertMissionClaim(){}\nexport function releaseMissionClaim(){}\nexport function withMissionClaimWriteAuthority(){}\n';
const DIGEST = createHash('sha256').update(Buffer.from(BODY)).digest('hex');

function fakeFetch({ commitSha = COMMIT, body = BODY, refStatus = 200, fileStatus = 200 } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (url.includes('/git/ref/')) {
      return {
        ok: refStatus === 200,
        status: refStatus,
        json: async () => ({ ref: `refs/heads/${SOURCE.branch}`, object: { sha: commitSha } }),
      };
    }
    if (url.includes('raw.githubusercontent.com')) {
      return {
        ok: fileStatus === 200,
        status: fileStatus,
        headers: new Headers({ 'content-length': String(body.length) }),
        arrayBuffer: async () => Buffer.from(body),
      };
    }
    throw new Error(`unexpected url ${url}`);
  };
  return { impl, calls };
}

test('no token means configuration required and zero network calls', async () => {
  const ws = makeWorkspace();
  try {
    const { impl, calls } = fakeFetch();
    const result = await retrieveCanonicalLease({ env: {}, fetchImpl: impl, outPath: join(ws.dir, 'lease.mjs') });
    assert.equal(result.state, RETRIEVAL_STATES.CONFIGURATION_REQUIRED);
    assert.equal(calls.length, 0);
    assert.equal(existsSync(join(ws.dir, 'lease.mjs')), false);
  } finally { ws.cleanup(); }
});

test('a successful retrieval is pinned to the immutable commit and written once', async () => {
  const ws = makeWorkspace();
  try {
    const outPath = join(ws.dir, 'lease.mjs');
    const { impl, calls } = fakeFetch();
    const result = await retrieveCanonicalLease({
      env: { WOLF_FACTORY_REPO_TOKEN: 'fixture-token' },
      fetchImpl: impl,
      outPath,
      expectedSha256: DIGEST,
      expectedCommit: COMMIT,
    });
    assert.equal(result.state, RETRIEVAL_STATES.VERIFIED);
    assert.equal(result.sourceCommit, COMMIT);
    assert.equal(result.sha256, DIGEST);
    assert.equal(readFileSync(outPath, 'utf8'), BODY);
    // The raw URL must embed the commit, never the branch.
    assert.ok(calls.some((u) => u.includes(`/${COMMIT}/${SOURCE.path}`)));
    assert.ok(!calls.some((u) => u.includes(`/${SOURCE.branch}/${SOURCE.path}`)));
    assert.ok(!JSON.stringify(result).includes('fixture-token'));
  } finally { ws.cleanup(); }
});

test('a digest mismatch writes nothing', async () => {
  const ws = makeWorkspace();
  try {
    const outPath = join(ws.dir, 'lease.mjs');
    const { impl } = fakeFetch({ body: `${BODY}// tampered\n` });
    const result = await retrieveCanonicalLease({
      env: { WOLF_FACTORY_REPO_TOKEN: 't' },
      fetchImpl: impl,
      outPath,
      expectedSha256: DIGEST,
    });
    assert.equal(result.state, RETRIEVAL_STATES.DIGEST_MISMATCH);
    assert.equal(result.written, false);
    assert.equal(existsSync(outPath), false);
  } finally { ws.cleanup(); }
});

test('an unpinned retrieval reports that pinning is still required', async () => {
  const ws = makeWorkspace();
  try {
    const { impl } = fakeFetch();
    const result = await retrieveCanonicalLease({
      env: { WOLF_FACTORY_REPO_TOKEN: 't' },
      fetchImpl: impl,
      outPath: join(ws.dir, 'lease.mjs'),
    });
    assert.equal(result.state, RETRIEVAL_STATES.VERIFIED);
    assert.equal(result.requiresPinning, true);
  } finally { ws.cleanup(); }
});

test('local copy comparison distinguishes identical, differing and absent', async () => {
  const ws = makeWorkspace();
  try {
    const outPath = join(ws.dir, 'existing.mjs');
    writeFileSync(outPath, BODY);
    const identical = await retrieveCanonicalLease({
      env: { WOLF_FACTORY_REPO_TOKEN: 't' },
      fetchImpl: fakeFetch().impl,
      outPath,
      comparePath: outPath,
    });
    assert.equal(identical.comparedLocalCopy, 'IDENTICAL');

    writeFileSync(outPath, 'something else entirely\n');
    const differs = await retrieveCanonicalLease({
      env: { WOLF_FACTORY_REPO_TOKEN: 't' },
      fetchImpl: fakeFetch().impl,
      outPath,
      comparePath: outPath,
    });
    assert.equal(differs.comparedLocalCopy, 'DIFFERS');

    const absent = await retrieveCanonicalLease({
      env: { WOLF_FACTORY_REPO_TOKEN: 't' },
      fetchImpl: fakeFetch().impl,
      outPath: join(ws.dir, 'fresh.mjs'),
      comparePath: join(ws.dir, 'never-existed.mjs'),
    });
    assert.equal(absent.comparedLocalCopy, 'ABSENT');
  } finally { ws.cleanup(); }
});

test('denied, missing and unavailable refs are distinct and write nothing', async () => {
  const ws = makeWorkspace();
  try {
    const outPath = join(ws.dir, 'lease.mjs');
    const notFound = await retrieveCanonicalLease({
      env: { WOLF_FACTORY_REPO_TOKEN: 't' }, fetchImpl: fakeFetch({ refStatus: 404 }).impl, outPath,
    });
    assert.equal(notFound.state, RETRIEVAL_STATES.REF_NOT_FOUND);

    const denied = await retrieveCanonicalLease({
      env: { WOLF_FACTORY_REPO_TOKEN: 't' }, fetchImpl: fakeFetch({ refStatus: 403 }).impl, outPath,
    });
    assert.equal(denied.state, RETRIEVAL_STATES.REF_DENIED);

    const fileMissing = await retrieveCanonicalLease({
      env: { WOLF_FACTORY_REPO_TOKEN: 't' }, fetchImpl: fakeFetch({ fileStatus: 404 }).impl, outPath,
    });
    assert.equal(fileMissing.state, RETRIEVAL_STATES.FILE_NOT_FOUND);
    assert.equal(existsSync(outPath), false);
  } finally { ws.cleanup(); }
});

test('network failure is reported without leaking the token', async () => {
  const ws = makeWorkspace();
  try {
    const result = await retrieveCanonicalLease({
      env: { WOLF_FACTORY_REPO_TOKEN: 'super-secret-token' },
      fetchImpl: async () => { throw new Error('boom'); },
      outPath: join(ws.dir, 'lease.mjs'),
    });
    assert.equal(result.state, RETRIEVAL_STATES.NETWORK_FAILED);
    assert.ok(!JSON.stringify(result).includes('super-secret-token'));
  } finally { ws.cleanup(); }
});

test('a branch that moved past the pinned commit is refused', async () => {
  const ws = makeWorkspace();
  try {
    const result = await retrieveCanonicalLease({
      env: { WOLF_FACTORY_REPO_TOKEN: 't' },
      fetchImpl: fakeFetch({ commitSha: 'b'.repeat(40) }).impl,
      outPath: join(ws.dir, 'lease.mjs'),
      expectedCommit: COMMIT,
    });
    assert.equal(result.state, RETRIEVAL_STATES.COMMIT_MISMATCH);
  } finally { ws.cleanup(); }
});

test('an empty body is never accepted as the canonical module', async () => {
  const ws = makeWorkspace();
  try {
    const result = await retrieveCanonicalLease({
      env: { WOLF_FACTORY_REPO_TOKEN: 't' },
      fetchImpl: fakeFetch({ body: '' }).impl,
      outPath: join(ws.dir, 'lease.mjs'),
    });
    assert.equal(result.state, RETRIEVAL_STATES.FILE_NOT_FOUND);
    assert.equal(existsSync(join(ws.dir, 'lease.mjs')), false);
  } finally { ws.cleanup(); }
});

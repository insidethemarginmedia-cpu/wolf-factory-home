/*
 * Wolf Omega P0 -- offline Qwen Code / npm installation safety.
 * Local temp workspaces only. No network calls, no inference, no paid resources.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  installOfflineTool, makeTar, parseArchive, verifyArtifact, verifyResumableChunks,
} from '../scripts/omega-p0/offline-install.mjs';

const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const VERSION = '1.2.3';
const NAME = 'qwen-code-offline';

function archiveEntries() {
  return [
    {name: 'package/package.json', data: JSON.stringify({name: NAME, version: VERSION})},
    {name: 'package/bin/qwen.js', data: 'module.exports = 1;\n'},
    {name: 'package/README.md', data: '# offline tool\n'},
  ];
}
function workspace() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-offline-p0-'));
  const installDir = path.join(base, 'workspace');
  fs.mkdirSync(installDir, {recursive: true});
  return {base, installDir, roots: [installDir]};
}
function cleanup(base) { fs.rmSync(base, {recursive: true, force: true}); }
function install(archive, w, overrides = {}) {
  return installOfflineTool({
    archive, expectedSha256: sha(archive), expectedVersion: VERSION,
    expectedName: NAME, installDir: w.installDir, allowedRoots: w.roots,
    targetName: 'qwen', ...overrides,
  });
}

test('exact SHA-256 verification and safe archive parsing', () => {
  const archive = makeTar(archiveEntries());
  assert.equal(verifyArtifact(archive, sha(archive)).state, 'VERIFIED');
  assert.equal(verifyArtifact(archive, 'a'.repeat(64)).reason, 'ARCHIVE_SHA256_MISMATCH');
  assert.equal(verifyArtifact(Buffer.alloc(0), sha(archive)).reason, 'ARCHIVE_BOUNDS_INVALID');
  const entries = parseArchive(archive);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map(e => e.name), ['package/package.json', 'package/bin/qwen.js', 'package/README.md']);
});

test('a verified offline install is atomic, isolated and network-free', () => {
  const w = workspace();
  try {
    const archive = makeTar(archiveEntries());
    const result = install(archive, w);
    assert.equal(result.state, 'INSTALLED');
    assert.equal(result.version, VERSION);
    assert.equal(result.sha256, sha(archive));
    assert.equal(result.files, 3);
    assert.equal(result.networkCalls, 0);
    assert.equal(result.atomic, true);
    assert.equal(result.rolledBack, false);
    assert.equal(fs.readFileSync(path.join(result.installPath, 'package', 'package.json'), 'utf8'), JSON.stringify({name: NAME, version: VERSION}));
    assert.equal(fs.statSync(path.join(result.installPath, 'package', 'bin', 'qwen.js')).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(w.installDir), ['qwen'], 'staging directory must not survive');
  } finally { cleanup(w.base); }
});

test('wrong SHA-256, wrong version and missing version manifest deny installation', () => {
  const w = workspace();
  try {
    const archive = makeTar(archiveEntries());
    const wrongHash = install(archive, w, {expectedSha256: 'b'.repeat(64)});
    assert.equal(wrongHash.reason, 'ARCHIVE_SHA256_MISMATCH');
    const wrongVersion = install(archive, w, {expectedVersion: '9.9.9'});
    assert.equal(wrongVersion.reason, 'VERSION_MISMATCH');
    assert.equal(wrongVersion.rolledBack, true);
    const noManifest = makeTar([{name: 'package/bin/qwen.js', data: 'x'}]);
    assert.equal(install(noManifest, w).reason, 'VERSION_MANIFEST_MISSING');
    assert.equal(fs.existsSync(path.join(w.installDir, 'qwen')), false, 'no partial installation is left behind');
  } finally { cleanup(w.base); }
});

test('archive extraction denies symlinks, hardlinks, devices, traversal, duplicates and unsafe modes', () => {
  const unsafe = [
    [{name: 'package/evil', data: '', typeflag: 50}, 'ARCHIVE_UNSAFE_ENTRY_TYPE'],           // '2' symlink
    [{name: 'package/evil', data: '', typeflag: 49}, 'ARCHIVE_UNSAFE_ENTRY_TYPE'],           // '1' hardlink
    [{name: 'package/evil', data: '', typeflag: 120}, 'ARCHIVE_UNSAFE_ENTRY_TYPE'],          // 'x' pax
    [{name: '../escape', data: 'x'}, 'ARCHIVE_PATH_TRAVERSAL'],
    [{name: '/absolute', data: 'x'}, 'ARCHIVE_PATH_TRAVERSAL'],
    [{name: 'package/..//evil', data: 'x'}, 'ARCHIVE_PATH_TRAVERSAL'],
    [{name: 'package/bin/qwen.js', data: 'x', mode: 0o4755}, 'ARCHIVE_UNSAFE_MODE'],
  ];
  for (const [entry, reason] of unsafe) {
    const archive = makeTar([...archiveEntries(), entry]);
    try { parseArchive(archive); assert.fail('expected denial: ' + reason); }
    catch (error) { assert.equal(error.wolfReason, reason, String(entry.typeflag)); }
  }
  const duplicate = makeTar([...archiveEntries(), {name: 'package/package.json', data: '{}'}]);
  try { parseArchive(duplicate); assert.fail('expected denial'); }
  catch (error) { assert.equal(error.wolfReason, 'ARCHIVE_DUPLICATE_ENTRY'); }
  const truncated = Buffer.from(makeTar(archiveEntries()).subarray(0, 1024));
  try { parseArchive(truncated); assert.fail('expected denial'); }
  catch (error) { assert.ok(['ARCHIVE_TRUNCATED', 'ARCHIVE_END_MARKER_MISSING', 'ARCHIVE_BOUNDS_INVALID', 'ARCHIVE_CHECKSUM_INVALID'].includes(error.wolfReason)); }
});

test('an existing target is not overwritten; replace performs atomic rollback on failure', () => {
  const w = workspace();
  try {
    const archive = makeTar(archiveEntries());
    assert.equal(install(archive, w).state, 'INSTALLED');
    const second = install(archive, w);
    assert.equal(second.reason, 'INSTALL_TARGET_EXISTS');
    assert.equal(second.rolledBack, true);
    assert.equal(fs.readFileSync(path.join(w.installDir, 'qwen', 'package', 'package.json'), 'utf8'), JSON.stringify({name: NAME, version: VERSION}));

    // Inject a write failure into the isolated staging phase; the original target
    // and its backup must be restored deterministically.
    const failingFs = Object.create(fs);
    failingFs.writeFileSync = (file, data, options) => {
      if (String(file).endsWith('qwen.js')) throw new Error('injected staging failure');
      return fs.writeFileSync(file, data, options);
    };
    const failed = install(archive, w, {replace: true, fsImpl: failingFs});
    assert.equal(failed.state, 'FAILED');
    assert.equal(failed.reason, 'OFFLINE_INSTALL_FAILED');
    assert.equal(failed.rolledBack, true);
    assert.equal(failed.networkCalls, 0);
    assert.equal(fs.existsSync(path.join(w.installDir, 'qwen', 'package', 'package.json')), true, 'original install restored');
    assert.deepEqual(fs.readdirSync(w.installDir), ['qwen'], 'no staging or backup debris');
  } finally { cleanup(w.base); }
});

test('workspace isolation denies installs outside the allowed roots', () => {
  const w = workspace();
  try {
    const other = path.join(w.base, 'other');
    fs.mkdirSync(other);
    const archive = makeTar(archiveEntries());
    const result = install(archive, w, {allowedRoots: [other]});
    assert.equal(result.reason, 'INSTALL_WORKSPACE_ESCAPE');
    assert.equal(fs.existsSync(path.join(w.installDir, 'qwen')), false);
  } finally { cleanup(w.base); }
});

test('resumable chunks require exact per-chunk hashes and an exact total digest', () => {
  const archive = makeTar(archiveEntries());
  const midpoint = Math.floor(archive.byteLength / 2);
  const chunks = [archive.subarray(0, midpoint), archive.subarray(midpoint)];
  const chunkDigests = chunks.map(sha);
  const verified = verifyResumableChunks({chunks, chunkDigests, expectedArchiveSha256: sha(archive)});
  assert.equal(verified.state, 'VERIFIED');
  assert.equal(verified.chunks, 2);
  assert.equal(verified.archive.equals(archive), true);
  const tampered = [chunks[0], Buffer.from(chunks[1])];
  tampered[1][0] ^= 0xff;
  assert.equal(verifyResumableChunks({chunks: tampered, chunkDigests, expectedArchiveSha256: sha(archive)}).reason, 'CHUNK_DIGEST_MISMATCH');
  assert.equal(verifyResumableChunks({chunks, chunkDigests, expectedArchiveSha256: 'c'.repeat(64)}).reason, 'ARCHIVE_SHA256_MISMATCH');
  assert.equal(verifyResumableChunks({chunks, chunkDigests: [chunkDigests[0]], expectedArchiveSha256: sha(archive)}).reason, 'CHUNK_COUNT_MISMATCH');
});

test('the offline module contains no network client and emits deterministic diagnostics', () => {
  const source = fs.readFileSync(new URL('../scripts/omega-p0/offline-install.mjs', import.meta.url), 'utf8');
  assert.equal(/\bfetch\s*\(|https?\.request|node:https?\b/.test(source), false, 'offline installer has no network API');
  const w = workspace();
  try {
    const failures = [
      install(makeTar(archiveEntries()), w, {expectedSha256: 'd'.repeat(64)}),
      install(makeTar(archiveEntries()), w, {expectedVersion: '0.0.0'}),
      install(makeTar(archiveEntries()), w, {targetName: '../escape'}),
    ];
    for (const failure of failures) {
      assert.equal(failure.state, 'FAILED');
      assert.equal(typeof failure.reason, 'string');
      assert.equal(failure.networkCalls, 0);
      assert.equal(typeof failure.rolledBack, 'boolean');
    }
  } finally { cleanup(w.base); }
});

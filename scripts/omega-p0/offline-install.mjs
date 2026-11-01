/*
 * Wolf Omega P0 -- offline Qwen Code / npm tooling installation boundary.
 *
 * No network API exists in this module. Installation is:
 *   exact SHA-256 -> safe archive parse -> version verification -> isolated stage
 *   -> atomic rename -> rollback on any failure. Deterministic reason codes only.
 * Large Base64 artifacts must never be passed through chat or command arguments:
 * use verified direct artifact transport, or resumable chunks with per-chunk hashes
 * (`verifyResumableChunks`) reassembled locally.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SHA256_HEX, deny, sha256, timingSafeHex} from './policy.mjs';
import {assertNoSymlinkAncestors, isContained} from './skill-loader.mjs';

const BLOCK = 512;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 20000;
const SAFE_TYPEFLAGS = new Set(['0', '\0', '5']);

function field(block, start, length) {
  return block.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '').trim();
}
function octal(text, reason) {
  const value = text.replace(/\0.*$/s, '').trim();
  if (!/^[0-7]+$/.test(value)) deny(reason, 'non-octal field');
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) deny(reason, 'overflow');
  return parsed;
}
function checksum(block) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 32 : block[i];
  return sum;
}

export function verifyArtifact(archive, expectedSha256) {
  try {
    if (!(archive instanceof Uint8Array) || archive.byteLength === 0 || archive.byteLength > MAX_ARCHIVE_BYTES) {
      deny('ARCHIVE_BOUNDS_INVALID');
    }
    if (typeof expectedSha256 !== 'string' || !SHA256_HEX.test(expectedSha256)) deny('ARCHIVE_SHA256_EXPECTED_INVALID');
    const digest = sha256(archive);
    if (!timingSafeHex(digest, expectedSha256)) deny('ARCHIVE_SHA256_MISMATCH');
    return Object.freeze({state: 'VERIFIED', sha256: digest, bytes: archive.byteLength});
  } catch (error) {
    return Object.freeze({state: 'FAILED', reason: error?.wolfReason || 'ARTIFACT_VERIFICATION_FAILED'});
  }
}

export function verifyResumableChunks({chunks, chunkDigests, expectedArchiveSha256} = {}) {
  try {
    if (!Array.isArray(chunks) || !Array.isArray(chunkDigests) || chunks.length !== chunkDigests.length ||
        chunks.length === 0 || chunks.length > 4096) deny('CHUNK_COUNT_MISMATCH');
    let total = 0;
    const buffers = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) deny('CHUNK_INVALID', i);
      total += chunk.byteLength;
      if (total > MAX_ARCHIVE_BYTES) deny('ARCHIVE_BOUNDS_INVALID', i);
      if (!timingSafeHex(sha256(chunk), chunkDigests[i])) deny('CHUNK_DIGEST_MISMATCH', i);
      buffers.push(Buffer.from(chunk));
    }
    const archive = Buffer.concat(buffers);
    const verified = verifyArtifact(archive, expectedArchiveSha256);
    if (verified.state !== 'VERIFIED') deny(verified.reason);
    return Object.freeze({state: 'VERIFIED', archive, sha256: verified.sha256, chunks: chunks.length});
  } catch (error) {
    return Object.freeze({state: 'FAILED', reason: error?.wolfReason || 'CHUNK_VERIFICATION_FAILED'});
  }
}

function validateEntryName(name, isDirectory) {
  let candidate = name;
  if (candidate.endsWith('/')) candidate = candidate.slice(0, -1);
  if (!candidate || candidate.length > 512 || candidate.includes('\0') || candidate.includes('\\') ||
      candidate.startsWith('/') || /^[A-Za-z]:/.test(candidate)) deny('ARCHIVE_PATH_TRAVERSAL', name);
  const segments = candidate.split('/');
  if (segments.length > 32 || segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    deny('ARCHIVE_PATH_TRAVERSAL', name);
  }
  if (isDirectory && name.endsWith('/') === false) deny('ARCHIVE_DIRECTORY_ENTRY_INVALID', name);
  return {name: candidate, segments};
}

export function parseArchive(archive, {maxBytes = MAX_ARCHIVE_BYTES, maxEntries = MAX_ENTRIES} = {}) {
  if (!(archive instanceof Uint8Array) || archive.byteLength === 0 || archive.byteLength > maxBytes ||
      archive.byteLength % BLOCK !== 0) deny('ARCHIVE_BOUNDS_INVALID');
  const buffer = Buffer.from(archive);
  const entries = [];
  const names = new Set();
  let offset = 0;
  let totalBytes = 0;
  let ended = false;
  while (offset + BLOCK <= buffer.byteLength) {
    const block = buffer.subarray(offset, offset + BLOCK);
    const zero = block.every(byte => byte === 0);
    if (zero) { ended = true; offset += BLOCK; break; }
    const stored = octal(block.subarray(148, 156).toString('utf8'), 'ARCHIVE_CHECKSUM_INVALID');
    if (stored !== checksum(block)) deny('ARCHIVE_CHECKSUM_INVALID', offset);
    const magic = block.subarray(257, 263).toString('latin1');
    if (magic !== 'ustar\0' && magic !== 'ustar ') deny('ARCHIVE_MAGIC_INVALID', offset);
    const typeflag = String.fromCharCode(block[156] || 48);
    if (!SAFE_TYPEFLAGS.has(typeflag)) deny('ARCHIVE_UNSAFE_ENTRY_TYPE', typeflag);
    const linkname = field(block, 157, 100);
    if (linkname) deny('ARCHIVE_LINK_ENTRY_DENIED', linkname);
    const mode = octal(block.subarray(100, 108).toString('utf8'), 'ARCHIVE_MODE_INVALID');
    if (mode & 0o7000) deny('ARCHIVE_UNSAFE_MODE', mode);
    const size = octal(block.subarray(124, 136).toString('utf8'), 'ARCHIVE_SIZE_INVALID');
    if (size > MAX_FILE_BYTES) deny('ARCHIVE_ENTRY_TOO_LARGE', size);
    const prefix = field(block, 345, 155);
    const rawName = field(block, 0, 100);
    if (!rawName) deny('ARCHIVE_ENTRY_NAME_MISSING', offset);
    const fullName = prefix ? prefix + '/' + rawName : rawName;
    const isDirectory = typeflag === '5';
    if (isDirectory && size !== 0) deny('ARCHIVE_DIRECTORY_SIZE_INVALID', fullName);
    const {name} = validateEntryName(fullName, isDirectory);
    if (names.has(name)) deny('ARCHIVE_DUPLICATE_ENTRY', name);
    names.add(name);
    const dataOffset = offset + BLOCK;
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (dataOffset + padded > buffer.byteLength) deny('ARCHIVE_TRUNCATED', name);
    totalBytes += size;
    if (totalBytes > maxBytes || entries.length >= maxEntries) deny('ARCHIVE_LIMITS_EXCEEDED');
    const data = Buffer.from(buffer.subarray(dataOffset, dataOffset + size));
    entries.push(Object.freeze({name, type: isDirectory ? 'directory' : 'file', mode, size, data}));
    offset = dataOffset + padded;
  }
  if (!ended) deny('ARCHIVE_END_MARKER_MISSING');
  if (!entries.some(entry => entry.type === 'file')) deny('ARCHIVE_NO_FILES');
  // Everything after the first zero block must be zero padding.
  for (let i = offset; i < buffer.byteLength; i += 1) {
    if (buffer[i] !== 0) deny('ARCHIVE_TRAILING_DATA');
  }
  return Object.freeze(entries);
}

export function makeTar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const header = Buffer.alloc(BLOCK);
    const name = entry.type === 'directory' ? entry.name + '/' : entry.name;
    if (Buffer.byteLength(name, 'utf8') > 100) deny('ARCHIVE_TEST_FIXTURE_NAME_TOO_LONG');
    header.write(name, 0, 100, 'utf8');
    header.write((entry.mode ?? 0o644).toString(8).padStart(7, '0') + '\0', 100, 8, 'utf8');
    header.write('0000000\0', 108, 8, 'utf8');
    header.write('0000000\0', 116, 8, 'utf8');
    const data = Buffer.from(entry.data ?? '', 'utf8');
    header.write(data.byteLength.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
    header.write('00000000000\0', 136, 12, 'utf8');
    header.write('        ', 148, 8, 'utf8');
    header[156] = entry.type === 'directory' ? 53 : entry.typeflag ?? 48;
    header.write('ustar\0', 257, 6, 'latin1');
    header.write('00', 263, 2, 'utf8');
    header.write(checksum(header).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
    blocks.push(header, Buffer.from(data));
    const padding = (BLOCK - (data.byteLength % BLOCK)) % BLOCK;
    if (padding) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(blocks);
}

function assertWorkspace(installDir, allowedRoots, {fsImpl, pathImpl}) {
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) deny('INSTALL_WORKSPACE_ROOT_REQUIRED');
  const roots = [...new Set(allowedRoots.map(root => {
    assertNoSymlinkAncestors(root, {fsImpl, pathImpl});
    return fsImpl.realpathSync(root);
  }))];
  assertNoSymlinkAncestors(installDir, {fsImpl, pathImpl});
  const canonical = fsImpl.realpathSync(installDir);
  if (!isContained(roots, canonical, pathImpl)) deny('INSTALL_WORKSPACE_ESCAPE', canonical);
  return canonical;
}

function readVersion(entries, expectedName, expectedVersion) {
  const record = entries.find(entry => entry.type === 'file' && entry.name === 'package/package.json');
  if (!record) deny('VERSION_MANIFEST_MISSING');
  let manifest;
  try { manifest = JSON.parse(record.data.toString('utf8')); } catch { deny('VERSION_MANIFEST_INVALID'); }
  if (typeof expectedName === 'string' && manifest.name !== expectedName) deny('VERSION_NAME_MISMATCH');
  if (typeof expectedVersion !== 'string' || !expectedVersion || manifest.version !== expectedVersion) {
    deny('VERSION_MISMATCH', manifest.version);
  }
  return manifest.version;
}

/**
 * Atomic offline installation. All failures are deterministic verdicts; no partial
 * target is ever left installed. `replace` performs a backup + rollback swap.
 */
export function installOfflineTool({
  archive, expectedSha256, expectedVersion, expectedName,
  installDir, targetName = 'tool', allowedRoots, replace = false,
  fsImpl = fs, pathImpl = path, osImpl = os,
} = {}) {
  let staging = null;
  let backup = null;
  let target = null;
  try {
    const verified = verifyArtifact(archive, expectedSha256);
    if (verified.state !== 'VERIFIED') deny(verified.reason);
    let entries;
    try { entries = parseArchive(archive); } catch (error) { deny(error?.wolfReason || 'ARCHIVE_PARSE_FAILED', error?.wolfDetail); }
    const version = readVersion(entries, expectedName, expectedVersion);
    if (typeof installDir !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(targetName)) {
      deny('INSTALL_TARGET_NAME_INVALID');
    }
    const workspace = assertWorkspace(installDir, allowedRoots || [osImpl.tmpdir()], {fsImpl, pathImpl});
    target = pathImpl.join(workspace, targetName);
    staging = fsImpl.mkdtempSync(pathImpl.join(workspace, '.wolf-stage-'));
    for (const entry of entries) {
      const destination = pathImpl.resolve(staging, entry.name);
      if (!isContained([staging], destination, pathImpl)) deny('ARCHIVE_PATH_ESCAPE_AT_INSTALL', entry.name);
      if (entry.type === 'directory') {
        fsImpl.mkdirSync(destination, {recursive: true});
      } else {
        fsImpl.mkdirSync(pathImpl.dirname(destination), {recursive: true});
        fsImpl.writeFileSync(destination, entry.data, {mode: 0o600, flag: 'wx'});
      }
    }
    const exists = fsImpl.existsSync(target);
    if (exists && !replace) deny('INSTALL_TARGET_EXISTS');
    if (exists) {
      backup = target + '.backup-' + process.pid;
      if (fsImpl.existsSync(backup)) deny('INSTALL_BACKUP_EXISTS');
      fsImpl.renameSync(target, backup);
    }
    fsImpl.renameSync(staging, target);
    staging = null;
    if (backup) { fsImpl.rmSync(backup, {recursive: true, force: true}); backup = null; }
    return Object.freeze({
      state: 'INSTALLED', installPath: target, version, sha256: verified.sha256,
      files: entries.filter(e => e.type === 'file').length,
      atomic: true, rolledBack: false, networkCalls: 0,
    });
  } catch (error) {
    // `rolledBack: true` means no partial staged/backup state remains; a failure
    // before staging also satisfies it. Only a cleanup failure can set it false.
    let rolledBack = true;
    try {
      if (staging && fsImpl.existsSync(staging)) fsImpl.rmSync(staging, {recursive: true, force: true});
      if (backup && fsImpl.existsSync(backup)) {
        if (target && fsImpl.existsSync(target)) fsImpl.rmSync(target, {recursive: true, force: true});
        fsImpl.renameSync(backup, target);
      }
    } catch { rolledBack = false; }
    return Object.freeze({
      state: 'FAILED', reason: error?.wolfReason || 'OFFLINE_INSTALL_FAILED',
      detail: error?.wolfDetail ?? null, rolledBack, networkCalls: 0,
    });
  }
}

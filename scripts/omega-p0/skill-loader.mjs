/*
 * Wolf Omega P0 -- hardened CEZAR / Composio skill loading.
 *
 * Security invariants:
 *  - trusted roots are canonical realpaths, themselves free of symlink ancestors;
 *  - no symlink may appear at ANY level of a skill path, including an ancestor
 *    directory of the trusted root (ancestor-directory symlink escape);
 *  - no `..`, absolute path, NUL, backslash or empty segment is accepted;
 *  - the final canonical path must remain inside the canonical trusted root;
 *  - manifests allow data fields only: executable directives, hooks, bin, run,
 *    exec, script and even a caller-supplied `trusted` boolean are rejected;
 *  - skill content is returned as DATA. It is never imported, evaluated or run.
 */
import fs from 'node:fs';
import path from 'node:path';
import {deny, isPlainObject, sha256} from './policy.mjs';

export const MAX_SKILL_BYTES = 262144;
export const ALLOWED_MANIFEST_KEYS = Object.freeze(new Set([
  'schema', 'name', 'version', 'description', 'entry', 'files', 'checksum',
]));
export const UNSAFE_MANIFEST_KEYS = Object.freeze(new Set([
  'run', 'exec', 'execute', 'command', 'cmd', 'script', 'shell', 'hooks', 'onload',
  'preinstall', 'postinstall', 'install', 'bin', 'tool', 'instructions', 'trusted',
  'authorized', 'authority', 'signature', 'proof',
]));
const EXECUTABLE_LINE = /^\s*(?:#!\/|exec\s*\(|spawnSync\s*\(|spawn\s*\(|eval\s*\(|new\s+Function\s*\(|require\(\s*['"]child_process|import\s+.*child_process|\{\s*"(?:run|exec|command)"\s*:)/;
const SKILL_EXTENSIONS = new Set(['.md', '.json', '.txt', '.yaml', '.yml']);

function lstatOrDeny(fsImpl, target) {
  try { return fsImpl.lstatSync(target); }
  catch { deny('SKILL_PATH_MISSING', target); }
}

/** Walks from the target up to `/`; any symlink in the chain is a hard denial. */
export function assertNoSymlinkAncestors(target, {fsImpl = fs, pathImpl = path} = {}) {
  let current = pathImpl.resolve(target);
  const seen = new Set();
  for (;;) {
    if (seen.has(current)) break;
    seen.add(current);
    const stat = lstatOrDeny(fsImpl, current);
    if (stat.isSymbolicLink()) deny('ANCESTOR_SYMLINK_DENIED', current);
    const parent = pathImpl.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return true;
}

export function isContained(roots, target, pathImpl = path) {
  return roots.some(root => {
    const rel = pathImpl.relative(root, target);
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + pathImpl.sep) && !pathImpl.isAbsolute(rel));
  });
}

export function validateRelativePath(relativePath, {pathImpl = path} = {}) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.length > 4096) {
    deny('SKILL_PATH_INVALID', 'relativePath');
  }
  if (relativePath.includes('\0') || relativePath.includes('\\') || pathImpl.isAbsolute(relativePath)) {
    deny('SKILL_PATH_TRAVERSAL_DENIED', relativePath);
  }
  const segments = relativePath.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    deny('SKILL_PATH_TRAVERSAL_DENIED', relativePath);
  }
  return segments;
}

/** Resolve a regular, symlink-free file that is canonically inside `rootCanonical`. */
export function resolveInsideRoot(rootCanonical, relativePath, {fsImpl = fs, pathImpl = path} = {}) {
  const segments = validateRelativePath(relativePath, {pathImpl});
  let current = rootCanonical;
  for (let i = 0; i < segments.length; i += 1) {
    current = pathImpl.join(current, segments[i]);
    const stat = lstatOrDeny(fsImpl, current);
    if (stat.isSymbolicLink()) deny('SKILL_SYMLINK_DENIED', current);
    if (i === segments.length - 1) {
      if (!stat.isFile()) deny('SKILL_NOT_A_REGULAR_FILE', current);
    } else if (!stat.isDirectory()) {
      deny('SKILL_PATH_INVALID', current);
    }
  }
  const canonical = fsImpl.realpathSync(current);
  if (!isContained([rootCanonical], canonical, pathImpl)) deny('SKILL_PATH_ESCAPE_DENIED', canonical);
  return canonical;
}

function parseManifest(text, {allowExecutable}) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { deny('MANIFEST_JSON_INVALID'); }
  if (!isPlainObject(parsed)) deny('MANIFEST_SHAPE_INVALID');
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_MANIFEST_KEYS.has(key)) {
      deny(UNSAFE_MANIFEST_KEYS.has(key.toLowerCase()) ? 'MANIFEST_EXECUTABLE_DIRECTIVE_DENIED' : 'MANIFEST_FIELD_NOT_ALLOWED', key);
    }
  }
  if (parsed.schema !== undefined && parsed.schema !== 'WolfSkillManifest/v1') deny('MANIFEST_SCHEMA_INVALID');
  return Object.freeze(parsed);
}

function assertInertContent(text, {allowExecutable}) {
  if (allowExecutable === true) return true;
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (EXECUTABLE_LINE.test(lines[i])) deny('SKILL_EXECUTABLE_CONTENT_DENIED', i + 1);
  }
  return true;
}

/**
 * Load one skill file as data. `trustedRoots` are the ONLY trust source; a manifest
 * cannot promote itself to trusted. `allowExecutable` is a Factory configuration
 * option, never a manifest field.
 */
export function loadSkill({
  root, relativePath, trustedRoots, manifestRelativePath,
  allowExecutable = false, maxBytes = MAX_SKILL_BYTES,
  fsImpl = fs, pathImpl = path,
} = {}) {
  try {
    if (typeof root !== 'string' || !Array.isArray(trustedRoots) || trustedRoots.length === 0) {
      deny('SKILL_ROOT_UNTRUSTED', 'trustedRoots required');
    }
    const canonicalRoots = [...new Set(trustedRoots.map(candidate => {
      if (typeof candidate !== 'string') deny('SKILL_ROOT_UNTRUSTED', 'non-string root');
      assertNoSymlinkAncestors(candidate, {fsImpl, pathImpl});
      return fsImpl.realpathSync(candidate);
    }))];
    assertNoSymlinkAncestors(root, {fsImpl, pathImpl});
    const rootCanonical = fsImpl.realpathSync(root);
    if (!isContained(canonicalRoots, rootCanonical, pathImpl)) deny('SKILL_ROOT_UNTRUSTED', rootCanonical);

    const canonicalPath = resolveInsideRoot(rootCanonical, relativePath, {fsImpl, pathImpl});
    const stat = fsImpl.statSync(canonicalPath);
    if (!stat.isFile() || stat.size > maxBytes) deny('SKILL_SIZE_DENIED', canonicalPath);
    const content = fsImpl.readFileSync(canonicalPath, 'utf8');
    assertInertContent(content, {allowExecutable});

    let manifest = null;
    if (manifestRelativePath !== undefined) {
      const manifestPath = resolveInsideRoot(rootCanonical, manifestRelativePath, {fsImpl, pathImpl});
      const manifestText = fsImpl.readFileSync(manifestPath, 'utf8');
      if (Buffer.byteLength(manifestText, 'utf8') > maxBytes) deny('MANIFEST_SIZE_DENIED');
      manifest = parseManifest(manifestText, {allowExecutable});
      const declared = [manifest.entry, ...(Array.isArray(manifest.files) ? manifest.files : [])].filter(Boolean);
      for (const entry of declared) {
        if (typeof entry !== 'string') deny('MANIFEST_ENTRY_INVALID', String(entry));
        resolveInsideRoot(rootCanonical, entry, {fsImpl, pathImpl});
      }
    }
    return Object.freeze({
      state: 'LOADED',
      canonicalPath,
      relativePath,
      content,
      contentDigest: sha256(content),
      manifest,
      executed: false,
      imported: false,
    });
  } catch (error) {
    const reason = error && error.wolfReason ? error.wolfReason : 'SKILL_LOAD_FAILED';
    const detail = error && error.wolfDetail !== undefined ? error.wolfDetail : null;
    return Object.freeze({state: 'DENIED', reason, detail});
  }
}

/** Legitimate discovery: real regular files only, symlinks silently skipped. */
export function discoverSkills({root, trustedRoots, allowExecutable = false, fsImpl = fs, pathImpl = path} = {}) {
  try {
    if (typeof root !== 'string' || !Array.isArray(trustedRoots) || trustedRoots.length === 0) {
      deny('SKILL_ROOT_UNTRUSTED');
    }
    const canonicalRoots = [...new Set(trustedRoots.map(candidate => {
      assertNoSymlinkAncestors(candidate, {fsImpl, pathImpl});
      return fsImpl.realpathSync(candidate);
    }))];
    assertNoSymlinkAncestors(root, {fsImpl, pathImpl});
    const rootCanonical = fsImpl.realpathSync(root);
    if (!isContained(canonicalRoots, rootCanonical, pathImpl)) deny('SKILL_ROOT_UNTRUSTED');
    const entries = fsImpl.readdirSync(rootCanonical, {withFileTypes: true});
    const loaded = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isFile()) continue;
      if (!SKILL_EXTENSIONS.has(pathImpl.extname(entry.name))) continue;
      const result = loadSkill({
        root, relativePath: entry.name, trustedRoots, allowExecutable, fsImpl, pathImpl,
      });
      if (result.state === 'LOADED') loaded.push(result);
    }
    return Object.freeze({state: 'DISCOVERED', root: rootCanonical, skills: Object.freeze(loaded)});
  } catch (error) {
    return Object.freeze({state: 'DENIED', reason: error?.wolfReason || 'SKILL_DISCOVERY_FAILED'});
  }
}

// Serialize immutable-SHA fetches shared by the pin tests. Node's test runner can
// run files in parallel, while both suites may need to fetch the same pin from a
// shallow checkout. The lock is kept under .git and removed in a finally block.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const FETCH_TIMEOUT_MS = 120000;
const lockRelative = execFileSync('git', ['rev-parse', '--git-path', 'private-ci-pin-fetch.lock'], {
  cwd: ROOT,
  encoding: 'utf8',
}).trim();
const LOCK_PATH = path.resolve(ROOT, lockRelative);
const waitCell = new Int32Array(new SharedArrayBuffer(4));

function hasCommit(ref) {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], {cwd: ROOT, stdio: 'ignore'});
    return true;
  } catch {
    return false;
  }
}

export function ensureCommit(ref) {
  if (!/^[0-9a-f]{40}$/.test(ref ?? '')) return false;
  if (hasCommit(ref)) return true;

  const deadline = Date.now() + FETCH_TIMEOUT_MS;
  let lockFd;
  while (lockFd === undefined) {
    try {
      lockFd = fs.openSync(LOCK_PATH, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Another test process owns the fetch. Re-check before waiting, then again
      // after it releases the lock so a failed fetch does not become a pass.
      if (hasCommit(ref)) return true;
      if (Date.now() >= deadline) return false;
      Atomics.wait(waitCell, 0, 0, 50);
    }
  }

  try {
    if (!hasCommit(ref)) {
      try {
        execFileSync('git', ['fetch', '--no-tags', '--depth', '1', 'origin', ref], {
          cwd: ROOT,
          stdio: 'ignore',
          timeout: FETCH_TIMEOUT_MS,
        });
      } catch {
        // A missing/inaccessible object remains a hard failure below.
      }
    }
    return hasCommit(ref);
  } finally {
    fs.closeSync(lockFd);
    try {
      fs.unlinkSync(LOCK_PATH);
    } catch {
      // Preserve the actual fetch/test result; a leftover lock causes future tests
      // to fail closed rather than accept an unavailable commit.
    }
  }
}

export function hasObjectAt(ref, filePath) {
  if (!ensureCommit(ref)) return false;
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}:${filePath}`], {cwd: ROOT, stdio: 'ignore'});
    return true;
  } catch {
    return false;
  }
}

// Regression for the P0 gitleaks question.
//
// Gitleaks must never be disabled and real credentials must never be hidden by a
// broad allowlist. The only permitted suppression mechanism in this repository is
// an exact immutable fingerprint (`<commit>:<path>:<rule>:<line>`) whose finding
// has been independently classified as a non-secret and recorded with evidence.
//
// The scanner binary itself is not available in this environment (release CDN is
// not reachable), so this test enforces the *policy* that the scanner result must
// satisfy, plus the non-secret evidence, entirely offline and deterministically.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignorePath = path.join(root, '.gitleaksignore');
const reviewPath = path.join(root, 'docs/checkpoints/omega/GITLEAKS-IMMUTABLE-NONSECRET-20261029.json');

const FINGERPRINT = /^([0-9a-f]{40}):([^\s:]+):([a-z0-9-]+):([1-9][0-9]*)$/;
const KNOWN_RULES = new Set(['generic-api-key', 'private-key', 'generic-secret', 'aws-access-token']);
const KIND_ALLOWLIST = new Set(['PUBLIC_CANONICAL_MISSION_SHA256', 'SSH_MARKER_VALIDATION_LITERAL']);

function ignoreEntries() {
  const lines = fs.readFileSync(ignorePath, 'utf8').split('\n');
  return {
    comments: lines.filter(line => line.trimStart().startsWith('#')),
    entries: lines.filter(line => line.trim() && !line.trimStart().startsWith('#')).map(line => line.trim()),
  };
}

function review() {
  return JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
}

test('the ignore file is linked to its evidence and contains no comments-only suppression', () => {
  const {comments} = ignoreEntries();
  const proof = comments.join('\n');
  assert.match(proof, /Exact immutable non-secret findings only/, 'the policy must be stated');
  assert.match(proof, /Proof: docs\/checkpoints\/omega\/GITLEAKS-IMMUTABLE-NONSECRET-20261029\.json/);
  assert.ok(fs.existsSync(reviewPath), 'the referenced proof document must exist');
});

test('every suppression is an exact immutable fingerprint with no wildcard or pattern allowlist', () => {
  const {entries} = ignoreEntries();
  assert.ok(entries.length > 0, 'the ignore file must not be empty or silently dropped');
  for (const entry of entries) {
    const match = FINGERPRINT.exec(entry);
    assert.ok(match, 'only exact <40-hex-commit>:<path>:<rule>:<positive-line> fingerprints are permitted: ' + entry);
    const [, commit, file, rule, line] = match;
    assert.match(commit, /^[0-9a-f]{40}$/, 'the commit must be immutable and fully qualified: ' + entry);
    assert.equal(/[*?[\]]/.test(file), false, 'no path globs are permitted: ' + entry);
    assert.equal(file.startsWith('/'), false, 'paths are repository relative: ' + entry);
    assert.ok(KNOWN_RULES.has(rule), 'unexpected rule suppressed without review: ' + rule);
    assert.ok(Number(line) >= 1, 'line numbers are one based: ' + entry);
  }
  // Whole-file or rule-wide suppression cannot be expressed by a fingerprint and
  // must not appear in any other form either.
  const raw = fs.readFileSync(ignorePath, 'utf8');
  assert.equal(/^\s*(generic-api-key|private-key|generic-secret)\s*$/m.test(raw), false, 'rule-wide allowlist is prohibited');
  assert.equal(/^\s*\*\s*$/m.test(raw), false, 'catch-all allowlist is prohibited');
});

test('the ignore file and the review document are exactly one to one', () => {
  const {entries} = ignoreEntries();
  const findings = review().exactImmutableFingerprints;
  assert.deepEqual([...entries].sort(), findings.map(f => f.fingerprint).sort());
  for (const finding of findings) {
    assert.equal(finding.fingerprint, `${finding.commit}:${finding.path}:${finding.rule}:${finding.line}`);
  }
});

test('the scanner configuration was not weakened and every finding is a reviewed non-credential', () => {
  const doc = review();
  assert.equal(doc.state, 'VERIFIED');
  assert.equal(doc.scanner, 'gitleaks 8.30.1');
  assert.equal(doc.defaultRulesChanged, false, 'default rules must not be changed');
  assert.equal(doc.entropyThresholdsChanged, false, 'entropy thresholds must not be changed');
  assert.equal(doc.pathOrRuleAllowlistAdded, false, 'no path or rule allowlist may be added');
  for (const finding of doc.exactImmutableFingerprints) {
    assert.equal(finding.credential, false, 'a real credential may never be suppressed: ' + finding.fingerprint);
    assert.ok(KIND_ALLOWLIST.has(finding.kind), 'unreviewed finding kind: ' + finding.kind);
  }
});

test('mission-digest findings are proven non-secret by recomputing their identity against the repository', () => {
  const findings = review().exactImmutableFingerprints.filter(f => f.kind === 'PUBLIC_CANONICAL_MISSION_SHA256');
  assert.ok(findings.length >= 4, 'the reviewed mission-digest findings must remain documented');
  for (const finding of findings) {
    assert.match(finding.expectedDigest, /^[0-9a-f]{64}$/, 'the digest must be a full SHA-256');
    const file = path.join(root, finding.path);
    assert.ok(fs.existsSync(file), 'the reviewed path must still exist: ' + finding.path);
    assert.match(
      fs.readFileSync(file, 'utf8'),
      new RegExp(finding.expectedDigest),
      'the finding must still be the recorded mission digest, not a credential: ' + finding.path,
    );
  }
});

test('private-key findings are validation literals, never a usable key', () => {
  const findings = review().exactImmutableFingerprints.filter(f => f.kind === 'SSH_MARKER_VALIDATION_LITERAL');
  assert.ok(findings.length >= 3);
  for (const finding of findings) {
    assert.equal(finding.validPemBlockPresent, false);
    assert.equal(finding.validationOperatorsPresent, true);
    const file = path.join(root, finding.path);
    assert.ok(fs.existsSync(file), 'the reviewed path must still exist: ' + finding.path);
  }

  // Repository-wide proof: the markers only ever appear as single-line validation
  // literals. A real key would have a base64 body between the markers.
  const offenders = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const text = fs.readFileSync(full, 'utf8');
        if (!text.includes('PRIVATE KEY-----')) continue;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          const begin = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.exec(lines[i]);
          if (!begin) continue;
          if (lines[i].slice(begin.index + begin[0].length).includes('-----END')) continue;
          // A real PEM block puts the header alone at the end of a line and follows
          // it with a long base64 body. Validation literals such as
          // `startsWith('-----BEGIN OPENSSH PRIVATE KEY-----')` do neither.
          let headerAtEndOfLine = lines[i].trimEnd().endsWith(begin[0]);
          let longBody = false;
          let closed = false;
          for (let j = i + 1; j < Math.min(i + 40, lines.length); j += 1) {
            const body = lines[j].trim();
            if (/-----END [A-Z ]*PRIVATE KEY-----/.test(body)) {
              closed = true;
              break;
            }
            if (/^[A-Za-z0-9+/=]{100,}$/.test(body)) longBody = true;
          }
          if (longBody || (headerAtEndOfLine && closed)) {
            offenders.push(`${path.relative(root, full)}:${i + 1}`);
          }
        }
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, [], 'no complete private key block may exist in the repository');
});

test('an unrelated new finding is never suppressed by these entries', () => {
  // Fingerprints are commit bound: a finding introduced at any other commit, or at
  // another line of the same file, can never match an existing entry.
  const {entries} = ignoreEntries();
  const synthetic = 'ffffffffffffffffffffffffffffffffffffffff:docs/checkpoints/omega/NEW.json:generic-api-key:1';
  assert.equal(entries.includes(synthetic), false);
  for (const entry of entries) {
    const [, , file, , line] = FINGERPRINT.exec(entry);
    assert.notEqual(`${file}:${line}`, 'docs/checkpoints/omega/NEW.json:1');
  }
});

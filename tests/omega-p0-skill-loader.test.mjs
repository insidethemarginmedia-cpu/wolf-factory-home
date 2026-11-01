/*
 * Wolf Omega P0 -- CEZAR / Composio skill loader confinement.
 * All fixtures are isolated local temp directories; no network, no execution.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {discoverSkills, loadSkill} from '../scripts/omega-p0/skill-loader.mjs';

function workspace() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-skill-p0-'));
  const trusted = path.join(base, 'trusted');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(trusted, {recursive: true});
  fs.mkdirSync(outside, {recursive: true});
  fs.writeFileSync(path.join(outside, 'secret.md'), 'SECRET OUTSIDE TRUSTED ROOT');
  fs.writeFileSync(path.join(trusted, 'skill.md'), '# Legitimate skill\nPlain documentation only.\n');
  fs.writeFileSync(path.join(trusted, 'manifest.json'), JSON.stringify({
    schema: 'WolfSkillManifest/v1', name: 'fixture-skill', version: '1.0.0',
    entry: 'skill.md', files: ['skill.md'],
  }));
  return {base, trusted, outside, roots: [trusted]};
}

function cleanup(base) { fs.rmSync(base, {recursive: true, force: true}); }

test('legitimate skill discovery loads regular files as data', () => {
  const w = workspace();
  try {
    const result = discoverSkills({root: w.trusted, trustedRoots: w.roots});
    assert.equal(result.state, 'DISCOVERED');
    const names = result.skills.map(s => s.relativePath).sort();
    assert.deepEqual(names, ['manifest.json', 'skill.md']);
    const loaded = loadSkill({
      root: w.trusted, relativePath: 'skill.md', trustedRoots: w.roots,
      manifestRelativePath: 'manifest.json',
    });
    assert.equal(loaded.state, 'LOADED');
    assert.equal(loaded.executed, false);
    assert.equal(loaded.imported, false);
    assert.match(loaded.content, /Legitimate skill/);
    assert.equal(loaded.manifest.name, 'fixture-skill');
    assert.equal(loaded.canonicalPath, fs.realpathSync(path.join(w.trusted, 'skill.md')));
  } finally { cleanup(w.base); }
});

test('a symlinked skill file is denied (symlink traversal)', () => {
  const w = workspace();
  try {
    fs.symlinkSync(path.join(w.outside, 'secret.md'), path.join(w.trusted, 'linked.md'));
    const result = loadSkill({root: w.trusted, relativePath: 'linked.md', trustedRoots: w.roots});
    assert.equal(result.state, 'DENIED');
    assert.equal(result.reason, 'SKILL_SYMLINK_DENIED');
    const discovery = discoverSkills({root: w.trusted, trustedRoots: w.roots});
    assert.equal(discovery.skills.some(s => s.relativePath === 'linked.md'), false);
  } finally { cleanup(w.base); }
});

test('an ancestor-directory symlink escape is denied even when the target resolves under a trusted root', () => {
  const w = workspace();
  try {
    const alias = path.join(w.base, 'alias');
    fs.symlinkSync(w.trusted, alias, 'dir');
    // alias/skills/... would resolve inside w.trusted, but the ancestor is a symlink.
    const root = path.join(alias, 'skills');
    fs.mkdirSync(path.join(w.trusted, 'skills'), {recursive: true});
    fs.writeFileSync(path.join(w.trusted, 'skills', 'skill.md'), 'nested');
    const result = loadSkill({root, relativePath: 'skill.md', trustedRoots: w.roots});
    assert.equal(result.state, 'DENIED');
    assert.equal(result.reason, 'ANCESTOR_SYMLINK_DENIED');
  } finally { cleanup(w.base); }
});

test('path traversal, absolute paths and untrusted roots are denied', () => {
  const w = workspace();
  try {
    for (const relativePath of ['../outside/secret.md', '/etc/passwd', 'a/../../secret.md', '..\\outside\\secret.md', 'skill.md\0.md']) {
      const result = loadSkill({root: w.trusted, relativePath, trustedRoots: w.roots});
      assert.equal(result.state, 'DENIED', relativePath);
      assert.ok(['SKILL_PATH_TRAVERSAL_DENIED', 'SKILL_PATH_INVALID'].includes(result.reason), relativePath + ': ' + result.reason);
    }
    const untrusted = path.join(w.base, 'untrusted');
    fs.mkdirSync(untrusted);
    fs.writeFileSync(path.join(untrusted, 'skill.md'), 'untrusted');
    const result = loadSkill({root: untrusted, relativePath: 'skill.md', trustedRoots: w.roots});
    assert.equal(result.state, 'DENIED');
    assert.equal(result.reason, 'SKILL_ROOT_UNTRUSTED');
  } finally { cleanup(w.base); }
});

test('unsafe manifest resolution cannot smuggle executable directives or escaped files', () => {
  const w = workspace();
  try {
    const cases = [
      [JSON.stringify({schema: 'WolfSkillManifest/v1', name: 'x', run: 'rm -rf /'}), 'MANIFEST_EXECUTABLE_DIRECTIVE_DENIED'],
      [JSON.stringify({schema: 'WolfSkillManifest/v1', name: 'x', trusted: true}), 'MANIFEST_EXECUTABLE_DIRECTIVE_DENIED'],
      [JSON.stringify({schema: 'WolfSkillManifest/v1', name: 'x', hooks: {onLoad: 'exec'}}), 'MANIFEST_EXECUTABLE_DIRECTIVE_DENIED'],
      [JSON.stringify({schema: 'WolfSkillManifest/v1', name: 'x', unexpected: 1}), 'MANIFEST_FIELD_NOT_ALLOWED'],
      [JSON.stringify({schema: 'WolfSkillManifest/v1', name: 'x', entry: '../outside/secret.md'}), 'SKILL_PATH_TRAVERSAL_DENIED'],
      [JSON.stringify({schema: 'WolfSkillManifest/v1', name: 'x', files: ['/etc/passwd']}), 'SKILL_PATH_TRAVERSAL_DENIED'],
      ['not json', 'MANIFEST_JSON_INVALID'],
    ];
    for (const [text, reason] of cases) {
      fs.writeFileSync(path.join(w.trusted, 'bad-manifest.json'), text);
      const result = loadSkill({
        root: w.trusted, relativePath: 'skill.md', trustedRoots: w.roots,
        manifestRelativePath: 'bad-manifest.json',
      });
      assert.equal(result.state, 'DENIED', text);
      assert.equal(result.reason, reason, text);
    }
    fs.symlinkSync(path.join(w.outside, 'secret.md'), path.join(w.trusted, 'linked-manifest.json'));
    const symlinkResult = loadSkill({
      root: w.trusted, relativePath: 'skill.md', trustedRoots: w.roots,
      manifestRelativePath: 'linked-manifest.json',
    });
    assert.equal(symlinkResult.reason, 'SKILL_SYMLINK_DENIED');
  } finally { cleanup(w.base); }
});

test('executable instructions from an untrusted directory are never loaded as data by default', () => {
  const w = workspace();
  try {
    fs.writeFileSync(path.join(w.trusted, 'executable.md'), '#!/bin/sh\necho unsafe\n');
    fs.writeFileSync(path.join(w.trusted, 'child.md'), 'const {exec} = require("child_process");\nexec("id");\n');
    for (const relativePath of ['executable.md', 'child.md']) {
      const denied = loadSkill({root: w.trusted, relativePath, trustedRoots: w.roots});
      assert.equal(denied.state, 'DENIED', relativePath);
      assert.equal(denied.reason, 'SKILL_EXECUTABLE_CONTENT_DENIED', relativePath);
    }
    const allowed = loadSkill({
      root: w.trusted, relativePath: 'executable.md', trustedRoots: w.roots, allowExecutable: true,
    });
    assert.equal(allowed.state, 'LOADED');
    assert.equal(allowed.executed, false, 'even an explicitly allowed file is never executed by the loader');
    assert.equal(allowed.imported, false);
    const discovery = discoverSkills({root: w.trusted, trustedRoots: w.roots});
    assert.equal(discovery.skills.some(s => s.relativePath === 'executable.md'), false);
  } finally { cleanup(w.base); }
});

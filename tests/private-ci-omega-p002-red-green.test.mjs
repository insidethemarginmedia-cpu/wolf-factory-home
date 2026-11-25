import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import test from 'node:test';
import {DEFAULT_REQUIRED_CHECKS, normalizeChecks as normalizeBridgeChecks, sanitizeReceiptChecks, verifyReceiptBinding} from '../scripts/private-ci-bridge.mjs';
import {ALLOWED_CHECKS} from '../scripts/private-ci-contract.mjs';
import {signReceipt} from '../scripts/private-ci-receipt.mjs';
import {buildUntrustedInvocation, executePrivateCi, inspectCheckout, workflowChildEnvironment} from '../scripts/private-ci-execute.mjs';
import {validateMission, MISSION_STATES} from '../scripts/private-ci-mission.mjs';
import {auditCredentialExposure, checkDispatch} from '../scripts/private-ci-app-acceptance.mjs';

const SHA = 'a'.repeat(40);
const REPO = 'donraposo1-source/project-wolf';
const TREE_SHA = 'd'.repeat(40);
const SIGNING_KEY = 'omega synthetic receipt signing key for tests only';
const MISSION_ID = 'MISSION-TEST-0001';
const RESERVATION_KEY = 'e'.repeat(64);
const ALL_CHECKS = [...ALLOWED_CHECKS];
const MISSION_BINDING = {missionId: MISSION_ID, missionReservation: RESERVATION_KEY};

function gitFixture({workflow = null} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-omega-p002-git-'));
  fs.mkdirSync(path.join(root, '.github', 'workflows'), {recursive: true});
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name: 'fixture', scripts: {test: 'node -e "process.exit(0)"'}}));
  if (workflow) fs.writeFileSync(path.join(root, '.github', 'workflows', 'postgres-concurrency-evidence.yml'), workflow);
  execFileSync('git', ['init', '-q'], {cwd: root});
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:donraposo1-source/project-wolf.git'], {cwd: root});
  execFileSync('git', ['config', 'user.name', 'Omega Fixture'], {cwd: root});
  execFileSync('git', ['config', 'user.email', 'omega-fixture@example.invalid'], {cwd: root});
  execFileSync('git', ['add', '.'], {cwd: root});
  execFileSync('git', ['commit', '-qm', 'fixture'], {cwd: root});
  return {root, sha: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim()};
}

function outputDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-omega-p002-output-'));
}

function signedReceipt({schema = 'wolf.private-ci.receipt/v1', state = 'VERIFIED', failingCheck = null, ...overrides} = {}) {
  const checkNames = [...ALL_CHECKS];
  const failedChecks = failingCheck ? [failingCheck] : [];
  const receipt = {
    schema,
    state,
    sha: SHA,
    treeSha: TREE_SHA,
    repository: REPO,
    checkout: {sha: SHA, treeSha: TREE_SHA, cleanBefore: true, cleanAfter: true, finalSha: SHA, finalTreeSha: TREE_SHA},
    testBinding: {sha: SHA, treeSha: TREE_SHA, checks: checkNames},
    missionBinding: {missionId: MISSION_ID, reservationKey: RESERVATION_KEY, sha: SHA},
    checks: checkNames.map(name => ({name, sha: SHA, treeSha: TREE_SHA, status: name === failingCheck ? 'failure' : 'success'})),
    requiredChecks: checkNames.filter(name => DEFAULT_REQUIRED_CHECKS.includes(name)),
    extraChecks: checkNames.filter(name => !DEFAULT_REQUIRED_CHECKS.includes(name)),
    failedChecks,
    startedAt: '2026-11-25T00:00:00.000Z',
    completedAt: '2026-11-25T00:00:01.000Z',
    failure: failingCheck ? `${failingCheck}:1` : null,
    sourceIntegrityFailure: null,
    ...overrides,
  };
  return signReceipt(receipt, SIGNING_KEY);
}

const jsonResponse = (status, body = null) => ({ok: status >= 200 && status < 300, status, json: async () => body});

function workflowFileContent() {
  return Buffer.from([
    'name: Private CI',
    'on:',
    '  workflow_dispatch:',
    '    inputs:',
    '      sha:',
    '        required: true',
    '      pr:',
    '        required: false',
    'jobs:',
    '  verify:',
    '    steps:',
    '      - run: echo check',
  ].join('\n')).toString('base64');
}

function dispatchFetch({runs = [], checkRuns = [], workflowStatus = 200} = {}) {
  let dispatches = 0;
  let runReads = 0;
  const run = {
    id: 100,
    workflow_id: 77,
    event: 'workflow_dispatch',
    head_branch: 'main',
    head_sha: 'b'.repeat(40),
    created_at: new Date().toISOString(),
    status: 'completed',
    conclusion: 'success',
  };
  return {
    counts: () => ({dispatches, runReads}),
    run,
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith('/actions/workflows/private-ci.yml')) {
        return jsonResponse(workflowStatus, workflowStatus === 200 ? {id: 77, path: '.github/workflows/private-ci.yml', state: 'active'} : {});
      }
      if (url.includes('/contents/.github/workflows/private-ci.yml')) {
        return jsonResponse(200, {encoding: 'base64', content: workflowFileContent()});
      }
      if (url.includes('/actions/workflows/77/runs?per_page=100')) {
        runReads += 1;
        const currentRuns = runReads === 1 ? [] : (typeof runs === 'function' ? runs(runReads, run) : runs);
        return jsonResponse(200, {total_count: currentRuns.length, workflow_runs: currentRuns});
      }
      if (url.includes('/actions/runs/100')) return jsonResponse(200, run);
      if (url.includes(`/commits/${SHA}/check-runs`)) return jsonResponse(200, {check_runs: checkRuns});
      if (url.includes('/workflows?')) return jsonResponse(200, {workflows: [{id: 9, path: '.github/workflows/actionlint.yml'}]});
      if (url.endsWith('/dispatches')) { dispatches += 1; return jsonResponse(204, null); }
      return jsonResponse(404, {});
    },
  };
}

test('receipt verifier rejects fabricated failed state, unsupported schema, tampering and failed extra checks', () => {
  const fabricated = {
    schema: 'forged', state: 'FAILED', sha: SHA, repository: REPO,
    receiptHash: 'not-a-hash', checks: [...DEFAULT_REQUIRED_CHECKS.map(name => ({name, status: 'success'})), {name: 'postgres-concurrency', status: 'failure'}],
  };
  const fabricatedVerdict = verifyReceiptBinding(fabricated, {sha: SHA, repository: REPO, checks: ALL_CHECKS, signingKey: SIGNING_KEY});
  assert.equal(fabricatedVerdict.state, 'REJECTED');
  assert.equal(fabricatedVerdict.reason, 'RECEIPT_SCHEMA_UNSUPPORTED');
  const unsupported = signedReceipt();
  unsupported.schema = 'forged';
  assert.equal(verifyReceiptBinding(unsupported, {sha: SHA, repository: REPO, checks: ALL_CHECKS, signingKey: SIGNING_KEY}).reason, 'RECEIPT_SCHEMA_UNSUPPORTED');
  const tampered = signedReceipt();
  tampered.checks[0].status = 'failure';
  assert.equal(verifyReceiptBinding(tampered, {sha: SHA, repository: REPO, checks: ALL_CHECKS, signingKey: SIGNING_KEY}).reason, 'RECEIPT_HASH_MISMATCH');
  const failedExtra = signedReceipt({state: 'FAILED', failingCheck: 'postgres-concurrency'});
  const verdict = verifyReceiptBinding(failedExtra, {sha: SHA, repository: REPO, checks: ALL_CHECKS, signingKey: SIGNING_KEY, missionId: MISSION_ID, reservationKey: RESERVATION_KEY});
  assert.equal(verdict.state, 'FAILED');
  assert.deepEqual(verdict.unsuccessful, ['postgres-concurrency']);
});

test('bridge accepts the executor job’s complete 13-check contract', () => {
  const fullCheckList = 'security,lint,typecheck,unit,integration,build,migrations,postgres-concurrency,postgres-schema,test,http-load-evidence,ocr-tesseract,ocr-paddle';
  assert.equal(normalizeBridgeChecks(fullCheckList).length, 13);
});

test('public receipt summary drops all free-form target-controlled command and log fields', () => {
  const canary = 'PRIVATE_TARGET_OUTPUT_CANARY_OMEGA';
  const safe = sanitizeReceiptChecks([{
    name: 'postgres-schema', status: 'failure', durationMs: 1250,
    privateField: canary,
    steps: [{
      stepIndex: 3,
      workflow: '.github/workflows/postgres-schema.yml',
      exitCode: 1,
      expectedExitCodes: [0],
      status: 'failure',
      durationMs: 50,
      command: 'bash',
      args: ['-c', `printf ${canary}`],
      stepName: canary,
      label: canary,
      errorLine: canary,
      sqlDetail: {DETAIL: canary},
      logTail: canary,
      python: {index: canary},
    }],
  }]);
  assert.deepEqual(safe, [{
    name: 'postgres-schema', status: 'failure', durationMs: 1250,
    steps: [{stepIndex: 3, workflow: '.github/workflows/postgres-schema.yml', exitCode: 1, expectedExitCodes: [0], status: 'failure', durationMs: 50}],
  }]);
  assert.equal(JSON.stringify(safe).includes(canary), false);
});

test('executor refuses to sign an arbitrary SHA from a non-Git directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-omega-p002-non-git-'));
  const out = outputDir();
  assert.throws(() => executePrivateCi({root, sha: SHA, checks: 'unit', logDir: path.join(out, 'logs'), signingKey: SIGNING_KEY, ...MISSION_BINDING}), /EXECUTOR_CHECKOUT_REQUIRED/);
  fs.rmSync(root, {recursive: true, force: true});
  fs.rmSync(out, {recursive: true, force: true});
});

test('executor rejects a caller-supplied SHA that differs from the actual checkout HEAD', () => {
  const {root} = gitFixture();
  const out = outputDir();
  assert.throws(() => executePrivateCi({root, sha: SHA, checks: 'unit', logDir: path.join(out, 'logs'), signingKey: SIGNING_KEY, ...MISSION_BINDING}), /EXECUTOR_CHECKOUT_SHA_MISMATCH/);
  fs.rmSync(root, {recursive: true, force: true});
  fs.rmSync(out, {recursive: true, force: true});
});

test('executor rejects a matching SHA from an unrelated repository origin', () => {
  const {root, sha} = gitFixture();
  execFileSync('git', ['remote', 'set-url', 'origin', 'git@github.com:another-owner/unrelated-repo.git'], {cwd: root});
  const out = outputDir();
  assert.throws(() => executePrivateCi({root, sha, checks: 'unit', logDir: path.join(out, 'logs'), signingKey: SIGNING_KEY, ...MISSION_BINDING}), /EXECUTOR_CHECKOUT_REPOSITORY_MISMATCH/);
  fs.rmSync(root, {recursive: true, force: true});
  fs.rmSync(out, {recursive: true, force: true});
});

test('executor rejects a dirty checkout instead of binding a modified tree to HEAD', () => {
  const {root, sha} = gitFixture({workflow: [
    'jobs:', '  measure:', '    steps:', '      - name: Inspect', '        run: echo clean',
  ].join('\n')});
  fs.appendFileSync(path.join(root, '.github', 'workflows', 'postgres-concurrency-evidence.yml'), '\n# changed after commit\n');
  const out = outputDir();
  assert.throws(() => executePrivateCi({root, sha, checks: 'postgres-concurrency', logDir: path.join(out, 'logs'), signingKey: SIGNING_KEY, ...MISSION_BINDING}), /EXECUTOR_CHECKOUT_DIRTY/);
  fs.rmSync(root, {recursive: true, force: true});
  fs.rmSync(out, {recursive: true, force: true});
});

test('executor refuses a pre-existing symlink log directory before any workflow command runs', () => {
  const {root, sha} = gitFixture({workflow: [
    'jobs:', '  measure:', '    steps:', '      - name: Should not run', '        run: echo should-not-run',
  ].join('\n')});
  const out = outputDir();
  const target = path.join(out, 'attacker-target');
  fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(out, 'logs'), 'dir');
  assert.throws(() => executePrivateCi({root, sha, checks: 'postgres-concurrency', logDir: path.join(out, 'logs'), signingKey: SIGNING_KEY, ...MISSION_BINDING}), /EXECUTOR_LOG_DIR_ALREADY_EXISTS/);
  assert.deepEqual(fs.readdirSync(target), []);
  fs.rmSync(root, {recursive: true, force: true});
  fs.rmSync(out, {recursive: true, force: true});
});

test('trusted checkout inspection disables repository-configured executable Git monitors', () => {
  const {root, sha} = gitFixture();
  const out = outputDir();
  const marker = path.join(out, 'fsmonitor-executed');
  const monitor = path.join(out, 'fsmonitor.sh');
  fs.writeFileSync(monitor, `#!/bin/sh\ntouch '${marker}'\nprintf '0\\n'\n`, {mode: 0o700});
  execFileSync('git', ['config', 'core.fsmonitor', monitor], {cwd: root});
  assert.equal(inspectCheckout({root, sha}).clean, true);
  assert.equal(fs.existsSync(marker), false, 'trusted Git status must not execute checkout-controlled monitors');
  fs.rmSync(root, {recursive: true, force: true});
  fs.rmSync(out, {recursive: true, force: true});
});

test('workflow child environment receives none of the bridge or GitHub credentials', () => {
  const child = workflowChildEnvironment({
    parent: {PATH: '/usr/bin', HOME: '/home/runner', GITHUB_TOKEN: 'parent-github', WOLF_CI_APP_READER_TOKEN: 'parent-reader'},
    env: {WOLF_CI_APP_READER_TOKEN: 'explicit-reader', WOLF_CI_RECEIPT_SIGNING_KEY: SIGNING_KEY, PGPASSWORD: 'local-db-password'},
    stepEnv: {WOLF_CI_APP_PUBLISHER_TOKEN: 'step-publisher', WOLF_FACTORY_DEPLOY_KEY: 'private-key'},
    isolatedHome: '/tmp/omega-untrusted-home',
    safeGitDirectory: '/tmp/wolf-private',
  });
  assert.equal(child.GITHUB_TOKEN, undefined);
  assert.equal(child.WOLF_CI_APP_READER_TOKEN, undefined);
  assert.equal(child.WOLF_CI_APP_PUBLISHER_TOKEN, undefined);
  assert.equal(child.WOLF_FACTORY_DEPLOY_KEY, undefined);
  assert.equal(child.WOLF_CI_RECEIPT_SIGNING_KEY, undefined);
  assert.equal(child.PGPASSWORD, 'local-db-password');
  assert.equal(child.HOME, '/tmp/omega-untrusted-home');
  assert.equal(child.TMPDIR, '/tmp/omega-untrusted-home/tmp');
  assert.equal(child.GIT_CONFIG_COUNT, '1');
  assert.equal(child.GIT_CONFIG_KEY_0, 'safe.directory');
  assert.equal(child.GIT_CONFIG_VALUE_0, '/tmp/wolf-private');
  assert.equal(child.GIT_OPTIONAL_LOCKS, '0');
  const invocation = buildUntrustedInvocation('node', ['scripts/check.mjs'], {user: 'wolf-ci-untrusted', env: child});
  assert.deepEqual(invocation.args.slice(0, 5), ['-n', '-u', 'wolf-ci-untrusted', '--', '/usr/bin/env']);
  assert.equal(invocation.env.WOLF_CI_RECEIPT_SIGNING_KEY, undefined);
  assert.throws(() => buildUntrustedInvocation('node', [], {user: 'wolf-ci-untrusted', env: {WOLF_CI_RECEIPT_SIGNING_KEY: SIGNING_KEY}}), /EXECUTOR_SANDBOX_ENV_DENIED/);
});

test('executor test child process cannot see reader, publisher, dispatcher or GitHub tokens', () => {
  const workflow = [
    'jobs:', '  measure:', '    steps:', '      - name: Inspect token environment',
    '        run: node -e "const keys=[\'WOLF_CI_APP_READER_TOKEN\',\'WOLF_CI_APP_PUBLISHER_TOKEN\',\'WOLF_CI_APP_DISPATCHER_TOKEN\',\'GITHUB_TOKEN\']; console.log(keys.map(k=>process.env[k] ? \'PRESENT\' : \'ABSENT\').join(\',\'))"',
  ].join('\n');
  const {root, sha} = gitFixture({workflow});
  const out = outputDir();
  const logDir = path.join(out, 'logs');
  const receipt = executePrivateCi({
    root, sha, checks: 'postgres-concurrency', logDir, signingKey: SIGNING_KEY, ...MISSION_BINDING,
    env: {
      WOLF_CI_APP_READER_TOKEN: 'fake-reader-token',
      WOLF_CI_APP_PUBLISHER_TOKEN: 'fake-publisher-token',
      WOLF_CI_APP_DISPATCHER_TOKEN: 'fake-dispatcher-token',
      GITHUB_TOKEN: 'fake-github-token',
    },
  });
  assert.equal(receipt.state, 'VERIFIED');
  const log = fs.readFileSync(path.join(logDir, 'postgres-concurrency-1.log'), 'utf8');
  assert.match(log, /ABSENT,ABSENT,ABSENT,ABSENT/);
  assert.doesNotMatch(log, /fake-(reader|publisher|dispatcher|github)-token/);
  fs.rmSync(root, {recursive: true, force: true});
  fs.rmSync(out, {recursive: true, force: true});
});

const OS_TEST_USER = `wolfci-test-${process.pid}`;
const CAN_RUN_OS_ISOLATION_TEST = process.platform === 'linux'
  && spawnSync('sudo', ['-n', 'true']).status === 0
  && fs.existsSync('/usr/sbin/useradd')
  && fs.existsSync('/usr/sbin/userdel')
  && fs.existsSync('/usr/bin/pkill')
  && fs.existsSync('/usr/bin/pgrep');

test('a separate OS identity cannot read signer state, alter Git metadata, forge logs, or outlive checkout verification', {skip: !CAN_RUN_OS_ISOLATION_TEST}, async () => {
  const signingKey = 'synthetic only process-isolation signing key for OMEGA';
  const workflow = [
    'jobs:', '  measure:', '    steps:', '      - name: Inspect process ancestry and protected boundaries',
    '        run: node scripts/read-parent-environment.mjs',
  ].join('\n');
  const {root} = gitFixture({workflow});
  const out = outputDir();
  const isolatedHome = path.join(os.tmpdir(), `wolf-omega-untrusted-home-${process.pid}`);
  const packagePath = path.join(root, 'package.json');
  const originalPackage = fs.readFileSync(packagePath, 'utf8');
  let userCreated = false;
  try {
    execFileSync('sudo', ['-n', '/usr/sbin/useradd', '--system', '--user-group', '--home-dir', isolatedHome, '--create-home', '--shell', '/usr/sbin/nologin', OS_TEST_USER]);
    userCreated = true;
    const sandboxUid = execFileSync('id', ['-u', OS_TEST_USER], {encoding: 'utf8'}).trim();
    const sandboxGid = execFileSync('id', ['-g', OS_TEST_USER], {encoding: 'utf8'}).trim();
    const probe = [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "import {spawn, spawnSync} from 'node:child_process';",
      `const marker=Buffer.from(${JSON.stringify(signingKey)});`,
      'let pid=process.pid;',
      'let visible=false;',
      'for(let depth=0;pid>1&&depth<16;depth+=1){',
      '  try{if(fs.readFileSync(`/proc/${pid}/environ`).includes(marker))visible=true;}catch{}',
      '  try{const stat=fs.readFileSync(`/proc/${pid}/stat`,\'utf8\');const parent=Number(stat.slice(stat.lastIndexOf(\')\')+2).split(\' \')[1]);if(!Number.isSafeInteger(parent)||parent===pid)break;pid=parent;}catch{break}',
      '}',
      "const gitRead=spawnSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'});",
      "const gitWrite=spawnSync('git',['config','remote.origin.url','https://github.com/attacker/unrelated.git'],{encoding:'utf8'});",
      "let gitMoved=false;try{fs.renameSync('.git','.git-attacker');gitMoved=true}catch{}",
      "let worktreeWritable=false;try{const p=path.join(process.cwd(),'.omega-write-test');fs.writeFileSync(p,'ok');fs.rmSync(p);worktreeWritable=true}catch{}",
      `const logPath=${JSON.stringify(path.join(out, 'logs', 'postgres-concurrency-1.log'))};`,
      "let logSymlinkCreated=false;try{fs.symlinkSync('/etc/passwd',logPath);logSymlinkCreated=true}catch{}",
      `const delayedWrite=${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(packagePath)},'tampered'),1200);`)}`,
      "const background=spawn(process.execPath,['-e',delayedWrite],{detached:true,stdio:'ignore'});background.unref();",
      "console.log(`uid=${process.getuid()};${visible?'SIGNER_VISIBLE':'SIGNER_HIDDEN'};GIT_READ=${gitRead.status===0?'ALLOWED':'BLOCKED'};GIT_CONFIG_WRITE=${gitWrite.status===0?'ALLOWED':'BLOCKED'};GIT_METADATA_MOVE=${gitMoved?'ALLOWED':'BLOCKED'};WORKTREE_WRITE=${worktreeWritable?'ALLOWED':'BLOCKED'};LOG_SYMLINK=${logSymlinkCreated?'ALLOWED':'BLOCKED'};BACKGROUND_STARTED=${background.pid?'YES':'NO'}`);",
    ].join('\n');
    fs.mkdirSync(path.join(root, 'scripts'), {recursive: true});
    fs.writeFileSync(path.join(root, 'scripts', 'read-parent-environment.mjs'), probe);
    execFileSync('git', ['add', 'scripts/read-parent-environment.mjs'], {cwd: root});
    execFileSync('git', ['commit', '-qm', 'add isolated process probe'], {cwd: root});
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
    const chmodTree = directory => {
      fs.chmodSync(directory, 0o755);
      for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
        const item = path.join(directory, entry.name);
        if (entry.isDirectory()) chmodTree(item);
        else {
          const mode = fs.statSync(item).mode;
          fs.chmodSync(item, mode & 0o111 ? 0o755 : 0o644);
        }
      }
    };
    chmodTree(root);
    execFileSync('sudo', ['-n', 'chown', '-R', `${sandboxUid}:${process.getgid()}`, root]);
    execFileSync('sudo', ['-n', 'chmod', '-R', 'u+rwX,g+rwX,o-rwx', root]);
    execFileSync('sudo', ['-n', 'chown', '-R', `${process.getuid()}:${sandboxGid}`, path.join(root, '.git')]);
    execFileSync('sudo', ['-n', 'chmod', '-R', 'u+rwX,g=rX,o-rwx', path.join(root, '.git')]);
    execFileSync('sudo', ['-n', 'chown', `${process.getuid()}:${sandboxGid}`, root]);
    execFileSync('sudo', ['-n', 'chmod', '1770', root]);
    execFileSync('sudo', ['-n', 'mkdir', '-p', path.join(isolatedHome, 'tmp')]);
    execFileSync('sudo', ['-n', 'chown', '-R', `${sandboxUid}:${sandboxGid}`, isolatedHome]);
    execFileSync('sudo', ['-n', 'chmod', '700', isolatedHome, path.join(isolatedHome, 'tmp')]);

    const executorUrl = new URL('../scripts/private-ci-execute.mjs', import.meta.url).href;
    const harness = [
      `import fs from 'node:fs'; import {executePrivateCi} from ${JSON.stringify(executorUrl)};`,
      'const root=process.env.WOLF_TEST_ROOT;',
      'const out=process.env.WOLF_TEST_OUTPUT;',
      `const receipt=executePrivateCi({root,sha:process.env.WOLF_TEST_SHA,checks:"postgres-concurrency",logDir:out+"/logs",receiptPath:out+"/receipt.json",signingKey:process.env.WOLF_CI_RECEIPT_SIGNING_KEY,missionId:"MISSION-TEST-0001",missionReservation:"e".repeat(64),untrustedUser:${JSON.stringify(OS_TEST_USER)},untrustedHome:process.env.WOLF_CI_UNTRUSTED_HOME});`,
      'const log=fs.readFileSync(out+"/logs/postgres-concurrency-1.log","utf8");',
      'console.log(JSON.stringify({state:receipt.state,log,failure:receipt.failure,sourceIntegrityFailure:receipt.sourceIntegrityFailure,checkout:receipt.checkout,checks:receipt.checks.map(check=>({name:check.name,status:check.status,steps:check.steps.map(step=>({status:step.status,exitCode:step.exitCode,errorClass:step.errorClass}))}))}));',
    ].join('\n');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', harness], {
      cwd: process.cwd(),
      env: {...process.env, WOLF_CI_RECEIPT_SIGNING_KEY: signingKey, WOLF_CI_UNTRUSTED_HOME: isolatedHome, WOLF_TEST_ROOT: root, WOLF_TEST_OUTPUT: out, WOLF_TEST_SHA: sha},
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim().split('\n').at(-1));
    assert.equal(result.state, 'VERIFIED', JSON.stringify({failure: result.failure, sourceIntegrityFailure: result.sourceIntegrityFailure, checkout: result.checkout, checks: result.checks, log: result.log}));
    for (const evidence of ['SIGNER_HIDDEN', 'GIT_READ=ALLOWED', 'GIT_CONFIG_WRITE=BLOCKED', 'GIT_METADATA_MOVE=BLOCKED', 'WORKTREE_WRITE=ALLOWED', 'LOG_SYMLINK=BLOCKED', 'BACKGROUND_STARTED=YES']) {
      assert.ok(result.log.includes(evidence), `missing boundary evidence ${evidence}: ${result.log}`);
    }
    assert.doesNotMatch(result.log, /SIGNER_VISIBLE/);
    await new Promise(resolve => setTimeout(resolve, 1400));
    assert.equal(fs.readFileSync(packagePath, 'utf8'), originalPackage, 'a detached untrusted process cannot mutate source after final verification');
  } finally {
    if (userCreated) {
      spawnSync('sudo', ['-n', '/usr/bin/pkill', '-KILL', '-u', OS_TEST_USER]);
      spawnSync('sudo', ['-n', '/usr/sbin/userdel', '--remove', OS_TEST_USER]);
    }
    spawnSync('sudo', ['-n', 'rm', '-rf', root, isolatedHome]);
    fs.rmSync(out, {recursive: true, force: true});
  }
});

test('every private-target workflow job is gated by durable mission admission before access', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/private-ci-bridge.yml', import.meta.url), 'utf8');
  const jobBlock = name => {
    const start = workflow.indexOf(`\n  ${name}:`);
    assert.ok(start >= 0, `missing job ${name}`);
    const next = workflow.slice(start + 1).search(/\n  [A-Za-z0-9_-]+:\n/);
    return workflow.slice(start, next < 0 ? undefined : start + 1 + next);
  };
  const admission = jobBlock('mission-admission');
  assert.match(admission, /github\.ref == 'refs\/heads\/main'/);
  assert.match(admission, /node scripts\/private-ci-mission-cli\.mjs/);
  assert.match(admission, /WOLF_CI_MISSION_ALLOWED_ACTORS/);
  assert.match(jobBlock('probe'), /needs: \[mission-admission, inventory\]/);
  assert.match(jobBlock('probe'), /needs\.mission-admission\.outputs\.accepted == 'true'/);
  assert.match(jobBlock('probe'), /needs\.inventory\.outputs\.state == 'INVENTORIED'/);
  assert.match(jobBlock('inventory'), /needs: mission-admission/);
  assert.match(jobBlock('inventory'), /needs\.mission-admission\.outputs\.accepted == 'true'/);
  const execute = jobBlock('execute');
  assert.match(execute, /needs: \[mission-admission, inventory\]/);
  assert.match(execute, /needs\.mission-admission\.outputs\.accepted == 'true'/);
  assert.match(execute, /needs\.inventory\.outputs\.state == 'INVENTORIED'/);
  assert.match(execute, /WOLF_CI_SHA: \$\{\{ needs\.mission-admission\.outputs\.sha \}\}/);
  assert.match(execute, /WOLF_CI_MISSION_RESERVATION: \$\{\{ needs\.mission-admission\.outputs\.mission_key \}\}/);
  assert.match(execute, /refs\/pull\/\$\{WOLF_CI_PR\}\/head/);
  assert.match(execute, /test \"\$fetched_sha\" = \"\$WOLF_CI_SHA\"/);
  assert.match(execute, /chmod 1770 \"\$WOLF_CI_PRIVATE_ROOT\"/);
  assert.match(execute, /private-ci-app-acceptance-cli\.mjs/);
  assert.doesNotMatch(execute, /private-ci-dispatch-probe\.mjs/);
});

test('mission validation accepts ISO timestamps only for an authenticated allowlisted actor', () => {
  const actor = 'wolf-factory-automation[bot]';
  const issuedAt = '2026-11-25T00:00:00.000Z';
  const result = validateMission({
    schemaVersion: 1,
    missionId: 'MISSION-2026-11-25-0001',
    repository: REPO,
    sha: SHA,
    pr: 743,
    issuedAt,
    requestedBy: actor,
  }, {now: Date.parse('2026-11-25T00:00:01.000Z'), allowlist: [REPO], actor, allowedActors: [actor], expectedPr: 743});
  assert.equal(result.state, MISSION_STATES.ACCEPTED);
  assert.equal(result.mission.issuedAt, Date.parse(issuedAt));
  assert.equal(result.mission.requestedBy, actor);
  assert.equal(validateMission({schemaVersion: 1}, {actor, allowedActors: [actor]}).state, MISSION_STATES.REJECTED);
});

test('credential audit flags token export before private execution', () => {
  const unsafe = [
    'jobs:', '  execute:', '    steps:',
    '      - name: Authenticate', '        run: |',
    '          cat "$WOLF_CI_TOKEN_FILE" >> "$GITHUB_ENV"',
    '      - name: Execute private commands', '        run: node scripts/private-ci-execute.mjs',
    '          echo WOLF_CI_APP_READER_TOKEN',
  ].join('\n');
  assert.equal(auditCredentialExposure(unsafe).state, 'EXPOSURE_RISK');
});

test('dispatch HTTP 204 without a correlated workflow run is blocked, not accepted', async () => {
  const mock = dispatchFetch();
  const result = await checkDispatch({
    token: 'fake-dispatch-token', readToken: 'fake-reader-token', checkToken: 'fake-check-reader',
    repository: REPO, workflow: 'private-ci.yml', ref: 'main', sha: SHA, pr: '743', settleMs: 0,
    sleep: async () => {}, fetchImpl: mock.fetchImpl,
  });
  assert.equal(mock.counts().dispatches, 1);
  assert.equal(result.state, 'BLOCKED');
  assert.equal(result.reason, 'DISPATCH_ACK_WITHOUT_CORRELATED_RUN');
});

test('dispatcher never falls back to a different workflow when the configured workflow is absent', async () => {
  const mock = dispatchFetch({workflowStatus: 404});
  const result = await checkDispatch({
    token: 'fake-dispatch-token', readToken: 'fake-reader-token', checkToken: 'fake-check-reader',
    repository: REPO, workflow: 'private-ci.yml', sha: SHA, settleMs: 0,
    sleep: async () => {}, fetchImpl: mock.fetchImpl,
  });
  assert.equal(mock.counts().dispatches, 0);
  assert.equal(result.state, 'BLOCKED');
  assert.equal(result.reason, 'CONFIGURED_WORKFLOW_NOT_FOUND');
});

test('a successful workflow run still blocks unless its receipt check binds the exact target SHA and run id', async () => {
  const correlatedRun = {
    id: 100, workflow_id: 77, event: 'workflow_dispatch', head_branch: 'main', head_sha: 'b'.repeat(40),
    created_at: new Date().toISOString(), status: 'completed', conclusion: 'success',
  };
  const mock = dispatchFetch({runs: [correlatedRun], checkRuns: []});
  const result = await checkDispatch({
    token: 'fake-dispatch-token', readToken: 'fake-reader-token', checkToken: 'fake-check-reader',
    repository: REPO, workflow: 'private-ci.yml', ref: 'main', sha: SHA, pr: '743', settleMs: 0,
    sleep: async () => {}, fetchImpl: mock.fetchImpl,
  });
  assert.equal(result.state, 'BLOCKED');
  assert.equal(result.reason, 'TARGET_CHECK_RUN_NOT_CORRELATED');
});

test('dispatch PASS requires a completed target check run correlated to the new workflow run', async () => {
  const correlatedRun = {
    id: 100, workflow_id: 77, event: 'workflow_dispatch', head_branch: 'main', head_sha: 'b'.repeat(40),
    created_at: new Date().toISOString(), status: 'completed', conclusion: 'success',
  };
  const check = {id: 9001, external_id: '100', name: 'wolf-private-ci-743', head_sha: SHA, status: 'completed', conclusion: 'success'};
  const mock = dispatchFetch({runs: [correlatedRun], checkRuns: [check]});
  const result = await checkDispatch({
    token: 'fake-dispatch-token', readToken: 'fake-reader-token', checkToken: 'fake-check-reader',
    repository: REPO, workflow: 'private-ci.yml', ref: 'main', sha: SHA, pr: '743', settleMs: 0,
    sleep: async () => {}, fetchImpl: mock.fetchImpl,
  });
  assert.equal(result.state, 'PASS');
  assert.equal(result.targetCheckRunId, 9001);
  assert.equal(result.targetCheckExternalId, '100');
});

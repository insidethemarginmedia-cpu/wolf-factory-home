// Isolated executor for the six required private CI checks.
//
// Private source is cloned only into the ephemeral runner temp directory. Every
// command's stdout/stderr is captured to a mode-0600 log file that is deleted at
// the end of the job. The only published values are check names, exit codes,
// durations and a SHA-bound receipt hash. No source, log, diff or credential is
// printed or uploaded.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const SHA_PATTERN = /^[a-f0-9]{40}$/;

export const REQUIRED_CHECKS = Object.freeze(['security', 'lint', 'typecheck', 'unit', 'integration', 'build']);
export const EXTRA_CHECKS = Object.freeze(['migrations', 'postgres-concurrency']);

export function normalizeSha(value) {
  const sha = String(value ?? '').trim().toLowerCase();
  if (!SHA_PATTERN.test(sha)) throw Error('EXECUTOR_SHA_MALFORMED');
  return sha;
}

export function normalizeChecks(value, allowed = [...REQUIRED_CHECKS, ...EXTRA_CHECKS]) {
  const checks = [...new Set(String(value ?? [...REQUIRED_CHECKS].join(',')).split(',').map(item => item.trim().toLowerCase()).filter(Boolean))];
  if (!checks.length) throw Error('EXECUTOR_CHECKS_REQUIRED');
  for (const check of checks) if (!allowed.includes(check)) throw Error('EXECUTOR_CHECK_DENIED');
  return checks;
}

export function redact(text) {
  return String(text ?? '')
    .replace(/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '[REDACTED_TOKEN]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_KEY]')
    .replace(/https?:\/\/[^\s"'<>]+/g, '[REDACTED_URL]')
    .slice(0, 4000);
}

// Extracts the ordered `psql -f <file>` sequence declared by a private workflow
// so the executor can run the workflow's own commands instead of a helper that
// the workflow never calls. Only repository-relative paths are accepted.
export function extractPsqlSequence(source) {
  const sequence = [];
  for (const raw of String(source ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/(?:^|[\s;&|(])psql\s+(.*)$/);
    if (!match) continue;
    const args = match[1].match(/(?:^|\s)-f\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
    if (!args) continue;
    const target = (args[1] ?? args[2] ?? args[3] ?? '').trim();
    if (!target || target.includes('$') || path.isAbsolute(target) || target.split('/').includes('..')) continue;
    sequence.push(target.replace(/^\.\//, ''));
    if (sequence.length >= 80) break;
  }
  return sequence;
}

function exists(root, relative) {
  try { return fs.statSync(path.join(root, relative)).isFile(); } catch { return false; }
}

function listSourceFiles(root) {
  const result = [];
  const walk = directory => {
    let entries;
    try { entries = fs.readdirSync(directory, {withFileTypes: true}); } catch { return; }
    for (const entry of entries) {
      if (['node_modules', '.git', '.continuity', 'dist', 'build', 'coverage'].includes(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:mjs|js|cjs)$/.test(entry.name)) result.push(path.relative(root, full));
      if (result.length >= 500) return;
    }
  };
  for (const directory of ['scripts', 'infra', 'tests']) walk(path.join(root, directory));
  return result.sort();
}

export function classifyError(text) {
  const value = String(text ?? '');
  const rules = [
    [/ECONNREFUSED|connection refused|Connection refused/i, 'DATABASE_CONNECTION_REFUSED'],
    [/password authentication failed|authentication failed/i, 'DATABASE_AUTH_FAILED'],
    [/database .* does not exist|FATAL:.*database/i, 'DATABASE_NOT_FOUND'],
    [/relation .* does not exist|table .* does not exist|column .* does not exist|schema .* does not exist/i, 'DATABASE_TABLE_MISSING'],
    [/No such file or directory|ENOENT|does not exist/i, 'FILE_MISSING'],
    [/Cannot find module|MODULE_NOT_FOUND/i, 'MODULE_MISSING'],
    [/command not found/i, 'COMMAND_NOT_FOUND'],
    [/AssertionError|assertion|assert /i, 'ASSERTION_FAILED'],
    [/ETIMEDOUT|timed out|Timeout/i, 'TIMEOUT'],
    [/permission denied|Permission denied/i, 'PERMISSION_DENIED'],
    [/syntax error|ERROR:/i, 'DATABASE_ERROR'],
    [/Error|ERROR|fatal|FATAL/i, 'GENERIC_ERROR'],
  ];
  for (const [pattern, classification] of rules) if (pattern.test(value)) return classification;
  return 'UNKNOWN';
}

function errorLine(text) {
  for (const line of String(text ?? '').split('\n')) {
    if (/error|Error|ERROR|fatal|FATAL|denied|refused|expected|Expected|FAIL|fail/i.test(line)) return redact(line).slice(0, 200);
  }
  return null;
}

function run(command, args, {cwd, env, timeoutMs, logPath}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd,
    env: {...process.env, ...env},
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  });
  const durationMs = Date.now() - started;
  const output = String(result.stdout ?? '') + String(result.stderr ?? '');
  if (logPath) {
    fs.mkdirSync(path.dirname(logPath), {recursive: true, mode: 0o700});
    fs.writeFileSync(logPath, redact(output) + '\n', {mode: 0o600});
  }
  return {
    command: path.basename(command),
    args: args.map(arg => redact(arg).slice(0, 200)),
    exitCode: Number.isInteger(result.status) ? result.status : null,
    signal: result.signal ?? null,
    timedOut: result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM',
    durationMs,
    logBytes: Buffer.byteLength(output),
    status: result.status === 0 ? 'success' : result.error?.code === 'ETIMEDOUT' ? 'timeout' : 'failure',
    errorClass: result.status === 0 ? null : classifyError(output),
    errorLine: result.status === 0 ? null : errorLine(output),
    logTail: result.status === 0 ? null : output.split('\n').slice(-30).join('\n'),
  };
}

// The private concurrency workflow assumes a schema that is created outside the
// workflow (by the Supabase migrations). When the repository ships a
// conventional bootstrap file we apply it first; otherwise the concurrency
// evidence remains advisory and reports its true exit codes.
export const BOOTSTRAP_CANDIDATES = Object.freeze([
  'supabase/bootstrap.sql',
  'supabase/schema.sql',
  'db/bootstrap.sql',
  'db/schema.sql',
  'scripts/bootstrap-postgres.sql',
  'supabase/tests/bootstrap.sql',
]);

export function findBootstrap(root) {
  for (const candidate of BOOTSTRAP_CANDIDATES) if (exists(root, candidate)) return candidate;
  return null;
}

function buildPlan({root, checks, env}) {
  const plan = [];
  // The private postgres-schema and postgres-concurrency workflows both run
  // against POSTGRES_DB=wolf_test on postgres:17, while the DBOS integration
  // workflow uses wolf_factory_dbos. Each check therefore pins its own database
  // explicitly instead of inheriting the job-wide PGDATABASE.
  const schemaDatabase = env.WOLF_CI_SCHEMA_DATABASE || 'wolf_test';
  const npm = args => ({command: 'npm', args, timeoutMs: 15 * 60 * 1000});
  const node = (args, timeoutMs = 15 * 60 * 1000) => ({command: 'node', args, timeoutMs});
  const bash = (args, timeoutMs = 15 * 60 * 1000) => ({command: 'bash', args, timeoutMs});
  if (checks.includes('security')) {
    plan.push({name: 'security', steps: [
      {...npm(['audit', '--audit-level=high', '--omit=dev', '--json']), required: true},
      {...node(['--input-type=module', '-e', [
        "import {spawnSync} from 'node:child_process';",
        "const r=spawnSync('git',['grep','-n','-I','-E','(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-or-v1-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)','--','.',':!package-lock.json',':!node_modules'],{encoding:'utf8'});",
        "if(r.status===0){console.error('SECRET_PATTERN_MATCHED');process.exit(1);}",
        "if(r.status===1)process.exit(0);",
        "console.error('SECRET_SCAN_FAILED');process.exit(2);",
      ].join('\n')], 5 * 60 * 1000), required: true},
    ]});
  }
  if (checks.includes('lint')) {
    plan.push({name: 'lint', steps: [
      exists(root, 'scripts/run-actionlint.sh')
        ? {...bash(['scripts/run-actionlint.sh']), required: true}
        : {...node(['--input-type=module', '-e', "console.error('ACTIONLINT_RUNNER_MISSING');process.exit(78)"]), required: true},
    ]});
  }
  if (checks.includes('typecheck')) {
    const tsconfig = exists(root, 'tsconfig.json');
    const files = listSourceFiles(root);
    plan.push({name: 'typecheck', steps: [
      ...(tsconfig ? [{...node(['node_modules/typescript/bin/tsc', '--noEmit']), required: true}] : []),
      {...node(['--input-type=module', '-e', [
        "import {spawnSync} from 'node:child_process';",
        `const files=${JSON.stringify(files)};`,
        "for(const file of files){const r=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(r.status!==0){console.error('SYNTAX_CHECK_FAILED='+file);process.exit(1);}}",
        "console.log('SYNTAX_CHECK_OK='+files.length);",
      ].join('\n')], 15 * 60 * 1000), required: true},
    ]});
  }
  if (checks.includes('unit')) {
    plan.push({name: 'unit', steps: [{...npm(['test']), required: true}]});
  }
  if (checks.includes('integration')) {
    // The private factory-dbos-outer-e2e workflow at this SHA uses only the
    // prepare -> crash(77) -> recover(0) sequence. The older public preflight's
    // recover-crash-after-m2 mode and its 78 exit code are not part of this
    // private workflow and must not be imposed on it.
    const sequence = [
      {...node(['scripts/wolf-dbos-outer-e2e.mjs', 'prepare']), expected: [0]},
      {...node(['scripts/wolf-dbos-outer-e2e.mjs', 'crash']), expected: [77]},
      {...node(['scripts/wolf-dbos-outer-e2e.mjs', 'recover']), expected: [0]},
    ];
    plan.push({name: 'integration', steps: sequence.map(step => ({...step, required: true}))});
  }
  if (checks.includes('build')) {
    plan.push({name: 'build', steps: [{...npm(['run', 'build']), required: true}]});
  }
  if (checks.includes('migrations')) {
    const schemaEnv = {PGDATABASE: schemaDatabase};
    plan.push({name: 'migrations', steps: [
      exists(root, 'scripts/run-postgres-schema-verification.sh')
        ? {...bash(['scripts/run-postgres-schema-verification.sh']), required: true, env: schemaEnv}
        : exists(root, 'scripts/verify-postgres-price-history-store.mjs')
          ? {...node(['scripts/verify-postgres-price-history-store.mjs']), required: true, env: schemaEnv}
          : {...node(['--input-type=module', '-e', "console.error('MIGRATION_RUNNER_MISSING');process.exit(78)"]), required: true, env: schemaEnv},
    ]});
  }
  if (checks.includes('postgres-concurrency')) {
    const concurrencyEnv = {PGDATABASE: schemaDatabase};
    let workflowSource = null;
    try { workflowSource = fs.readFileSync(path.join(root, '.github/workflows/postgres-concurrency-evidence.yml'), 'utf8'); } catch { workflowSource = null; }
    const sequence = workflowSource ? extractPsqlSequence(workflowSource) : [];
    const bootstrap = findBootstrap(root);
    const bootstrapSteps = bootstrap ? [{command: 'psql', args: ['-v', 'ON_ERROR_STOP=1', '-f', bootstrap], timeoutMs: 10 * 60 * 1000, required: false, env: concurrencyEnv}] : [];
    const steps = sequence.length
      ? [...bootstrapSteps, ...sequence.map(file => ({command: 'psql', args: ['-v', 'ON_ERROR_STOP=1', '-f', file], timeoutMs: 5 * 60 * 1000, required: true, env: concurrencyEnv}))]
      : [exists(root, 'scripts/measure-postgres-concurrency.mjs')
        ? {...node(['scripts/measure-postgres-concurrency.mjs']), required: true, env: concurrencyEnv}
        : {...node(['--input-type=module', '-e', "console.error('CONCURRENCY_RUNNER_MISSING');process.exit(78)"]), required: true, env: concurrencyEnv}];
    plan.push({name: 'postgres-concurrency', steps});
  }
  return plan;
}

export function executePrivateCi({root, sha, checks, logDir, receiptPath, env = {}, runnerTemp = process.env.RUNNER_TEMP, advisoryChecks = EXTRA_CHECKS} = {}) {
  const normalizedSha = normalizeSha(sha);
  const normalizedChecks = normalizeChecks(checks);
  const startedAt = new Date().toISOString();
  const results = [];
  let failure = null;
  // Required checks decide the verdict. Extra checks (migrations,
  // postgres-concurrency) are advisory: they run and are reported with their
  // true exit codes, but a failure there never blocks the six required checks.
  const advisory = new Set(advisoryChecks);
  const plan = buildPlan({root, checks: normalizedChecks, env});
  for (const group of plan) {
    const groupStarted = Date.now();
    const steps = [];
    const groupAdvisory = advisory.has(group.name);
    for (const step of group.steps) {
      const logPath = path.join(logDir, `${group.name}-${steps.length + 1}.log`);
      const result = run(step.command, step.args, {cwd: root, env: {...env, ...(step.env ?? {})}, timeoutMs: step.timeoutMs, logPath});
      const expected = step.expected ?? [0];
      const passed = expected.includes(result.exitCode) && !result.timedOut;
      steps.push({
        command: result.command,
        args: result.args,
        exitCode: result.exitCode,
        expectedExitCodes: expected,
        durationMs: result.durationMs,
        logBytes: result.logBytes,
        status: passed ? 'success' : result.timedOut ? 'timeout' : 'failure',
        ...(result.status === 'success' ? {} : {errorClass: result.errorClass, errorLine: result.errorLine, logTail: redact(result.logTail).slice(0, 4000)}),
      });
      if (!passed && step.required && !groupAdvisory) failure = `${group.name}:${steps.length}`;
    }
    results.push({
      name: group.name,
      status: steps.every(step => step.status === 'success') ? 'success' : 'failure',
      durationMs: Date.now() - groupStarted,
      steps,
    });
    process.stdout.write(`WOLF_CI_CHECK=${JSON.stringify({name: group.name, status: results.at(-1).status, steps: steps.map(step => ({exitCode: step.exitCode, status: step.status}))})}\n`);
  }
  // Advisory check failures are recorded explicitly instead of being hidden.
  for (const result of results) if (advisory.has(result.name) && result.status !== 'success') result.status = 'advisory-failure';
  const receipt = {
    schema: 'wolf.private-ci.receipt/v1',
    state: failure ? 'FAILED' : 'VERIFIED',
    sha: normalizedSha,
    repository: 'donraposo1-source/project-wolf',
    checks: results,
    requiredChecks: normalizedChecks.filter(check => REQUIRED_CHECKS.includes(check)),
    extraChecks: normalizedChecks.filter(check => EXTRA_CHECKS.includes(check)),
    advisoryChecks: [...advisory],
    advisoryFailures: results.filter(check => check.status === 'advisory-failure').map(check => check.name),
    startedAt,
    completedAt: new Date().toISOString(),
    failure,
    // Set when this run took over an expired lease from another runner.
    recoveredFrom: process.env.WOLF_CI_RECOVERED_FROM || null,
    privateLogsPublished: false,
    privateSourcePublished: false,
    inferencePerformed: false,
    refUpdated: false,
  };
  receipt.receiptHash = createHash('sha256').update(JSON.stringify({sha: receipt.sha, checks: receipt.checks})).digest('hex');
  if (receiptPath) {
    fs.mkdirSync(path.dirname(receiptPath), {recursive: true, mode: 0o700});
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
  }
  return receipt;
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  try {
    const receipt = executePrivateCi({
      root: process.env.WOLF_CI_PRIVATE_ROOT,
      sha: process.env.WOLF_CI_SHA,
      checks: process.env.WOLF_CI_CHECKS,
      logDir: process.env.WOLF_CI_LOG_DIR,
      receiptPath: process.env.WOLF_CI_RECEIPT,
      env: {
        EUR_SPEND: '0', COST_UNKNOWN: 'DENY', PAID_FALLBACK: 'DENY', TRIAL_CREDIT: 'DENY',
        ...(process.env.PGHOST ? {PGHOST: process.env.PGHOST} : {}),
        ...(process.env.PGPORT ? {PGPORT: process.env.PGPORT} : {}),
        ...(process.env.PGUSER ? {PGUSER: process.env.PGUSER} : {}),
        ...(process.env.PGPASSWORD ? {PGPASSWORD: process.env.PGPASSWORD} : {}),
        ...(process.env.PGDATABASE ? {PGDATABASE: process.env.PGDATABASE} : {}),
        ...(process.env.WOLF_CI_SCHEMA_DATABASE ? {WOLF_CI_SCHEMA_DATABASE: process.env.WOLF_CI_SCHEMA_DATABASE} : {}),
        ...(process.env.DBOS_SHA ? {DBOS_SHA: process.env.DBOS_SHA} : {}),
        ...(process.env.WOLF_DBOS_SYSTEM_DATABASE_URL ? {WOLF_DBOS_SYSTEM_DATABASE_URL: process.env.WOLF_DBOS_SYSTEM_DATABASE_URL} : {}),
        ...(process.env.WOLF_DBOS_FIXTURE_ROOT ? {WOLF_DBOS_FIXTURE_ROOT: process.env.WOLF_DBOS_FIXTURE_ROOT} : {}),
        ...(process.env.WOLF_DBOS_SDK_ENTRYPOINT ? {WOLF_DBOS_SDK_ENTRYPOINT: process.env.WOLF_DBOS_SDK_ENTRYPOINT} : {}),
      },
    });
    process.stdout.write(`WOLF_CI_RECEIPT=${JSON.stringify({state: receipt.state, sha: receipt.sha, checks: receipt.checks.map(check => ({name: check.name, status: check.status})), receiptHash: receipt.receiptHash})}\n`);
    process.exitCode = receipt.state === 'VERIFIED' ? 0 : 1;
  } catch (error) {
    process.stderr.write(JSON.stringify({state: 'FAILED', reason: error?.message ?? 'EXECUTOR_FAILED', privateSourcePublished: false}) + '\n');
    process.exitCode = 1;
  }
}

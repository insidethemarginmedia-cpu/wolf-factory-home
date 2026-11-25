// Isolated executor for the fixed private CI check contract.
//
// Private source is cloned only into the ephemeral runner temp directory. In
// GitHub Actions, target-controlled commands run as a separate unprivileged OS
// user with a filtered environment, preventing same-uid /proc reads of the
// executor's signing-key environment. Every command's output is captured to a
// mode-0600 log file deleted at job end. Only check names, exit codes, durations
// and a signed SHA/tree-bound receipt are published.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {buildWorkflowPlan, parseWorkflowJobs} from './private-ci-workflow.mjs';
import {DEFAULT_REQUIRED_CHECKS, EXTRA_CHECKS, WORKFLOW_CHECKS, ALLOWED_CHECKS, normalizeCheckNames} from './private-ci-contract.mjs';
import {RECEIPT_SCHEMA, signReceipt} from './private-ci-receipt.mjs';

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const SOURCE_REPOSITORY = 'donraposo1-source/project-wolf';

export const REQUIRED_CHECKS = DEFAULT_REQUIRED_CHECKS;
export {EXTRA_CHECKS, WORKFLOW_CHECKS};

export function normalizeSha(value) {
  const sha = String(value ?? '').trim().toLowerCase();
  if (!SHA_PATTERN.test(sha)) throw Error('EXECUTOR_SHA_MALFORMED');
  return sha;
}

export function normalizeChecks(value, allowed = ALLOWED_CHECKS) {
  try {
    return normalizeCheckNames(value, {defaults: REQUIRED_CHECKS, allowed, errorPrefix: 'EXECUTOR_CHECKS'});
  } catch (error) {
    if (error?.message === 'EXECUTOR_CHECKS_DENIED') throw Error('EXECUTOR_CHECK_DENIED');
    throw error;
  }
}

const GIT_ENV = Object.freeze({
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_OPTIONAL_LOCKS: '0',
});

function git(root, args) {
  // The checkout is owned by the untrusted execution identity in Actions. Mark
  // only this exact path safe for the trusted, read-only before/after checks.
  const result = spawnSync('git', [
    '-c', `safe.directory=${root}`,
    '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=/dev/null',
    ...args,
  ], {
    cwd: root,
    env: {...GIT_ENV, PATH: process.env.PATH ?? ''},
    encoding: 'utf8',
    timeout: 30000,
  });
  return {status: result.status ?? 1, stdout: String(result.stdout ?? '').trim(), stderr: String(result.stderr ?? '')};
}

function normalizeOrigin(value) {
  return String(value ?? '').trim()
    .replace(/^git@github\.com:/i, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//i, 'https://github.com/')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

/** Bind the executor's working tree to the requested immutable Git commit. */
export function inspectCheckout({root, sha} = {}) {
  const expectedSha = normalizeSha(sha);
  if (typeof root !== 'string' || !root.trim()) throw Error('EXECUTOR_CHECKOUT_REQUIRED');
  let rootPath;
  try { rootPath = fs.realpathSync(root); } catch { throw Error('EXECUTOR_CHECKOUT_REQUIRED'); }
  const top = git(rootPath, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) throw Error('EXECUTOR_CHECKOUT_REQUIRED');
  let topPath;
  try { topPath = fs.realpathSync(top.stdout); } catch { throw Error('EXECUTOR_CHECKOUT_REQUIRED'); }
  if (topPath !== rootPath) throw Error('EXECUTOR_CHECKOUT_ROOT_MISMATCH');
  const origin = git(rootPath, ['remote', 'get-url', 'origin']);
  if (origin.status !== 0) throw Error('EXECUTOR_CHECKOUT_ORIGIN_REQUIRED');
  if (normalizeOrigin(origin.stdout) !== `https://github.com/${SOURCE_REPOSITORY}`) throw Error('EXECUTOR_CHECKOUT_REPOSITORY_MISMATCH');
  const head = git(rootPath, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (head.status !== 0 || !SHA_PATTERN.test(head.stdout)) throw Error('EXECUTOR_CHECKOUT_HEAD_UNREADABLE');
  if (head.stdout !== expectedSha) throw Error('EXECUTOR_CHECKOUT_SHA_MISMATCH');
  const tree = git(rootPath, ['rev-parse', '--verify', `${expectedSha}^{tree}`]);
  if (tree.status !== 0 || !SHA_PATTERN.test(tree.stdout)) throw Error('EXECUTOR_CHECKOUT_TREE_UNREADABLE');
  const status = git(rootPath, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.status !== 0) throw Error('EXECUTOR_CHECKOUT_STATUS_UNREADABLE');
  if (status.stdout) throw Error('EXECUTOR_CHECKOUT_DIRTY');
  return {root: rootPath, sha: head.stdout, treeSha: tree.stdout, clean: true};
}

const PARENT_ENV_ALLOWLIST = Object.freeze([
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'RUNNER_TEMP', 'CI', 'LANG', 'LC_ALL', 'TZ',
]);
const CHILD_FORBIDDEN_ENV = /(^GITHUB_|^GH_|^ACTIONS_|^RUNNER_|TOKEN|SECRET|PRIVATE[_-]?KEY|DEPLOY[_-]?KEY|SIGNING[_-]?KEY|HMAC[_-]?KEY|CREDENTIAL|AUTHORIZATION|^WOLF_FACTORY_|^WOLF_CI_APP_)/i;
const CHILD_EXPLICIT_ALWAYS_ALLOW = new Set([
  'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE',
  'DBOS_SHA', 'WOLF_CI_SCHEMA_DATABASE', 'WOLF_DBOS_SYSTEM_DATABASE_URL',
  'WOLF_DBOS_FIXTURE_ROOT', 'WOLF_DBOS_SDK_ENTRYPOINT', 'EUR_SPEND',
  'COST_UNKNOWN', 'PAID_FALLBACK', 'TRIAL_CREDIT',
]);

/**
 * Build the exact environment given to target-workflow commands. Credentials
 * from GitHub, the App, or the bridge are never inherited. Only runner basics
 * and explicit non-bridge test settings cross the process boundary.
 */
export function workflowChildEnvironment({parent = process.env, env = {}, stepEnv = {}, isolatedHome = null, safeGitDirectory = null} = {}) {
  const child = {};
  for (const name of PARENT_ENV_ALLOWLIST) {
    if (typeof parent?.[name] === 'string' && !CHILD_FORBIDDEN_ENV.test(name)) child[name] = parent[name];
  }
  for (const [name, value] of Object.entries({...env, ...stepEnv})) {
    if (value === undefined || value === null || CHILD_FORBIDDEN_ENV.test(name)) continue;
    if (PARENT_ENV_ALLOWLIST.includes(name)) continue;
    if (!CHILD_EXPLICIT_ALWAYS_ALLOW.has(name) && !/^WOLF_DBOS_[A-Z0-9_]+$/.test(name)) continue;
    child[name] = String(value);
  }
  if (typeof isolatedHome === 'string' && isolatedHome.trim()) {
    const temp = path.join(isolatedHome, 'tmp');
    child.HOME = isolatedHome;
    child.TMPDIR = temp;
    child.TMP = temp;
    child.TEMP = temp;
  }
  if (typeof safeGitDirectory === 'string' && path.isAbsolute(safeGitDirectory)) {
    // The checkout metadata is runner-owned/read-only. Give target workflows
    // only the exact safe.directory exception they need for read-only Git use.
    child.GIT_CONFIG_COUNT = '1';
    child.GIT_CONFIG_KEY_0 = 'safe.directory';
    child.GIT_CONFIG_VALUE_0 = path.resolve(safeGitDirectory);
    child.GIT_OPTIONAL_LOCKS = '0';
    child.GIT_TERMINAL_PROMPT = '0';
  }
  return child;
}

const SANDBOX_USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;

/**
 * Cross the OS user boundary before executing target-controlled commands. Merely
 * filtering the child environment is insufficient: a same-uid process can read
 * its parent's original environment through /proc/<pid>/environ. The sudo wrapper
 * itself receives only PATH; `env -i` installs the already-filtered values after
 * switching to the dedicated untrusted identity.
 */
export function buildUntrustedInvocation(command, args = [], {user, env = {}} = {}) {
  if (typeof user !== 'string' || !SANDBOX_USER_PATTERN.test(user) || user === 'root') {
    throw Error('EXECUTOR_UNTRUSTED_USER_INVALID');
  }
  if (typeof command !== 'string' || !command.trim() || !Array.isArray(args)) throw Error('EXECUTOR_UNTRUSTED_COMMAND_INVALID');
  for (const name of Object.keys(env)) {
    if (CHILD_FORBIDDEN_ENV.test(name)) throw Error('EXECUTOR_SANDBOX_ENV_DENIED');
  }
  const assignments = Object.entries(env).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value === undefined || value === null) throw Error('EXECUTOR_SANDBOX_ENV_INVALID');
    return `${name}=${String(value)}`;
  });
  return {
    command: '/usr/bin/sudo',
    args: ['-n', '-u', user, '--', '/usr/bin/env', '-i', ...assignments, command, ...args.map(String)],
    env: {PATH: process.env.PATH ?? '/usr/bin:/bin'},
  };
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

// The Python "no matching distribution" error states which interpreter tags it
// searched and how the interpreter was invoked. Capturing that is what
// distinguishes an unsupported runtime from a missing package, and the package
// metadata is public. Only the tag list and version are kept - never paths or
// the surrounding command.
export function extractPythonDiagnostics(text) {
  const value = String(text ?? '');
  const searched = value.match(/from versions:([^)\n]*)/)?.[1]?.trim() ?? null;
  const requires = value.match(/Requires-Python ([^\n]+)/)?.[1]?.trim() ?? null;
  const pythonVersion = value.match(/Python (\d+\.\d+(?:\.\d+)?)/)?.[1] ?? null;
  const oneline = value.match(/--python-version (\d+\.\d+(?:\.\d+)?)/)?.[1] ?? null;
  const implementation = value.match(/(cp|py)(\d{2,3})-(?:cp|py)\d{2,3}[a-z]*-(\w+)/)?.[0] ?? null;
  const pipIndex = value.match(/Looking in indexes: ([^\n]+)/)?.[1]?.replace(/https?:\/\/[^\s]+/g, '[REDACTED_URL]') ?? null;
  const sslOrNetwork = /CERTIFICATE_VERIFY_FAILED|SSLError|Connection|Temporary failure|ProxyError|Read timed out/i.test(value)
    ? (value.match(/CERTIFICATE_VERIFY_FAILED|SSLError|Temporary failure[^\n]*|ProxyError[^\n]*|Read timed out/i)?.[0] ?? 'NETWORK') : null;
  return {
    versionsAvailable: searched === null ? null : searched.replace(/\s+/g, ' ').slice(0, 200),
    requiresPython: requires,
    pythonVersion,
    searchedInterpreter: oneline,
    platformTag: implementation,
    index: pipIndex,
    networkError: sslOrNetwork,
  };
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

// PostgreSQL diagnostics carry a stable SQLSTATE and a structured message. The
// failure class (e.g. 42P01 undefined_table) is enough to drive a repair and
// carries no private data, so it is published; the surrounding statement never
// is. Non-postgres output falls back to the first error-looking line.
export function errorDetail(text) {
  const lines = String(text ?? '').split('\n');
  const sqlstate = lines.find(line => /^psql:.*ERROR:/.test(line))?.match(/ERROR:\s*([0-9A-Z]{5})/)?.[1] ?? null;
  const detail = {};
  for (const line of lines) {
    const match = line.match(/^(DETAIL|HINT|CONTEXT|SCHEMA NAME|TABLE NAME|COLUMN NAME|DATATYPE NAME|CONSTRAINT NAME):\s*(.*)$/);
    if (match) detail[match[1]] = redact(match[2]).slice(0, 160);
  }
  const message = lines.find(line => /ERROR:\s/.test(line))?.replace(/^psql:[^ ]*\s*/, '').match(/ERROR:\s*(.*)$/)?.[1] ?? null;
  const errorLine = message ? redact(message).slice(0, 200) : (() => {
    for (const line of lines) {
      if (/error|Error|ERROR|fatal|FATAL|denied|refused|expected|Expected|FAIL|fail/i.test(line)) return redact(line).slice(0, 200);
    }
    return null;
  })();
  return {errorLine, sqlstate, detail: Object.keys(detail).length ? detail : null};
}

function errorLine(text) {
  return errorDetail(text).errorLine;
}

function run(command, args, {cwd, env, timeoutMs, logPath, untrustedUser = null}) {
  const started = Date.now();
  const invocation = untrustedUser
    ? buildUntrustedInvocation(command, args, {user: untrustedUser, env: env ?? {}})
    : {command, args, env: env ?? {}};
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    env: invocation.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  });
  const durationMs = Date.now() - started;
  const output = String(result.stdout ?? '') + String(result.stderr ?? '');
  if (logPath) {
    // The parent creates a private log directory before the first untrusted
    // command runs. O_EXCL makes a child-created symlink or pre-existing path a
    // hard failure rather than a write-through into a trusted file.
    fs.writeFileSync(logPath, redact(output) + '\n', {mode: 0o600, flag: 'wx'});
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
    ...(result.status === 0 ? {} : (() => {
      const d = errorDetail(output);
      const py = extractPythonDiagnostics(output);
      return {
        sqlstate: d.sqlstate,
        sqlDetail: d.detail,
        ...(py.versionsAvailable || py.pythonVersion ? {python: py} : {}),
      };
    })()),
    errorLine: result.status === 0 ? null : errorLine(output),
    logTail: result.status === 0 ? null : output.split('\n').slice(-30).join('\n'),
  };
}

// The private Postgres workflows assume a schema created by the Supabase
// migrations. The executor applies those migrations before the workflow runs,
// so a check failure means the check itself failed - never a missing schema.
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

// The private repository carries its schema as ordered migrations. Applying
// them in lexical order is what the schema workflow itself does, so the
// concurrency and schema checks start from the same database they assume.
export function listMigrations(root, directory = 'supabase/migrations') {
  try {
    return fs.readdirSync(path.join(root, directory))
      .filter(name => name.endsWith('.sql'))
      .sort()
      .map(name => `${directory}/${name}`);
  } catch {
    return [];
  }
}

export function listVerificationFiles(root, directory = 'supabase/tests') {
  try {
    return fs.readdirSync(path.join(root, directory))
      .filter(name => name.endsWith('.sql'))
      .sort()
      .map(name => `${directory}/${name}`);
  } catch {
    return [];
  }
}

// Steps that establish the schema a workflow assumes. Migrations are ordered
// and each is applied through psql with ON_ERROR_STOP so a partial schema can
// never be mistaken for a prepared one.
// Supabase migrations assume the hosted platform: the `authenticated`,
// `anon`, `service_role` and `supabase_admin` roles, the `auth`/`storage`/
// `extensions` schemas, and extensions that ship with the platform. Provisioning
// those is what makes the private workflow's own SQL runnable on a local
// postgres:17, which is exactly the schema/bootstrap the workflow expects.
export const PLATFORM_EXTENSIONS = Object.freeze(['pgcrypto', 'uuid-ossp', 'pg_trgm', 'btree_gin', 'citext', 'unaccent', 'pg_stat_statements', 'vector']);

// The platform DDL is fed to psql through a single-quoted heredoc. That is the
// only construction that survives every hazard here: `$$` and `$f$` would be
// shell-expanded inside double quotes, and a JSON-encoded multi-line string
// would reach psql with literal backslash-n. A quoted delimiter performs no
// expansion at all, so the SQL arrives byte-for-byte.
export function platformProvisionScript({roles = true} = {}) {
  const ddl = [];
  if (roles) {
    for (const name of ['anon', 'authenticated', 'service_role', 'supabase_admin', 'supabase_auth_admin', 'supabase_storage_admin']) {
      ddl.push(`do $$ begin if not exists (select 1 from pg_roles where rolname='${name}') then create role ${name} nologin; end if; end $$;`);
    }
  }
  for (const name of ['auth', 'storage', 'extensions', 'realtime', 'vault', 'public']) ddl.push(`create schema if not exists ${name};`);
  // Supabase's hosted platform ships these tables and helpers; the migrations
  // reference them, so their shape is supplied to make the migrations runnable
  // off-platform instead of failing on the first foreign key to auth.users.
  ddl.push(`create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  instance_id uuid,
  aud varchar(255),
  role varchar(255),
  email varchar(255),
  encrypted_password varchar(255),
  email_confirmed_at timestamptz,
  invited_at timestamptz,
  confirmation_token varchar(255),
  raw_app_meta_data jsonb default '{}'::jsonb,
  raw_user_meta_data jsonb default '{}'::jsonb,
  is_super_admin boolean,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  phone text,
  confirmed_at timestamptz,
  last_sign_in_at timestamptz,
  banned_until timestamptz,
  deleted_at timestamptz
);`);
  ddl.push(`create or replace function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;`);
  ddl.push(`create or replace function auth.jwt() returns jsonb language sql stable as $f$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $f$;`);
  ddl.push(`create or replace function auth.role() returns text language sql stable as $f$ select nullif(current_setting('request.jwt.claim.role', true), '') $f$;`);
  ddl.push(`create table if not exists storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now(), updated_at timestamptz default now());`);
  ddl.push(`create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb, created_at timestamptz default now(), updated_at timestamptz default now());`);
  for (const extension of PLATFORM_EXTENSIONS) {
    ddl.push(`create extension if not exists "${extension}" schema extensions;`);
  }

  return [
    'set -uo pipefail',
    '# Report the outcome without aborting: a genuinely broken cluster surfaces',
    '# on the workflow step that follows, where the repository SQL runs.',
    'output=$(psql -v ON_ERROR_STOP=0 -q <<\'WOLF_PLATFORM_DDL\' 2>&1',
    ddl.join('\n'),
    'WOLF_PLATFORM_DDL',
    ')',
    'failed=$(printf \'%s\n\' "$output" | grep -c \'^ERROR\' || true)',
    'printf \'%s\n\' "$output" | grep \'^ERROR\' | cut -c1-120 >&2 || true',
    'echo "PLATFORM_SCHEMA_PROVISIONED=YES FAILED_STATEMENTS=$failed"',
    'exit 0',
  ].join('\n');
}

export function schemaBootstrapSteps({root, database, useMigrations = true, platform = true, platformRoles = false}) {
  const steps = [];
  const migrationFiles = useMigrations ? listMigrations(root) : [];
  // Provision the platform surface first so migration failures are real
  // migration failures rather than missing-role or missing-schema noise. The
  // schema/concurrency workflows create those roles themselves, so they opt out
  // (see buildPlan) to avoid a duplicate-role collision.
  if (migrationFiles.length && platform) {
    steps.push({
      command: 'bash',
      args: ['-c', platformProvisionScript({roles: platformRoles})],
      env: {PGDATABASE: database},
      timeoutMs: 5 * 60 * 1000,
      required: true,
      label: 'platform-provisioning',
    });
  }
  if (migrationFiles.length) {
    const script = [
      'set -euo pipefail',
      'applied=0',
      'failed=0',
      'while IFS= read -r file; do',
      '  if psql -v ON_ERROR_STOP=1 -q -f "$file" >/dev/null; then',
      '    applied=$((applied+1))',
      '  else',
      '    failed=$((failed+1))',
      '    echo "MIGRATION_FAILED_PATH_CLASS=$file" >&2',
      '    psql -v ON_ERROR_STOP=1 -q -f "$file" >&2 || true',
      '  fi',
      'done < <(printf "%s\\n" "$@")',
      'echo "MIGRATIONS_APPLIED=$applied"',
      'if [ "$failed" -gt 0 ]; then echo "MIGRATIONS_FAILED=$failed"; exit 1; fi',
    ].join('\n');
    steps.push({
      command: 'bash',
      args: ['-c', script, 'schema-bootstrap', ...migrationFiles],
      env: {PGDATABASE: database},
      timeoutMs: 20 * 60 * 1000,
      required: true,
      label: 'schema-bootstrap',
    });
  } else {
    const bootstrap = findBootstrap(root);
    if (bootstrap) {
      steps.push({command: 'psql', args: ['-v', 'ON_ERROR_STOP=1', '-q', '-f', bootstrap], env: {PGDATABASE: database}, timeoutMs: 10 * 60 * 1000, required: true, label: 'schema-bootstrap'});
    }
  }
  const verification = listVerificationFiles(root);
  if (verification.length) {
    steps.push({
      command: 'bash',
      args: ['-c', 'set -euo pipefail; for file in "$@"; do echo "SCHEMA_TEST=$file"; psql -v ON_ERROR_STOP=1 -q -f "$file" >/dev/null; done', 'schema-tests', ...verification],
      env: {PGDATABASE: database},
      timeoutMs: 20 * 60 * 1000,
      required: true,
      label: 'schema-verification-tests',
    });
  }
  return steps;
}

// A step is runnable when the bridge can reproduce it faithfully inside the
// executor. Anything else (another checkout, an action with a network install)
// is recorded as skipped with its reason, never silently treated as passing.
// Package installation and image/OCR tooling are part of what these workflows
// actually do on a GitHub runner, so they are reproducible here too.
const RUNNABLE_EXECUTABLES = /^\s*(?:sudo\s+)?(psql|node|npm|npx|bash|sh|python3?|pip3?|git|echo|test|set|export|for|while|if|cat|printf|mkdir|cp|mv|rm|ls|chmod|sleep|true|false|pg_isready|createdb|dropdb|curl|wget|jq|apt-get|apt|dpkg|update-alternatives|tesseract|convert|magick|identify|pdftoppm|unzip|tar)\b/;
const SKIPPABLE_PREFIXES = [/^\s*uses:/, /\s*\bset\s*\+e\b/, /^\s*git\s+clone\b/];

export function classifyWorkflowStep(step) {
  if (step.empty) return {runnable: false, reason: 'STEP_HAS_NO_COMMAND'};
  if (!step.run) {
    if (step.uses) return {runnable: false, reason: 'STEP_USES_EXTERNAL_ACTION', uses: step.uses};
    return {runnable: false, reason: 'STEP_HAS_NO_COMMAND'};
  }
  const firstCommandLines = step.run.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  if (!firstCommandLines.length) return {runnable: false, reason: 'STEP_RUN_EMPTY'};
  const accepted = firstCommandLines.filter(line => RUNNABLE_EXECUTABLES.test(line));
  if (!accepted.length) return {runnable: false, reason: 'STEP_NOT_REPRODUCIBLE'};
  return {runnable: true, reason: null, commandCount: accepted.length};
}

// Builds executable steps from a workflow's own definition, starting at
// `fromStep` (a step name) so bootstrap steps are not duplicated.
export function workflowSteps({root, check, fromStepIndex = 0, database, extraEnv = {}}) {
  const definition = WORKFLOW_CHECKS[check];
  if (!definition) throw Error('EXECUTOR_WORKFLOW_CHECK_UNKNOWN');
  const targetDatabase = database === undefined ? definition.database : database;
  const clusterEnv = {
    ...(targetDatabase ? {PGDATABASE: targetDatabase} : {}),
    ...(definition.port ? {PGPORT: String(definition.port)} : {}),
  };
  const plan = buildWorkflowPlan(root, definition.workflow);
  if (plan.state !== 'PLANNED') throw Error('EXECUTOR_WORKFLOW_ABSENT');
  const all = plan.jobs.flatMap(job => job.steps);
  if (!all.length) throw Error('EXECUTOR_WORKFLOW_STEPS_EMPTY');
  const steps = [];
  for (let index = fromStepIndex; index < all.length; index += 1) {
    const step = all[index];
    const verdict = classifyWorkflowStep(step);
    if (!verdict.runnable) {
      steps.push({
        command: 'node',
        // A step the controller cannot reproduce is not a pass. Exit 78 keeps
        // the required check red without copying the target action text into evidence.
        args: ['--input-type=module', '-e', "console.error('EXECUTOR_WORKFLOW_STEP_NOT_REPRODUCIBLE'); process.exit(78);"],
        env: {},
        timeoutMs: 60 * 1000,
        required: true,
        label: `unsupported:${step.name ?? verdict.reason}`,
        skippedReason: verdict.reason,
      });
      continue;
    }
    steps.push({
      command: 'bash',
      // Match GitHub's Bash runner semantics. Without `-e -o pipefail`, an early
      // command or pipeline failure could be masked by a later successful echo and
      // the required check would be reported as a pass.
      args: ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run],
      env: {...clusterEnv, ...extraEnv},
      timeoutMs: 20 * 60 * 1000,
      required: true,
      label: step.name ?? `step-${index}`,
      workflowStep: {workflow: definition.workflow, stepName: step.name ?? null, stepIndex: index},
    });
  }
  return steps;
}

function buildPlan({root, checks, env}) {
  const plan = [];
  // The private postgres-schema and postgres-concurrency workflows both run
  // against POSTGRES_DB=wolf_test on postgres:17, while the DBOS integration
  // workflow uses wolf_factory_dbos. Each check therefore pins its own database
  // explicitly instead of inheriting the job-wide PGDATABASE.
  const schemaDatabase = env.WOLF_CI_SCHEMA_DATABASE || 'wolf_test';
  // Each workflow check gets its own database. They create roles and fixtures
  // with the same names, so sharing one database makes them interfere.
  const isolatedDatabase = check => `${schemaDatabase}_${String(check).replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`;
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
  // The two Postgres checks run the original Wolf workflows' own commands. Both
  // assume a populated schema, so the ordered migrations are applied first and
  // a migration failure fails the check: it is never downgraded to advisory.
  // When the workflow itself supplies schema steps (the "Build synthetic
  // canonical database evidence" / schema-sequence steps) those ARE the
  // bootstrap. Only the platform surface is provisioned first; mixing in the
  // repository's migrations as well would change what the workflow measures.
  // These two workflows build their own database fixture, including the
  // roles and schema they need. Pre-creating the platform surface collides with
  // their own `create role` statements, so they run unprovisioned and isolated.
  // These workflows build their own fixture, including `create role
  // authenticated`. The schema still has to exist first (their verify scripts
  // read public tables), so the ordered migrations run; the platform roles are
  // left for the workflow to create so its own statements do not collide.
  // The concurrency workflow builds its own canonical fixture end to end,
  // including the roles and the tables it then measures. Any bootstrap would
  // change what it is measuring, so it runs exactly as written.
  if (checks.includes('postgres-concurrency')) {
    plan.push({name: 'postgres-concurrency', steps: workflowSteps({root, check: 'postgres-concurrency', database: isolatedDatabase('postgres-concurrency')})});
  }
  // The schema workflow verifies the schema the migrations produce, so the
  // migrations are applied first with only the platform schemas supplied.
  if (checks.includes('postgres-schema')) {
    plan.push({name: 'postgres-schema', steps: [
      ...schemaBootstrapSteps({root, database: isolatedDatabase('postgres-schema'), platform: true, platformRoles: false}),
      ...workflowSteps({root, check: 'postgres-schema', database: isolatedDatabase('postgres-schema')}),
    ]});
  }
  if (checks.includes('test')) {
    plan.push({name: 'test', steps: workflowSteps({root, check: 'test', database: isolatedDatabase('test')})});
  }
  if (checks.includes('http-load-evidence')) {
    plan.push({name: 'http-load-evidence', steps: workflowSteps({root, check: 'http-load-evidence', database: isolatedDatabase('http-load-evidence')})});
  }
  if (checks.includes('ocr-tesseract')) {
    plan.push({name: 'ocr-tesseract', steps: workflowSteps({root, check: 'ocr-tesseract', database: null})});
  }
  if (checks.includes('ocr-paddle')) {
    plan.push({name: 'ocr-paddle', steps: workflowSteps({root, check: 'ocr-paddle', database: null})});
  }
  return plan;
}

function assertArtifactOutsideCheckout(root, artifact, label) {
  if (!artifact) return;
  const relative = path.relative(path.resolve(root), path.resolve(artifact));
  if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw Error(`EXECUTOR_${label}_MUST_BE_OUTSIDE_CHECKOUT`);
  }
}

function preparePrivateLogDirectory(root, directory) {
  const absolute = path.resolve(directory);
  const parent = path.dirname(absolute);
  fs.mkdirSync(parent, {recursive: true, mode: 0o700});
  const realParent = fs.realpathSync(parent);
  const actualPath = path.join(realParent, path.basename(absolute));
  assertArtifactOutsideCheckout(root, actualPath, 'LOG_DIR');
  try {
    fs.lstatSync(absolute);
    throw Error('EXECUTOR_LOG_DIR_ALREADY_EXISTS');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  fs.mkdirSync(absolute, {mode: 0o700});
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw Error('EXECUTOR_LOG_DIR_NOT_PRIVATE');
  }
  fs.chmodSync(absolute, 0o700);
  if (fs.lstatSync(absolute).mode & 0o077) throw Error('EXECUTOR_LOG_DIR_NOT_PRIVATE');
  return absolute;
}

function stopUntrustedProcesses(user) {
  const sudo = '/usr/bin/sudo';
  const processEnv = {PATH: process.env.PATH ?? '/usr/bin:/bin'};
  const invoke = (tool, args) => spawnSync(sudo, ['-n', tool, ...args], {
    env: processEnv,
    encoding: 'utf8',
    timeout: 5000,
  });
  const killed = invoke('/usr/bin/pkill', ['-KILL', '-u', user]);
  if (killed.error || ![0, 1].includes(killed.status)) throw Error('EXECUTOR_UNTRUSTED_PROCESS_CLEANUP_FAILED');
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const remaining = invoke('/usr/bin/pgrep', ['-u', user]);
    if (remaining.status === 1) return;
    if (remaining.error || remaining.status !== 0) throw Error('EXECUTOR_UNTRUSTED_PROCESS_CLEANUP_FAILED');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  throw Error('EXECUTOR_UNTRUSTED_PROCESS_CLEANUP_FAILED');
}

export function executePrivateCi({root, sha, checks, logDir, receiptPath, env = {}, runnerTemp = process.env.RUNNER_TEMP, signingKey = process.env.WOLF_CI_RECEIPT_SIGNING_KEY, missionId = process.env.WOLF_CI_MISSION_ID, missionReservation = process.env.WOLF_CI_MISSION_RESERVATION, untrustedUser = process.env.WOLF_CI_UNTRUSTED_USER ?? null, untrustedHome = process.env.WOLF_CI_UNTRUSTED_HOME ?? null} = {}) {
  const normalizedSha = normalizeSha(sha);
  const normalizedChecks = normalizeChecks(checks);
  if (typeof signingKey !== 'string' || Buffer.byteLength(signingKey, 'utf8') < 32) throw Error('EXECUTOR_RECEIPT_SIGNING_KEY_REQUIRED');
  if (typeof missionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(missionId) || !/^[a-f0-9]{64}$/.test(String(missionReservation ?? ''))) {
    throw Error('EXECUTOR_MISSION_BINDING_REQUIRED');
  }
  if (!logDir) throw Error('EXECUTOR_LOG_DIR_REQUIRED');
  if (untrustedUser) {
    if (!SANDBOX_USER_PATTERN.test(untrustedUser) || untrustedUser === 'root') throw Error('EXECUTOR_UNTRUSTED_USER_INVALID');
    if (typeof untrustedHome !== 'string' || !path.isAbsolute(untrustedHome)) throw Error('EXECUTOR_UNTRUSTED_HOME_REQUIRED');
  } else if (untrustedHome) {
    throw Error('EXECUTOR_UNTRUSTED_USER_REQUIRED');
  }
  const checkout = inspectCheckout({root, sha: normalizedSha});
  const checkoutRoot = checkout.root;
  assertArtifactOutsideCheckout(checkoutRoot, logDir, 'LOG_DIR');
  assertArtifactOutsideCheckout(checkoutRoot, receiptPath, 'RECEIPT');
  const trustedLogDir = preparePrivateLogDirectory(checkoutRoot, logDir);
  const startedAt = new Date().toISOString();
  const results = [];
  let failure = null;
  // Every requested check is blocking. There is no advisory tier: a check that
  // runs must be able to fail the run, or the receipt would not mean anything.
  const plan = buildPlan({root: checkoutRoot, checks: normalizedChecks, env});
  for (const group of plan) {
    const groupStarted = Date.now();
    const steps = [];
    for (const step of group.steps) {
      const logPath = path.join(trustedLogDir, `${group.name}-${steps.length + 1}.log`);
      const result = run(step.command, step.args, {
        cwd: checkoutRoot,
        env: workflowChildEnvironment({parent: process.env, env, stepEnv: step.env, isolatedHome: untrustedHome, safeGitDirectory: checkoutRoot}),
        timeoutMs: step.timeoutMs,
        logPath,
        untrustedUser,
      });
      const expected = step.expected ?? [0];
      const passed = expected.includes(result.exitCode) && !result.timedOut;
      const stepStatus = passed ? 'success' : result.timedOut ? 'timeout' : 'failure';
      const workflowPath = step.workflowStep?.workflow;
      const safeStep = {
        stepIndex: steps.length,
        ...(typeof workflowPath === 'string' && Object.values(WORKFLOW_CHECKS).some(definition => definition.workflow === workflowPath) ? {workflow: workflowPath} : {}),
        exitCode: result.exitCode,
        expectedExitCodes: expected,
        durationMs: result.durationMs,
        status: stepStatus,
      };
      // Target-controlled command text, step labels and output belong only in the
      // mode-0600 ephemeral log. A signed receipt carries no free-form target data.
      if (!passed) {
        safeStep.errorClass = result.errorClass;
        if (/^[0-9A-Z]{5}$/.test(String(result.sqlstate ?? ''))) safeStep.sqlstate = result.sqlstate;
      }
      steps.push(safeStep);
      if (!passed && step.required) failure = `${group.name}:${steps.length}`;
    }
    results.push({
      name: group.name,
      sha: checkout.sha,
      treeSha: checkout.treeSha,
      status: steps.every(step => step.status === 'success') ? 'success' : 'failure',
      durationMs: Date.now() - groupStarted,
      steps,
    });
    process.stdout.write(`WOLF_CI_CHECK=${JSON.stringify({name: group.name, status: results.at(-1).status, steps: steps.map(step => ({exitCode: step.exitCode, status: step.status}))})}\n`);
  }
  let checkoutAfter = null;
  let sourceIntegrityFailure = null;
  if (untrustedUser) {
    try {
      // Background descendants can outlive a shell step. Revoke their write
      // access before the trusted process measures the final source tree.
      stopUntrustedProcesses(untrustedUser);
    } catch {
      sourceIntegrityFailure = 'EXECUTOR_UNTRUSTED_PROCESS_CLEANUP_FAILED';
    }
  }
  try {
    checkoutAfter = inspectCheckout({root: checkoutRoot, sha: normalizedSha});
    if (checkoutAfter.treeSha !== checkout.treeSha) sourceIntegrityFailure ??= 'EXECUTOR_CHECKOUT_TREE_CHANGED';
  } catch (error) {
    sourceIntegrityFailure ??= error?.message ?? 'EXECUTOR_CHECKOUT_POSTCHECK_FAILED';
  }
  if (sourceIntegrityFailure) failure ??= 'SOURCE_INTEGRITY_CHANGED';
  const failedChecks = results.filter(check => check.status !== 'success').map(check => check.name);
  if (sourceIntegrityFailure) failedChecks.push('source-integrity');
  const unsignedReceipt = {
    schema: RECEIPT_SCHEMA,
    state: failure ? 'FAILED' : 'VERIFIED',
    sha: checkout.sha,
    treeSha: checkout.treeSha,
    repository: SOURCE_REPOSITORY,
    checkout: {
      sha: checkout.sha,
      treeSha: checkout.treeSha,
      cleanBefore: checkout.clean,
      cleanAfter: Boolean(checkoutAfter?.clean) && !sourceIntegrityFailure,
      finalSha: checkoutAfter?.sha ?? null,
      finalTreeSha: checkoutAfter?.treeSha ?? null,
    },
    testBinding: {sha: checkout.sha, treeSha: checkout.treeSha, checks: normalizedChecks},
    missionBinding: {missionId, reservationKey: missionReservation, sha: checkout.sha},
    checks: results,
    requiredChecks: normalizedChecks.filter(check => REQUIRED_CHECKS.includes(check)),
    extraChecks: normalizedChecks.filter(check => EXTRA_CHECKS.includes(check)),
    failedChecks,
    startedAt,
    completedAt: new Date().toISOString(),
    failure,
    sourceIntegrityFailure,
    // Set when this run took over an expired lease from another runner.
    recoveredFrom: process.env.WOLF_CI_RECOVERED_FROM || null,
    privateLogsPublished: false,
    privateSourcePublished: false,
    inferencePerformed: false,
    refUpdated: false,
  };
  const receipt = signReceipt(unsignedReceipt, signingKey);
  if (receiptPath) {
    fs.mkdirSync(path.dirname(receiptPath), {recursive: true, mode: 0o700});
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
  }
  return receipt;
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  try {
    const untrustedUser = process.env.WOLF_CI_UNTRUSTED_USER ?? null;
    const untrustedHome = process.env.WOLF_CI_UNTRUSTED_HOME ?? null;
    if (process.env.GITHUB_ACTIONS === 'true' && (!untrustedUser || !untrustedHome)) {
      throw Error('EXECUTOR_UNTRUSTED_IDENTITY_REQUIRED');
    }
    const receipt = executePrivateCi({
      root: process.env.WOLF_CI_PRIVATE_ROOT,
      sha: process.env.WOLF_CI_SHA,
      checks: process.env.WOLF_CI_CHECKS,
      logDir: process.env.WOLF_CI_LOG_DIR,
      receiptPath: process.env.WOLF_CI_RECEIPT,
      untrustedUser,
      untrustedHome,
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

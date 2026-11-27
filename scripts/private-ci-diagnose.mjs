// Read-only diagnostics for the private CI scripts. Publishes only numeric exit
// codes, environment-variable names and executable names; never source lines,
// paths under the private root, logs or credentials.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export function extractExitCodes(source) {
  const codes = new Set();
  const text = String(source ?? '');
  for (const match of text.matchAll(/process\.exit\(\s*(\d+)\s*\)/g)) codes.add(Number(match[1]));
  for (const match of text.matchAll(/process\.exitCode\s*=\s*(\d+)/g)) codes.add(Number(match[1]));
  for (const match of text.matchAll(/(?:^|\n)\s*exit\s+(\d+)\b/g)) codes.add(Number(match[1]));
  return [...codes].sort((a, b) => a - b);
}

export function extractEnvKeys(source) {
  const keys = new Set();
  const text = String(source ?? '');
  for (const match of text.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) keys.add(match[1]);
  for (const match of text.matchAll(/\$\{?([A-Z][A-Z0-9_]*)\}?/g)) keys.add(match[1]);
  for (const match of text.matchAll(/\b([A-Z][A-Z0-9_]{2,})\s*=\s*["']?/g)) keys.add(match[1]);
  return [...keys].filter(key => !['PATH', 'HOME', 'PWD', 'SHELL', 'USER', 'TERM', 'LANG', 'LC_ALL'].includes(key)).sort();
}

export function extractCommands(source) {
  const commands = new Set();
  for (const line of String(source ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(?:sudo\s+)?(?:[A-Za-z0-9_./-]+\/)?(psql|node|npm|npx|bash|sh|python3?|git|docker|pg_isready|createdb|dropdb)(?=\s|$)/);
    if (match) commands.add(match[1]);
  }
  return [...commands].sort();
}

export function extractShellEnvKeys(source) {
  const keys = new Set();
  const text = String(source ?? '');
  for (const match of text.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) {
    if (!['PATH', 'HOME', 'PWD', 'SHELL', 'USER', 'TERM', 'LANG', 'LC_ALL', 'UID', 'EUID', 'PPID', 'RANDOM', 'SECONDS', 'LINENO', 'FUNCNAME', 'BASH_SOURCE', 'BASH_VERSION'].includes(match[1])) keys.add(match[1]);
  }
  for (const match of text.matchAll(/\b([A-Z][A-Z0-9_]{2,})\s*=/g)) keys.add(match[1]);
  for (const match of text.matchAll(/export\s+([A-Za-z_][A-Za-z0-9_]*)/g)) keys.add(match[1]);
  return [...keys].sort();
}

export function extractPsqlFlags(source) {
  const flags = new Set();
  for (const line of String(source ?? '').split('\n')) {
    if (!/\bpsql\b/.test(line)) continue;
    for (const match of line.matchAll(/(?:^|\s)(-[A-Za-z])(?:\s|=|$)/g)) flags.add(match[1]);
    for (const match of line.matchAll(/(--?[a-z][a-z-]*)/g)) flags.add(match[1]);
  }
  return [...flags].sort();
}

export function extractSqlFiles(source) {
  const files = new Set();
  for (const match of String(source ?? '').matchAll(/([A-Za-z0-9_./-]+\.sql)\b/g)) {
    const base = match[1].split('/').pop();
    if (base && !base.includes('$')) files.add(base);
  }
  return [...files].sort().slice(0, 50);
}

export function extractWorkflowUses(source) {
  const uses = new Set();
  for (const match of String(source ?? '').matchAll(/uses:\s*([^\s#]+)/g)) uses.add(match[1].split('@')[0]);
  return [...uses].sort();
}

// Ordered list of the psql -f targets with their directory, so the bootstrap
// that the private workflow assumes can be identified from structure alone.
export function extractPsqlPlan(source) {
  const plan = [];
  for (const raw of String(source ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/(?:^|[\s;&|(])psql\s+(.*)$/);
    if (!match) continue;
    const args = match[1];
    const target = args.match(/-f\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
    if (!target) continue;
    const file = (target[1] ?? target[2] ?? target[3] ?? '').trim();
    if (!file || file.includes('$')) continue;
    plan.push({
      dir: file.split('/').slice(0, -1).join('/') || '.',
      base: file.split('/').pop(),
      onErrorStop: /ON_ERROR_STOP/.test(args),
      // Exclude -f, whose value is already reported as the target file.
      flags: [...args.matchAll(/(?:^|\s)(-[a-zA-Z]+)(?=\s|$)/g)].map(match => match[1]).filter(value => value !== '-f').sort(),
    });
    if (plan.length >= 80) break;
  }
  return plan;
}

// Structural facts about how a workflow provisions its database: which
// executables run before the first psql call, the psql flags used, and whether
// the workflow itself creates schema or expects it. No source text is returned.
export function extractProvisioning(source) {
  const text = String(source ?? '');
  const lines = text.split('\n');
  const executables = new Set();
  const setupExcerpt = [];
  let seenPsql = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (!seenPsql && /psql\b/.test(line)) seenPsql = true;
    const command = line.match(/^(?:sudo\s+)?([a-z0-9_.-]+)\b/);
    if (command) executables.add(command[1]);
    if (!seenPsql && setupExcerpt.length < 40) {
      // Report only the executable and flag shape, never arguments or paths.
      const tokens = line.split(/\s+/).slice(0, 3).map(token => (/^-/.test(token) ? token : token.replace(/[A-Za-z0-9_./-]+/g, '<arg>')));
      setupExcerpt.push(tokens.join(' '));
    }
  }
  return {
    executableNames: [...executables].sort(),
    prePsqlCommands: setupExcerpt,
    createsSchema: /CREATE\s+(TABLE|SCHEMA|EXTENSION)/i.test(text),
    createsDatabase: /CREATE\s+DATABASE/i.test(text),
    usesOnErrorStop: /ON_ERROR_STOP/.test(text),
    referencesMigrations: /migrations/i.test(text),
    referencesSchemaFile: /\.sql\b/.test(text),
    // Package/tool setup lines, reduced to manager + verb.
    toolchainSetup: [...new Set(lines
      .map(line => line.trim())
      .map(line => line.match(/^(apt-get|apt|npm|npx|pip|pip3|corepack|yarn|pnpm|docker|systemctl|service|pg_ctl|initdb)\s+(\S+)/))
      .filter(Boolean)
      .map(match => `${match[1]} ${match[2]}`))].sort(),
    // Supabase CLI/service-hosting markers: these change what the schema expects.
    supabaseCli: /\bsupabase\b/.test(text),
    usesServiceContainer: /^\s*services:\s*$/m.test(text),
    workingDirectories: [...new Set([...text.matchAll(/working-directory:\s*(\S+)/g)].map(match => match[1]))].sort(),
  };
}

// Non-secret service/setup facts: which step names precede the psql run block.
export function extractStepNames(source) {
  const names = [];
  for (const line of String(source ?? '').split('\n')) {
    const match = line.match(/^\s*- name:\s*(.+)$/);
    if (match) names.push(match[1].trim().slice(0, 80));
    if (names.length >= 40) break;
  }
  return names;
}

export function extractWorkflowConfig(source) {
  const text = String(source ?? '');
  const envKeys = new Set();
  const serviceEnvKeys = new Set();
  let inServices = false;
  let currentService = null;
  for (const line of text.split('\n')) {
    if (/^services:\s*$/.test(line)) { inServices = true; currentService = null; continue; }
    if (inServices && /^[^\s]/.test(line)) { inServices = false; currentService = null; }
    if (inServices) {
      const service = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
      if (service) { currentService = service[1]; continue; }
      const env = line.match(/^ {6}env:\s*$/);
      if (env) continue;
      const key = line.match(/^ {8}([A-Z][A-Z0-9_]+):/);
      if (key && currentService) serviceEnvKeys.add(key[1]);
      continue;
    }
    const key = line.match(/^\s+([A-Z][A-Z0-9_]{2,}):\s/);
    if (key && !['PGPASSWORD', 'PGUSER', 'PGHOST', 'PGPORT', 'PGDATABASE'].includes(key[1])) envKeys.add(key[1]);
  }
  const image = text.match(/image:\s*([^\s#]+)/m)?.[1] ?? null;
  const ports = [...text.matchAll(/-\s*['"]?([0-9]+):([0-9]+)/g)].map(match => `${match[1]}:${match[2]}`);
  // Non-secret service/job env values (never passwords or tokens).
  const nonSecret = {};
  for (const match of text.matchAll(/^\s*(POSTGRES_DB|POSTGRES_USER|PGDATABASE|PGUSER|PGHOST|PGPORT|DBOS_SHA|WOLF_DBOS_[A-Z_]+):\s*([^\s#]+)/gm)) {
    const key = match[1];
    const value = match[2].replace(/^['"]|['"]$/g, '');
    if (!/password|token|secret|key/i.test(key) && value.length < 120 && !value.includes('$')) nonSecret[key] = value;
  }
  return {envKeys: [...envKeys].sort(), serviceEnvKeys: [...serviceEnvKeys].sort(), serviceImage: image, servicePorts: ports, nonSecretValues: nonSecret, uses: extractWorkflowUses(text)};
}

// Directory names and .sql file counts only; never file contents.
export function describeSqlTree(root) {
  const summary = {};
  const visit = (directory, depth) => {
    if (depth > 2) return;
    let entries;
    try { entries = fs.readdirSync(path.join(root, directory), {withFileTypes: true}); } catch { return; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { visit(relative, depth + 1); continue; }
      if (!entry.name.endsWith('.sql')) continue;
      const parent = directory || '.';
      summary[parent] = (summary[parent] ?? 0) + 1;
    }
  };
  for (const base of ['supabase', 'db', 'migrations', 'scripts']) visit(base, 0);
  return Object.fromEntries(Object.entries(summary).sort(([a], [b]) => a.localeCompare(b)).slice(0, 40));
}

// Files are summarized by directory and first-token shape only. This answers
// "does the schema live in migrations or in test fixtures?" without exposing SQL.
export function summarizeSqlDirectory(root, directory) {
  const base = path.join(root, directory);
  let names;
  try { names = fs.readdirSync(base).filter(name => name.endsWith('.sql')).sort(); } catch { return null; }
  const creaters = [];
  const inserts = [];
  for (const name of names) {
    let text;
    try { text = fs.readFileSync(path.join(base, name), 'utf8'); } catch { continue; }
    if (/create\s+(?:or\s+replace\s+)?(?:table|schema|role|type|function|extension)/i.test(text)) creaters.push(name);
    if (/insert\s+into|copy\s+/i.test(text)) inserts.push(name);
  }
  return {count: names.length, sample: names.slice(0, 6), createsSchema: creaters.length, insertFiles: inserts.length};
}

// psql flags used per script, so the invocation the repository expects can be
// reproduced exactly (e.g. -1 signleton transaction, or single-transaction).
export function summarizePsqlInvocations(root) {
  const result = {};
  const walk = (directory, depth) => {
    if (depth > 2) return;
    let entries;
    try { entries = fs.readdirSync(path.join(root, directory), {withFileTypes: true}); } catch { return; }
    for (const entry of entries) {
      if (['node_modules', '.git'].includes(entry.name)) continue;
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) { walk(relative, depth + 1); continue; }
      if (!/\.(sh|mjs|js)$/.test(entry.name)) continue;
      let text;
      try { text = fs.readFileSync(path.join(root, relative), 'utf8'); } catch { continue; }
      for (const match of text.matchAll(/psql\s+((?:-[A-Za-z]+\s+\S+\s+)*)-f\s+(\S+)/g)) {
        const flags = (match[1].match(/-[A-Za-z]+/g) ?? []).sort().join(' ');
        const target = match[2];
        const key = target.includes('migrations') ? 'migrations' : target.includes('tests') ? 'tests' : 'other';
        result[key] = result[key] ?? new Set();
        result[key].add(flags || '(none)');
      }
    }
  };
  for (const base of ['scripts', 'supabase']) walk(base, 0);
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, [...value].sort()]));
}

export function diagnosePrivateCi({root} = {}) {
  if (!root || !fs.existsSync(root)) throw Error('DIAGNOSTIC_ROOT_REQUIRED');
  const read = relative => {
    try { return fs.readFileSync(path.join(root, relative), 'utf8'); } catch { return null; }
  };
  const dbos = read('scripts/wolf-dbos-outer-e2e.mjs');
  const migration = read('scripts/run-postgres-schema-verification.sh') ?? read('scripts/verify-postgres-price-history-store.mjs');
  const concurrency = read('scripts/measure-postgres-concurrency.mjs');
  const actionlint = read('scripts/run-actionlint.sh');
  const workflowFiles = ['factory-dbos-outer-e2e.yml', 'postgres-schema.yml', 'postgres-concurrency-evidence.yml', 'test.yml', 'actionlint.yml', 'http-load-evidence.yml', 'ocr-tesseract.yml', 'ocr-paddle.yml'];
  const workflows = {};
  for (const file of workflowFiles) {
    const source = read(`.github/workflows/${file}`);
    if (source) workflows[file] = extractWorkflowConfig(source);
  }
  const migrationShell = read('scripts/run-postgres-schema-verification.sh');
  return {
    state: 'DIAGNOSED',
    dbos: dbos ? {exitCodes: extractExitCodes(dbos), envKeys: extractEnvKeys(dbos), commands: extractCommands(dbos)} : null,
    migrations: migration ? {exitCodes: extractExitCodes(migration), envKeys: extractEnvKeys(migration), commands: extractCommands(migration), shellEnvKeys: migrationShell ? extractShellEnvKeys(migrationShell) : null, psqlFlags: migrationShell ? extractPsqlFlags(migrationShell) : null, sqlFiles: migrationShell ? extractSqlFiles(migrationShell) : null} : null,
    concurrency: concurrency ? {exitCodes: extractExitCodes(concurrency), envKeys: extractEnvKeys(concurrency), commands: extractCommands(concurrency)} : null,
    actionlint: actionlint ? {exitCodes: extractExitCodes(actionlint), envKeys: extractEnvKeys(actionlint), commands: extractCommands(actionlint)} : null,
    workflows,
    concurrencyPlan: (() => {
      const source = read('.github/workflows/postgres-concurrency-evidence.yml');
      return source ? {steps: extractStepNames(source), psql: extractPsqlPlan(source), provisioning: extractProvisioning(source)} : null;
    })(),
    schemaPlan: (() => {
      const source = read('.github/workflows/postgres-schema.yml');
      return source ? {steps: extractStepNames(source), psql: extractPsqlPlan(source), provisioning: extractProvisioning(source)} : null;
    })(),
    workflowProvisions: (() => {
      const summary = {};
      for (const file of workflowFiles) {
        const source = read(`.github/workflows/${file}`);
        if (source) summary[file] = extractProvisioning(source);
      }
      return summary;
    })(),
    sqlTree: describeSqlTree(root),
    migrationsDir: summarizeSqlDirectory(root, 'supabase/migrations'),
    testsDir: summarizeSqlDirectory(root, 'supabase/tests'),
    psqlInvocations: summarizePsqlInvocations(root),
    sourcePublished: false,
    logsPublished: false,
    inferencePerformed: false,
  };
}

export function buildPublicDiagnosticAggregate(result = {}) {
  return {
    schema: 'wolf.private-ci.aggregate/v1',
    kind: 'private-ci-diagnostic',
    state: result?.state === 'DIAGNOSED' ? 'COMPLETED' : result?.state === 'FAILED' ? 'FAILED' : 'UNKNOWN',
    privateSourcePublished: false,
    privateLogsPublished: false,
    credentialsPrinted: false,
  };
}

async function publish(result) {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  if (!token || !repository || !sha) return {state: 'SKIPPED'};
  const aggregate = buildPublicDiagnosticAggregate(result);
  const response = await fetch(`https://api.github.com/repos/${repository}/commits/${sha}/comments`, {
    method: 'POST',
    headers: {authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'WolfPrivateCiDiagnostic'},
    body: JSON.stringify({body: '```json\n' + JSON.stringify(aggregate, null, 2) + '\n```'}),
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) { await response.body?.cancel(); return {state: 'FAILED'}; }
  return {state: 'PUBLISHED'};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = diagnosePrivateCi({root: process.env.WOLF_CI_PRIVATE_ROOT});
    const publication = await publish(result);
    process.stdout.write(JSON.stringify({...buildPublicDiagnosticAggregate(result), publicationState: publication.state}) + '\n');
  } catch {
    process.stderr.write(JSON.stringify({state: 'FAILED', reason: 'DIAGNOSTIC_FAILED', privateSourcePublished: false, credentialsPrinted: false}) + '\n');
    process.exitCode = 1;
  }
}

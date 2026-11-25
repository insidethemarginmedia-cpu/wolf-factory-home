// Single source of truth for the private CI check contract. The bridge may
// normalize a subset for local controller checks; mission admission fixes the
// complete set before any private-source access.

export const DEFAULT_REQUIRED_CHECKS = Object.freeze([
  'security', 'lint', 'typecheck', 'unit', 'integration', 'build',
]);

export const WORKFLOW_CHECKS = Object.freeze({
  test: {workflow: '.github/workflows/test.yml', database: 'wolf_test', port: 5432},
  'postgres-schema': {workflow: '.github/workflows/postgres-schema.yml', database: 'wolf_test', port: 5433},
  'postgres-concurrency': {workflow: '.github/workflows/postgres-concurrency-evidence.yml', database: 'wolf_test', port: 5434},
  'http-load-evidence': {workflow: '.github/workflows/http-load-evidence.yml', database: 'wolf_test', port: 5432},
  'ocr-tesseract': {workflow: '.github/workflows/ocr-tesseract.yml', database: null, port: null},
  'ocr-paddle': {workflow: '.github/workflows/ocr-paddle.yml', database: null, port: null},
});

export const ALL_REQUIRED_CHECKS = Object.freeze([
  ...DEFAULT_REQUIRED_CHECKS,
  'migrations', 'postgres-concurrency', 'postgres-schema', 'test',
  'http-load-evidence', 'ocr-tesseract', 'ocr-paddle',
]);
// Every allowed check outside the six base checks is reported as an extra and
// remains blocking when requested; there is no advisory-only check category.
export const ALLOWED_CHECKS = ALL_REQUIRED_CHECKS;
export const EXTRA_CHECKS = Object.freeze(ALLOWED_CHECKS.filter(name => !DEFAULT_REQUIRED_CHECKS.includes(name)));

export function normalizeCheckNames(value, {
  defaults = DEFAULT_REQUIRED_CHECKS,
  allowed = ALLOWED_CHECKS,
  errorPrefix = 'CHECK',
} = {}) {
  const source = value === undefined || value === null ? defaults.join(',') : value;
  const checks = [...new Set(String(source).split(',').map(item => item.trim().toLowerCase()).filter(Boolean))];
  if (!checks.length) throw Error(`${errorPrefix}_REQUIRED`);
  for (const check of checks) if (!allowed.includes(check)) throw Error(`${errorPrefix}_DENIED`);
  return checks;
}

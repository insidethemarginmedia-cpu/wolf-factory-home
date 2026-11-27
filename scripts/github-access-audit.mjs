#!/usr/bin/env node
// Read-only capability inventory; never dispatches workflows or writes to GitHub.
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

export const repositories = [
  'donraposo1-source/project-wolf',
  'insidethemarginmedia-cpu/wolf-factory-home',
  'donraposo1-source/wolf-compute',
  'insidethemarginmedia-cpu/composio-engineering-kit',
];
export const endpoints = {
  metadata: '', workflows: '/actions/workflows?per_page=1',
  issues: '/issues?state=all&per_page=1', pulls: '/pulls?state=all&per_page=1',
  checks: '/commits/HEAD/check-runs?per_page=1', actions_policy: '/actions/permissions',
};

export function classify(status) {
  if (status >= 200 && status < 300) return 'READABLE';
  if (status === 404) return 'NOT_FOUND_OR_INACCESSIBLE';
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN_OR_RATE_LIMITED';
  return 'UNKNOWN';
}

export function probe(repo, suffix, run = spawnSync) {
  const result = run('gh', ['api', '--include', '--method', 'GET', `repos/${repo}${suffix}`], {encoding: 'utf8', timeout: 15000});
  const output = result.stdout || '';
  const matches = [...output.matchAll(/^HTTP\/\S+\s+(\d{3})\b/gm)];
  const status = matches.length ? Number(matches.at(-1)[1]) : null;
  // Do not persist response headers, bodies, stderr, or credential material.
  return {status, result: classify(status)};
}

export function audit(run = spawnSync) {
  return Object.fromEntries(repositories.map(repo => [repo,
    Object.fromEntries(Object.entries(endpoints).map(([name, suffix]) => [name, probe(repo, suffix, run)]))]));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = audit();
  console.log(JSON.stringify({mode: 'read-only', writeCapabilities: 'NOT_TESTED', results}, null, 2));
  if (Object.values(results).some(r => r.metadata.result !== 'READABLE')) process.exitCode = 1;
}

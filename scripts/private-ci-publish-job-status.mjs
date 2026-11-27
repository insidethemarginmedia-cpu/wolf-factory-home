// Publish only the trusted GitHub Actions job conclusion for the immutable
// private target SHA. This script runs in a separate job after private source
// execution; it consumes no artifact, test log, source tree, or receipt from that
// runner and never receives a source-read credential.
import {publishPrivateStatusChecks} from './private-ci-bridge.mjs';

const PRIVATE_REPOSITORY = 'donraposo1-source/project-wolf';
const SHA_RE = /^[a-f0-9]{40}$/;
const PR_RE = /^[1-9][0-9]{0,8}$/;
const RESULTS = new Map([
  ['success', 'success'],
  ['failure', 'failure'],
  ['cancelled', 'cancelled'],
]);

export function buildJobStatus({repository, sha, pullRequest, executionResult} = {}) {
  if (repository !== PRIVATE_REPOSITORY) throw new Error('JOB_STATUS_REPOSITORY_DENIED');
  if (!SHA_RE.test(String(sha ?? ''))) throw new Error('JOB_STATUS_SHA_MALFORMED');
  const pr = String(pullRequest ?? '');
  if (!PR_RE.test(pr)) throw new Error('JOB_STATUS_PR_MALFORMED');
  if (!RESULTS.has(executionResult)) throw new Error('JOB_STATUS_RESULT_UNVERIFIED');
  const conclusion = RESULTS.get(executionResult);
  return Object.freeze({
    repository: PRIVATE_REPOSITORY,
    sha,
    name: `wolf-private-ci-${pr}`,
    conclusion,
    summary: [
      'Aggregate result from the isolated exact-SHA CI execution job.',
      '',
      `Target SHA: ${sha}`,
      `Execution job result: ${executionResult}`,
      'No private source, diff, logs, credential, or artifact is attached.',
      'This check is not private-worker or mission acceptance.',
    ].join('\n'),
  });
}

export function buildPublicJobStatusAggregate(result = {}) {
  const state = result?.state === 'PUBLISHED' ? 'PUBLISHED'
    : result?.state === 'BLOCKED' ? 'BLOCKED'
      : result?.state === 'FAILED' ? 'FAILED' : 'UNKNOWN';
  return {
    schema: 'wolf.private-ci.aggregate/v1',
    kind: 'private-check-publication',
    state,
    exactShaStatusPublished: state === 'PUBLISHED',
    privateSourcePublished: false,
    privateLogsPublished: false,
    credentialsPrinted: false,
  };
}

export async function publishJobStatus({
  token,
  repository,
  sha,
  pullRequest,
  executionResult,
  publishImpl = publishPrivateStatusChecks,
} = {}) {
  const status = buildJobStatus({repository, sha, pullRequest, executionResult});
  return publishImpl({
    statusToken: token,
    statusIdentity: 'app-installation',
    repository: status.repository,
    sha: status.sha,
    names: [status.name],
    conclusion: status.conclusion,
    summary: status.summary,
  });
}

async function main() {
  const result = await publishJobStatus({
    token: process.env.WOLF_CI_APP_PUBLISHER_TOKEN,
    repository: process.env.WOLF_CI_REPOSITORY,
    sha: process.env.WOLF_CI_SHA,
    pullRequest: process.env.WOLF_CI_PR,
    executionResult: process.env.WOLF_CI_EXECUTION_RESULT,
  });
  process.stdout.write(`${JSON.stringify(buildPublicJobStatusAggregate(result))}\n`);
  if (result.state !== 'PUBLISHED') process.exitCode = result.state === 'BLOCKED' ? 78 : 1;
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({schema: 'wolf.private-ci.aggregate/v1', kind: 'private-check-publication', state: 'FAILED', exactShaStatusPublished: false, privateSourcePublished: false, privateLogsPublished: false, credentialsPrinted: false})}\n`);
    process.exitCode = 1;
  }
}

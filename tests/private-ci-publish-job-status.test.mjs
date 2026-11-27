import assert from 'node:assert/strict';
import test from 'node:test';
import {buildJobStatus, buildPublicJobStatusAggregate, publishJobStatus} from '../scripts/private-ci-publish-job-status.mjs';

const repository = 'donraposo1-source/project-wolf';
const sha = 'a'.repeat(40);

test('aggregate status binds only the trusted job result to the requested immutable SHA', () => {
  const status = buildJobStatus({repository, sha, pullRequest: '743', executionResult: 'success'});
  assert.equal(status.repository, repository);
  assert.equal(status.sha, sha);
  assert.equal(status.name, 'wolf-private-ci-743');
  assert.equal(status.conclusion, 'success');
  assert.match(status.summary, new RegExp(sha));
  assert.match(status.summary, /No private source, diff, logs, credential, or artifact is attached/);
  assert.match(status.summary, /not private-worker or mission acceptance/);
  assert.equal(Object.isFrozen(status), true);
});

test('failed and cancelled executions cannot be relabelled as success', () => {
  assert.equal(buildJobStatus({repository, sha, pullRequest: '743', executionResult: 'failure'}).conclusion, 'failure');
  assert.equal(buildJobStatus({repository, sha, pullRequest: '743', executionResult: 'cancelled'}).conclusion, 'cancelled');
  for (const executionResult of ['skipped', 'neutral', 'success-ish', '']) {
    assert.throws(() => buildJobStatus({repository, sha, pullRequest: '743', executionResult}), /JOB_STATUS_RESULT_UNVERIFIED/);
  }
});

test('repository, SHA, and pull-request input fail closed', () => {
  assert.throws(() => buildJobStatus({repository: 'public/repo', sha, pullRequest: '743', executionResult: 'success'}), /JOB_STATUS_REPOSITORY_DENIED/);
  assert.throws(() => buildJobStatus({repository, sha: 'latest', pullRequest: '743', executionResult: 'success'}), /JOB_STATUS_SHA_MALFORMED/);
  assert.throws(() => buildJobStatus({repository, sha, pullRequest: '0', executionResult: 'success'}), /JOB_STATUS_PR_MALFORMED/);
});

test('public job-status output is a fixed aggregate and omits publisher response details', () => {
  const projection = buildPublicJobStatusAggregate({
    state: 'PUBLISHED', statusId: 123, repository: 'private/repo', sha: 'secret-sha',
    checks: [{name: 'private-check', conclusion: 'success'}], error: 'private diagnostic',
  });
  assert.deepEqual(projection, {
    schema: 'wolf.private-ci.aggregate/v1', kind: 'private-check-publication', state: 'PUBLISHED',
    exactShaStatusPublished: true, privateSourcePublished: false, privateLogsPublished: false,
    credentialsPrinted: false,
  });
});

test('publisher receives no source-read token or artifact payload', async () => {
  const calls = [];
  const result = await publishJobStatus({
    token: 'publisher-fixture-token', repository, sha, pullRequest: '743', executionResult: 'failure',
    publishImpl: async input => { calls.push(input); return {state: 'PUBLISHED'}; },
  });
  assert.deepEqual(result, {state: 'PUBLISHED'});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].statusToken, 'publisher-fixture-token');
  assert.equal(calls[0].sourceToken, undefined);
  assert.deepEqual(calls[0].names, ['wolf-private-ci-743']);
  assert.equal(calls[0].conclusion, 'failure');
  assert.match(calls[0].summary, new RegExp(sha));
  assert.equal(Object.hasOwn(calls[0], 'artifact'), false);
  assert.equal(Object.hasOwn(calls[0], 'logs'), false);
});

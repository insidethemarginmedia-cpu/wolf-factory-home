import test from 'node:test';
import assert from 'node:assert/strict';
import {audit, classify, probe, repositories, endpoints} from '../scripts/github-access-audit.mjs';

test('HTTP results do not conflate inaccessible resources with absence or authorization', () => {
  assert.equal(classify(200), 'READABLE');
  assert.equal(classify(404), 'NOT_FOUND_OR_INACCESSIBLE');
  assert.equal(classify(403), 'FORBIDDEN_OR_RATE_LIMITED');
  assert.equal(classify(401), 'UNAUTHENTICATED');
  assert.equal(classify(null), 'UNKNOWN');
});
test('only sends GET requests to fixed GitHub repository endpoints and discards response data', () => {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({command, args, options});
    return {stdout: 'HTTP/2.0 200 OK\r\nX-Secret: must-not-leak\r\n\r\nprivate body', stderr: 'secret'};
  };
  const result = audit(run);
  assert.equal(calls.length, repositories.length * Object.keys(endpoints).length);
  for (const call of calls) {
    assert.equal(call.command, 'gh');
    assert.deepEqual(call.args.slice(0, 4), ['api', '--include', '--method', 'GET']);
    assert.ok(call.args[4].startsWith('repos/'));
  }
  assert.ok(!JSON.stringify(result).includes('secret'));
});
test('transport failures and missing gh are unknown, never successes', () => {
  assert.deepEqual(probe(repositories[0], '', () => ({error: new Error('missing')})), {status: null, result: 'UNKNOWN'});
  assert.deepEqual(probe(repositories[0], '', () => ({stdout: 'HTTP/2 404 Not Found\r\n'})), {status: 404, result: 'NOT_FOUND_OR_INACCESSIBLE'});
});

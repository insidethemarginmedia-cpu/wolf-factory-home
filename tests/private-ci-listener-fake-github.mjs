// In-memory GitHub Contents API used by listener admission tests. It never sends
// network requests and stores only fixture data created in the test process.
export const LISTENER_TEST_REPOSITORY = 'insidethemarginmedia-cpu/wolf-factory-home';
export const LISTENER_TEST_TOKEN = 'ghp_listener_fixture_never_print';
export const LISTENER_TEST_BRANCH = 'wolf-mission-admissions';
export const LISTENER_TEST_LEDGER = '.wolf-ci/mission-admissions.jsonl';
export const LISTENER_TEST_ANCHOR = '.wolf-ci/mission-admissions-head.json';

const response = (status, body = null) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

export function makeListenerGitHub({
  branch = false,
  ledger = null,
  anchor = null,
  failAnchorWrites = 0,
  conflictLedgerWrites = 0,
  createBranchRace = false,
} = {}) {
  let branchExists = branch;
  let failAnchors = failAnchorWrites;
  let ledgerConflicts = conflictLedgerWrites;
  let branchRaces = createBranchRace ? 1 : 0;
  let nextBlob = 1;
  const files = new Map();
  const requests = [];
  const writes = [];
  if (ledger !== null) files.set(LISTENER_TEST_LEDGER, {text: ledger, sha: 'c'.repeat(40)});
  if (anchor !== null) files.set(LISTENER_TEST_ANCHOR, {text: anchor, sha: 'd'.repeat(40)});

  const fetchImpl = async (url, init = {}) => {
    assertSafeRequest(init);
    const parsed = new URL(url);
    const method = init.method ?? 'GET';
    const apiPath = parsed.pathname.replace(`/repos/${LISTENER_TEST_REPOSITORY}`, '');
    requests.push({method, path: apiPath});

    if (apiPath === `/git/ref/heads/${LISTENER_TEST_BRANCH}` && method === 'GET') {
      return branchExists
        ? response(200, {object: {sha: 'a'.repeat(40)}})
        : response(404, {message: 'Not Found'});
    }

    if (apiPath === '/git/refs' && method === 'POST') {
      writes.push({kind: 'create-branch'});
      branchExists = true;
      if (branchRaces > 0) {
        branchRaces -= 1;
        return response(422, {message: 'Reference already exists'});
      }
      const body = JSON.parse(init.body);
      return response(201, {ref: `refs/heads/${LISTENER_TEST_BRANCH}`, object: {sha: body.sha}});
    }

    const filePath = apiPath.startsWith('/contents/') ? apiPath.slice('/contents/'.length) : null;
    if (filePath && method === 'GET') {
      const stored = files.get(filePath);
      if (!stored) return response(404, {message: 'Not Found'});
      return response(200, {
        encoding: 'base64',
        content: Buffer.from(stored.text, 'utf8').toString('base64'),
        sha: stored.sha,
      });
    }

    if (filePath && method === 'PUT') {
      const body = JSON.parse(init.body);
      const stored = files.get(filePath);
      writes.push({kind: filePath === LISTENER_TEST_LEDGER ? 'ledger' : 'anchor', filePath});
      if (filePath === LISTENER_TEST_LEDGER && ledgerConflicts > 0) {
        ledgerConflicts -= 1;
        return response(409, {message: 'Conflict'});
      }
      if (stored && body.sha !== stored.sha) return response(409, {message: 'Conflict'});
      if (!stored && body.sha) return response(409, {message: 'Unexpected sha'});
      if (filePath === LISTENER_TEST_ANCHOR && failAnchors > 0) {
        failAnchors -= 1;
        return response(500, {message: 'Simulated anchor write failure'});
      }
      const text = Buffer.from(body.content, 'base64').toString('utf8');
      files.set(filePath, {text, sha: String(nextBlob++).padStart(40, '0')});
      return response(201, {content: {path: filePath}, commit: {sha: 'e'.repeat(40)}});
    }

    return response(404, {message: 'Unexpected route'});
  };

  return {
    fetchImpl,
    files,
    requests,
    writes,
    hasBranch: () => branchExists,
    conflictNextLedgerWrite() { ledgerConflicts += 1; },
    failNextAnchorWrite() { failAnchors += 1; },
  };
}

function assertSafeRequest(init) {
  if (init.headers?.authorization !== `Bearer ${LISTENER_TEST_TOKEN}`) {
    throw new Error('Unexpected fixture authorization header');
  }
  if (init.redirect !== 'error') throw new Error('Redirect handling must be fail-closed');
  if (!['GET', 'POST', 'PUT'].includes(init.method ?? 'GET')) throw new Error('Unexpected HTTP method');
}

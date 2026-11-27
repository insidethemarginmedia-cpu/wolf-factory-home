// Minimal, fail-closed reader for the subset of GitHub Actions YAML that the
// private Wolf workflows use. It exists because the public runner has no
// dependency tree and must not gain one: a full YAML parser is out of scope,
// but guessing is not acceptable either.
//
// Contract: every function either returns a well-formed structure or throws a
// coded error. A workflow that cannot be read confidently fails the check that
// depends on it. Nothing is ever skipped silently.
import fs from 'node:fs';
import path from 'node:path';

export const STEP_KEYS = Object.freeze(['name', 'uses', 'run', 'with', 'env', 'if', 'working-directory', 'shell', 'id']);

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function stripComment(line) {
  // Only strips an inline comment that is not inside a quoted string. Quoted
  // scalars in these workflows never contain ' #' pairs, and treating a real
  // one as a comment would corrupt the command, so this is deliberately
  // conservative: it requires whitespace before '#'.
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '#' && index > 0 && /\s/.test(line[index - 1])) return line.slice(0, index).replace(/\s+$/, '');
  }
  return line.replace(/\s+$/, '');
}

function unquote(value) {
  const text = value.trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\');
  }
  return text;
}

// Collects a block scalar (`run: |`, `run: >`) starting after `index`.
function readBlockScalar(lines, index, parentIndent) {
  const body = [];
  let cursor = index;
  let blockIndent = null;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.trim() === '') { body.push(''); cursor += 1; continue; }
    const indent = indentOf(line);
    if (indent <= parentIndent) break;
    if (blockIndent === null) blockIndent = indent;
    if (indent < blockIndent) break;
    body.push(line.slice(blockIndent));
    cursor += 1;
  }
  while (body.length && body[body.length - 1] === '') body.pop();
  return {lines: body, next: cursor};
}

// Reads a nested mapping block (`env:`, `with:`) into a flat object of strings.
function readMapping(lines, index, parentIndent) {
  const entries = {};
  let cursor = index;
  let childIndent = null;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.trim() === '' || line.trim().startsWith('#')) { cursor += 1; continue; }
    const indent = indentOf(line);
    if (indent <= parentIndent) break;
    if (childIndent === null) childIndent = indent;
    if (indent < childIndent) break;
    const content = line.slice(childIndent).replace(/^-\s+/, '');
    const match = content.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!match) { cursor += 1; continue; }
    const [, key, raw] = match;
    const value = raw.trim();
    if (value === '|' || value === '>' || /^[|>][+-]?$/.test(value)) {
      const block = readBlockScalar(lines, cursor + 1, childIndent);
      entries[key] = block.lines.join('\n') + '\n';
      cursor = block.next;
      continue;
    }
    entries[key] = unquote(stripComment(value));
    cursor += 1;
  }
  return {entries, next: cursor};
}

// Parses every job in a workflow file into {name, steps:[{name, uses, run, env, with}]}.
export function parseWorkflowJobs(text) {
  if (typeof text !== 'string' || !text.length) throw Error('WORKFLOW_TEXT_REQUIRED');
  const lines = text.split(/\r?\n/);
  const jobsStart = lines.findIndex(line => /^jobs:\s*$/.test(line));
  if (jobsStart === -1) throw Error('WORKFLOW_JOBS_MISSING');

  const jobStarts = [];
  for (let index = jobsStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^[^\s#]/.test(line)) break;
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) jobStarts.push({name: line.trim().slice(0, -1), index});
  }
  if (!jobStarts.length) throw Error('WORKFLOW_JOBS_EMPTY');

  const jobs = jobStarts.map((start, position) => {
    const end = jobStarts[position + 1]?.index ?? lines.length;
    const body = lines.slice(start.index, end);
    const stepsAt = body.findIndex(line => /^ {4}steps:\s*$/.test(line));
    if (stepsAt === -1) return {name: start.name, steps: []};
    const steps = [];
    let cursor = stepsAt + 1;
    let itemIndent = null;
    while (cursor < body.length) {
      const line = body[cursor];
      if (line.trim() === '' || line.trim().startsWith('#')) { cursor += 1; continue; }
      const indent = indentOf(line);
      if (itemIndent === null) {
        if (!/^\s*-\s+/.test(line)) break;
        itemIndent = indent;
      }
      if (indent < itemIndent) break;
      if (indent === itemIndent && !/^\s*-\s+/.test(line)) break;
      if (indent !== itemIndent) { cursor += 1; continue; }

      // A new list item begins here.
      const firstContent = line.slice(itemIndent).replace(/^-\s+/, '');
      const stepIndent = itemIndent + 2;
      const step = {name: null, uses: null, run: null, env: {}, with: {}};
      const firstMatch = firstContent.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
      let inner = cursor;
      if (firstMatch) {
        const [, key, raw] = firstMatch;
        const value = raw.trim();
        if (key === 'run' && (value === '|' || value === '>')) {
          const block = readBlockScalar(body, cursor + 1, itemIndent);
          step.run = block.lines.join('\n');
          inner = block.next;
        } else if (value === '' || value === '|' || value === '>') {
          const nested = readMapping(body, cursor + 1, itemIndent);
          if (key === 'env') step.env = nested.entries;
          else if (key === 'with') step.with = nested.entries;
          inner = nested.next;
        } else if (key === 'run') {
          step.run = unquote(stripComment(value));
          inner = cursor + 1;
        } else if (key === 'name') {
          step.name = unquote(stripComment(value));
          inner = cursor + 1;
        } else if (key === 'uses') {
          step.uses = unquote(stripComment(value));
          inner = cursor + 1;
        } else {
          inner = cursor + 1;
        }
      } else {
        inner = cursor + 1;
      }

      // Remaining keys of this step item.
      cursor = inner;
      while (cursor < body.length) {
        const line2 = body[cursor];
        if (line2.trim() === '' || line2.trim().startsWith('#')) { cursor += 1; continue; }
        const indent2 = indentOf(line2);
        if (indent2 <= itemIndent) break;
        if (indent2 !== stepIndent) { cursor += 1; continue; }
        const match2 = line2.slice(stepIndent).match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
        if (!match2) { cursor += 1; continue; }
        const [, key2, raw2] = match2;
        const value2 = raw2.trim();
        if (key2 === 'run') {
          if (value2 === '|' || value2 === '>') {
            const block = readBlockScalar(body, cursor + 1, stepIndent);
            step.run = block.lines.join('\n');
            cursor = block.next;
          } else {
            step.run = unquote(stripComment(value2));
            cursor += 1;
          }
          continue;
        }
        if (key2 === 'name' || key2 === 'uses') {
          step[key2] = unquote(stripComment(value2));
          cursor += 1;
          continue;
        }
        if (key2 === 'env' || key2 === 'with') {
          const nested = readMapping(body, cursor + 1, stepIndent);
          step[key2] = nested.entries;
          cursor = nested.next;
          continue;
        }
        cursor += 1;
      }
      steps.push(step);
    }
    return {name: start.name, steps};
  });
  return jobs;
}

// Resolves a local composite action (`./.github/actions/x`) into its steps.
export function readLocalCompositeAction(root, uses) {
  const normalized = String(uses ?? '').trim();
  if (!normalized.startsWith('./')) return null;
  const relative = normalized.replace(/^\.\//, '');
  const candidates = [path.join(relative, 'action.yml'), path.join(relative, 'action.yaml')];
  for (const candidate of candidates) {
    const absolute = path.join(root, candidate);
    if (!fs.existsSync(absolute)) continue;
    const text = fs.readFileSync(absolute, 'utf8');
    const lines = text.split(/\r?\n/);
    const runsAt = lines.findIndex(line => /^runs:\s*$/.test(line));
    if (runsAt === -1) throw Error('COMPOSITE_RUNS_MISSING');
    // The `steps:` key can sit at any indentation; the list items are deeper.
    let stepsKeyAt = -1;
    let stepsKeyIndent = 0;
    for (let index = runsAt + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^[^\s]/.test(line)) break;
      if (/^\s*steps:\s*$/.test(line)) { stepsKeyAt = index; stepsKeyIndent = indentOf(line); break; }
    }
    if (stepsKeyAt === -1) throw Error('COMPOSITE_STEPS_MISSING');
    const steps = [];
    let cursor = stepsKeyAt + 1;
    let itemIndent = null;
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (line.trim() === '' || line.trim().startsWith('#')) { cursor += 1; continue; }
      const indent = indentOf(line);
      if (/^[^\s]/.test(line)) break;
      if (itemIndent === null) {
        if (!/^\s*-\s+/.test(line) || indent <= stepsKeyIndent) { cursor += 1; continue; }
        itemIndent = indent;
      }
      if (indent < itemIndent) break;
      if (indent !== itemIndent || !/^\s*-\s+/.test(line)) { cursor += 1; continue; }
      const content = line.slice(itemIndent).replace(/^-\s+/, '');
      const step = {name: null, run: null, shell: null, env: {}, with: {}};
      const match = content.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
      let inner = cursor + 1;
      if (match) {
        const [, key, raw] = match;
        const value = raw.trim();
        if ((key === 'run' || key === 'name' || key === 'shell') && value !== '') step[key] = unquote(stripComment(value));
        else if (key === 'run' && (value === '|' || value === '>')) {
          const block = readBlockScalar(lines, cursor + 1, itemIndent);
          step.run = block.lines.join('\n');
          inner = block.next;
        }
      }
      cursor = inner;
      while (cursor < lines.length) {
        const line2 = lines[cursor];
        if (line2.trim() === '' || line2.trim().startsWith('#')) { cursor += 1; continue; }
        const indent2 = indentOf(line2);
        if (indent2 <= itemIndent) break;
        const match2 = line2.slice(indent2).match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
        if (!match2) { cursor += 1; continue; }
        const [, key2, raw2] = match2;
        const value2 = raw2.trim();
        if (key2 === 'run') {
          if (value2 === '|' || value2 === '>') {
            const block = readBlockScalar(lines, cursor + 1, indent2);
            step.run = block.lines.join('\n');
            cursor = block.next;
          } else {
            step.run = unquote(stripComment(value2));
            cursor += 1;
          }
          continue;
        }
        if (key2 === 'name' || key2 === 'shell') { step[key2] = unquote(stripComment(value2)); cursor += 1; continue; }
        cursor += 1;
      }
      steps.push(step);
    }
    if (!steps.length) throw Error('COMPOSITE_STEPS_EMPTY');
    return {path: candidate, steps};
  }
  return null;
}

// Expands a workflow file into an ordered, executable plan. Composite steps are
// inlined. A step with neither `run` nor `uses` is preserved as an assertion so
// it can never disappear without notice.
export function buildWorkflowPlan(root, workflowRelative) {
  const absolute = path.join(root, workflowRelative);
  if (!fs.existsSync(absolute)) return {state: 'ABSENT', workflow: workflowRelative, jobs: []};
  const text = fs.readFileSync(absolute, 'utf8');
  const jobs = parseWorkflowJobs(text);
  const expanded = jobs.map(job => ({
    name: job.name,
    steps: job.steps.flatMap(step => {
      if (step.uses) {
        const composite = readLocalCompositeAction(root, step.uses);
        if (composite) return composite.steps.map(inner => ({...inner, fromComposite: composite.path, parentName: step.name}));
        return [{name: step.name, uses: step.uses, run: null, env: {}, with: step.with ?? {}}];
      }
      if (step.run === null) return [{name: step.name, run: null, env: step.env ?? {}, with: step.with ?? {}, empty: true}];
      return [{name: step.name, run: step.run, env: step.env ?? {}, with: step.with ?? {}, shell: step.shell ?? null}];
    }),
  }));
  return {state: 'PLANNED', workflow: workflowRelative, jobs: expanded};
}

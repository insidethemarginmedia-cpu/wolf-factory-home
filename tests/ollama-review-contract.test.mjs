import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildPublicReviewPrompt, OLLAMA_PUBLIC_REVIEW_MARKER} from '../scripts/ollama-review-contract.mjs';

test('review prompt contains syntactically conventional multi-line Python and deterministic examples', () => {
  const prompt = buildPublicReviewPrompt();
  assert.match(prompt, /def add\(a, b\):\n    return a \+ b/);
  assert.match(prompt, /add\(2, 3\) = 5/);
  assert.match(prompt, /add\(-2, 5\) = 3/);
  assert.match(prompt, /add\(0, 0\) = 0/);
  assert.ok(!prompt.includes(String.raw`\n`), 'must contain actual line breaks, not escaped backslash-n');
  assert.ok(prompt.includes(OLLAMA_PUBLIC_REVIEW_MARKER));
  assert.match(prompt, /Otherwise reply exactly REJECT/);
  assert.ok(!prompt.includes('GROQ_API_KEY') && !prompt.includes('OPENROUTER_API_KEY'));
});

test('existing workflow uses shared fixture without changing strict rejection or scope gates', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ollama-public-synthetic-qualification.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes('userPrompt:buildPublicReviewPrompt()'));
  assert.ok(workflow.includes('scripts/ollama-review-contract.mjs'));
  assert.ok(workflow.includes("markerMatched:r.text.trim()==='WOLF_OLLAMA_REVIEW_OK'"));
  assert.ok(workflow.includes('CEZAR_OLLAMA_LINK_NOT_VERIFIED'));
  assert.ok(workflow.includes('factoryIntegrated:false'));
  assert.ok(workflow.includes('github.event.repository.private'));
  assert.ok(workflow.includes('confirm_public_synthetic_only'));
  assert.ok(!workflow.includes("userPrompt:'Review only this Python code."));
});

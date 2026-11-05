/** Public synthetic-only code-review fixture; never accepts private Factory source. */
export const OLLAMA_PUBLIC_REVIEW_MARKER = 'WOLF_OLLAMA_REVIEW_OK';
export function buildPublicReviewPrompt() {
  return [
    'Review this standalone Python function. Do not use tools or execute commands.',
    'Requirement: add(a, b) returns the arithmetic sum of two integers.',
    'Check these examples: add(2, 3) = 5; add(-2, 5) = 3; add(0, 0) = 0.',
    'Python source:',
    '```python',
    'def add(a, b):',
    '    return a + b',
    '```',
    'If the code meets the requirement and every example, reply exactly WOLF_OLLAMA_REVIEW_OK.',
    'Otherwise reply exactly REJECT. Output only one marker, without explanations.',
  ].join('\n');
}

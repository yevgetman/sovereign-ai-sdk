// tests/learning-layer/eval.runner.test.ts — unit test for the eval runner's pure tool-call counter.
import { describe, expect, test } from 'bun:test';
import { countToolCalls } from '../../src/learning-layer/eval/runner.js';

describe('countToolCalls', () => {
  test('counts one per [result <tool>] line', () => {
    const transcript = [
      '[tool Bash]',
      '[input Bash] ls',
      '[result Bash] 3 files',
      '[tool Read]',
      '[result Read] 120 lines',
    ].join('\n');
    expect(countToolCalls(transcript)).toBe(2);
  });

  test('returns 0 when no tools ran', () => {
    expect(countToolCalls('just some text\n[turn_complete stop]')).toBe(0);
  });

  test('only matches result lines at line start (ignores embedded mentions)', () => {
    const transcript = 'the agent said [result Bash] inline\n[result Read] ok';
    // The embedded "[result Bash]" is mid-line (preceded by text), so only the
    // real line-start "[result Read]" counts.
    expect(countToolCalls(transcript)).toBe(1);
  });
});

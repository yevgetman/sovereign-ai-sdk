// tests/learning-layer/recall.format.test.ts
import { describe, expect, test } from 'bun:test';
import { formatRecallSnapshot } from '../../src/learning-layer/recall/format.js';

describe('formatRecallSnapshot', () => {
  test('empty lessons -> empty string', () => {
    expect(formatRecallSnapshot([])).toBe('');
  });
  test('renders a fenced learned-context block', () => {
    const out = formatRecallSnapshot([
      { id: 'a', trigger: 'running tests', action: 'use bun test', confidence: 0.5 },
    ]);
    expect(out).toContain('NOT new user input');
    expect(out).toContain('<learned-context>');
    expect(out).toContain('running tests');
    expect(out).toContain('use bun test');
    expect(out).toContain('</learned-context>');
  });
});

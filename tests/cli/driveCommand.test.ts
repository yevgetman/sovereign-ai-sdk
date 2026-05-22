// Unit tests for the pure helpers in src/cli/driveCommand.ts. The end-
// to-end behavior of `sov drive` is covered by the semantic test suite
// (which uses sov drive as its binary surface since 2026-05-22); these
// tests pin the rendering rules in isolation.

import { describe, expect, test } from 'bun:test';
import { parseEventBlock, previewInput, renderToolOutput } from '../../src/cli/driveCommand.js';

describe('previewInput', () => {
  test('returns empty for null/undefined', () => {
    expect(previewInput(null)).toBe('');
    expect(previewInput(undefined)).toBe('');
  });

  test('stringifies objects to flat JSON', () => {
    const out = previewInput({ path: '/tmp/foo.txt', limit: 100 });
    expect(out).toContain('"path"');
    expect(out).toContain('/tmp/foo.txt');
    // Single line — no embedded newlines.
    expect(out).not.toContain('\n');
  });

  test('flattens whitespace in string inputs', () => {
    const out = previewInput('echo  hello\nworld');
    expect(out).toBe('echo hello world');
  });

  test('truncates long inputs with ellipsis', () => {
    const longInput = `bash command: ${'x'.repeat(500)}`;
    const out = previewInput(longInput);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith('...')).toBe(true);
  });
});

describe('renderToolOutput', () => {
  test('extracts summary + raw from envelope object', () => {
    const out = renderToolOutput({ status: 'success', summary: 'ok · 3 lines', content: 'body' });
    expect(out.summary).toBe('ok · 3 lines');
    expect(out.raw).toContain('"summary"');
    expect(out.raw).toContain('ok · 3 lines');
  });

  test('treats plain-string output as raw with empty summary', () => {
    const out = renderToolOutput('permission denied: rule deny matched');
    expect(out.summary).toBe('');
    expect(out.raw).toBe('permission denied: rule deny matched');
  });

  test('empty for null/undefined', () => {
    expect(renderToolOutput(null)).toEqual({ summary: '', raw: '' });
    expect(renderToolOutput(undefined)).toEqual({ summary: '', raw: '' });
  });

  test('missing summary field returns empty summary', () => {
    const out = renderToolOutput({ status: 'success', content: 'just content' });
    expect(out.summary).toBe('');
    expect(out.raw).toContain('"content"');
  });
});

describe('parseEventBlock', () => {
  test('parses a single-line data event', () => {
    const block = [
      'event: text_delta',
      'data: {"type":"text_delta","sessionId":"s1","seq":1,"block":0,"text":"hello"}',
    ].join('\n');
    const ev = parseEventBlock(block);
    expect(ev).not.toBeNull();
    if (ev !== null && ev.type === 'text_delta') {
      expect(ev.text).toBe('hello');
    }
  });

  test('returns null when no data: line is present', () => {
    const block = ['event: keepalive', ': comment only', ''].join('\n');
    expect(parseEventBlock(block)).toBeNull();
  });

  test('returns null when data is not a valid event JSON', () => {
    const block = 'data: {malformed';
    expect(parseEventBlock(block)).toBeNull();
  });
});

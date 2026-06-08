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

  // Regression — AgentTool (native AND subscription-executor) delegations.
  // The orchestrator renders an AgentTool tool_result as a STRING: an
  // observation header (`status:`/`summary:` lines) followed by a
  // `<subagent_result>…delegated text…</subagent_result>` block. The wire
  // carries that string verbatim as `output`. Before the fix, renderToolOutput
  // only mined a `summary` from a JSON *object*, so a string output yielded an
  // empty summary and drive printed `[result AgentTool] (no summary)` even
  // though the model received the full delegated answer. These pin that the
  // delegated summary is recovered from the string shape.
  describe('AgentTool string output (subagent_result block)', () => {
    const agentToolOutput = [
      'status: success',
      'summary: subscription-executor → completed (3 turns, 1 tool calls)',
      '',
      '<subagent_result name="subscription-executor" session="child-1" lane="anthropic/claude" turns="3" tool_calls="1" duration_ms="100" terminal="completed">',
      'There are 3 files.',
      '</subagent_result>',
    ].join('\n');

    test('surfaces the delegated text (subagent_result body) as the summary', () => {
      const out = renderToolOutput(agentToolOutput);
      // The delegated answer — what the model saw — is now the one-line summary,
      // NOT "(no summary)".
      expect(out.summary).toBe('There are 3 files.');
      // The full string remains available as raw (unchanged contract).
      expect(out.raw).toBe(agentToolOutput);
    });

    test('multi-line delegated text is flattened to a single summary line', () => {
      const multiline = [
        'status: success',
        'summary: explore → completed (5 turns, 4 tool calls)',
        '',
        '<subagent_result name="explore" session="c2" lane="anthropic/m" turns="5" tool_calls="4" duration_ms="9" terminal="completed">',
        'Found the auth module.',
        'It lives at src/auth.ts.',
        '</subagent_result>',
      ].join('\n');
      const out = renderToolOutput(multiline);
      expect(out.summary).toContain('Found the auth module.');
      expect(out.summary).toContain('It lives at src/auth.ts.');
      // No embedded newline — drive prints summary on one line.
      expect(out.summary).not.toContain('\n');
    });

    test('falls back to the observation-header summary when the body is empty', () => {
      // An errored/empty delegation: the subagent_result body is blank, but the
      // observation header still carries a meaningful status summary.
      const emptyBody = [
        'status: error',
        'summary: subscription-executor → error (0 turns, 0 tool calls)',
        '',
        '<subagent_result name="subscription-executor" session="c3" lane="anthropic/m" turns="0" tool_calls="0" duration_ms="5" terminal="error">',
        '',
        '</subagent_result>',
      ].join('\n');
      const out = renderToolOutput(emptyBody);
      expect(out.summary).toBe('subscription-executor → error (0 turns, 0 tool calls)');
    });

    test('recovers the observation-header summary from a plain (non-subagent) string', () => {
      // A tool whose result carries the observation header but no
      // subagent_result block — the header `summary:` line is surfaced.
      const headerOnly = ['status: success', 'summary: ok · 12 lines', '', 'the body'].join('\n');
      const out = renderToolOutput(headerOnly);
      expect(out.summary).toBe('ok · 12 lines');
    });

    test('a bare string with no header stays summary-less (unchanged)', () => {
      const out = renderToolOutput('permission denied: rule deny matched');
      expect(out.summary).toBe('');
      expect(out.raw).toBe('permission denied: rule deny matched');
    });
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

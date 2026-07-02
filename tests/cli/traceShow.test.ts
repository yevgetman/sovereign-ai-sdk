// Phase 10.5 — `sov trace show` renderer tests. Pure formatTrace() output;
// the IO wrapper (showTrace) is exercised by the integration test that
// rounds an actual TraceWriter file through it.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TraceEvent } from '@yevgetman/sov-sdk/trace/types';
import { TraceWriter } from '@yevgetman/sov-sdk/trace/writer';
import { formatTrace, parseTraceFile, showTrace } from '../../src/cli/traceShow.js';

const ISO = '2026-05-04T20:00:00.000Z';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sov-trace-show-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('formatTrace', () => {
  test('renders the session header from session_start', () => {
    const out = formatTrace([
      {
        type: 'session_start',
        sessionId: 'abc-123',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        cwd: '/x',
        bundlePath: '/y',
        iso: ISO,
      },
    ]);
    expect(out).toContain('═══ session abc-123 ═══');
    expect(out).toContain('provider: anthropic | model: claude-sonnet-4-6 | bundle: /y');
    expect(out).toContain('cwd: /x');
    expect(out).toContain(`started: ${ISO}`);
  });

  test('groups events under Turn N headings', () => {
    const events: TraceEvent[] = [
      { type: 'turn_start', turn: 0, iso: ISO },
      {
        type: 'provider_request',
        provider: 'anthropic',
        model: 'm',
        purpose: 'main',
        messageCount: 1,
        systemBytes: 100,
        iso: ISO,
      },
      {
        type: 'provider_response',
        provider: 'anthropic',
        model: 'm',
        purpose: 'main',
        usage: { inputTokens: 12, outputTokens: 3 },
        latencyMs: 200,
        ttftMs: 100,
        stopReason: 'end_turn',
        iso: ISO,
      },
      { type: 'turn_start', turn: 1, iso: ISO },
      { type: 'tool_start', tool: 'Read', toolUseId: 'tu_1', iso: ISO },
      {
        type: 'tool_end',
        tool: 'Read',
        toolUseId: 'tu_1',
        durationMs: 5,
        outputBytes: 1024,
        iso: ISO,
      },
    ];
    const out = formatTrace(events);
    expect(out).toContain('Turn 0');
    expect(out).toContain('Turn 1');
    // Turn 0 should contain its events; Turn 1 likewise.
    const turn0Pos = out.indexOf('Turn 0');
    const turn1Pos = out.indexOf('Turn 1');
    expect(turn0Pos).toBeLessThan(out.indexOf('→ request'));
    expect(out.indexOf('Read#tu_1: ok')).toBeGreaterThan(turn1Pos);
  });

  test('renders provider_response usage and latency', () => {
    const out = formatTrace([
      {
        type: 'turn_start',
        turn: 0,
        iso: ISO,
      },
      {
        type: 'provider_response',
        provider: 'anthropic',
        model: 'm',
        purpose: 'main',
        usage: {
          inputTokens: 10,
          outputTokens: 50,
          cacheReadInputTokens: 4096,
          cacheCreationInputTokens: 200,
        },
        latencyMs: 250,
        ttftMs: 100,
        stopReason: 'tool_use',
        iso: ISO,
      },
    ]);
    expect(out).toContain(
      '← response: tool_use (250ms, ttft 100ms; in 10 / out 50 / cache_r 4096 / cache_w 200)',
    );
  });

  test('renders permission_check, tool_start/end, microcompact', () => {
    const out = formatTrace([
      { type: 'turn_start', turn: 0, iso: ISO },
      { type: 'permission_check', tool: 'Bash', decision: 'allow', transformed: false, iso: ISO },
      { type: 'tool_start', tool: 'Bash', toolUseId: 't1', iso: ISO },
      {
        type: 'tool_end',
        tool: 'Bash',
        toolUseId: 't1',
        durationMs: 12,
        outputBytes: 84,
        iso: ISO,
      },
      {
        type: 'microcompact',
        cleared: 4,
        estimatedTokensSaved: 1500,
        keptRecent: 6,
        iso: ISO,
      },
    ]);
    expect(out).toContain('permission Bash: allow');
    expect(out).toContain('Bash#t1: ok (12ms, 84 bytes)');
    expect(out).toContain(
      'microcompact: cleared 4 stale results (~1500 tokens saved, 6 kept recent)',
    );
  });

  test('includes deny reason and the input-transformed marker when set', () => {
    const out = formatTrace([
      { type: 'turn_start', turn: 0, iso: ISO },
      {
        type: 'permission_check',
        tool: 'Bash',
        decision: 'deny',
        reason: 'rule says no',
        transformed: false,
        iso: ISO,
      },
      {
        type: 'permission_check',
        tool: 'Edit',
        decision: 'allow',
        transformed: true,
        iso: ISO,
      },
    ]);
    expect(out).toContain('permission Bash: deny (rule says no)');
    expect(out).toContain('permission Edit: allow [input-transformed]');
  });

  test('renders tool_error', () => {
    const out = formatTrace([
      { type: 'turn_start', turn: 0, iso: ISO },
      {
        type: 'tool_error',
        tool: 'Bash',
        toolUseId: 'x1',
        durationMs: 7,
        message: 'command not found',
        iso: ISO,
      },
    ]);
    expect(out).toContain('Bash#x1: ERROR (7ms) — command not found');
  });

  test('renders the session_end footer', () => {
    const out = formatTrace([{ type: 'session_end', reason: 'completed', iso: ISO }]);
    expect(out).toContain('session_end: completed');
  });
});

describe('parseTraceFile', () => {
  test('parses a JSONL stream and skips malformed lines', () => {
    const content = [
      JSON.stringify({ type: 'turn_start', turn: 0, iso: ISO }),
      'this-is-not-json',
      '',
      JSON.stringify({ type: 'session_end', reason: 'completed', iso: ISO }),
    ].join('\n');
    const events = parseTraceFile(content);
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe('turn_start');
    expect(events[1]?.type).toBe('session_end');
  });
});

describe('showTrace (IO)', () => {
  test('reads the trace file written by TraceWriter and renders it', async () => {
    const writer = new TraceWriter({ sessionId: 'rt', harnessHome: home });
    writer.record({
      type: 'session_start',
      sessionId: 'rt',
      provider: 'anthropic',
      model: 'm',
      cwd: '/x',
      iso: ISO,
    });
    writer.record({ type: 'turn_start', turn: 0, iso: ISO });
    writer.record({ type: 'session_end', reason: 'completed', iso: ISO });
    await writer.close();

    const result = showTrace({ sessionId: 'rt', harnessHome: home });
    if (!result.ok) throw new Error(`unexpected error: ${result.error}`);
    expect(result.eventCount).toBe(3);
    expect(result.output).toContain('═══ session rt ═══');
    expect(result.output).toContain('Turn 0');
    expect(result.output).toContain('session_end: completed');
  });

  test('returns ok: false when the trace file is missing', () => {
    const result = showTrace({ sessionId: 'ghost', harnessHome: home });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain("no trace file found for session 'ghost'");
  });
});

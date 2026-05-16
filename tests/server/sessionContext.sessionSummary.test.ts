// Phase 16.1 M8 T7 — extended session_summary payload.
//
// Verifies that the `session_summary` SSE event emitted by
// disposeSessionContext carries the rich SessionMetrics fields the M9
// goodbye-card renderer will consume (tokens, tool counts). The base
// shape from M7 T6 (totalDispatched + byAgent) MUST remain — older
// consumers must still parse the event.
//
// Two contracts:
//   1. When the session has recorded token usage and persisted messages
//      with tool_use blocks, the emitted event carries:
//        - tokens.input / .output / .cacheRead / .cacheWrite /
//          .estimatedCostUsd from the sessions table
//        - toolCalls reflecting the number of tool_use blocks in the
//          stored transcript
//   2. When nothing has been recorded (a freshly created session with no
//      messages or token usage), the optional fields are either omitted
//      or zero — the event still parses against the M7 shape.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test_resetProjectIdCache } from '../../src/learning/project.js';
import { MockProvider } from '../../src/providers/mock.js';
import { ServerEventBus } from '../../src/server/eventBus.js';
import { buildRuntime } from '../../src/server/runtime.js';
import type { ServerEvent } from '../../src/server/schema.js';

describe('disposeSessionContext — extended session_summary payload (M8 T7)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m8-t7-summary-'));
    __test_resetProjectIdCache();
  });

  afterEach(() => {
    MockProvider.toolUseMode = false;
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('session with recorded tokens + tool_use messages → rich payload', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });

    try {
      const sessionId = runtime.sessionDb.createSession({
        model: runtime.model,
        provider: 'mock',
        platform: 'test',
      });

      // Record some token usage via the same wire path the turns route
      // uses (recordTokenUsage was wired by the M7 cost fix at
      // src/server/routes/turns.ts:314). The cost arg is what the wire
      // event surfaces — provider-independent, since estimateCostUsd
      // already ran upstream.
      runtime.sessionDb.recordTokenUsage(
        sessionId,
        {
          inputTokens: 120,
          outputTokens: 80,
          cacheCreationInputTokens: 10,
          cacheReadInputTokens: 50,
        },
        0.001234,
      );

      // Persist a couple of messages including tool_use blocks so the
      // metric query has something to count. The shape mirrors what
      // saveMessage already stores via the turns route's
      // handleAssistantMessage path.
      runtime.sessionDb.saveMessage(sessionId, {
        role: 'user',
        content: [{ type: 'text', text: 'list files' }],
      });
      runtime.sessionDb.saveMessage(sessionId, {
        role: 'assistant',
        content: [
          { type: 'text', text: 'sure' },
          { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
        ],
      });
      runtime.sessionDb.saveMessage(sessionId, {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'foo\nbar' }],
      });
      runtime.sessionDb.saveMessage(sessionId, {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_2', name: 'Bash', input: { command: 'pwd' } }],
      });

      // Touch SessionContext so disposeSession sees a live context to
      // walk. Without this, the dispose call short-circuits on the
      // sessionContexts.get(sessionId) miss in runtime.disposeSession.
      runtime.getSessionContext(sessionId);

      const bus = new ServerEventBus();
      const captured: ServerEvent[] = [];
      bus.subscribe((evt) => captured.push(evt));

      await runtime.disposeSession(sessionId, { bus });

      const summary = captured.find((e) => e.type === 'session_summary');
      expect(summary).toBeDefined();
      if (!summary || summary.type !== 'session_summary') {
        throw new Error('session_summary event missing');
      }
      // Base M7 fields still present.
      expect(summary.sessionId).toBe(sessionId);
      expect(summary.totalDispatched).toBe(0);
      expect(summary.byAgent).toEqual({});

      // M8 T7 extended fields.
      expect(summary.tokens).toBeDefined();
      expect(summary.tokens?.input).toBe(120);
      expect(summary.tokens?.output).toBe(80);
      expect(summary.tokens?.cacheRead).toBe(50);
      expect(summary.tokens?.cacheWrite).toBe(10);
      expect(summary.tokens?.estimatedCostUsd).toBeCloseTo(0.001234, 5);

      // Two tool_use blocks across the persisted messages.
      expect(summary.toolCalls).toBe(2);
    } finally {
      await runtime.dispose();
    }
  });

  test('session with no usage or messages still emits a valid session_summary', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });

    try {
      const sessionId = runtime.sessionDb.createSession({
        model: runtime.model,
        provider: 'mock',
        platform: 'test',
      });
      runtime.getSessionContext(sessionId);

      const bus = new ServerEventBus();
      const captured: ServerEvent[] = [];
      bus.subscribe((evt) => captured.push(evt));

      await runtime.disposeSession(sessionId, { bus });

      const summary = captured.find((e) => e.type === 'session_summary');
      expect(summary).toBeDefined();
      if (!summary || summary.type !== 'session_summary') {
        throw new Error('session_summary event missing');
      }
      // Base fields still required.
      expect(summary.totalDispatched).toBe(0);
      expect(summary.byAgent).toEqual({});
      // Tokens omitted (or zeros) when nothing was recorded. Either shape
      // is acceptable — the schema marks all M8 fields optional.
      if (summary.tokens !== undefined) {
        expect(summary.tokens.input).toBe(0);
        expect(summary.tokens.output).toBe(0);
        expect(summary.tokens.estimatedCostUsd).toBe(0);
      }
      // toolCalls either undefined or 0; both are acceptable.
      if (summary.toolCalls !== undefined) {
        expect(summary.toolCalls).toBe(0);
      }
    } finally {
      await runtime.dispose();
    }
  });
});

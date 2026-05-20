// Phase 16.1 M8 T7 — stall_detected SSE event.
//
// Verifies that when query() emits a `stall_detected` trace event (3
// consecutive tool iterations with no edits, memory writes, decisions,
// or tool errors), the server route forwards it onto the SSE bus as a
// typed `stall_detected` wire event the TUI can render.
//
// The trace event itself is emitted by src/core/query.ts:393 via the
// `recordTrace` closure threaded into query(). The turns route's
// `traceRecorder` decorates that closure so it ALSO publishes a wire
// event when the trace event fires — option (c) from the M8 T7 brief
// (least invasive; no new StreamEvent type needed).
//
// Note on the stall window: detectStall (src/review/stall.ts:17) operates
// on a 3-iteration sliding window populated INSIDE query()'s tool loop —
// specifically after each `runTools` batch (src/core/query.ts:389). The
// orchestrator's `recentTurnSummaries` is local to a single query() call,
// so a stall fires only when one query() call has ≥3 tool iterations.
// The MockProvider.stallMode (added by M8 T7) drives exactly that: each
// stream() invocation emits a Bash echo tool_use until the history
// carries `stallTargetIterations` tool_results.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test_resetProjectIdCache } from '../../src/learning/project.js';
import { MockProvider } from '../../src/providers/mock.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('turns route — stall_detected SSE event (M8 T7)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m8-t7-stall-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    __test_resetProjectIdCache();
  });

  afterEach(() => {
    MockProvider.toolUseMode = false;
    MockProvider.stallMode = false;
    MockProvider.stallTargetIterations = 4;
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('repeated tool-only iterations drive detectStall; stall_detected lands on SSE bus', async () => {
    // Stall mode: Bash echo on every iteration until the history has 4
    // tool_results. That's >3 — enough to fill detectStall's WINDOW of 3
    // with all-zero TurnSummaries and trip the "no edits, no decisions,
    // no memory writes" branch in src/review/stall.ts:28.
    MockProvider.stallMode = true;
    MockProvider.stallTargetIterations = 4;

    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
    });

    try {
      const app = buildAppWithRuntime(runtime);

      const createRes = await app.request('/sessions', { method: 'POST' });
      expect(createRes.status).toBe(201);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'drive the stall' }),
      });
      expect(turnRes.status).toBe(202);

      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      expect(eventsRes.status).toBe(200);
      const body = await eventsRes.text();

      // SSE frames are "data: <json>\n\n". Parse each `data: ` line and
      // look for stall_detected. Mirrors the parse pattern used in
      // tests/server/events.test.ts.
      const stallEvents: Array<{ type: string; reason: string; turn: number }> = [];
      for (const line of body.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const json = line.slice('data: '.length).trim();
        if (!json) continue;
        try {
          const parsed = JSON.parse(json) as {
            type?: string;
            reason?: string;
            turn?: number;
          };
          if (parsed.type === 'stall_detected') {
            stallEvents.push({
              type: parsed.type,
              reason: parsed.reason ?? '',
              turn: parsed.turn ?? -1,
            });
          }
        } catch {
          // ignore framing-only lines.
        }
      }

      expect(stallEvents.length).toBeGreaterThanOrEqual(1);
      const first = stallEvents[0];
      // ux-fixes round 2: the mock now runs `false` so each iteration
      // produces an is_error tool_result and the detector trips the
      // "repeated tool errors" branch. The prior "no edits..." reason
      // was tied to the all-empty branch which now requires zero tool
      // calls and won't fire for a model that's making (failing) calls.
      expect(first?.reason).toMatch(/repeated tool errors/);
      expect(first?.turn).toBeGreaterThanOrEqual(0);
    } finally {
      await runtime.dispose();
    }
  });
});

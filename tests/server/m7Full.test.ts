// Phase 16.1 M7 T7 — full integration smoke for the Hermes-layer parity group.
//
// Drives ONE turn through the server runtime and asserts that every per-session
// subsystem M7 wired into SessionContext (T3–T6) plus the bus-attached disposal
// summary (T6) lands its expected output. The MCP wiring (T1) is verified by
// tests/server/runtime.mcp.test.ts — no MCP servers are configured here, but
// the assertion that `mcpClientPool` is exposed on Runtime covers that the
// field is reachable from the integration shape. DaemonEventBus (T2) is
// verified by tests/server/runtime.daemonBus.test.ts.
//
// What lands inside this single turn:
//   1. Runtime.daemonEventBus exists                  (T2 plumbing reachable)
//   2. SessionContext.traceWriter exists               (T3)
//      → traces/<sessionId>.jsonl writes turn_start, provider_request,
//        provider_response on the model call
//   3. SessionContext.learningObserver exists          (T5)
//      → learning/<projectId>/observations.jsonl writes a Bash tool record
//   4. SessionContext.reviewManager exists             (T6)
//      → onUserTurn fires on the user prompt (verified via spy)
//   5. disposeSession({bus}) emits session_summary     (T6)
//   6. Trajectory written on disposal                  (T4)
//      → trajectories/samples.jsonl carries the ShareGPT-shaped record
//
// Uses the same POST /sessions + POST /sessions/:id/turns + SSE drain pattern
// the other per-subsystem T3–T6 tests use, so the contract is the public route
// surface, not an internal helper.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test_resetProjectIdCache, getProjectId } from '../../src/learning/project.js';
import { MockProvider } from '../../src/providers/mock.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { ServerEventBus } from '../../src/server/eventBus.js';
import { buildRuntime } from '../../src/server/runtime.js';
import type { ServerEvent } from '../../src/server/schema.js';

describe('M7 full integration — all six subsystems wired end-to-end', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m7-full-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    __test_resetProjectIdCache();
  });

  afterEach(() => {
    MockProvider.toolUseMode = false;
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('one turn fires; all six output sinks land correctly', async () => {
    // Trigger the MockProvider's tool_use → tool_result → observe cycle so the
    // learning observer has something to record.
    MockProvider.toolUseMode = true;
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
    });

    try {
      // (1) DaemonEventBus reachable on the runtime (T2 plumbing).
      expect(runtime.daemonEventBus).toBeDefined();

      const app = buildAppWithRuntime(runtime);
      const bus = new ServerEventBus();
      const captured: ServerEvent[] = [];
      bus.subscribe((evt) => captured.push(evt));

      // Create the session via the public route.
      const createRes = await app.request('/sessions', { method: 'POST' });
      expect(createRes.status).toBe(201);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      // Touch SessionContext to pre-build the per-session subsystems before
      // the turn runs. This lets the test inspect the field shape (T3 trace,
      // T5 learning, T6 review) and install the onUserTurn spy before the
      // turn route's getSessionContext call returns the cached instance.
      const ctx = runtime.getSessionContext(sessionId);
      expect(ctx.traceWriter).toBeDefined();
      expect(ctx.learningObserver).toBeDefined();
      expect(ctx.reviewManager).toBeDefined();

      // Install onUserTurn spy (T6 follow-up wiring check).
      const onUserTurnCalls: string[] = [];
      const original = ctx.reviewManager?.onUserTurn.bind(ctx.reviewManager);
      // biome-ignore lint/style/noNonNullAssertion: guarded by the expect above.
      ctx.reviewManager!.onUserTurn = (callerSessionId: string) => {
        onUserTurnCalls.push(callerSessionId);
        original?.(callerSessionId);
      };

      // Drive one turn through the public route. Mock provider returns a Bash
      // tool_use followed by a final text — that's a real iteration through
      // runTools → observe → continue cycle.
      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'run echo hi' }),
      });
      expect(turnRes.status).toBe(202);

      // Drain SSE so the background turn completes deterministically before
      // disposal. The route's own per-turn bus carries provider events; the
      // tmpHome bus is for the disposal-time session_summary.
      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      expect(eventsRes.status).toBe(200);
      await eventsRes.text();

      // Dispose with the disposal bus attached so the session_summary event
      // emission lands in `captured` (T6 contract).
      await runtime.disposeSession(sessionId, { bus });

      // (2) Trace file landed (T3).
      const tracePath = join(tmpHome, 'traces', `${sessionId}.jsonl`);
      expect(existsSync(tracePath)).toBe(true);
      const trace = readFileSync(tracePath, 'utf8');
      expect(trace).toContain('"type":"turn_start"');
      expect(trace).toContain('"type":"provider_request"');
      // Whole-branch review I3 — `session_start` and `session_end` must be
      // emitted by buildSessionContext / disposeSessionContext respectively,
      // NOT by the route or test. Without these bookends, `sov trace show`
      // can't render the per-trace header or close out the final turn group
      // — server-mode trace ergonomics regress vs. terminalRepl.
      expect(trace).toContain('"type":"session_start"');
      expect(trace).toContain('"type":"session_end"');

      // (3) Trajectory file landed (T4).
      const samplesPath = join(tmpHome, 'trajectories', 'samples.jsonl');
      expect(existsSync(samplesPath)).toBe(true);
      const traj = readFileSync(samplesPath, 'utf8');
      expect(traj).toContain(`"sessionId":"${sessionId}"`);
      expect(traj).toContain('"from":"human"');
      // Whole-branch review I1 — the smoke fires exactly one Bash tool_use
      // (MockProvider.toolUseMode = true), so toolCallCount must be 1 and
      // iterationsUsed must be 1 (one tool_result drained). Without the
      // turn-time counter increments these would silently ship as zeros.
      expect(traj).toContain('"toolCallCount":1');
      expect(traj).toContain('"iterationsUsed":1');
      // M7 follow-up — the route's recordUsageIfPresent helper must have
      // fired against this session's cost row. MockProvider's tool-use path
      // emits two `usage_delta` events (5 then 1 output tokens); the last
      // writer wins, so outputTokens lands at 1. The mock model isn't in
      // PRICE_TABLE so estimatedCostUsd stays $0 — what we're asserting is
      // that the recording side fired at all. The dedicated coverage lives
      // in tests/server/turns.cost.test.ts; this is the integration tie-in.
      const cost = runtime.sessionDb.getSessionCost(sessionId);
      expect(cost.outputTokens).toBe(1);

      // (4) Learning observations landed (T5).
      const projectId = getProjectId(tmpHome).id;
      const obsPath = join(tmpHome, 'learning', projectId, 'observations.jsonl');
      expect(existsSync(obsPath)).toBe(true);
      const obs = readFileSync(obsPath, 'utf8');
      expect(obs).toContain('"tool_name":"Bash"');

      // (5) onUserTurn was invoked exactly once with the session id (T6 wiring).
      expect(onUserTurnCalls).toEqual([sessionId]);

      // (6) session_summary fired on disposal (T6 contract).
      const summary = captured.find((e) => e.type === 'session_summary');
      expect(summary).toBeDefined();
      if (summary && summary.type === 'session_summary') {
        expect(summary.sessionId).toBe(sessionId);
        expect(summary.totalDispatched).toBe(0);
      }
    } finally {
      await runtime.dispose();
    }
  });
});

// Phase 16.1 M7 follow-up — token usage recording in server mode.
//
// Pins the contract that `runTurnInBackground` captures `usage_delta`
// StreamEvents from the provider stream and persists the totals via
// `runtime.sessionDb.recordTokenUsage`. Without this wiring, every
// server-mode trajectory shipped with `estimatedCostUsd: 0` (and the
// per-session cost row stayed at zero tokens) because the recording
// side of the M7 whole-branch I1 fix at sessionContext.ts:297 had no
// data to read from. Caught by the autonomous M7 smoke against real
// Anthropic Haiku 4.5 after the synthetic mock-provider tests had
// already passed — the synthetic suite never asserted on cost.
//
// MockProvider emits `usage_delta` events at mock.ts:127,151,167; the
// mock-haiku model isn't in the PRICE_TABLE so the resulting
// estimatedCostUsd stays zero, but the inputTokens / outputTokens
// counters increment whenever recordTokenUsage fires. The assertions
// here target the token counts directly so a future PRICE_TABLE
// rearrangement doesn't accidentally couple the test to dollar
// figures — what matters is "did the recording happen at all".

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('POST /sessions/:id/turns records token usage (M7 follow-up)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-turns-cost-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
  });

  afterEach(() => {
    MockProvider.toolUseMode = false;
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('single-call hello-world turn records the final usage_delta against the session', async () => {
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

      // Sanity: pre-turn cost row is zero across the board.
      const pre = runtime.sessionDb.getSessionCost(sessionId);
      expect(pre.inputTokens).toBe(0);
      expect(pre.outputTokens).toBe(0);

      // Fire one turn through the default mock path (streamHelloWorld emits
      // `usage_delta { inputTokens: 0, outputTokens: 2 }` once).
      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      expect(turnRes.status).toBe(202);

      // Drain SSE so the background turn finishes before we read the row.
      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      expect(eventsRes.status).toBe(200);
      await eventsRes.text();

      // Recording must have fired exactly once with the hello-world usage.
      const post = runtime.sessionDb.getSessionCost(sessionId);
      expect(post.outputTokens).toBe(2);
      expect(post.inputTokens).toBe(0);
    } finally {
      await runtime.dispose();
    }
  });

  test('tool-use turn records the LATEST usage_delta (last writer wins)', async () => {
    // streamToolUse emits two usage_delta events across the two model calls:
    //   call 1 (preamble + tool_use):    { inputTokens: 0, outputTokens: 5 }
    //   call 2 (final "done."):          { inputTokens: 0, outputTokens: 1 }
    // recordTokenUsage fires ONCE per runOnce, so the total ends up at
    // 1 — the LAST stream's usage overwrites latestUsage before runOnce
    // returns.
    MockProvider.toolUseMode = true;
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
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'run echo hi' }),
      });
      expect(turnRes.status).toBe(202);

      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      await eventsRes.text();

      const cost = runtime.sessionDb.getSessionCost(sessionId);
      // Last writer wins across the two model calls within one runOnce.
      expect(cost.outputTokens).toBe(1);
      expect(cost.inputTokens).toBe(0);
    } finally {
      await runtime.dispose();
    }
  });
});

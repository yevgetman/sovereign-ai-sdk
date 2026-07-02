// Phase 2 T4 — End-to-end integration test: SSE bus carries the four
// delegator_* events when the runtime drives a delegator-mediated turn.
//
// Mirrors the Phase 1 T13/T14 trivial-turn harness (parent → delegator →
// cost-lane atom → delegator continuation → parent continuation) and adds
// SSE event-flow assertions on top. Validates that the synthesis closure
// constructed in `runTurnInBackground` correctly wires the scheduler's
// delegation lifecycle into the per-session bus.
//
// Plan: docs/plans/2026-05-23-phase-2-task-routing.md (T4)
// Spec: docs/specs/2026-05-23-multi-provider-task-routing-design.md

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

/** Parse an SSE response body into an array of event objects. The events
 *  route writes `event: <type>\ndata: <json>\n\n` blocks; we walk the body
 *  and accumulate parsed-JSON objects per block. */
function parseSseEvents(body: string): Array<{ event: string; data: unknown }> {
  const blocks = body.split('\n\n').filter((b) => b.trim() !== '');
  const events: Array<{ event: string; data: unknown }> = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    let eventType: string | null = null;
    let dataLine: string | null = null;
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice('event: '.length);
      } else if (line.startsWith('data: ')) {
        dataLine = line.slice('data: '.length);
      }
    }
    if (eventType !== null && dataLine !== null) {
      try {
        events.push({ event: eventType, data: JSON.parse(dataLine) });
      } catch {
        // Skip lines that aren't valid JSON — comments, heartbeats, etc.
      }
    }
  }
  return events;
}

describe('delegator SSE synthesis — end-to-end', () => {
  let home: string;
  let prevHarnessHome: string | undefined;
  let prevMockFlag: string | undefined;

  beforeEach(() => {
    prevHarnessHome = process.env.HARNESS_HOME;
    prevMockFlag = process.env.SOV_TEST_MOCK_PROVIDER;
    home = mkdtempSync(join(tmpdir(), 'deleg-sse-'));
    process.env.HARNESS_HOME = home;
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ taskRouting: { enabled: true } }),
      'utf8',
    );
    MockProvider.streamCalls = 0;
  });

  afterEach(() => {
    MockProvider.toolUseScript = undefined;
    MockProvider.resetScriptCursor();
    if (prevHarnessHome === undefined) {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.HARNESS_HOME;
    } else {
      process.env.HARNESS_HOME = prevHarnessHome;
    }
    if (prevMockFlag === undefined) {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.SOV_TEST_MOCK_PROVIDER;
    } else {
      process.env.SOV_TEST_MOCK_PROVIDER = prevMockFlag;
    }
    rmSync(home, { recursive: true, force: true });
  });

  test('single-atom turn produces plan + atom_started + atom_complete + complete', async () => {
    // Five-entry script mirrors the T13 trivial-turn shape: parent →
    // delegator → cheap-task → delegator continuation → parent continuation.
    MockProvider.toolUseScript = [
      {
        kind: 'tool_use',
        name: 'AgentTool',
        input: { subagent_type: 'delegator', prompt: 'test prompt' },
        id: 'parent-call-1',
      },
      {
        kind: 'tool_use',
        name: 'AgentTool',
        input: { subagent_type: 'cheap-task', prompt: 'do the cheap thing' },
        id: 'deleg-call-1',
      },
      { kind: 'text', text: 'atom finished' },
      { kind: 'text', text: 'atom finished' },
      { kind: 'text', text: 'atom finished' },
    ];
    MockProvider.resetScriptCursor();

    const runtime = await buildRuntime({
      harnessHome: home,
      cwd: process.cwd(),
      provider: 'mock',
      model: 'mock-haiku',
      cronEnabled: false,
      preflight: false,
      permissionMode: 'bypass',
    });
    runtime.laneRegistry.lookup = (_role) => ({
      provider: 'mock',
      model: 'mock-haiku',
      allowedTools: null,
      maxTokens: null,
      timeoutMs: 60_000,
    });
    const loadedDelegator = runtime.agents.byName.get('delegator');
    if (loadedDelegator !== undefined) {
      runtime.agents.byName.set('delegator', { ...loadedDelegator, readOnly: true });
    }

    try {
      const app = buildAppWithRuntime(runtime);

      const createRes = await app.request('/sessions', { method: 'POST' });
      expect(createRes.status).toBe(201);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'test prompt' }),
      });
      expect(turnRes.status).toBe(202);

      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      expect(eventsRes.status).toBe(200);
      const body = await eventsRes.text();
      const events = parseSseEvents(body);

      // Filter to the delegator_* events. The full stream also carries
      // tool_use_*, tool_result, text_delta, etc. — those are validated
      // separately by tests/agents/delegator.integration.test.ts.
      const delegatorPlan = events.filter((e) => e.event === 'delegator_plan');
      const atomStarted = events.filter((e) => e.event === 'delegator_atom_started');
      const atomComplete = events.filter((e) => e.event === 'delegator_atom_complete');
      const delegatorComplete = events.filter((e) => e.event === 'delegator_complete');

      expect(delegatorPlan).toHaveLength(1);
      expect(atomStarted).toHaveLength(1);
      expect(atomComplete).toHaveLength(1);
      expect(delegatorComplete).toHaveLength(1);

      // Plan event carries the root session id (the one the SSE client
      // subscribed against).
      const planData = delegatorPlan[0]?.data as { sessionId: string };
      expect(planData.sessionId).toBe(sessionId);

      // Atom started: index 0, lane name resolved.
      const startData = atomStarted[0]?.data as {
        atomIndex: number;
        laneName: string;
        promptPreview: string;
      };
      expect(startData.atomIndex).toBe(0);
      expect(startData.laneName).toBe('cheap-task');
      expect(startData.promptPreview).toContain('cheap');

      // Atom complete: same index, success=true (mock returns 'completed').
      const completeData = atomComplete[0]?.data as {
        atomIndex: number;
        laneName: string;
        success: boolean;
      };
      expect(completeData.atomIndex).toBe(0);
      expect(completeData.laneName).toBe('cheap-task');
      expect(completeData.success).toBe(true);

      // Delegator complete: totalAtomCount=1, distribution has cheap-task=1.
      const finalData = delegatorComplete[0]?.data as {
        totalAtomCount: number;
        laneDistribution: Record<string, number>;
      };
      expect(finalData.totalAtomCount).toBe(1);
      expect(finalData.laneDistribution['cheap-task']).toBe(1);

      // Ordering check — the four events arrive in the canonical sequence
      // and seq values are monotonic across them. Walk the full event
      // list looking for the four delegator_* slots in order.
      const orderedDelegatorEvents = events.filter((e) => e.event.startsWith('delegator_'));
      expect(orderedDelegatorEvents.length).toBe(4);
      expect(orderedDelegatorEvents[0]?.event).toBe('delegator_plan');
      expect(orderedDelegatorEvents[1]?.event).toBe('delegator_atom_started');
      expect(orderedDelegatorEvents[2]?.event).toBe('delegator_atom_complete');
      expect(orderedDelegatorEvents[3]?.event).toBe('delegator_complete');

      // seq is strictly increasing across the four events (the bus mints
      // one seq per publish across the whole turn; the delegator events
      // share the global counter with other events but never repeat).
      const seqs = orderedDelegatorEvents.map((e) => (e.data as { seq: number }).seq);
      for (let i = 1; i < seqs.length; i += 1) {
        const prev = seqs[i - 1] ?? 0;
        const cur = seqs[i] ?? 0;
        expect(cur).toBeGreaterThan(prev);
      }
    } finally {
      await runtime.dispose();
    }
  });

  test('non-delegator domain agent dispatch emits NO delegator_* events', async () => {
    // Dispatch the `explore` agent directly from the parent. No delegator
    // is involved, so no delegator_* events should land on the bus.
    MockProvider.toolUseScript = [
      {
        kind: 'tool_use',
        name: 'AgentTool',
        input: { subagent_type: 'explore', prompt: 'look around' },
        id: 'parent-call-1',
      },
      { kind: 'text', text: 'explore done' },
      { kind: 'text', text: 'explore done' },
    ];
    MockProvider.resetScriptCursor();

    const runtime = await buildRuntime({
      harnessHome: home,
      cwd: process.cwd(),
      provider: 'mock',
      model: 'mock-haiku',
      cronEnabled: false,
      preflight: false,
      permissionMode: 'bypass',
    });
    // Pin only the router roles so `explore` falls through to the
    // capability table (lookup returns undefined for it).
    const routerRoles = new Set(['delegator', 'cheap-task', 'moderate-task', 'frontier-task']);
    runtime.laneRegistry.lookup = (role) =>
      routerRoles.has(role)
        ? {
            provider: 'mock',
            model: 'mock-haiku',
            allowedTools: null,
            maxTokens: null,
            timeoutMs: 60_000,
          }
        : undefined;

    try {
      const app = buildAppWithRuntime(runtime);
      const createRes = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'look around' }),
      });
      expect(turnRes.status).toBe(202);

      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      expect(eventsRes.status).toBe(200);
      const body = await eventsRes.text();
      const events = parseSseEvents(body);

      const delegatorEvents = events.filter((e) => e.event.startsWith('delegator_'));
      expect(delegatorEvents).toHaveLength(0);
    } finally {
      await runtime.dispose();
    }
  });
});

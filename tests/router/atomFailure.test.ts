// Phase 1 T15 — Atom failure integration test.
//
// Drives a compound-turn call graph where the first atom (cheap-task)
// hits a terminal error mid-stream. The delegator does NOT abort the
// turn; it continues to dispatch the synthesis atom (frontier-task),
// whose acknowledgment text mentions the failed atom. The parent
// then relays that synthesis text as the final assistant message.
//
// The injection mechanism is a new `'throw'` script entry on
// MockProvider.toolUseScript — when the cursor lands on it, the
// scripted async generator throws before yielding any events. The
// AgentRunner inside the cheap-task session surfaces that throw to
// SubagentScheduler.delegate(), which catches it and returns a
// `terminal: { reason: 'interrupted', ... }` envelope. The
// delegator's continuation stream sees that envelope as a tool_result
// with `is_error: true` carrying `[child interrupted: ...]` and is
// scripted to react by dispatching the synthesis atom.
//
// Plan: docs/plans/2026-05-23-phase-1-task-routing.md (T15)
// Spec: docs/specs/2026-05-23-multi-provider-task-routing-design.md

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '../../src/providers/mock.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('delegator integration — atom failure', () => {
  let home: string;
  let prevHarnessHome: string | undefined;
  let prevMockFlag: string | undefined;

  beforeEach(() => {
    prevHarnessHome = process.env.HARNESS_HOME;
    prevMockFlag = process.env.SOV_TEST_MOCK_PROVIDER;
    home = mkdtempSync(join(tmpdir(), 'atom-fail-'));
    process.env.HARNESS_HOME = home;
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ taskRouting: { enabled: true } }),
      'utf8',
    );
    MockProvider.streamCalls = 0;
    // Seven-entry script walking the compound failure path:
    // parent → delegator → cheap-task (throws) → delegator continuation
    // → frontier-task (synthesis) → delegator relay → parent relay.
    MockProvider.toolUseScript = [
      // 1. Parent stream() #1: dispatch to delegator.
      {
        kind: 'tool_use',
        name: 'AgentTool',
        input: { subagent_type: 'delegator', prompt: 'audit task' },
        id: 'parent-call-1',
      },
      // 2. Delegator stream() #1: dispatch atom 1 (cheap-task) — will fail.
      {
        kind: 'tool_use',
        name: 'AgentTool',
        input: { subagent_type: 'cheap-task', prompt: 'scan source files' },
        id: 'deleg-call-1',
      },
      // 3. cheap-task stream() #1: THROW. The AgentRunner's for-await
      //    surfaces this; SubagentScheduler.delegate() catches it and
      //    returns terminal=interrupted. The delegator sees the wrapped
      //    tool_result with is_error: true.
      { kind: 'throw', message: 'simulated atom failure' },
      // 4. Delegator stream() #2: react to the failure by dispatching
      //    the synthesis atom (frontier-task). The scripted prompt
      //    annotates the failed atom — mirroring what a real delegator
      //    would do per the smart-router prompt rules.
      {
        kind: 'tool_use',
        name: 'AgentTool',
        input: {
          subagent_type: 'frontier-task',
          prompt: 'synthesize. Atom 1 (failed: simulated atom failure).',
        },
        id: 'deleg-call-2',
      },
      // 5. frontier-task stream() #1: terminal synthesis text that
      //    explicitly acknowledges the failed atom.
      {
        kind: 'text',
        text: 'The source scan failed; reporting partial results only.',
      },
      // 6. Delegator stream() #3: relay synthesis terminal text.
      {
        kind: 'text',
        text: 'The source scan failed; reporting partial results only.',
      },
      // 7. Parent stream() #2: relay delegator's terminal text as the
      //    final assistant fragment.
      {
        kind: 'text',
        text: 'The source scan failed; reporting partial results only.',
      },
    ];
    MockProvider.resetScriptCursor();
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

  test('atom failure: delegator continues to synthesis with failed-atom annotation', async () => {
    const runtime = await buildRuntime({
      harnessHome: home,
      cwd: process.cwd(),
      provider: 'mock',
      model: 'mock-haiku',
      cronEnabled: false,
      preflight: false,
      // Bypass permissions so the multi-hop AgentTool chain doesn't
      // park on a permission_request SSE event waiting for a
      // /approvals POST.
      permissionMode: 'bypass',
    });
    // Route every lane (cheap-task, moderate-task, frontier-task, and
    // delegator) to the mock provider so all stream() calls in the
    // call graph land on the shared scripted cursor.
    runtime.laneRegistry.lookup = (_role) => ({
      provider: 'mock',
      model: 'mock-haiku',
      allowedTools: null,
      maxTokens: null,
      timeoutMs: 60_000,
    });
    // Defensive: re-stamp delegator.readOnly to avoid the Semaphore
    // writeLock deadlock (matches T13/T14).
    const loaded = runtime.agents.byName.get('delegator');
    if (loaded !== undefined) {
      runtime.agents.byName.set('delegator', { ...loaded, readOnly: true });
    }
    try {
      const app = buildAppWithRuntime(runtime);

      // Mint a session.
      const createRes = await app.request('/sessions', { method: 'POST' });
      expect(createRes.status).toBe(201);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      // Drive the user's turn.
      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'audit task' }),
      });
      expect(turnRes.status).toBe(202);

      // Drain SSE — the wire closes on turn_complete.
      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      expect(eventsRes.status).toBe(200);
      const body = await eventsRes.text();

      // (a) Parent dispatched to delegator.
      expect(body).toContain('event: tool_use_start');
      expect(body).toContain('"tool":"AgentTool"');
      expect(body).toContain('"subagent_type":"delegator"');

      // (b) Delegator's tool_result envelope landed on the parent bus.
      // It must carry a `completed` terminal — the delegator itself
      // wrapped up cleanly (it continued past the failed atom to
      // produce the synthesis).
      expect(body).toContain('event: tool_result');
      expect(body).toContain('<subagent_result name=\\"delegator\\"');
      expect(body).toContain('lane=\\"mock/mock-haiku\\"');
      expect(body).toContain('terminal=\\"completed\\"');

      // (c) Final assistant text reached the parent bus — proves the
      // relay chain closed cleanly even though one atom failed mid-graph.
      expect(body).toContain('"text":"The source scan failed; reporting partial results only."');

      // (d) Exactly ONE turn_complete on the parent wire.
      const turnCompleteMatches = body.match(/event: turn_complete/g) ?? [];
      expect(turnCompleteMatches.length).toBe(1);

      // (e) Seven script entries → seven provider.stream() invocations.
      // parent(2) + delegator(3) + cheap-task(1 — the throw) +
      // frontier-task(1) = 7. The throw counts as a stream call
      // because streamCalls increments at the top of stream() before
      // any branching.
      expect(MockProvider.streamCalls).toBe(7);

      // (f) The session tree records the full call graph: parent +
      // delegator child + two atom grandchildren (cheap-task that
      // failed + frontier-task that succeeded). Use a generous listing
      // bound (50) so the count is not truncated.
      const allSessions = runtime.sessionDb.listSessions(50);
      const matchedRows = allSessions.filter(
        (s) => s.sessionId === sessionId || s.parentSessionId !== null,
      );
      // Parent + delegator + cheap-task + frontier-task = 4.
      expect(matchedRows.length).toBe(4);
      const delegatorRow = allSessions.find((s) => s.parentSessionId === sessionId);
      expect(delegatorRow).toBeDefined();
      const delegatorSessionId = delegatorRow?.sessionId;
      const atomRows = allSessions.filter((s) => s.parentSessionId === delegatorSessionId);
      // Two atoms — cheap-task (failed) + frontier-task (succeeded) —
      // both pointing at the delegator session as parent.
      expect(atomRows.length).toBe(2);

      // (g) The failed atom's tool_result envelope must have surfaced
      // on the delegator's child bus as `terminal=interrupted` with the
      // error message in the summary. The parent's SSE stream only
      // sees the delegator's terminal envelope, not the atom's — that
      // assertion lives in the scheduler/AgentTool unit tests. Here we
      // verify the wire-visible signal: the delegator continued past
      // the failed atom (would not have done so on abort).
    } finally {
      await runtime.dispose();
    }
  });
});

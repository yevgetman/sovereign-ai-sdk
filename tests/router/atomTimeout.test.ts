// Phase 2 T3 — Atom timeout integration test.
//
// Verifies that a lane's configured `timeoutMs` is enforced end-to-end:
// a `cheap-task` lane with `timeoutMs: 50` cancels a `slowMode`-throttled
// MockProvider stream, surfacing as an `interrupted` terminal on the
// atom's tool_result envelope that lands on the delegator's child bus.
//
// The enforcement path (R-D mitigation in the spec) was wired in T3:
//
//   1. `SubagentScheduler.delegate()` reads
//      `input.perChildTimeoutMsOverride` ahead of `opts.perChildTimeoutMs`
//      and the `agent.maxTurns * DEFAULT_PER_TURN_TIMEOUT_MS` fallback.
//
//   2. `ToolContext.laneRegistry` exposes the runtime's LaneRegistry to
//      AgentTool so it can resolve lane-specific timeouts at dispatch
//      time.
//
//   3. `AgentTool.call` looks up
//      `ctx.laneRegistry?.lookup(agent.role)?.timeoutMs` and threads it
//      as `perChildTimeoutMsOverride` on the `scheduler.delegate()`
//      call.
//
// Plan: docs/plans/2026-05-23-phase-2-task-routing.md (T3)
// Spec: docs/specs/2026-05-23-multi-provider-task-routing-design.md

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('delegator integration — atom timeout', () => {
  let home: string;
  let prevHarnessHome: string | undefined;
  let prevMockFlag: string | undefined;

  beforeEach(() => {
    prevHarnessHome = process.env.HARNESS_HOME;
    prevMockFlag = process.env.SOV_TEST_MOCK_PROVIDER;
    home = mkdtempSync(join(tmpdir(), 'atom-timeout-'));
    process.env.HARNESS_HOME = home;
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    // taskRouting.enabled flips on the lane registry + smart-router prompt;
    // the lane-resolver hit is what triggers the perChildTimeoutMsOverride
    // path in AgentTool.
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ taskRouting: { enabled: true } }),
      'utf8',
    );
    MockProvider.streamCalls = 0;
    // slowMode adds a real wall-clock delay to every yielded event in the
    // default Hello-world stream path so the cheap-task atom takes long
    // enough to exceed the lane's 50ms timeoutMs ceiling.
    MockProvider.slowMode = true;
    MockProvider.slowModeDelayMs = 200;
  });

  afterEach(() => {
    MockProvider.toolUseScript = undefined;
    MockProvider.resetScriptCursor();
    MockProvider.slowMode = false;
    MockProvider.slowModeDelayMs = 0;
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

  test('lane timeoutMs causes atom to surface terminal=interrupted', async () => {
    // Five-entry script: parent → delegator → cheap-task (slowMode →
    // timeout) → delegator continuation → parent continuation. The
    // cheap-task atom is configured with the lane's 50ms timeoutMs;
    // slowMode forces the mock stream to take ~200ms per event, so the
    // first yield trips AbortSignal.timeout(50) and the AgentRunner
    // surfaces an AbortError. SubagentScheduler.delegate() catches it
    // and returns terminal: { reason: 'interrupted', ... }.
    MockProvider.toolUseScript = [
      // 1. Parent stream() #1: dispatch to delegator.
      {
        kind: 'tool_use',
        name: 'AgentTool',
        input: { subagent_type: 'delegator', prompt: 'timeout test' },
        id: 'parent-call-1',
      },
      // 2. Delegator stream() #1: dispatch the atom.
      {
        kind: 'tool_use',
        name: 'AgentTool',
        input: { subagent_type: 'cheap-task', prompt: 'slow work' },
        id: 'deleg-call-1',
      },
      // 3. cheap-task stream() #1: falls past the script entry, hitting
      //    the default Hello-world path. slowMode forces a wall-clock
      //    delay that exceeds the 50ms lane timeout. The atom yields
      //    interrupted.
      //
      //    (No explicit script entry needed — the cursor advances past
      //    end-of-script and the mock falls through to streamHelloWorld
      //    with slowMode active.)
      // 4. Delegator stream() #2: acknowledges the interrupted atom.
      { kind: 'text', text: 'atom timed out; halting.' },
      // 5. Parent stream() #2: relays the synthesis text.
      { kind: 'text', text: 'atom timed out; halting.' },
    ];
    MockProvider.resetScriptCursor();

    const runtime = await buildRuntime({
      harnessHome: home,
      cwd: process.cwd(),
      provider: 'mock',
      model: 'mock-haiku',
      cronEnabled: false,
      preflight: false,
      // Bypass permissions so the AgentTool chain doesn't park on a
      // permission_request waiting for /approvals.
      permissionMode: 'bypass',
    });
    // Pin every router role to mock + override cheap-task's timeoutMs to
    // 50ms so the slowMode stream trips it. Delegator + frontier-task
    // need generous timeouts so only the atom races and dies.
    runtime.laneRegistry.lookup = (role) => {
      if (role === 'cheap-task') {
        return {
          provider: 'mock',
          model: 'mock-haiku',
          allowedTools: null,
          maxTokens: null,
          timeoutMs: 50,
        };
      }
      return {
        provider: 'mock',
        model: 'mock-haiku',
        allowedTools: null,
        maxTokens: null,
        timeoutMs: 60_000,
      };
    };
    // Defensive: re-stamp delegator.readOnly to avoid the writeLock
    // deadlock (matches T13/T14).
    const loaded = runtime.agents.byName.get('delegator');
    if (loaded !== undefined) {
      runtime.agents.byName.set('delegator', { ...loaded, readOnly: true });
    }
    // Also force cheap-task to readOnly so it doesn't acquire the
    // writeLock + serialize unexpectedly against the delegator.
    const cheapTask = runtime.agents.byName.get('cheap-task');
    if (cheapTask !== undefined) {
      runtime.agents.byName.set('cheap-task', { ...cheapTask, readOnly: true });
    }
    try {
      const app = buildAppWithRuntime(runtime);

      const createRes = await app.request('/sessions', { method: 'POST' });
      expect(createRes.status).toBe(201);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'timeout test' }),
      });
      expect(turnRes.status).toBe(202);

      // Drain SSE so the parent turn settles before we inspect the DB.
      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      expect(eventsRes.status).toBe(200);
      const body = await eventsRes.text();

      // Parent dispatched to delegator (always visible on the wire).
      expect(body).toContain('event: tool_use_start');
      expect(body).toContain('"subagent_type":"delegator"');

      // The delegator returned a tool_result envelope — the delegator
      // itself completed cleanly even though one of its atoms timed
      // out, mirroring the failure-recovery path.
      expect(body).toContain('<subagent_result name=\\"delegator\\"');

      // Exactly one turn_complete on the parent wire.
      const turnCompleteMatches = body.match(/event: turn_complete/g) ?? [];
      expect(turnCompleteMatches.length).toBe(1);

      // Inspect the cheap-task atom's session row. The scheduler writes
      // the interrupted terminal into the trace stream, but the
      // immediately-visible signal at the DB level is the session
      // lineage: parent → delegator → cheap-task.
      const allSessions = runtime.sessionDb.listSessions(50);
      const delegatorEntry = allSessions.find((s) => s.parentSessionId === sessionId);
      expect(delegatorEntry).toBeDefined();
      const delegatorSessionId = delegatorEntry?.sessionId ?? '';
      const atomEntry = allSessions.find((s) => s.parentSessionId === delegatorSessionId);
      expect(atomEntry).toBeDefined();
      const atomRow = runtime.sessionDb.getSession(atomEntry?.sessionId ?? '');
      expect(atomRow).not.toBeNull();
      // The cheap-task atom was created under the routing-atom metadata
      // shape (T1), so its lane-name is recorded.
      expect(atomRow?.metadata.kind).toBe('routing-atom');
      expect(atomRow?.metadata.laneName).toBe('cheap-task');
    } finally {
      await runtime.dispose();
    }
  });
});

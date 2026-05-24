// Phase 2 T1 — Per-atom lane metadata in SessionDb.
//
// The runtime's `createChildSession` closure (src/server/runtime.ts) writes
// the SessionDb row that anchors every sub-agent session. Phase 1 wrote a
// uniform `{ agentName, kind: 'subagent' }` blob for every child. Phase 2
// promotes router-routed children (delegator + cost-lane atoms) into
// distinct shapes that downstream telemetry (audit logger, /sessions list,
// trajectory exports) can group on:
//
//   - delegator session: `{ kind: 'routing-delegator', parentSessionId }`
//   - cost-lane atom:    `{ kind: 'routing-atom', laneName, laneProvider,
//                            laneModel, parentDelegatorSessionId }`
//   - everything else:   unchanged — `{ agentName, kind: 'subagent' }`
//
// The scheduler computes the lane-resolution outcome ALREADY for
// `resolveProviderModel` (Phase 1 T7); this task threads that result PLUS
// an `isDelegator` flag through the `createChildSession` callback so the
// runtime closure can pick the right metadata shape.
//
// Plan: docs/plans/2026-05-23-phase-2-task-routing.md (T1)
// Spec: docs/specs/2026-05-23-multi-provider-task-routing-design.md

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '../../src/providers/mock.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('routing metadata — delegator + atom attribution', () => {
  let home: string;
  let prevHarnessHome: string | undefined;
  let prevMockFlag: string | undefined;

  beforeEach(() => {
    prevHarnessHome = process.env.HARNESS_HOME;
    prevMockFlag = process.env.SOV_TEST_MOCK_PROVIDER;
    home = mkdtempSync(join(tmpdir(), 'lane-attr-'));
    process.env.HARNESS_HOME = home;
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    // taskRouting.enabled flips on the lane registry and the smart-router
    // system-prompt segment. Both are needed because the test asserts the
    // metadata shape that ONLY shows up when the lane resolver returns a
    // hit for the agent's role (delegator + cheap-task).
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

  test('cost-lane atom session row carries routing-atom metadata', async () => {
    // Five-entry script mirrors the T13 trivial-turn shape: parent →
    // delegator → cheap-task → delegator continuation → parent continuation.
    // The cursor advances one entry per stream() call across the call graph.
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
        input: { subagent_type: 'cheap-task', prompt: 'do the trivial thing' },
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
    // Pin every router role to mock so the script-driven call graph stays
    // intact AND so the lane-resolver in the scheduler returns a hit
    // (which is what triggers the routing-atom metadata branch).
    runtime.laneRegistry.lookup = (_role) => ({
      provider: 'mock',
      model: 'mock-haiku',
      allowedTools: null,
      maxTokens: null,
      timeoutMs: 60_000,
    });
    // Bundled delegator already ships readOnly: true after the T13
    // deadlock fix; re-stamp defensively so this test stays robust if the
    // bundled file is edited later.
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

      // Drain SSE so the parent turn settles before we inspect the DB. The
      // events route closes the wire on turn_complete.
      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      expect(eventsRes.status).toBe(200);
      await eventsRes.text();

      // Five script entries → five provider.stream() invocations; if this
      // mismatches we're not in the right state to assert on session rows.
      expect(MockProvider.streamCalls).toBe(5);

      // Inspect every session row's metadata. listSessions doesn't carry
      // metadata, so we walk the lineage via the lightweight list view and
      // fetch each row's full metadata via getSession.
      const allSessions = runtime.sessionDb.listSessions(50);
      // Parent + delegator + cheap-task atom = 3.
      const linkedRows = allSessions.filter(
        (s) => s.sessionId === sessionId || s.parentSessionId !== null,
      );
      expect(linkedRows.length).toBe(3);

      const parentEntry = allSessions.find((s) => s.sessionId === sessionId);
      expect(parentEntry).toBeDefined();
      expect(parentEntry?.parentSessionId).toBeNull();

      const delegatorEntry = allSessions.find((s) => s.parentSessionId === sessionId);
      expect(delegatorEntry).toBeDefined();
      const delegatorSessionId = delegatorEntry?.sessionId ?? '';
      const delegatorRow = runtime.sessionDb.getSession(delegatorSessionId);
      expect(delegatorRow).not.toBeNull();
      expect(delegatorRow?.metadata.kind).toBe('routing-delegator');
      expect(delegatorRow?.metadata.parentSessionId).toBe(sessionId);

      const atomEntry = allSessions.find((s) => s.parentSessionId === delegatorSessionId);
      expect(atomEntry).toBeDefined();
      const atomRow = runtime.sessionDb.getSession(atomEntry?.sessionId ?? '');
      expect(atomRow).not.toBeNull();
      expect(atomRow?.metadata.kind).toBe('routing-atom');
      expect(atomRow?.metadata.laneName).toBe('cheap-task');
      expect(atomRow?.metadata.laneProvider).toBe('mock');
      expect(atomRow?.metadata.laneModel).toBe('mock-haiku');
      expect(atomRow?.metadata.parentDelegatorSessionId).toBe(delegatorSessionId);
    } finally {
      await runtime.dispose();
    }
  });

  test('non-router agent keeps the legacy subagent metadata shape', async () => {
    // explore is a regular sub-agent (no `role` field — it's a domain agent,
    // not a cost lane). Dispatching to it from the parent must keep the
    // pre-Phase-2 `{ agentName, kind: 'subagent' }` shape so downstream
    // consumers that group on that shape don't see a contract change.
    MockProvider.toolUseScript = [
      {
        kind: 'tool_use',
        name: 'AgentTool',
        input: { subagent_type: 'explore', prompt: 'look around' },
        id: 'parent-call-1',
      },
      { kind: 'text', text: 'explore findings' },
      { kind: 'text', text: 'explore findings' },
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
    // Pin only the four router roles. explore has role `explore`, which
    // is NOT a router role — the lane registry returns undefined for it,
    // so resolveProviderModel falls through to the capability table and
    // the runtime's createChildSession closure writes the legacy
    // `{ agentName, kind: 'subagent' }` shape.
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
      expect(createRes.status).toBe(201);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'look around' }),
      });
      expect(turnRes.status).toBe(202);

      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      expect(eventsRes.status).toBe(200);
      await eventsRes.text();

      const allSessions = runtime.sessionDb.listSessions(50);
      const childEntry = allSessions.find((s) => s.parentSessionId === sessionId);
      expect(childEntry).toBeDefined();
      const childRow = runtime.sessionDb.getSession(childEntry?.sessionId ?? '');
      expect(childRow).not.toBeNull();
      // Legacy shape — `kind: 'subagent'`, NOT `routing-atom` or
      // `routing-delegator`.
      expect(childRow?.metadata.kind).toBe('subagent');
      expect(childRow?.metadata.agentName).toBe('explore');
    } finally {
      await runtime.dispose();
    }
  });
});

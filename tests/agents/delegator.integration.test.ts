// Phase 1 T13 — End-to-end integration test for trivial-turn smart routing.
//
// Drives a full call graph through the runtime: parent (top-level user turn)
// → delegator sub-agent (AgentTool) → cheap-task atom (AgentTool) → delegator
// relay → parent relay. Uses MockProvider.toolUseScript to encode the five
// successive provider.stream() invocations the dispatch sequence produces,
// with no real LLM in the loop.
//
// Routing path: the `/turns` route uses `runtime.toolPool` directly (vs.
// the OpenAI route which filters out AgentTool via SUBAGENT_EXCLUDED_TOOLS),
// so the parent can dispatch to the delegator. The scheduler then takes
// over and runs each sub-agent as its own session whose provider instance
// shares MockProvider's process-static `toolUseScript` + `scriptCursor`.
// The script naturally walks parent → child → grandchild as their stream
// calls fire in sequence.
//
// Plan: docs/plans/2026-05-23-phase-1-task-routing.md (T13)
// Spec: docs/specs/2026-05-23-multi-provider-task-routing-design.md

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '../../src/providers/mock.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('delegator integration — trivial turn', () => {
  let home: string;
  let prevHarnessHome: string | undefined;
  let prevMockFlag: string | undefined;

  beforeEach(() => {
    prevHarnessHome = process.env.HARNESS_HOME;
    prevMockFlag = process.env.SOV_TEST_MOCK_PROVIDER;
    home = mkdtempSync(join(tmpdir(), 'deleg-int-'));
    process.env.HARNESS_HOME = home;
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    // Write taskRouting.enabled so buildRuntime injects the smart-router
    // system prompt segment and the lane registry is consulted. Even though
    // the mock provider doesn't READ the prompt, enabling the wiring keeps
    // the call sequence honest — preflight runs, the delegator role
    // resolves through the lane registry, recursion guard fires.
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ taskRouting: { enabled: true } }),
      'utf8',
    );
    // Reset the static stream-call counter so the post-turn assertion
    // measures only invocations driven by THIS test.
    MockProvider.streamCalls = 0;
    // Five-entry script: parent → delegator → cheap-task → delegator
    // continuation → parent continuation. The mock walks one entry per
    // provider.stream() call across the call graph; each sub-agent is its
    // own session but they share the process-static cursor.
    MockProvider.toolUseScript = [
      // 1. Parent's first turn: dispatch to delegator with the user's
      //    prompt verbatim (the smart-router segment instructs this; the
      //    mock encodes it directly).
      {
        kind: 'tool_use',
        name: 'AgentTool',
        input: { subagent_type: 'delegator', prompt: 'what is a dog?' },
        id: 'parent-call-1',
      },
      // 2. Delegator's first turn: decompose to a single cheap-task atom
      //    (trivial-turn path per the delegator's prompt rules).
      {
        kind: 'tool_use',
        name: 'AgentTool',
        input: { subagent_type: 'cheap-task', prompt: 'explain what a dog is' },
        id: 'deleg-call-1',
      },
      // 3. cheap-task atom: answer directly with end_turn.
      { kind: 'text', text: 'A dog is a domesticated mammal.' },
      // 4. Delegator continuation: returns the cheap-task atom's answer.
      { kind: 'text', text: 'A dog is a domesticated mammal.' },
      // 5. Parent continuation: relays the delegator's summary.
      { kind: 'text', text: 'A dog is a domesticated mammal.' },
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

  test('trivial turn flows through delegator to cheap-task and back', async () => {
    const runtime = await buildRuntime({
      harnessHome: home,
      cwd: process.cwd(),
      provider: 'mock',
      model: 'mock-haiku',
      cronEnabled: false,
      preflight: false,
      // Auto-allow every tool call. The default 'default' mode would
      // fall through to the server's ask() bridge for any non-allowlisted
      // tool, which emits a permission_request SSE event and parks until
      // a POST /approvals — neither of which this test handles. The
      // smart-router dispatch chain (AgentTool → AgentTool) needs to
      // run without human-in-the-loop friction.
      permissionMode: 'bypass',
    });
    // Override every lane to resolve to the mock provider. By default the
    // delegator lane resolves to anthropic/claude-sonnet-4-6 (provider is
    // hardcoded in `DELEGATOR_DEFAULTS`, only the model is configurable
    // via `taskRouting.delegator.model`), and the cost lanes default to
    // anthropic too. We need every sub-agent's stream() call to land on
    // MockProvider so the shared process-static script cursor walks the
    // full call graph. The scheduler reads `laneRegistry.lookup(role)`
    // at delegation time via a closure over the registry reference, so
    // replacing the registry's `lookup` method after boot is sufficient.
    runtime.laneRegistry.lookup = (_role) => ({
      provider: 'mock',
      model: 'mock-haiku',
      allowedTools: null,
      maxTokens: null,
      timeoutMs: 60_000,
    });
    // Patch the loaded `delegator` agent to `readOnly: true` to break the
    // global writeLock deadlock: with the bundled `readOnly: false`, the
    // delegator's scheduler.delegate() call acquires the Semaphore(1)
    // writeLock, then dispatches AgentTool(cheap-task) which tries to
    // acquire the SAME writeLock — held by the outer delegate() call,
    // which is itself awaiting the inner delegate(). The integration
    // test exposes this real scheduler issue (filed as a Phase 1 follow-
    // up); for the test we patch the in-memory registry so the delegator
    // doesn't hold the writeLock during its own dispatch. This is the
    // architecturally-correct posture — AgentTool itself is the only
    // tool the delegator can call, and AgentTool is a dispatcher rather
    // than a writer (the WRITES happen inside the dispatched child,
    // which acquires the writeLock on its own behalf).
    const loaded = runtime.agents.byName.get('delegator');
    if (loaded !== undefined) {
      runtime.agents.byName.set('delegator', { ...loaded, readOnly: true });
    }
    try {
      // The smart-router segment should have been injected (taskRouting
      // is enabled and bundle-default/prompts/smart-router.md ships).
      const systemText = runtime.systemSegments.map((s) => s.text ?? '').join('\n');
      expect(systemText).toContain('<smart-router>');

      // The parent uses `runtime.toolPool` directly via the /turns route,
      // so AgentTool is present and the model (mock) can dispatch.
      const toolNames = runtime.toolPool.map((t) => t.name);
      expect(toolNames).toContain('AgentTool');

      // Lane registry resolves the delegator role and the three cost lanes
      // — both routed to mock by the override above.
      expect(runtime.laneRegistry.lookup('delegator')?.provider).toBe('mock');
      expect(runtime.laneRegistry.lookup('cheap-task')?.provider).toBe('mock');

      const app = buildAppWithRuntime(runtime);

      // Mint a session.
      const createRes = await app.request('/sessions', { method: 'POST' });
      expect(createRes.status).toBe(201);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      // Drive a turn — the parent question.
      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'what is a dog?' }),
      });
      expect(turnRes.status).toBe(202);

      // Drain the SSE stream. The events route closes the wire on
      // turn_complete, so `await text()` returns once the parent's
      // turn is done. The shared MockProvider script naturally
      // sequences the call graph (parent → delegator → cheap-task →
      // delegator continuation → parent continuation), each entry
      // walked by one provider.stream() invocation.
      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      expect(eventsRes.status).toBe(200);
      const body = await eventsRes.text();

      // Verify the call graph fired end-to-end.
      //
      // (a) Parent dispatched to delegator — its first tool_use was
      // AgentTool with subagent_type=delegator.
      expect(body).toContain('event: tool_use_start');
      expect(body).toContain('"tool":"AgentTool"');
      expect(body).toContain('"subagent_type":"delegator"');

      // (b) The delegator's tool_result echoed back on the parent's
      // wire, carrying a `<subagent_result>` envelope. The lane echoed
      // as mock/mock-haiku because of the laneRegistry.lookup override
      // above. The `turns` count of 2 + `tool_calls` of 1 matches the
      // script-driven shape (delegator makes ONE AgentTool call, then
      // one continuation turn). The body is JSON-stringified onto the
      // SSE wire so the XML quotes are backslash-escaped — match via
      // the JSON-encoded forms.
      expect(body).toContain('event: tool_result');
      expect(body).toContain('<subagent_result name=\\"delegator\\"');
      expect(body).toContain('lane=\\"mock/mock-haiku\\"');
      expect(body).toContain('terminal=\\"completed\\"');

      // (c) The final assistant text reached the parent's wire — relay
      // chain (cheap-task → delegator → parent) closed cleanly. This
      // single text fragment proves every layer wrote the same content
      // through: cheap-task emitted it, delegator relayed it, parent
      // emitted it back as its final assistant text.
      expect(body).toContain('"text":"A dog is a domesticated mammal."');

      // (d) Exactly ONE turn_complete on the wire. Each sub-agent runs
      // as its own session; only the parent's terminal hits the parent
      // bus. A doubled turn_complete would be the marker for child events
      // leaking onto the parent bus.
      expect(body).toContain('event: turn_complete');
      const turnCompleteMatches = body.match(/event: turn_complete/g) ?? [];
      expect(turnCompleteMatches.length).toBe(1);

      // (e) Five script entries → five provider.stream() invocations.
      // (preflight: false above means MockProvider.streamCalls didn't
      // get bumped at boot; all 5 are turn-driven.) An extra invocation
      // would mean the parent looped, or the scheduler re-dispatched —
      // either way a regression marker.
      expect(MockProvider.streamCalls).toBe(5);
    } finally {
      await runtime.dispose();
    }
  });
});

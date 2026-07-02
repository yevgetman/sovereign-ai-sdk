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
// Phase 2 T10 augmentation: each test now also walks the parsed SSE event
// stream and asserts the four delegator_* events synthesized by T4 land in
// the canonical sequence (plan → atom_started* → atom_complete* → complete),
// with shape assertions on the final `delegator_complete.totalAtomCount` and
// `laneDistribution`. The augmentation is additive — every original assertion
// still runs unchanged; the new assertions slot in alongside the existing
// SSE-body checks. Mirrors the canonical pattern established in
// tests/router/synthesisIntegration.test.ts (T4).
//
// Plan: docs/plans/2026-05-23-phase-1-task-routing.md (T13);
// docs/plans/2026-05-23-phase-2-task-routing.md (T10)
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
 *  and accumulate parsed-JSON objects per block. Mirrors the helper in
 *  tests/router/synthesisIntegration.test.ts (T4) — kept inline here so the
 *  Phase 1 integration tests stay self-contained. */
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
    // The bundled delegator ships with `readOnly: true` to avoid a
    // Semaphore(1) writeLock deadlock during nested delegation. We also
    // re-stamp it here so the test stays robust if the bundled file is
    // edited later without this fact being load-bearing on the test path.
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

      // (f) Phase 2 T10 — assert the four delegator_* events synthesized
      // by T4 (`src/router/progressEvents.ts`) land in the canonical
      // sequence on the SSE wire. The trivial-turn shape has one atom
      // (cheap-task), so expect:
      //   plan → atom_started(×1) → atom_complete(×1) → complete
      // with `totalAtomCount: 1` and `laneDistribution: {'cheap-task': 1}`.
      const events = parseSseEvents(body);
      const delegatorEvents = events.filter((e) => e.event.startsWith('delegator_'));
      const types = delegatorEvents.map((e) => e.event);
      expect(types).toContain('delegator_plan');
      expect(types).toContain('delegator_atom_started');
      expect(types).toContain('delegator_atom_complete');
      expect(types).toContain('delegator_complete');
      // Strict ordering — plan precedes atom_started, atom_complete precedes
      // the final delegator_complete. The synthesizer is stateful and the
      // bus is single-subscriber FIFO, so any reordering is a regression.
      expect(types.indexOf('delegator_plan')).toBeLessThan(types.indexOf('delegator_atom_started'));
      expect(types.indexOf('delegator_atom_complete')).toBeLessThan(
        types.indexOf('delegator_complete'),
      );
      // Exactly one atom for the trivial-turn shape.
      expect(types.filter((t) => t === 'delegator_atom_started').length).toBe(1);
      expect(types.filter((t) => t === 'delegator_atom_complete').length).toBe(1);
      // The terminal `delegator_complete` reports totalAtomCount=1 and the
      // lane distribution shows the cheap-task atom we dispatched.
      const finalEvent = delegatorEvents.find((e) => e.event === 'delegator_complete');
      expect(finalEvent).toBeDefined();
      const finalData = finalEvent?.data as {
        totalAtomCount: number;
        laneDistribution: Record<string, number>;
      };
      expect(finalData.totalAtomCount).toBe(1);
      expect(finalData.laneDistribution).toEqual({ 'cheap-task': 1 });
    } finally {
      await runtime.dispose();
    }
  });
});

// Phase 1 T14 — End-to-end integration test for compound-turn smart routing.
//
// Same harness shape as the T13 trivial-turn test, but the script encodes a
// longer call graph: parent dispatches to delegator → delegator dispatches
// THREE atoms in sequence (cheap-task, moderate-task, frontier-task acting as
// synthesizer) → delegator relays the synthesis → parent relays the final.
//
// Total provider.stream() calls = 9 (parent: 2, delegator: 4, cheap-task: 1,
// moderate-task: 1, frontier-task: 1). The shared process-static cursor walks
// these naturally as each agent's session fires its own stream() invocation.
//
// Plan: docs/plans/2026-05-23-phase-1-task-routing.md (T14)
// Spec: docs/specs/2026-05-23-multi-provider-task-routing-design.md
describe('delegator integration — compound turn', () => {
  let home: string;
  let prevHarnessHome: string | undefined;
  let prevMockFlag: string | undefined;

  beforeEach(() => {
    prevHarnessHome = process.env.HARNESS_HOME;
    prevMockFlag = process.env.SOV_TEST_MOCK_PROVIDER;
    home = mkdtempSync(join(tmpdir(), 'deleg-int-compound-'));
    process.env.HARNESS_HOME = home;
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    // taskRouting.enabled flips on the lane registry and the smart-router
    // system-prompt segment. Same shape as T13.
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ taskRouting: { enabled: true } }),
      'utf8',
    );
    MockProvider.streamCalls = 0;
    // Nine-entry script walking parent → delegator → cheap-task → delegator →
    // moderate-task → delegator → frontier-task → delegator → parent. The
    // cursor advances one entry per stream() call across the call graph, so
    // each scripted entry corresponds to exactly one provider invocation.
    MockProvider.toolUseScript = [
      // 1. Parent stream() #1: dispatch to delegator with the user prompt.
      {
        kind: 'tool_use',
        name: 'AgentTool',
        input: { subagent_type: 'delegator', prompt: 'do a security audit' },
        id: 'parent-call-1',
      },
      // 2. Delegator stream() #1: dispatch atom 1 (cheap-task).
      {
        kind: 'tool_use',
        name: 'AgentTool',
        input: { subagent_type: 'cheap-task', prompt: 'list source files' },
        id: 'deleg-call-1',
      },
      // 3. cheap-task stream() #1: terminal answer.
      { kind: 'text', text: 'src/auth/middleware.ts, src/openai/auth.ts' },
      // 4. Delegator stream() #2: dispatch atom 2 (moderate-task).
      {
        kind: 'tool_use',
        name: 'AgentTool',
        input: { subagent_type: 'moderate-task', prompt: 'analyze auth code' },
        id: 'deleg-call-2',
      },
      // 5. moderate-task stream() #1: terminal answer.
      { kind: 'text', text: 'Auth uses bcrypt; no critical issues.' },
      // 6. Delegator stream() #3: dispatch synthesis atom (frontier-task).
      {
        kind: 'tool_use',
        name: 'AgentTool',
        input: {
          subagent_type: 'frontier-task',
          prompt: 'synthesize. Atom 1 output: list. Atom 2 output: analysis.',
        },
        id: 'deleg-call-3',
      },
      // 7. frontier-task stream() #1: synthesis output.
      { kind: 'text', text: 'Final security audit report: auth implementation is sound.' },
      // 8. Delegator stream() #4: relay synthesis terminal text.
      { kind: 'text', text: 'Final security audit report: auth implementation is sound.' },
      // 9. Parent stream() #2: relay delegator's terminal text.
      { kind: 'text', text: 'Final security audit report: auth implementation is sound.' },
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

  test('compound turn flows through delegator with multi-atom + synthesis', async () => {
    const runtime = await buildRuntime({
      harnessHome: home,
      cwd: process.cwd(),
      provider: 'mock',
      model: 'mock-haiku',
      cronEnabled: false,
      preflight: false,
      // bypass: auto-allow every tool call so the multi-hop AgentTool chain
      // (parent → delegator → atom) doesn't block on a permission ask().
      permissionMode: 'bypass',
    });
    // Route every lane to mock so each sub-agent's stream() lands on the
    // shared MockProvider script. Without this, the cost-lane agents would
    // resolve to anthropic/claude-haiku etc. and bypass the script cursor
    // entirely.
    runtime.laneRegistry.lookup = (_role) => ({
      provider: 'mock',
      model: 'mock-haiku',
      allowedTools: null,
      maxTokens: null,
      timeoutMs: 60_000,
    });
    // Re-stamp delegator's readOnly: true (defensive — the bundled file
    // already ships this way after the 895d16d deadlock fix).
    const loaded = runtime.agents.byName.get('delegator');
    if (loaded !== undefined) {
      runtime.agents.byName.set('delegator', { ...loaded, readOnly: true });
    }
    try {
      // Smart-router segment must be injected (taskRouting.enabled = true).
      const systemText = runtime.systemSegments.map((s) => s.text ?? '').join('\n');
      expect(systemText).toContain('<smart-router>');

      // All three cost lanes resolve to mock via the override above.
      expect(runtime.laneRegistry.lookup('cheap-task')?.provider).toBe('mock');
      expect(runtime.laneRegistry.lookup('moderate-task')?.provider).toBe('mock');
      expect(runtime.laneRegistry.lookup('frontier-task')?.provider).toBe('mock');

      const app = buildAppWithRuntime(runtime);

      // Mint a session.
      const createRes = await app.request('/sessions', { method: 'POST' });
      expect(createRes.status).toBe(201);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      // Drive a turn — the audit request.
      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'do a security audit' }),
      });
      expect(turnRes.status).toBe(202);

      // Drain SSE. The wire closes on turn_complete so `await text()`
      // returns once the parent's turn settles. Internal child events
      // (cheap-task, moderate-task, frontier-task, and the delegator's own
      // intermediate tool_use blocks) stay on their child session buses —
      // only the delegator's terminal envelope + parent's final text reach
      // this stream.
      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      expect(eventsRes.status).toBe(200);
      const body = await eventsRes.text();

      // (a) Parent dispatched to delegator.
      expect(body).toContain('event: tool_use_start');
      expect(body).toContain('"tool":"AgentTool"');
      expect(body).toContain('"subagent_type":"delegator"');

      // (b) Delegator's tool_result envelope landed on the parent bus.
      // The lane string echoes mock/mock-haiku because of the override.
      // turns=4 (delegator made 4 stream calls); tool_calls=3 (the three
      // AgentTool atom dispatches). terminal=completed marks a clean close.
      expect(body).toContain('event: tool_result');
      expect(body).toContain('<subagent_result name=\\"delegator\\"');
      expect(body).toContain('lane=\\"mock/mock-haiku\\"');
      expect(body).toContain('terminal=\\"completed\\"');

      // (c) The synthesis text reached the parent bus as the final
      // assistant fragment — proves the full relay chain closed cleanly
      // (frontier-task → delegator → parent).
      expect(body).toContain('"text":"Final security audit report: auth implementation is sound."');

      // (d) Exactly ONE turn_complete on the parent wire. Child sessions
      // each fire their own turn_complete on their private bus, but those
      // are scoped to the scheduler and never leak here.
      const turnCompleteMatches = body.match(/event: turn_complete/g) ?? [];
      expect(turnCompleteMatches.length).toBe(1);

      // (e) Nine script entries → nine provider.stream() invocations.
      // parent(2) + delegator(4) + cheap-task(1) + moderate-task(1) +
      // frontier-task(1) = 9. A mismatch means an agent looped or the
      // scheduler re-entered a node — either way a regression marker.
      expect(MockProvider.streamCalls).toBe(9);

      // (f) The session tree records the full call graph: parent +
      // delegator child + three atom grandchildren = 5 rows. The parent
      // row has parentSessionId === null; the delegator row's parent is
      // the parent session; each atom's parent is the delegator session.
      // Use listSessions(50) — well above the 5 we expect — so we don't
      // accidentally truncate.
      const allSessions = runtime.sessionDb.listSessions(50);
      const matchedRows = allSessions.filter(
        (s) => s.sessionId === sessionId || s.parentSessionId !== null,
      );
      // Parent + delegator + cheap-task + moderate-task + frontier-task = 5.
      expect(matchedRows.length).toBe(5);
      const parentRow = allSessions.find((s) => s.sessionId === sessionId);
      expect(parentRow).toBeDefined();
      expect(parentRow?.parentSessionId).toBeNull();
      const delegatorRow = allSessions.find((s) => s.parentSessionId === sessionId);
      expect(delegatorRow).toBeDefined();
      const delegatorSessionId = delegatorRow?.sessionId;
      const atomRows = allSessions.filter((s) => s.parentSessionId === delegatorSessionId);
      // Three atoms — cheap-task, moderate-task, frontier-task — all
      // pointing at the delegator session as parent.
      expect(atomRows.length).toBe(3);

      // (g) Phase 2 T10 — assert the four delegator_* events synthesized
      // by T4 land in the canonical sequence for the compound-turn shape.
      // Three atoms (cheap-task + moderate-task + frontier-task synthesis)
      // → three `delegator_atom_started` + three `delegator_atom_complete`,
      // bracketed by one `delegator_plan` + one `delegator_complete`.
      // The final event reports `totalAtomCount: 3` and the lane
      // distribution shows one dispatch per cost lane.
      const events = parseSseEvents(body);
      const delegatorEvents = events.filter((e) => e.event.startsWith('delegator_'));
      const types = delegatorEvents.map((e) => e.event);
      expect(types).toContain('delegator_plan');
      expect(types).toContain('delegator_atom_started');
      expect(types).toContain('delegator_atom_complete');
      expect(types).toContain('delegator_complete');
      // plan precedes the first atom_started; the last atom_complete
      // precedes the terminal delegator_complete. Use first/last-index
      // checks so we don't accidentally compare a started-at-index-N
      // against a complete-at-index-N (they interleave naturally as each
      // atom finishes before the next is dispatched in this script).
      expect(types.indexOf('delegator_plan')).toBeLessThan(types.indexOf('delegator_atom_started'));
      expect(types.lastIndexOf('delegator_atom_complete')).toBeLessThan(
        types.indexOf('delegator_complete'),
      );
      // Three atoms dispatched + three atoms completed.
      expect(types.filter((t) => t === 'delegator_atom_started').length).toBe(3);
      expect(types.filter((t) => t === 'delegator_atom_complete').length).toBe(3);
      // The terminal `delegator_complete` reports totalAtomCount=3 and the
      // lane distribution maps each cost lane to a single dispatch.
      const finalEvent = delegatorEvents.find((e) => e.event === 'delegator_complete');
      expect(finalEvent).toBeDefined();
      const finalData = finalEvent?.data as {
        totalAtomCount: number;
        laneDistribution: Record<string, number>;
      };
      expect(finalData.totalAtomCount).toBe(3);
      expect(finalData.laneDistribution).toEqual({
        'cheap-task': 1,
        'moderate-task': 1,
        'frontier-task': 1,
      });
    } finally {
      await runtime.dispose();
    }
  });
});

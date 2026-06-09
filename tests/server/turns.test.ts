// Phase 16.1 M3.4 — server-side turn submission.
// POST /sessions creates a session in the in-memory store. POST /sessions/:id/turns
// kicks a query() loop against the mock provider; events stream over SSE.
//
// Two scenarios are covered:
//   1. The default mock provider's single text-only call. Asserts the
//      bare wire contract: text_delta + turn_complete arrive and the
//      stream closes.
//   2. The mock provider's tool-use mode (a two-call sequence with a
//      `Bash` tool dispatch in between). Asserts the regression coverage
//      for the M3 truncation bug: tool_use_start, tool_use_done, and
//      tool_result events surface, and exactly ONE turn_complete is
//      emitted at the end (not one per internal model call).

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '../../src/providers/mock.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildServerCommandContext } from '../../src/server/commandContext.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('POST /sessions + POST /sessions/:id/turns', () => {
  test('creates a session, accepts a turn POST, streams events over SSE', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sov-turns-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    try {
      const runtime = await buildRuntime({
        harnessHome: home,
        cwd: process.cwd(),
        provider: 'mock',
        model: 'mock-haiku',
      });
      const app = buildAppWithRuntime(runtime);

      // Create a session.
      const createRes = await app.request('/sessions', { method: 'POST' });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as { sessionId: string };
      expect(typeof created.sessionId).toBe('string');
      expect(created.sessionId.length).toBeGreaterThan(0);
      const sessionId = created.sessionId;

      // Subscribe to the SSE stream BEFORE submitting the turn so the
      // first text_delta is observable. The mock provider streams
      // synchronously; the bus buffers until the subscriber attaches,
      // so the order of these two steps does not change the assertion.
      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      expect(turnRes.status).toBe(202);

      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      expect(eventsRes.status).toBe(200);
      expect(eventsRes.headers.get('content-type')).toMatch(/text\/event-stream/);
      const body = await eventsRes.text();

      // The mock provider yields two text_deltas ('Hello' + ' world.') then
      // a message_stop. The route maps text_delta -> text_delta and the
      // generator-return Terminal -> turn_complete. So we expect at minimum:
      // a text_delta and a terminal turn_complete.
      expect(body).toContain('event: text_delta');
      expect(body).toContain('"text":"Hello"');
      expect(body).toContain('event: turn_complete');
      // Exactly ONE turn_complete — the events route stops on the first
      // turn_complete, but the bus must not have queued a second one. A
      // doubled turn_complete is the marker for the pre-fix bug where
      // every internal message_stop mapped to a wire turn_complete.
      const turnCompleteMatches = body.match(/event: turn_complete/g) ?? [];
      expect(turnCompleteMatches.length).toBe(1);

      await runtime.dispose();
    } finally {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.SOV_TEST_MOCK_PROVIDER;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('multi-call turn emits tool_use_start + tool_use_done + tool_result + one turn_complete', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sov-turns-toolmode-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    MockProvider.toolUseMode = true;
    try {
      const runtime = await buildRuntime({
        harnessHome: home,
        cwd: process.cwd(),
        provider: 'mock',
        model: 'mock-haiku',
      });
      const app = buildAppWithRuntime(runtime);

      const createRes = await app.request('/sessions', { method: 'POST' });
      expect(createRes.status).toBe(201);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'run something' }),
      });
      expect(turnRes.status).toBe(202);

      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      expect(eventsRes.status).toBe(200);
      const body = await eventsRes.text();

      // Pre-tool preamble: the mock emits two deltas ("Let me " + "check.").
      expect(body).toContain('event: text_delta');
      expect(body).toContain('"text":"Let me "');
      expect(body).toContain('"text":"check."');

      // Tool dispatch surfaces on the wire.
      expect(body).toContain('event: tool_use_start');
      expect(body).toContain('"tool":"Bash"');
      expect(body).toContain('event: tool_use_done');
      expect(body).toContain('event: tool_result');
      // The tool_result's `output` carries Bash's stdout — assert the
      // echo's payload made it through end-to-end so we know the tool
      // actually ran (not just that we minted the wire event from the
      // assistant message's tool_use block).
      expect(body).toContain('hello-from-mock');

      // Final assistant turn.
      expect(body).toContain('"text":"done."');

      // Exactly ONE turn_complete — the regression marker for the M3
      // truncation bug. Multiple model calls inside one user turn must
      // collapse to a single wire terminal event.
      expect(body).toContain('event: turn_complete');
      const turnCompleteMatches = body.match(/event: turn_complete/g) ?? [];
      expect(turnCompleteMatches.length).toBe(1);

      // Ordering: tool_use_start must appear before tool_result, which
      // must appear before the final text_delta ("done."), which must
      // appear before turn_complete. Otherwise the TUI cannot place
      // them onto the right blocks in real time.
      const toolStartIdx = body.indexOf('event: tool_use_start');
      const toolResultIdx = body.indexOf('event: tool_result');
      const finalTextIdx = body.indexOf('"text":"done."');
      const turnCompleteIdx = body.indexOf('event: turn_complete');
      expect(toolStartIdx).toBeGreaterThan(-1);
      expect(toolResultIdx).toBeGreaterThan(toolStartIdx);
      expect(finalTextIdx).toBeGreaterThan(toolResultIdx);
      expect(turnCompleteIdx).toBeGreaterThan(finalTextIdx);

      await runtime.dispose();
    } finally {
      MockProvider.toolUseMode = false;
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.SOV_TEST_MOCK_PROVIDER;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('returns 400 for invalid session id', async () => {
    // Backlog #31 — sibling routes (sessions, events, approvals, compact) all
    // validate the :id path param via isValidSessionId and 400 on malformed
    // input. The turns route was the outlier: it silently accepted any string
    // and ran the per-session bus + background turn loop on it. Mirrors the
    // canonical 400 pattern from sessions.test.ts:80-97 — same sibling-route
    // validator, same rejected-character rationale.
    const home = join(tmpdir(), `backlog-31-${Date.now()}`);
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
      });
      const app = buildAppWithRuntime(runtime);
      // 'bad id!' contains characters outside [A-Za-z0-9_-] so
      // isValidSessionId rejects it before any bus creation or background
      // turn dispatch. Body shape MUST match sibling routes (sessions.ts:39,
      // events.ts:20, approvals.ts:23, compact.ts:41) — `{ error: 'invalid
      // session id' }`.
      const res = await app.request('/sessions/bad%20id!/turns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe('invalid session id');
    } finally {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.SOV_TEST_MOCK_PROVIDER;
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('returns 404 for a well-formed but nonexistent session id', async () => {
    // A valid-shaped id with no DB row must 404, not flow into the
    // fire-and-forget turn where saveMessage hits the FOREIGN KEY and throws an
    // unhandled rejection that crashes the server process.
    const home = join(tmpdir(), `nonexistent-session-${Date.now()}`);
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({ cwd: process.cwd(), provider: 'mock', harnessHome: home });
      const app = buildAppWithRuntime(runtime);
      const res = await app.request('/sessions/does-not-exist-123/turns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe('session not found');
    } finally {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.SOV_TEST_MOCK_PROVIDER;
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('turns route — message persistence', () => {
  test('POST /turns persists user, assistant, and tool_result messages', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sov-turns-persist-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    MockProvider.toolUseMode = true;
    try {
      const runtime = await buildRuntime({
        harnessHome: home,
        cwd: process.cwd(),
        provider: 'mock',
        model: 'mock-haiku',
      });
      const app = buildAppWithRuntime(runtime);

      const createRes = await app.request('/sessions', { method: 'POST' });
      expect(createRes.status).toBe(201);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      // MockProvider toolUseMode runs a 2-call sequence: preamble assistant
      // message + tool_use(Bash echo hello-from-mock) -> tool_result user
      // message -> final assistant message ("done.") -> Terminal.
      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'run a tool please' }),
      });
      expect(turnRes.status).toBe(202);

      // Draining the SSE stream blocks until turn_complete arrives, which
      // means the background turn loop has fully resolved and every
      // saveMessage call has flushed to sqlite. This mirrors the drain
      // pattern used by the tool-use truncation regression test above.
      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      expect(eventsRes.status).toBe(200);
      await eventsRes.text();

      const stored = runtime.sessionDb.loadMessages(sessionId);
      // Expect at minimum: 1 user (inbound) + 1 assistant (preamble +
      // tool_use) + 1 user (tool_result) + 1 assistant ("done.") = 4.
      expect(stored.length).toBeGreaterThanOrEqual(4);

      // First persisted message is the inbound user text.
      expect(stored[0]?.role).toBe('user');
      const firstContent = stored[0]?.content ?? [];
      const userText = firstContent.find((b) => b.type === 'text');
      expect(userText && 'text' in userText ? userText.text : '').toBe('run a tool please');

      // At least one assistant message was persisted.
      expect(stored.some((m) => m.role === 'assistant')).toBe(true);

      // A user-role message carrying a tool_result block was persisted.
      expect(
        stored.some((m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result')),
      ).toBe(true);

      await runtime.dispose();
    } finally {
      MockProvider.toolUseMode = false;
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.SOV_TEST_MOCK_PROVIDER;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('turns route — maxTokens propagation', () => {
  test('turns route honors runtime.maxTokens', async () => {
    const home = join(tmpdir(), `m4-task5c-${Date.now()}`);
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
        maxTokens: 1234,
      });
      expect(runtime.maxTokens).toBe(1234);
      const app = buildAppWithRuntime(runtime);
      const created = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await created.json()) as { sessionId: string };
      MockProvider.lastMaxTokens = undefined; // reset before turn to avoid cross-test leak
      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      expect(turnRes.status).toBe(202);
      // Drain SSE so the background turn completes before asserting.
      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      await eventsRes.text();
      // Read the static field through the prototype so tsc cannot apply
      // control-flow narrowing from the reset assignment above. The field
      // is declared as `number | undefined` — the annotation on `captured`
      // makes that explicit and satisfies the overload.
      const props = MockProvider as typeof MockProvider;
      const captured: number | undefined = props.lastMaxTokens;
      expect(captured).toBe(1234);
    } finally {
      MockProvider.lastMaxTokens = undefined;
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('turns route — effort (reasoning depth) propagation', () => {
  test('a turn after setEffort(high) forwards effort:high to the provider', async () => {
    const home = join(tmpdir(), `effort-prop-${Date.now()}`);
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
      });
      // Default boot level (no thinking config) is 'off'.
      expect(runtime.effort).toBe('off');
      // Mutate via the SAME path the /effort command will use — the
      // CommandContext setEffort hook — so the test exercises the real wiring.
      const sessionCtx = runtime.getSessionContext('effort-setter');
      const { ctx } = buildServerCommandContext(runtime, sessionCtx, 'effort-setter');
      ctx.setEffort('high');
      expect(runtime.effort).toBe('high');

      const app = buildAppWithRuntime(runtime);
      const created = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await created.json()) as { sessionId: string };
      MockProvider.lastEffort = undefined; // reset before turn to avoid cross-test leak
      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      expect(turnRes.status).toBe(202);
      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      await eventsRes.text();
      const props = MockProvider as typeof MockProvider;
      const captured: import('../../src/providers/effort.js').ReasoningEffort | undefined =
        props.lastEffort;
      expect(captured).toBe('high');
    } finally {
      MockProvider.lastEffort = undefined;
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('default-off turn forwards effort:off (adapter no-ops → byte-identical)', async () => {
    const home = join(tmpdir(), `effort-off-${Date.now()}`);
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
      });
      expect(runtime.effort).toBe('off');
      const app = buildAppWithRuntime(runtime);
      const created = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await created.json()) as { sessionId: string };
      MockProvider.lastEffort = undefined;
      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      expect(turnRes.status).toBe(202);
      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      await eventsRes.text();
      const props = MockProvider as typeof MockProvider;
      const captured: import('../../src/providers/effort.js').ReasoningEffort | undefined =
        props.lastEffort;
      // runtime.effort is 'off' → query() forwards effort:'off'; the adapter
      // treats 'off' as no thinking, so the wire request is byte-identical.
      expect(captured).toBe('off');
    } finally {
      MockProvider.lastEffort = undefined;
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('turns route — resume hydrates model context', () => {
  test('turns route sends prior conversation history to the model on resume', async () => {
    const home = join(tmpdir(), `m4-resume-hydrate-${Date.now()}`);
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
      });
      const app = buildAppWithRuntime(runtime);

      // Seed a session with two prior turns directly in sessionDb to
      // simulate "resume after prior conversation". The bug being
      // pinned: the turns route used to send only the new user message
      // to the model, ignoring prior history entirely. T9 hydrated the
      // TUI transcript visually but the model saw a fresh context.
      const sessionId = runtime.sessionDb.createSession({
        model: runtime.model,
        provider: runtime.resolvedProvider.transport.name,
        systemPrompt: runtime.systemSegments,
        metadata: { cwd: runtime.cwd },
      });
      runtime.sessionDb.saveMessage(sessionId, {
        role: 'user',
        content: [{ type: 'text', text: 'first turn user prompt' }],
      });
      runtime.sessionDb.saveMessage(sessionId, {
        role: 'assistant',
        content: [{ type: 'text', text: 'first turn assistant response' }],
      });

      MockProvider.lastMessages = undefined;

      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'second turn user prompt' }),
      });
      expect(turnRes.status).toBe(202);
      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      await eventsRes.text();

      const props = MockProvider as typeof MockProvider;
      const captured = props.lastMessages;
      expect(captured).toBeDefined();
      // The model should see at least the 2 prior turns + the new user
      // turn = 3 messages. query() may normalize/dedupe further but the
      // core invariant is "prior history reached the provider". A bare
      // `[userMessage]` would produce length=1, which is exactly what we're
      // pinning against.
      const msgs = captured ?? [];
      expect(msgs.length).toBeGreaterThanOrEqual(3);
      // First two messages preserve the seeded history in order.
      const firstUserBlock = msgs[0]?.content[0];
      expect(msgs[0]?.role).toBe('user');
      expect(firstUserBlock && firstUserBlock.type === 'text' ? firstUserBlock.text : '').toBe(
        'first turn user prompt',
      );
      const firstAsstBlock = msgs[1]?.content[0];
      expect(msgs[1]?.role).toBe('assistant');
      expect(firstAsstBlock && firstAsstBlock.type === 'text' ? firstAsstBlock.text : '').toBe(
        'first turn assistant response',
      );
      // The new user turn appears somewhere in the array (order
      // depends on query()'s internal normalization).
      const hasNewUserTurn = msgs.some(
        (m) =>
          m.role === 'user' &&
          m.content.some((b) => b.type === 'text' && b.text === 'second turn user prompt'),
      );
      expect(hasNewUserTurn).toBe(true);
    } finally {
      MockProvider.lastMessages = undefined;
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// Per-turn effort — PostTurnRequest.effort → PerTurn.effort.
//
// A single turn MAY carry an `effort` string from the REASONING_EFFORTS
// vocabulary (`off|low|medium|high|max`) that sets the reasoning depth for THAT
// turn only. The turns route validates it at the untrusted-body boundary and
// hands it to agent.run() via PerTurn.effort as `perTurnEffort ??
// sessionCtx.effort` — so the session's own level (set by `/effort` or the
// `thinking.effort` config) is NEVER mutated and the very next turn without an
// `effort` field is back on the session level.
//
// Validation is strict on purpose: a typo (`huge`) or a wrong type (`42`) is a
// 400, never a silent fallback. Silently dropping an unrecognised value would
// turn "disable reasoning for this turn" into "no control at all" — exactly the
// failure mode this feature exists to remove (spec §2.2).
//
// The seam is proven at the provider boundary: MockProvider.lastEffort
// snapshots `req.effort`, i.e. the level createAgent resolved
// (`perTurn.effort ?? config.effort`) and forwarded to stream().

import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReasoningEffort } from '@yevgetman/sov-sdk/providers/effort';
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

/** The exact 400 body the boundary returns for any non-vocabulary `effort`. */
const EFFORT_400 = 'effort must be one of off|low|medium|high|max';

describe('turns route — per-turn effort (PostTurnRequest.effort)', () => {
  test('a turn posted with effort:off reaches the provider as off while the session stays low, and the NEXT turn without effort is back on low', async () => {
    const home = join(tmpdir(), `perturn-effort-override-${Date.now()}`);
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      // Seed the session level at 'low' (the boot default the gateway ships to
      // chat), so an `off` on ONE turn is visibly a per-turn override and not
      // just the ambient default.
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
        model: 'mock-haiku',
        effort: 'low',
      });
      expect(runtime.effort).toBe('low');
      const app = buildAppWithRuntime(runtime);

      const created = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await created.json()) as { sessionId: string };
      const sessionCtx = runtime.getSessionContext(sessionId);
      expect(sessionCtx.effort).toBe('low');

      MockProvider.lastEffort = undefined; // reset before turn to avoid cross-test leak
      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi', effort: 'off' }),
      });
      expect(turnRes.status).toBe(202);
      // Drain SSE so the background turn completes before asserting.
      await (await app.request(`/sessions/${sessionId}/events`)).text();

      const props = MockProvider as typeof MockProvider;
      const captured: ReasoningEffort | undefined = props.lastEffort;
      expect(captured).toBe('off');
      // THIS turn only: the per-session level is untouched (no mutation of
      // sessionCtx.effort), and so is the shared boot default.
      expect(sessionCtx.effort).toBe('low');
      expect(runtime.effort).toBe('low');

      // The very next turn on the SAME session, with no `effort` on the wire,
      // is back on the session's level.
      MockProvider.lastEffort = undefined;
      const turnRes2 = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'again' }),
      });
      expect(turnRes2.status).toBe(202);
      await (await app.request(`/sessions/${sessionId}/events`)).text();
      const captured2: ReasoningEffort | undefined = props.lastEffort;
      expect(captured2).toBe('low');
    } finally {
      MockProvider.lastEffort = undefined;
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a turn posted WITHOUT effort uses the session level unchanged (byte-identical to today)', async () => {
    const home = join(tmpdir(), `perturn-effort-absent-${Date.now()}`);
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
        model: 'mock-haiku',
        effort: 'low',
      });
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
      await (await app.request(`/sessions/${sessionId}/events`)).text();

      const props = MockProvider as typeof MockProvider;
      const captured: ReasoningEffort | undefined = props.lastEffort;
      // No `effort` on the wire → perTurnEffort is undefined → PerTurn.effort
      // falls back to sessionCtx.effort, exactly as before this feature.
      expect(captured).toBe('low');
      expect(runtime.getSessionContext(sessionId).effort).toBe('low');
    } finally {
      MockProvider.lastEffort = undefined;
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('effort:"huge" (not in the vocabulary) is a 400 and no turn runs', async () => {
    const home = join(tmpdir(), `perturn-effort-typo-${Date.now()}`);
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
        model: 'mock-haiku',
        effort: 'low',
      });
      const app = buildAppWithRuntime(runtime);

      const created = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await created.json()) as { sessionId: string };

      MockProvider.lastEffort = undefined;
      MockProvider.streamCalls = 0;
      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi', effort: 'huge' }),
      });
      expect(turnRes.status).toBe(400);
      expect(await turnRes.json()).toEqual({ error: EFFORT_400 });

      // Rejected at the boundary BEFORE any turn state is touched: give the
      // event loop a tick and confirm the provider was never reached (a
      // fire-and-forget turn would have called stream() by now) and the
      // session's own level is untouched.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(MockProvider.streamCalls).toBe(0);
      expect(MockProvider.lastEffort).toBeUndefined();
      expect(runtime.getSessionContext(sessionId).effort).toBe('low');
    } finally {
      MockProvider.lastEffort = undefined;
      MockProvider.streamCalls = 0;
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('effort of the wrong type (42) is a 400 and no turn runs', async () => {
    const home = join(tmpdir(), `perturn-effort-type-${Date.now()}`);
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
        model: 'mock-haiku',
        effort: 'low',
      });
      const app = buildAppWithRuntime(runtime);

      const created = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await created.json()) as { sessionId: string };

      MockProvider.lastEffort = undefined;
      MockProvider.streamCalls = 0;
      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Deliberately off-type — the wire is untrusted JSON, not a typed body.
        body: JSON.stringify({ text: 'hi', effort: 42 }),
      });
      expect(turnRes.status).toBe(400);
      expect(await turnRes.json()).toEqual({ error: EFFORT_400 });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(MockProvider.streamCalls).toBe(0);
      expect(MockProvider.lastEffort).toBeUndefined();
    } finally {
      MockProvider.lastEffort = undefined;
      MockProvider.streamCalls = 0;
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('an empty-string effort is a 400 (not a silent fallback to the session level)', async () => {
    const home = join(tmpdir(), `perturn-effort-empty-${Date.now()}`);
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
        model: 'mock-haiku',
        effort: 'low',
      });
      const app = buildAppWithRuntime(runtime);

      const created = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await created.json()) as { sessionId: string };

      MockProvider.lastEffort = undefined;
      MockProvider.streamCalls = 0;
      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi', effort: '' }),
      });
      expect(turnRes.status).toBe(400);
      expect(await turnRes.json()).toEqual({ error: EFFORT_400 });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(MockProvider.streamCalls).toBe(0);
    } finally {
      MockProvider.lastEffort = undefined;
      MockProvider.streamCalls = 0;
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('every REASONING_EFFORTS level is accepted and reaches the provider verbatim', async () => {
    const home = join(tmpdir(), `perturn-effort-vocab-${Date.now()}`);
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
        model: 'mock-haiku',
        effort: 'low',
      });
      const app = buildAppWithRuntime(runtime);
      const props = MockProvider as typeof MockProvider;

      for (const level of ['off', 'low', 'medium', 'high', 'max'] as const) {
        const created = await app.request('/sessions', { method: 'POST' });
        const { sessionId } = (await created.json()) as { sessionId: string };
        MockProvider.lastEffort = undefined;
        const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'hi', effort: level }),
        });
        expect(turnRes.status).toBe(202);
        await (await app.request(`/sessions/${sessionId}/events`)).text();
        const captured: ReasoningEffort | undefined = props.lastEffort;
        expect(captured).toBe(level);
      }
    } finally {
      MockProvider.lastEffort = undefined;
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

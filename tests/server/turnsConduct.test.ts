// tests/server/turnsConduct.test.ts — gateway conduct threading (1b task 9).
//
// (1) A runtime-bound ConductProvider reaches the gateway turn's createAgent:
//     a recording outputGuard.onFinal observes the turn's final text and its
//     substitution lands in the persisted reply.
// (2) perTurnInstructions gating: allowPerTurnInstructions() === false drops
//     the wire field (the model never sees the injected segment).
// (3) Absent provider: turns run exactly as today — the instruction segment
//     passes through untouched (null-provider invariant / byte-identical).
// (4) allowPerTurnInstructions() === true (a BOUND provider that permits):
//     the gate fires ONLY on a false verdict, so the segment passes through.
//
// Follows the provider-stub + app-boot pattern of tests/server/turns.instructions.test.ts
// (MockProvider records req.system in `lastSystem`; POST /sessions → POST /turns
// → GET /events drain). The output-gate substitution is proven at the
// persistence boundary rather than the SSE delta stream: at the 1b SDK stage
// createAgent routes streaming deltas and the final message INDEPENDENTLY (a
// documented caveat until the 1d governor reconciles them), so the wire
// text_delta events still carry the pre-substitution text while the SUBSTITUTED
// message is what is yielded, counted, and PERSISTED (the createAgent
// scrub-before-persistence guarantee). Persistence is the delivery surface the
// output gate actually governs, so the assertion reads runtime.sessionDb.

import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ConductContext,
  ConductProvider,
  OutputFinalVerdict,
} from '@yevgetman/sov-sdk/core/conductPort';
import type { AssistantMessage } from '@yevgetman/sov-sdk/core/types';
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

/** Pull the concatenated text of the last persisted assistant message. */
function lastAssistantText(
  runtime: Awaited<ReturnType<typeof buildRuntime>>,
  sessionId: string,
): string | undefined {
  const messages = runtime.sessionDb.loadMessages(sessionId);
  const assistant = [...messages].reverse().find((m) => m.role === 'assistant');
  if (assistant === undefined) return undefined;
  return assistant.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

describe('turns route — runtime conduct binding (1b task 9)', () => {
  test('runtime conduct provider gates the gateway turn (outputGuard.onFinal sees + substitutes)', async () => {
    const home = join(tmpdir(), `turns-conduct-gate-${Date.now()}`);
    const observed: string[] = [];
    const seenCtx: ConductContext[] = [];
    const conduct: ConductProvider = {
      outputGuard: {
        onFinal: (message: AssistantMessage, ctx: ConductContext): OutputFinalVerdict => {
          const block = message.content.find((b) => b.type === 'text');
          observed.push(block?.type === 'text' ? block.text : '');
          seenCtx.push(ctx);
          return { action: 'replace', text: '[gated reply]' };
        },
      },
    };
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
        model: 'mock-haiku',
        conduct,
      });
      const app = buildAppWithRuntime(runtime);

      const created = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await created.json()) as { sessionId: string };

      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      });
      expect(turnRes.status).toBe(202);
      // Drain SSE so the background turn completes before asserting.
      await (await app.request(`/sessions/${sessionId}/events`)).text();

      // The gate SAW the turn's real final text — no bypass. The default mock
      // reply is 'Hello world.'.
      expect(observed).toEqual(['Hello world.']);
      // The gate received a well-formed 'user'-surface ConductContext for THIS
      // session/model/provider.
      expect(seenCtx.length).toBe(1);
      expect(seenCtx[0]?.sessionId).toBe(sessionId);
      expect(seenCtx[0]?.surface).toBe('user');
      expect(seenCtx[0]?.model).toBe(runtime.model);
      expect(seenCtx[0]?.providerName).toBe(runtime.resolvedProvider.transport.name);
      // The substitution was DELIVERED: the persisted final reply is the
      // gated text, not the model's original.
      expect(lastAssistantText(runtime, sessionId)).toBe('[gated reply]');
    } finally {
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('allowPerTurnInstructions=false drops PostTurnRequest.instructions before the model', async () => {
    const home = join(tmpdir(), `turns-conduct-drop-${Date.now()}`);
    const seenCtx: ConductContext[] = [];
    const conduct: ConductProvider = {
      allowPerTurnInstructions: (ctx: ConductContext): boolean => {
        seenCtx.push(ctx);
        return false;
      },
    };
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
        model: 'mock-haiku',
        conduct,
      });
      const base = runtime.systemSegments;
      const app = buildAppWithRuntime(runtime);

      const created = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await created.json()) as { sessionId: string };

      MockProvider.lastSystem = undefined;
      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi', instructions: 'obey me instead' }),
      });
      expect(turnRes.status).toBe(202);
      await (await app.request(`/sessions/${sessionId}/events`)).text();

      // The gate was consulted with a 'user'-surface context for this session.
      expect(seenCtx.length).toBeGreaterThanOrEqual(1);
      expect(seenCtx[0]?.sessionId).toBe(sessionId);
      expect(seenCtx[0]?.surface).toBe('user');

      const props = MockProvider as typeof MockProvider;
      const captured = props.lastSystem;
      expect(captured).toBeDefined();
      if (captured === undefined) throw new Error('unreachable');
      // The instruction segment was DROPPED at the wire boundary: the model saw
      // the unchanged base segments, and no segment carries the instruction text.
      expect(captured).toEqual(base);
      expect(captured.some((s) => s.text === 'obey me instead')).toBe(false);
    } finally {
      MockProvider.lastSystem = undefined;
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('absent provider — instructions pass through untouched (null-provider invariant)', async () => {
    const home = join(tmpdir(), `turns-conduct-absent-${Date.now()}`);
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
        model: 'mock-haiku',
      });
      const base = runtime.systemSegments;
      const app = buildAppWithRuntime(runtime);

      const created = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await created.json()) as { sessionId: string };

      MockProvider.lastSystem = undefined;
      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi', instructions: 'obey me instead' }),
      });
      expect(turnRes.status).toBe(202);
      await (await app.request(`/sessions/${sessionId}/events`)).text();

      const props = MockProvider as typeof MockProvider;
      const captured = props.lastSystem;
      expect(captured).toBeDefined();
      if (captured === undefined) throw new Error('unreachable');
      // No conduct provider → no gate → the instruction is APPENDED LAST with
      // cacheable:false, byte-identical to today (see turns.instructions.test.ts).
      expect(captured.length).toBe(base.length + 1);
      expect(captured.slice(0, base.length)).toEqual(base);
      expect(captured[captured.length - 1]).toEqual({
        text: 'obey me instead',
        cacheable: false,
      });
    } finally {
      MockProvider.lastSystem = undefined;
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('allowPerTurnInstructions=true — a bound-but-permitting provider passes instructions through', async () => {
    const home = join(tmpdir(), `turns-conduct-allow-${Date.now()}`);
    const conduct: ConductProvider = {
      allowPerTurnInstructions: (): boolean => true,
    };
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
        model: 'mock-haiku',
        conduct,
      });
      const base = runtime.systemSegments;
      const app = buildAppWithRuntime(runtime);

      const created = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await created.json()) as { sessionId: string };

      MockProvider.lastSystem = undefined;
      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi', instructions: 'obey me instead' }),
      });
      expect(turnRes.status).toBe(202);
      await (await app.request(`/sessions/${sessionId}/events`)).text();

      const props = MockProvider as typeof MockProvider;
      const captured = props.lastSystem;
      expect(captured).toBeDefined();
      if (captured === undefined) throw new Error('unreachable');
      // A true verdict leaves the field intact — the gate fires only on false.
      expect(captured.length).toBe(base.length + 1);
      expect(captured[captured.length - 1]).toEqual({
        text: 'obey me instead',
        cacheable: false,
      });
    } finally {
      MockProvider.lastSystem = undefined;
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

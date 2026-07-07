// Per-turn model override — PostTurnRequest.model → PerTurn.model.
//
// A single chat session can run one turn on model A and the next on model B
// without a new gateway process. The wire body gained an optional `model`; the
// turns route threads it onto the PerTurn slice handed to agent.run(), where
// createAgent applies `perTurn.model ?? config.model` for THAT turn only. When
// the field is absent, behaviour is byte-identical to today (the configured
// global runtime.model is used).
//
// The seam is proven at the provider boundary: MockProvider.lastModel snapshots
// `req.model`, i.e. the model createAgent resolved and forwarded to stream().

import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('turns route — per-turn model override (PostTurnRequest.model)', () => {
  test('a turn posted with model:X runs the agent with X for THIS turn only', async () => {
    const home = join(tmpdir(), `perturn-model-override-${Date.now()}`);
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
        model: 'mock-haiku',
      });
      expect(runtime.model).toBe('mock-haiku');
      const app = buildAppWithRuntime(runtime);

      const created = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await created.json()) as { sessionId: string };

      MockProvider.lastModel = undefined; // reset before turn to avoid cross-test leak
      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi', model: 'mock-sonnet' }),
      });
      expect(turnRes.status).toBe(202);
      // Drain SSE so the background turn completes before asserting.
      await (await app.request(`/sessions/${sessionId}/events`)).text();

      // Read through a typed alias so tsc cannot narrow to `undefined` from the
      // reset assignment above (matches the maxTokens/effort propagation tests).
      const props = MockProvider as typeof MockProvider;
      const captured: string | undefined = props.lastModel;
      // The per-turn override wins over the configured global for THIS turn.
      expect(captured).toBe('mock-sonnet');
      // The process-global model is untouched (per-turn override, not a swap).
      expect(runtime.model).toBe('mock-haiku');
    } finally {
      MockProvider.lastModel = undefined;
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a turn posted WITHOUT model falls back to the configured global model (unchanged)', async () => {
    const home = join(tmpdir(), `perturn-model-fallback-${Date.now()}`);
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
        model: 'mock-haiku',
      });
      const app = buildAppWithRuntime(runtime);

      const created = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await created.json()) as { sessionId: string };

      MockProvider.lastModel = undefined;
      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      expect(turnRes.status).toBe(202);
      await (await app.request(`/sessions/${sessionId}/events`)).text();

      const props = MockProvider as typeof MockProvider;
      const captured: string | undefined = props.lastModel;
      // No `model` on the wire → createAgent falls back to config.model, which
      // the gateway sets to the configured global runtime.model. Byte-identical
      // to today's behaviour.
      expect(captured).toBe('mock-haiku');
    } finally {
      MockProvider.lastModel = undefined;
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

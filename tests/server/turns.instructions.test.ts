// Per-turn instructions — PostTurnRequest.instructions → PerTurn.systemPrompt.
//
// A single turn MAY carry an ephemeral `instructions` string that reaches the
// model as an extra system segment for THAT turn only, without being persisted
// in session history. The wire body gained an optional `instructions`; the
// turns route AUGMENTS the standing base system segments (runtime.systemSegments)
// with `{ text: instructions, cacheable: false }` APPENDED LAST, then hands the
// combined array to agent.run() via PerTurn.systemPrompt. createAgent resolves
// `perTurn.systemPrompt ?? config.systemPrompt` — a REPLACE — so the gateway
// must build the full augmented array (not pass only the instruction), or the
// base persona/bundle/skills prompt would be dropped. When `instructions` is
// absent, behaviour is byte-identical to today (config.systemPrompt =
// runtime.systemSegments is used unchanged).
//
// The seam is proven at the provider boundary: MockProvider.lastSystem snapshots
// `req.system`, i.e. the SystemSegment[] createAgent resolved and forwarded to
// stream() (query.ts passes systemPrompt straight through — only messages get
// memory/recall injection, never the system).

import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('turns route — per-turn instructions (PostTurnRequest.instructions)', () => {
  test('a turn posted with instructions augments the base system: base preserved + instruction appended last (cacheable:false)', async () => {
    const home = join(tmpdir(), `perturn-instructions-augment-${Date.now()}`);
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

      MockProvider.lastSystem = undefined; // reset before turn to avoid cross-test leak
      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi', instructions: 'DO X' }),
      });
      expect(turnRes.status).toBe(202);
      // Drain SSE so the background turn completes before asserting.
      await (await app.request(`/sessions/${sessionId}/events`)).text();

      const props = MockProvider as typeof MockProvider;
      const captured = props.lastSystem;
      expect(captured).toBeDefined();
      if (captured === undefined) throw new Error('unreachable');

      // AUGMENT-not-REPLACE: the base segments are PRESERVED (present + unchanged)
      // and the instruction is APPENDED LAST with cacheable:false.
      expect(captured.length).toBe(base.length + 1);
      expect(captured.slice(0, base.length)).toEqual(base);
      expect(captured[captured.length - 1]).toEqual({ text: 'DO X', cacheable: false });

      // Ephemeral: the process-global base segments are untouched.
      expect(runtime.systemSegments).toEqual(base);
    } finally {
      MockProvider.lastSystem = undefined;
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a turn posted WITHOUT instructions uses the unchanged base system (byte-identical to today)', async () => {
    const home = join(tmpdir(), `perturn-instructions-absent-${Date.now()}`);
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
        body: JSON.stringify({ text: 'hi' }),
      });
      expect(turnRes.status).toBe(202);
      await (await app.request(`/sessions/${sessionId}/events`)).text();

      const props = MockProvider as typeof MockProvider;
      const captured = props.lastSystem;
      expect(captured).toBeDefined();
      // No `instructions` on the wire → createAgent falls back to config.systemPrompt,
      // which the gateway sets to the configured base runtime.systemSegments. The
      // system reaching the provider is the unchanged base — byte-identical to today.
      expect(captured).toEqual(base);
    } finally {
      MockProvider.lastSystem = undefined;
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

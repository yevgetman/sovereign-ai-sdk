// Task 7.1 — gateway turn-exec re-seat onto `createAgent().run()`.
//
// The gateway no longer calls `query()` directly; each turn is driven through
// the open SDK's `createAgent().run()` while every surrounding concern (SSE
// bus, persistence, compaction pivot, approval bridge, delegation recorder,
// the consumption loop) stays byte-identical. The existing tests/server/ suite
// (turns / overflowRecovery / approvals / skillSlash / eventsReconnect / …) is
// the load-bearing guard for that byte-identity and remains green.
//
// This file pins the ONE re-seat-specific behavior not covered E2E elsewhere:
// LIVE-RELOAD PRESERVATION. The agent is created ONCE PER TURN from the live
// `runtime.*` refs, so a `/model` swap applied BETWEEN turns (the reload engine
// mutates runtime.model + the resolved provider stack) must take effect on the
// NEXT turn. If the re-seat had hoisted/cached the agent across turns, the
// second turn would run on the stale model — this test would catch it.
//
// It also asserts per-turn SSE-sequence parity: each turn yields a text_delta
// and exactly ONE terminal turn_complete (no doubled terminal, no turn_error).
//
// Isolation: POST /sessions mints a fresh id per call and temp dirs are keyed
// per test, so nothing collides with the global ~/.harness/sessions.db.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '../../src/providers/mock.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { __test_resetAllBuses } from '../../src/server/eventBus.js';
import { buildRuntime } from '../../src/server/runtime.js';
import { type ServerEvent, parseServerEvent } from '../../src/server/schema.js';

type SseEvent = { event: string; id: string | null; data: ServerEvent | null };

/** Parse one `event:`/`id:`/`data:` SSE block into its parts. */
function parseSseBlock(block: string): SseEvent | null {
  let eventName: string | null = null;
  let idLine: string | null = null;
  let dataLine: string | null = null;
  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) eventName = line.slice('event: '.length);
    else if (line.startsWith('id: ')) idLine = line.slice('id: '.length);
    else if (line.startsWith('data: ')) dataLine = line.slice('data: '.length);
  }
  if (eventName === null) return null;
  const parsed = dataLine !== null ? parseServerEvent(dataLine) : null;
  return { event: eventName, id: idLine, data: parsed };
}

/** Drive ONE turn end-to-end and drain its non-follow SSE stream to terminal.
 *  The stream closing on turn_complete is the synchronization point (no sleeps),
 *  so by the time this resolves the background turn has fully run. */
async function driveTurn(
  app: ReturnType<typeof buildAppWithRuntime>,
  sessionId: string,
  text: string,
): Promise<SseEvent[]> {
  const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  expect(turnRes.status).toBe(202);

  const events: SseEvent[] = [];
  const res = await app.request(`/sessions/${sessionId}/events`);
  expect(res.status).toBe(200);
  if (res.body === null) throw new Error('SSE response has no body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let blockEnd = buffer.indexOf('\n\n');
      while (blockEnd !== -1) {
        const block = buffer.slice(0, blockEnd);
        buffer = buffer.slice(blockEnd + 2);
        const parsed = parseSseBlock(block);
        if (parsed !== null) events.push(parsed);
        blockEnd = buffer.indexOf('\n\n');
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore: cancel can throw if the reader is already closed
    }
  }
  return events;
}

describe('gateway turn re-seat onto createAgent().run() (Task 7.1)', () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-reseat-'));
    cwd = mkdtempSync(join(tmpdir(), 'sov-reseat-cwd-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    MockProvider.toolUseMode = false;
    MockProvider.lastModel = undefined;
    __test_resetAllBuses();
  });

  afterEach(() => {
    MockProvider.toolUseMode = false;
    MockProvider.lastModel = undefined;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    __test_resetAllBuses();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
  });

  test('a /model swap between two turns takes effect on the second (per-turn createAgent reads the live runtime.model)', async () => {
    const runtime = await buildRuntime({
      cwd,
      harnessHome: home,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
      cronEnabled: false,
    });
    const app = buildAppWithRuntime(runtime);
    try {
      const create = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await create.json()) as { sessionId: string };
      expect(typeof sessionId).toBe('string');

      // --- Turn 1 on the boot model. (beforeEach reset lastModel; this turn's
      //     provider.stream() sets it.) ---
      const firstEvents = await driveTurn(app, sessionId, 'turn one');
      // SSE-sequence parity: a text_delta + exactly ONE terminal, no error.
      expect(firstEvents.some((e) => e.event === 'text_delta')).toBe(true);
      expect(firstEvents.filter((e) => e.event === 'turn_complete').length).toBe(1);
      expect(firstEvents.some((e) => e.event === 'turn_error')).toBe(false);
      // The turn ran through the per-turn agent on the boot model.
      expect(MockProvider.lastModel).toBe('mock-haiku');

      // --- Live-reload BETWEEN turns: swap the active model. ---
      expect(runtime.reresolveProvider).toBeDefined();
      await runtime.reresolveProvider?.('mock', 'mock-sonnet');
      expect(runtime.model).toBe('mock-sonnet');

      // --- Turn 2: the fresh-per-turn createAgent must pick up the new model.
      //     lastModel still holds turn 1's 'mock-haiku'; if turn 2 failed to run
      //     on the reloaded model the assertion below would catch it. ---
      const secondEvents = await driveTurn(app, sessionId, 'turn two');
      expect(secondEvents.some((e) => e.event === 'text_delta')).toBe(true);
      expect(secondEvents.filter((e) => e.event === 'turn_complete').length).toBe(1);
      expect(secondEvents.some((e) => e.event === 'turn_error')).toBe(false);
      // The load-bearing assertion: the second turn's provider.stream() saw the
      // RELOADED model — proof the per-turn createAgent read the live
      // runtime.model rather than a value captured once and cached across turns.
      expect(MockProvider.lastModel).toBe('mock-sonnet');
    } finally {
      await runtime.dispose();
    }
  });
});

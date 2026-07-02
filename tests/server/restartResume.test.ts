// Phase D T6 — restart / eviction resume characterization.
//
// The SessionSupervisor reclaims idle in-memory session state (its
// sessionContext + event bus) on a background sweep, and a process restart
// starts the gateway with empty in-memory maps. Either way, a subsequent turn
// on a previously-seen session id must transparently rebuild its context from
// the persisted message backlog and continue — no error, no lost history.
//
// This test LOCKS that behavior (D5: eviction / restart are transparent). It
// drives the real turns path against buildAppWithRuntime + MockProvider:
//
//   1. create a session, drive one turn to turn_complete, assert the turn's
//      messages were persisted (sessionDb.loadMessages non-empty).
//   2. simulate an eviction / restart: disposeSession(id) + disposeBus(id) —
//      now the in-memory context + bus are gone, exactly as after an idle
//      sweep or a fresh process boot with empty maps.
//   3. drive a SECOND turn on the SAME session id. It must lazily rebuild the
//      context from the DB (buildSessionContext → sessionDb.loadMessages) and
//      reach turn_complete with no error; loadMessages now carries BOTH turns.
//
// This likely passes on the first run — getSessionContext already rebuilds
// lazily and buildSessionContext already hydrates from the DB. That is the
// point: it is a regression guard pinning the resume-after-eviction contract.
//
// Isolation: buildMockRuntime / buildRuntime may open the global
// ~/.harness/sessions.db, so we never use a fixed session id. POST /sessions
// mints a fresh id per call; we additionally key temp dirs per test so nothing
// collides across the suite.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { __test_resetAllBuses, disposeBus } from '../../src/server/eventBus.js';
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

/** Drive ONE turn end-to-end against the app and drain its SSE stream to the
 *  terminal event. POSTs the turn (expects 202), opens the events stream
 *  (non-follow, so it closes on the turn terminal), and returns the drained
 *  events. The non-follow stream ending on turn_complete is the synchronization
 *  point — no sleeps. */
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

describe('gateway — turn resumes after session eviction / restart (Phase D T6)', () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-resume-'));
    cwd = mkdtempSync(join(tmpdir(), 'sov-resume-cwd-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    MockProvider.toolUseMode = false;
    MockProvider.slowMode = false;
    MockProvider.slowModeDelayMs = 0;
    __test_resetAllBuses();
  });

  afterEach(() => {
    MockProvider.toolUseMode = false;
    MockProvider.slowMode = false;
    MockProvider.slowModeDelayMs = 0;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    __test_resetAllBuses();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
  });

  test('after disposeSession + disposeBus, a second turn on the same id rebuilds from the DB and reaches turn_complete with both turns persisted', async () => {
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
      // POST /sessions mints a fresh random id — never a fixed id, so this
      // never collides with the global ~/.harness/sessions.db that
      // buildRuntime may open.
      const create = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await create.json()) as { sessionId: string };
      expect(typeof sessionId).toBe('string');

      // --- Turn 1: drive to turn_complete, assert messages persisted. ---
      const firstEvents = await driveTurn(app, sessionId, 'first turn');
      expect(firstEvents.some((e) => e.event === 'turn_complete')).toBe(true);
      expect(firstEvents.some((e) => e.event === 'turn_error')).toBe(false);

      const afterFirst = runtime.sessionDb.loadMessages(sessionId);
      expect(afterFirst.length).toBeGreaterThan(0);
      const countAfterFirst = afterFirst.length;

      // --- Eviction / restart: drop the in-memory context + bus. ---
      // After this the runtime has no sessionContext for the id and no bus —
      // exactly the state an idle sweep leaves, and the state a freshly
      // restarted process starts in (empty maps, DB on disk).
      await runtime.disposeSession(sessionId);
      disposeBus(sessionId);
      expect(runtime.sessionContexts.has(sessionId)).toBe(false);

      // --- Turn 2 on the SAME id: must rebuild lazily from the DB. ---
      const secondEvents = await driveTurn(app, sessionId, 'second turn');
      expect(secondEvents.some((e) => e.event === 'turn_complete')).toBe(true);
      expect(secondEvents.some((e) => e.event === 'turn_error')).toBe(false);

      // The persisted backlog now contains BOTH turns' messages — the second
      // turn appended on top of the rehydrated first-turn history rather than
      // starting from an empty context.
      const afterSecond = runtime.sessionDb.loadMessages(sessionId);
      expect(afterSecond.length).toBeGreaterThan(countAfterFirst);

      // And the first turn's user message survived the eviction round-trip
      // (proof the second turn rebuilt context from the DB, not from scratch).
      // Pull the text out of each user message's content blocks.
      const userTexts = afterSecond
        .filter((m) => m.role === 'user')
        .flatMap((m) =>
          m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text),
        );
      expect(userTexts.some((t) => t.includes('first turn'))).toBe(true);
      expect(userTexts.some((t) => t.includes('second turn'))).toBe(true);
    } finally {
      await runtime.dispose();
    }
  }, 20_000);
});

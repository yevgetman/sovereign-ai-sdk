// Phase F-T5 — the Telegram adapter (long-poll getUpdates, injectable transport).
//
// Telegram needs no public endpoint: the adapter long-polls `getUpdates` and
// drives ONE headless channel turn per usable message, then `sendMessage`s the
// reply back. The whole adapter is built against an INJECTABLE TelegramTransport
// so it's fully testable with no live bot token (the live token is a documented
// setup step resolved by the caller, F-T7).
//
// These tests pin the load-bearing contracts deterministically against the
// MockProvider runtime (no LLM variance) + a mock transport:
//   1. canned update → turn → send — one private message maps to an
//      InboundMessage (channel 'telegram', sender/chatId '42', chatType
//      'private', text 'hi'), runs the real pipeline (session sourced + owned by
//      the principal), and calls transport.sendMessage(42, <reply>).
//   2. offset advances — after processing update_id N, the next getUpdates is
//      called with offset N+1 (no reprocessing).
//   3. silent — a [SILENT]/empty reply → sendMessage NOT called.
//   4. skip — non-message updates / messages with no text / the bot's own
//      messages → no turn, no send.
//   5. lifecycle — start() arms an unref'd poll loop (asserted via an injected
//      setInterval seam); stop() halts it (no further getUpdates).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type TelegramTransport,
  type TelegramUpdate,
  createTelegramListener,
} from '../../src/channels/adapters/telegram.js';
import { buildSessionKey } from '../../src/channels/sessionKey.js';
import type { InboundMessage } from '../../src/channels/types.js';
import { MockProvider } from '../../src/providers/mock.js';
import { buildRuntime } from '../../src/server/runtime.js';
import type { Runtime } from '../../src/server/runtime.js';

const PRINCIPAL = 'tg-bot';
const TOKEN = 'bot-token-never-logged';

/** A canned private-DM update from user 42 in chat 42, text 'hi'. */
function privateUpdate(updateId: number, text = 'hi'): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      from: { id: 42, username: 'alice' },
      chat: { id: 42, type: 'private' },
      text,
    },
  };
}

/** A controllable mock transport. `queues` is a list of getUpdates responses
 *  served in order (each subsequent call drains the next queued batch, then
 *  empties). Records every offset passed to getUpdates + every sendMessage. */
function makeMockTransport(queues: TelegramUpdate[][]): {
  transport: TelegramTransport;
  getUpdatesOffsets: number[];
  sent: Array<{ chatId: string | number; text: string }>;
} {
  const getUpdatesOffsets: number[] = [];
  const sent: Array<{ chatId: string | number; text: string }> = [];
  let call = 0;
  const transport: TelegramTransport = {
    async getUpdates(offset: number): Promise<TelegramUpdate[]> {
      getUpdatesOffsets.push(offset);
      const batch = queues[call] ?? [];
      call += 1;
      return batch;
    },
    async sendMessage(chatId: string | number, text: string): Promise<void> {
      sent.push({ chatId, text });
    },
  };
  return { transport, getUpdatesOffsets, sent };
}

/** Reset every MockProvider static this suite touches so the known
 *  static-pollution flake can't bleed across tests in the shared Bun process. */
function resetMockProviderStatics(): void {
  MockProvider.toolUseMode = false;
  MockProvider.stallMode = false;
  MockProvider.toolUseScript = undefined;
  MockProvider.resetScriptCursor();
  MockProvider.lastMessages = undefined;
  MockProvider.streamCalls = 0;
}

async function buildTestRuntime(home: string): Promise<Runtime> {
  return buildRuntime({
    cwd: home,
    harnessHome: home,
    provider: 'mock',
    model: 'mock-haiku',
    preflight: false,
    cronEnabled: false,
  });
}

describe('createTelegramListener — getUpdates long-poll adapter', () => {
  let home: string;
  let runtime: Runtime;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'sov-channels-telegram-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    // Isolate the session DB per test (buildRuntime opens HARNESS_HOME/sessions.db).
    process.env.HARNESS_HOME = home;
    resetMockProviderStatics();
    runtime = await buildTestRuntime(home);
  });

  afterEach(async () => {
    await runtime.dispose();
    resetMockProviderStatics();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.HARNESS_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  test('canned update → maps to InboundMessage, runs the turn, sends the reply', async () => {
    const { transport, sent } = makeMockTransport([[privateUpdate(100)]]);
    const listener = createTelegramListener({
      runtime,
      botToken: TOKEN,
      principalId: PRINCIPAL,
      transport,
    });

    await listener.pollOnce();

    // The default MockProvider reply is "Hello world." — delivered to chat 42.
    expect(sent).toEqual([{ chatId: 42, text: 'Hello world.' }]);

    // The pipeline sourced a session under the mapped InboundMessage, owned by
    // the principal, platform 'telegram' (proves the msg mapping + principalId
    // + posture flowed into runChannelTurn).
    const mapped: InboundMessage = {
      channel: 'telegram',
      sender: '42',
      chatId: '42',
      chatType: 'private',
      text: 'hi',
    };
    const row = runtime.sessionDb.getSession(buildSessionKey(mapped));
    expect(row).not.toBeNull();
    expect(row?.ownerId).toBe(PRINCIPAL);
    expect(row?.platform).toBe('telegram');
  });

  test('offset advances — next getUpdates uses max(update_id)+1, no reprocessing', async () => {
    // First poll serves two updates (ids 100, 101); second poll serves nothing.
    const { transport, getUpdatesOffsets, sent } = makeMockTransport([
      [privateUpdate(100), privateUpdate(101)],
      [],
    ]);
    const listener = createTelegramListener({
      runtime,
      botToken: TOKEN,
      principalId: PRINCIPAL,
      transport,
    });

    await listener.pollOnce();
    await listener.pollOnce();

    // First call started at offset 0; second call used max(100,101)+1 = 102.
    expect(getUpdatesOffsets).toEqual([0, 102]);
    // Both updates produced a send; the second poll (empty) added nothing.
    expect(sent.length).toBe(2);
  });

  test('silent — a [SILENT]-prefixed reply does NOT call sendMessage', async () => {
    MockProvider.toolUseScript = [{ kind: 'text', text: '[SILENT] internal note' }];
    MockProvider.resetScriptCursor();

    const { transport, sent } = makeMockTransport([[privateUpdate(200)]]);
    const listener = createTelegramListener({
      runtime,
      botToken: TOKEN,
      principalId: PRINCIPAL,
      transport,
    });

    await listener.pollOnce();

    expect(sent).toEqual([]);
  });

  test('silent — an empty reply does NOT call sendMessage', async () => {
    MockProvider.toolUseScript = [{ kind: 'text', text: '   ' }];
    MockProvider.resetScriptCursor();

    const { transport, sent } = makeMockTransport([[privateUpdate(201)]]);
    const listener = createTelegramListener({
      runtime,
      botToken: TOKEN,
      principalId: PRINCIPAL,
      transport,
    });

    await listener.pollOnce();

    expect(sent).toEqual([]);
  });

  test('skip — non-message update (no message field) runs no turn and sends nothing', async () => {
    const noMessage: TelegramUpdate = { update_id: 300 };
    const { transport, sent } = makeMockTransport([[noMessage]]);
    const listener = createTelegramListener({
      runtime,
      botToken: TOKEN,
      principalId: PRINCIPAL,
      transport,
    });

    await listener.pollOnce();

    expect(sent).toEqual([]);
    expect(MockProvider.streamCalls).toBe(0);
  });

  test('skip — a message with no text runs no turn and sends nothing', async () => {
    const noText: TelegramUpdate = {
      update_id: 301,
      message: { message_id: 1, from: { id: 42 }, chat: { id: 42, type: 'private' } },
    };
    const { transport, sent } = makeMockTransport([[noText]]);
    const listener = createTelegramListener({
      runtime,
      botToken: TOKEN,
      principalId: PRINCIPAL,
      transport,
    });

    await listener.pollOnce();

    expect(sent).toEqual([]);
    expect(MockProvider.streamCalls).toBe(0);
  });

  test("skip — the bot's own messages (from.is_bot) run no turn and send nothing", async () => {
    const fromBot: TelegramUpdate = {
      update_id: 302,
      message: {
        message_id: 1,
        from: { id: 999, is_bot: true },
        chat: { id: 42, type: 'private' },
        text: 'echo from myself',
      },
    };
    const { transport, sent } = makeMockTransport([[fromBot]]);
    const listener = createTelegramListener({
      runtime,
      botToken: TOKEN,
      principalId: PRINCIPAL,
      transport,
    });

    await listener.pollOnce();

    expect(sent).toEqual([]);
    expect(MockProvider.streamCalls).toBe(0);
  });

  test('resilience — one throwing update does not abort the batch; offset still advances', async () => {
    // Two updates: the first maps to a message whose turn we force to throw
    // (throwOnNext), the second processes normally. Per-update try/catch must
    // let the second one through, and the offset must still advance past both.
    const { transport, getUpdatesOffsets, sent } = makeMockTransport([
      [privateUpdate(400, 'boom'), privateUpdate(401, 'ok')],
      [],
    ]);
    // The MockProvider throws on the FIRST stream() call only.
    MockProvider.throwOnNext = new Error('provider boom');

    const listener = createTelegramListener({
      runtime,
      botToken: TOKEN,
      principalId: PRINCIPAL,
      transport,
    });

    await listener.pollOnce();
    await listener.pollOnce();

    // The first update threw (no send), the second succeeded (one send).
    expect(sent.length).toBe(1);
    // Offset advanced past BOTH updates despite the first throwing.
    expect(getUpdatesOffsets).toEqual([0, 402]);
  });

  test("start() arms an unref'd poll loop; firing the tick polls; stop() halts it", async () => {
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    let capturedFn: (() => void) | undefined;
    let capturedMs: number | undefined;
    let unrefCalled = false;
    let cleared = false;
    const fakeTimer = {
      unref(): typeof fakeTimer {
        unrefCalled = true;
        return fakeTimer;
      },
    } as unknown as ReturnType<typeof setInterval>;
    // biome-ignore lint/suspicious/noExplicitAny: test seam to capture scheduling.
    (globalThis as any).setInterval = (
      fn: () => void,
      ms: number,
    ): ReturnType<typeof setInterval> => {
      capturedFn = fn;
      capturedMs = ms;
      return fakeTimer;
    };
    // biome-ignore lint/suspicious/noExplicitAny: test seam to observe clear.
    (globalThis as any).clearInterval = (t: unknown): void => {
      if (t === fakeTimer) cleared = true;
    };

    try {
      const { transport, getUpdatesOffsets, sent } = makeMockTransport([[privateUpdate(500)], []]);
      const listener = createTelegramListener({
        runtime,
        botToken: TOKEN,
        principalId: PRINCIPAL,
        transport,
        pollIntervalMs: 9_876,
      });

      listener.start();
      expect(capturedMs).toBe(9_876);
      expect(unrefCalled).toBe(true);
      expect(capturedFn).toBeDefined();

      // Fire the captured tick fn → it triggers one poll (fire-and-forget).
      capturedFn?.();
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(sent).toEqual([{ chatId: 42, text: 'Hello world.' }]);

      // Double-start guard: a second start() must not schedule again.
      capturedMs = undefined;
      listener.start();
      expect(capturedMs).toBeUndefined();

      // stop() clears the interval; no further getUpdates after the captured fn
      // is no longer fired.
      listener.stop();
      expect(cleared).toBe(true);
      const offsetsAfterStop = getUpdatesOffsets.length;
      // Nothing fires the timer now, so no further getUpdates calls accrue.
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(getUpdatesOffsets.length).toBe(offsetsAfterStop);
    } finally {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    }
  });
});

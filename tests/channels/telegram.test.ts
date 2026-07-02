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
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import {
  type TelegramTransport,
  type TelegramUpdate,
  createTelegramListener,
} from '../../src/channels/adapters/telegram.js';
import { buildChannelListeners } from '../../src/channels/listeners.js';
import { buildSessionKey } from '../../src/channels/sessionKey.js';
import type { InboundMessage } from '../../src/channels/types.js';
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
  // FIX 4 tests toggle slowMode to keep a turn observably in flight; reset it
  // so it can't leak into the other tests in this shared Bun process.
  MockProvider.slowMode = false;
  MockProvider.slowModeDelayMs = 0;
  MockProvider.throwOnNext = undefined;
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

    // Pipeline Fix 2(b): a provider error no longer yields pure silence — the
    // turn returns a user-facing fallback reply, so the throwing update DOES
    // send (a "please try again" message) rather than dropping silently. The
    // second update succeeds normally → TWO sends total. The resilience point
    // still holds: the throwing update didn't abort the batch.
    expect(sent.length).toBe(2);
    // The first send is the error fallback; the second is the real reply.
    expect(sent[0]?.text).toContain('try again');
    expect(sent[1]?.text).toBe('Hello world.');
    // Offset advanced past BOTH updates despite the first throwing.
    expect(getUpdatesOffsets).toEqual([0, 402]);
  });

  // Fix F4(b) — a getUpdates failure (bad token / network) must NOT become an
  // unhandled rejection on every tick. pollOnce must RESOLVE (not throw), log
  // ONE actionable line, and keep the loop alive.
  test('resilience — a getUpdates rejection resolves pollOnce and logs an actionable line', async () => {
    const failing: TelegramTransport = {
      async getUpdates(): Promise<TelegramUpdate[]> {
        throw new Error('Unauthorized');
      },
      async sendMessage(): Promise<void> {},
    };
    const logged: string[] = [];
    const listener = createTelegramListener({
      runtime,
      botToken: TOKEN,
      principalId: PRINCIPAL,
      transport: failing,
      log: (m) => logged.push(m),
    });

    // Must not reject (no unhandled rejection).
    await expect(listener.pollOnce()).resolves.toBeUndefined();
    // One concise, actionable line that does NOT leak the token.
    expect(logged.length).toBeGreaterThanOrEqual(1);
    const line = logged.join('\n');
    expect(line).toContain('telegram poll failed');
    expect(line).toContain('Unauthorized');
    expect(line).not.toContain(TOKEN);
  });

  // Fix F4(b) — after a failure the loop backs off (skips ticks) so a
  // persistent bad token doesn't spam at the poll cadence.
  test('resilience — failure triggers backoff (the tick skips getUpdates for a few ticks)', async () => {
    let calls = 0;
    const failing: TelegramTransport = {
      async getUpdates(): Promise<TelegramUpdate[]> {
        calls += 1;
        throw new Error('network down');
      },
      async sendMessage(): Promise<void> {},
    };
    const logged: string[] = [];
    const realSetInterval = globalThis.setInterval;
    let capturedFn: (() => void) | undefined;
    const fakeTimer = { unref: () => fakeTimer } as unknown as ReturnType<typeof setInterval>;
    // biome-ignore lint/suspicious/noExplicitAny: test seam to capture scheduling.
    (globalThis as any).setInterval = (fn: () => void): ReturnType<typeof setInterval> => {
      capturedFn = fn;
      return fakeTimer;
    };
    try {
      const listener = createTelegramListener({
        runtime,
        botToken: TOKEN,
        principalId: PRINCIPAL,
        transport: failing,
        log: (m) => logged.push(m),
        failureBackoffTicks: 3,
      });
      listener.start();
      // Tick 1: fires getUpdates → fails → arms a 3-tick backoff.
      capturedFn?.();
      await new Promise<void>((r) => setTimeout(r, 10));
      expect(calls).toBe(1);
      // Ticks 2–4 are skipped by the backoff (no further getUpdates).
      capturedFn?.();
      capturedFn?.();
      capturedFn?.();
      await new Promise<void>((r) => setTimeout(r, 10));
      expect(calls).toBe(1);
      // Tick 5: backoff elapsed → getUpdates fires again.
      capturedFn?.();
      await new Promise<void>((r) => setTimeout(r, 10));
      expect(calls).toBe(2);
    } finally {
      globalThis.setInterval = realSetInterval;
    }
  });

  // Fix F4(a) — the DEFAULT fetch transport must send a real long-poll
  // `timeout` in the getUpdates body (Telegram short-polls without it → a fixed
  // busy-poll). No injected transport here: we stub global fetch and inspect the
  // request the default client builds.
  test('default transport sends a long-poll timeout in the getUpdates body', async () => {
    const realFetch = globalThis.fetch;
    let captured: { url: string; body: unknown } | undefined;
    // biome-ignore lint/suspicious/noExplicitAny: test seam to capture the request.
    (globalThis as any).fetch = async (url: string, init: any): Promise<Response> => {
      captured = { url, body: JSON.parse(init.body as string) };
      return new Response(JSON.stringify({ ok: true, result: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    try {
      const listener = createTelegramListener({
        runtime,
        botToken: TOKEN,
        principalId: PRINCIPAL,
        // no transport → the default fetch client is used.
      });
      await listener.pollOnce();
      expect(captured).toBeDefined();
      expect(captured?.url).toContain('/getUpdates');
      const body = captured?.body as { offset?: number; timeout?: number };
      expect(typeof body.timeout).toBe('number');
      expect(body.timeout).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = realFetch;
    }
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

  // FIX 4 — the poll loop had no in-flight guard and advanced the offset only
  // AFTER awaiting the (slow) model turn. While a turn ran, every 1 s tick
  // re-getUpdates with the STALE offset → Telegram re-served the unconfirmed
  // update → a duplicate turn + reply (+ duplicate billed calls) per second.
  describe('FIX 4 — in-flight guard + offset-before-await', () => {
    test('advances the offset per-update BEFORE awaiting the turn (offset confirmed even if the turn throws)', async () => {
      // The offset must advance as each update is consumed, BEFORE its (awaited)
      // turn — so a processed update is never re-served even if the turn fails.
      // Two updates in one batch; the FIRST turn throws. Per-update advancement
      // must carry the offset past BOTH, and the second update still runs.
      MockProvider.throwOnNext = new Error('provider boom');

      const { transport, getUpdatesOffsets, sent } = makeMockTransport([
        [privateUpdate(100, 'boom'), privateUpdate(101, 'ok')],
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

      // Offset advanced past BOTH updates (max(100,101)+1 = 102) — neither is
      // re-served on the second poll. The throwing first update did not stall
      // the offset at 100.
      expect(getUpdatesOffsets).toEqual([0, 102]);
      // The second (good) update still produced a reply; the first surfaced the
      // error-fallback reply (pipeline behavior) — both processed exactly once.
      expect(sent.length).toBe(2);
      expect(sent[1]?.text).toBe('Hello world.');
    });

    test('overlapping polls do not double-process the same update (in-flight guard)', async () => {
      // Two concurrent pollOnce calls: the second begins while the first is
      // still mid-turn. Without the guard both would fetch the SAME stale
      // offset 0 and re-serve update 100 twice → two sends + two getUpdates.
      // The in-flight guard must make the overlapping call a no-op → ONE send,
      // ONE getUpdates. (We await both promises so the slow turn finishes before
      // afterEach disposes the runtime — no closed-DB race.)
      MockProvider.slowMode = true;
      MockProvider.slowModeDelayMs = 15;

      const { transport, sent, getUpdatesOffsets } = makeMockTransport([
        [privateUpdate(100)],
        [privateUpdate(100)], // a second fetch at the same offset re-serves it
      ]);
      const listener = createTelegramListener({
        runtime,
        botToken: TOKEN,
        principalId: PRINCIPAL,
        transport,
      });

      // Poll 1 starts (fetches batch, begins the slow turn) but isn't awaited.
      const poll1 = listener.pollOnce();
      await new Promise<void>((r) => setTimeout(r, 5));
      // Poll 2 fires WHILE poll 1's turn is in flight — the guard skips it.
      const poll2 = listener.pollOnce();
      await Promise.all([poll1, poll2]);

      // Exactly one update processed → exactly one send. No duplicate turn.
      expect(sent.length).toBe(1);
      expect(sent[0]).toEqual({ chatId: 42, text: 'Hello world.' });
      // The guard meant only ONE getUpdates fired during the overlap window.
      expect(getUpdatesOffsets).toEqual([0]);
    });

    test('a processed update is not re-served on the next (post-turn) poll', async () => {
      // Sequential polls (no overlap): after processing update 100, the next
      // getUpdates must use offset 101 so Telegram never re-serves 100.
      const { transport, getUpdatesOffsets, sent } = makeMockTransport([[privateUpdate(100)], []]);
      const listener = createTelegramListener({
        runtime,
        botToken: TOKEN,
        principalId: PRINCIPAL,
        transport,
      });

      await listener.pollOnce();
      await listener.pollOnce();

      expect(getUpdatesOffsets).toEqual([0, 101]);
      expect(sent.length).toBe(1);
    });
  });

  // Fix #20 (L3/L4) — shutdown drain. stop() must AWAIT the in-flight pollOnce
  // before resolving, so the gateway's `await listeners.stop()` → runtime.dispose()
  // ordering guarantees no live turn's DB writes can outlive sessionDb.close().
  // Previously stop() only clearInterval()'d (synchronous) and could not drain.
  describe('Fix #20 — stop() drains the in-flight poll before resolving', () => {
    test('stop() does not resolve until a mid-turn pollOnce completes', async () => {
      // Keep the model turn observably in flight so stop() has something to drain.
      MockProvider.slowMode = true;
      MockProvider.slowModeDelayMs = 30;

      const { transport, sent } = makeMockTransport([[privateUpdate(100)]]);
      const listener = createTelegramListener({
        runtime,
        botToken: TOKEN,
        principalId: PRINCIPAL,
        transport,
      });

      // Start the poll (fetches the batch, begins the slow turn) without awaiting.
      const poll = listener.pollOnce();
      // Let the turn get underway but not finish.
      await new Promise<void>((r) => setTimeout(r, 5));
      // At this point the slow turn has not sent its reply yet.
      expect(sent.length).toBe(0);

      // stop() MUST drain the in-flight poll: when it resolves, the turn is done
      // and the reply has been delivered. With the pre-fix synchronous stop()
      // this returns immediately and the send has NOT happened yet → FAIL.
      await listener.stop();
      expect(sent.length).toBe(1);
      expect(sent[0]).toEqual({ chatId: 42, text: 'Hello world.' });

      // The original poll promise is already settled by the time stop() resolved.
      await poll;
    });

    test('stop() is idempotent and resolves with no in-flight poll', async () => {
      const { transport } = makeMockTransport([[]]);
      const listener = createTelegramListener({
        runtime,
        botToken: TOKEN,
        principalId: PRINCIPAL,
        transport,
      });
      listener.start();
      // No poll in flight → stop() resolves promptly; a second stop() is a no-op.
      await expect(listener.stop()).resolves.toBeUndefined();
      await expect(listener.stop()).resolves.toBeUndefined();
    });
  });
});

// Fix #20 — the buildChannelListeners aggregator must AWAIT each worker's
// (async) stop() so the gateway's `await listeners.stop()` actually drains the
// Telegram poll loop before runtime.dispose() closes the DB.
describe('buildChannelListeners — stop() awaits each worker drain', () => {
  let home: string;
  let runtime: Runtime;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'sov-channels-tg-listeners-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
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

  test('listeners.stop() drains an in-flight Telegram turn before resolving', async () => {
    MockProvider.slowMode = true;
    MockProvider.slowModeDelayMs = 30;

    const { transport, sent } = makeMockTransport([[privateUpdate(700)]]);
    // A tiny poll cadence so the armed timer fires its first (slow) poll quickly;
    // slowMode keeps that turn in flight while we call stop().
    const listeners = buildChannelListeners(
      runtime,
      { telegram: { enabled: true, botToken: TOKEN, principalId: PRINCIPAL } },
      { telegramTransport: transport, pollIntervalMs: 2 },
    );

    listeners.start();
    // Let the armed timer's first tick fire the slow poll and get mid-turn.
    await new Promise<void>((r) => setTimeout(r, 8));
    // The slow turn has not sent its reply yet.
    expect(sent.length).toBe(0);

    // stop() returns a Promise (async contract) and must drain the in-flight poll
    // before resolving — proving the aggregator awaits each worker's async stop().
    const result = listeners.stop();
    expect(result).toBeInstanceOf(Promise);
    await result;
    expect(sent.length).toBe(1);
    // privateUpdate hardcodes chat.id 42 regardless of update_id; the point is
    // the in-flight turn finished + delivered before stop() resolved.
    expect(sent[0]).toEqual({ chatId: 42, text: 'Hello world.' });
  });
});

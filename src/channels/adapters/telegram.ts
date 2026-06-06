// Phase F-T5 — the Telegram adapter (long-poll getUpdates, injectable transport).
//
// Telegram needs no public endpoint: instead of receiving a webhook, the adapter
// long-polls the Bot API's `getUpdates` and drives ONE headless channel turn per
// usable text message, then `sendMessage`s the non-silent reply back to the
// originating chat. It mirrors the cron/supervisor background-loop pattern: a
// guarded `start()` arms an unref'd `setInterval` that fires `pollOnce()`, and
// `stop()` clears it.
//
// The whole adapter is built against an INJECTABLE {@link TelegramTransport} so
// it's fully testable with no live bot token. In production the caller (F-T7)
// resolves the bot token (env-first) and passes it in; this module's default
// transport is a thin `fetch`-based Bot API client. The token is NEVER logged.
//
// Per-update resilience: each update is handled inside its own try/catch so a
// single malformed update (or a turn that throws) can't kill the batch or the
// poll loop. The offset still advances past every update in the batch
// (max(update_id)+1) so a poisonous update is not reprocessed forever.

import type { Runtime } from '../../server/runtime.js';
import { runChannelTurn } from '../pipeline.js';
import type { InboundMessage } from '../types.js';

/** Default poll cadence (ms). The Bot API long-poll itself can hold the
 *  connection open server-side; this is the floor between our own ticks. */
const DEFAULT_POLL_INTERVAL_MS = 1_000;

/** The minimal subset of the Telegram Bot API `Update` shape we consume. Only
 *  the fields the adapter reads are typed; the rest of the wire object is
 *  ignored. (Mirrors the doc'd subset in the task brief.) */
export type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; username?: string; is_bot?: boolean };
    chat: { id: number; type: string };
    text?: string;
  };
};

/** The transport seam the adapter drives. The default implementation
 *  ({@link createDefaultTransport}) talks to the live Bot API over `fetch`;
 *  tests inject a mock. */
export interface TelegramTransport {
  /** Fetch updates with `update_id >= offset` (Telegram's long-poll cursor). */
  getUpdates(offset: number): Promise<TelegramUpdate[]>;
  /** Post a text reply to a chat. */
  sendMessage(chatId: string | number, text: string): Promise<void>;
}

export type CreateTelegramListenerOpts = {
  runtime: Runtime;
  /** The resolved bot token (env-first resolution is the caller's job, F-T7).
   *  Used only to construct the default fetch transport; NEVER logged. */
  botToken: string;
  /** The Phase-E principal that owns every session this channel sources. */
  principalId: string;
  /** Channel permission posture. Defaults to 'default' in the pipeline. */
  permissionMode?: 'default' | 'ask';
  /** Inject a transport (tests). Omitted in production → the default fetch
   *  client to api.telegram.org. */
  transport?: TelegramTransport;
  /** Override the poll cadence (ms). Defaults to {@link DEFAULT_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number;
};

export type TelegramListener = {
  /** Arm the background poll loop. Guards double-start; the timer is unref'd so
   *  it never holds the process open on its own. */
  start(): void;
  /** Disarm the background poll loop. Idempotent. */
  stop(): void;
  /** Run one poll tick: getUpdates(offset) → per-update turn + send → advance
   *  offset. Exposed for tests + a future on-demand drain. */
  pollOnce(): Promise<void>;
};

/** `[silent]` / empty replies are handled by the pipeline (it returns
 *  `{ silent: true }`); the adapter simply skips the send in that case. */

/** Map a Telegram update to an InboundMessage, or null when it isn't a usable
 *  text message we should act on. Skips:
 *    - non-message updates (no `message` field — edited_channel_post, etc.);
 *    - messages with no `text` (stickers, photos, service messages);
 *    - the bot's OWN messages (`from.is_bot === true`) to avoid echo loops.
 *  chatId + sender are the Telegram numeric ids stringified (so the session key
 *  is stable + a string like every other channel). */
function mapUpdateToInbound(update: TelegramUpdate): InboundMessage | null {
  const message = update.message;
  if (message === undefined) return null;
  if (message.from?.is_bot === true) return null;
  const text = message.text;
  if (typeof text !== 'string' || text.length === 0) return null;

  const senderId = message.from?.id;
  const chatId = String(message.chat.id);
  const chatType =
    message.chat.type === 'private'
      ? 'private'
      : message.chat.type === 'channel'
        ? 'channel'
        : 'group';

  return {
    channel: 'telegram',
    sender: senderId !== undefined ? String(senderId) : chatId,
    chatId,
    chatType,
    text,
    raw: update,
  };
}

/** The default fetch-based Bot API transport. Only used in production (tests
 *  inject a mock). The token is interpolated into the request URL — standard
 *  Bot API auth — and is NEVER logged. */
function createDefaultTransport(botToken: string): TelegramTransport {
  const base = `https://api.telegram.org/bot${botToken}`;
  return {
    async getUpdates(offset: number): Promise<TelegramUpdate[]> {
      const res = await fetch(`${base}/getUpdates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ offset }),
      });
      if (!res.ok) {
        // Don't leak the token-bearing URL in the error.
        throw new Error(`telegram getUpdates failed: HTTP ${res.status}`);
      }
      const body = (await res.json()) as { ok?: boolean; result?: TelegramUpdate[] };
      if (body.ok !== true || !Array.isArray(body.result)) {
        throw new Error('telegram getUpdates returned a non-ok payload');
      }
      return body.result;
    },
    async sendMessage(chatId: string | number, text: string): Promise<void> {
      const res = await fetch(`${base}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      if (!res.ok) {
        throw new Error(`telegram sendMessage failed: HTTP ${res.status}`);
      }
    },
  };
}

/** Construct a Telegram listener. See the module header for the contract. */
export function createTelegramListener(opts: CreateTelegramListenerOpts): TelegramListener {
  const { runtime, principalId } = opts;
  const permissionMode = opts.permissionMode;
  const transport = opts.transport ?? createDefaultTransport(opts.botToken);
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  // The long-poll cursor: the next getUpdates asks for update_id >= offset.
  let offset = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function handleUpdate(update: TelegramUpdate): Promise<void> {
    const msg = mapUpdateToInbound(update);
    // Non-actionable update (non-message / no text / bot's own): skip silently —
    // no turn, no send. The offset still advances (handled by the caller).
    if (msg === null) return;

    const result = await runChannelTurn({
      runtime,
      msg,
      principalId,
      ...(permissionMode !== undefined ? { permissionMode } : {}),
    });

    // Silent verdict (empty reply or a [SILENT] prefix) → deliver nothing.
    if (result.silent === true || result.text === undefined || result.text.length === 0) {
      return;
    }
    await transport.sendMessage(update.message?.chat.id ?? msg.chatId, result.text);
  }

  async function pollOnce(): Promise<void> {
    const updates = await transport.getUpdates(offset);
    let maxUpdateId = -1;
    for (const update of updates) {
      // Advance the cursor past EVERY update in the batch — even ones that
      // throw or are skipped — so a poisonous update isn't reprocessed forever.
      if (update.update_id > maxUpdateId) maxUpdateId = update.update_id;
      try {
        await handleUpdate(update);
      } catch (err) {
        // One bad update must not kill the batch or the loop. Log without the
        // bot token (it's never part of the message anyway).
        const detail = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[telegram] update ${update.update_id} failed: ${detail}\n`);
      }
    }
    if (maxUpdateId >= 0) offset = maxUpdateId + 1;
  }

  function start(): void {
    if (timer !== null) return;
    const t = setInterval(() => {
      void pollOnce();
    }, pollIntervalMs);
    // Don't hold the process open just for the poll loop — the gateway always
    // has another live handle (HTTP server) and tests want a clean exit.
    t.unref?.();
    timer = t;
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, pollOnce };
}

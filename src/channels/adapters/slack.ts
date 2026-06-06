// Phase F-T6 — the Slack Events API adapter (signing-secret verify, injectable
// transport).
//
// Slack delivers every subscribed event to a SINGLE public endpoint and
// authenticates each request with an HMAC-SHA256 signature over the RAW body
// keyed by the app's signing secret (NOT a per-message bearer token). The
// adapter owns three pure pieces so the gateway route (routes/channels.ts) stays
// a thin orchestrator:
//
//   * verifySlackSignature — authenticate the request. The signed payload is the
//     literal string `v0:${timestamp}:${rawBody}`; the presented header is
//     `X-Slack-Signature: v0=<hex>`. Compared CONSTANT-TIME. A timestamp more
//     than {@link REPLAY_WINDOW_SECS} from now is rejected as a replay even when
//     the HMAC is otherwise valid. Returns false (never throws) on a missing /
//     malformed / stale input so the route maps it straight to 403.
//   * parseSlackBody — classify the JSON body: the one-time url_verification
//     handshake (→ { kind:'challenge', challenge }), a usable user message event
//     (→ { kind:'event', message, eventId }), or anything we ignore (bot's own
//     message, a non-message event, a malformed body) (→ { kind:'ignore' }).
//   * createSlackDedupe — a bounded seen-set of `event_id`s. Slack retries an
//     unACK'd (or slow) delivery at-least-once; deduping by event_id keeps the
//     turn from running twice for one user message.
//
// Delivery seam: {@link SlackTransport} is injectable so the whole adapter is
// testable with no live Slack app (the live app is a documented setup step). The
// default transport posts to chat.postMessage with the bot token over `fetch`.
//
// SECURITY: the signing secret + bot token are NEVER logged or echoed; verify
// runs BEFORE any parse or turn so an unsigned / forged / replayed request
// triggers no side-effect (no session, no model call, no post).

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { InboundMessage } from '../types.js';

/** Replay window (seconds). A request whose `X-Slack-Request-Timestamp` is more
 *  than this far from the current clock — in either direction — is rejected.
 *  Slack's own recommended value. */
const REPLAY_WINDOW_SECS = 300;

/** Default cap on the dedupe set so a long-lived gateway can't grow it
 *  unbounded. Once exceeded, the oldest-inserted ids are evicted (insertion
 *  order = Set iteration order). Generous vs Slack's real retry cadence. */
const DEFAULT_DEDUPE_MAX = 4096;

/** The transport seam the adapter drives to post a reply back to Slack. The
 *  default implementation ({@link createDefaultSlackTransport}) calls
 *  chat.postMessage with the bot token over `fetch`; tests inject a mock. */
export interface SlackTransport {
  /** Post a text reply into a Slack channel/DM (`channel` is the Slack channel
   *  id, e.g. `C…` / `D…`). */
  postMessage(channel: string, text: string): Promise<void>;
}

/** Inputs to {@link verifySlackSignature}. `timestamp` + `signature` come from
 *  the `X-Slack-Request-Timestamp` / `X-Slack-Signature` headers (may be
 *  absent); `rawBody` is the EXACT request bytes that were signed. `nowMs`
 *  overrides the clock for deterministic tests. */
export type VerifySlackSignatureInput = {
  /** The RAW request body bytes as a string — the exact payload Slack signed.
   *  Must NOT be re-serialized from parsed JSON (the bytes would change). */
  rawBody: string;
  /** The `X-Slack-Request-Timestamp` header (unix SECONDS as a string). */
  timestamp: string | undefined | null;
  /** The `X-Slack-Signature` header, expected as `v0=<hex>`. */
  signature: string | undefined | null;
  /** The app's signing secret. */
  signingSecret: string;
  /** Override the clock (ms since epoch) for tests. Defaults to Date.now(). */
  nowMs?: number;
};

/** Verify a Slack request signature in constant time, with a replay window.
 *
 *  Computes `HMAC-SHA256(signingSecret, 'v0:' + timestamp + ':' + rawBody)` as
 *  hex and compares it constant-time against the `v0=<hex>` header. Returns
 *  false (never throws) on a missing/malformed signature, a missing/non-numeric
 *  timestamp, an empty signing secret, a timestamp outside the
 *  {@link REPLAY_WINDOW_SECS} window, or any HMAC mismatch — the route maps a
 *  false verdict to 403. The comparison is length-checked first (timingSafeEqual
 *  throws on unequal-length buffers); a length mismatch leaks nothing about the
 *  secret. */
export function verifySlackSignature(input: VerifySlackSignatureInput): boolean {
  const { rawBody, timestamp, signature, signingSecret } = input;
  if (signingSecret.length === 0) return false;
  if (typeof signature !== 'string' || signature.length === 0) return false;
  if (typeof timestamp !== 'string' || timestamp.length === 0) return false;

  // Replay window: reject a stale (or far-future) timestamp before doing any
  // HMAC work. The timestamp must be an integer count of seconds.
  const tsSecs = Number(timestamp);
  if (!Number.isFinite(tsSecs)) return false;
  const nowSecs = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSecs - tsSecs) > REPLAY_WINDOW_SECS) return false;

  // Accept only the explicit `v0=<hex>` scheme. Anything else is malformed.
  const match = /^v0=([0-9a-fA-F]+)$/.exec(signature.trim());
  if (match === null || match[1] === undefined) return false;
  const presentedHex = match[1].toLowerCase();

  const base = `v0:${timestamp}:${rawBody}`;
  const expectedHex = createHmac('sha256', signingSecret).update(base).digest('hex');

  // Constant-time compare. timingSafeEqual requires equal-length buffers, so
  // guard the length first (a hex-length mismatch is itself a non-match).
  if (presentedHex.length !== expectedHex.length) return false;
  return timingSafeEqual(Buffer.from(presentedHex, 'hex'), Buffer.from(expectedHex, 'hex'));
}

/** The classification {@link parseSlackBody} returns. */
export type ParsedSlackBody =
  | { kind: 'challenge'; challenge: string }
  | { kind: 'event'; message: InboundMessage; eventId?: string }
  | { kind: 'ignore' };

/** The minimal subset of the Slack Events API envelope we consume. Only the
 *  fields the adapter reads are typed; the rest of the wire object is ignored. */
type SlackEnvelope = {
  type?: unknown;
  challenge?: unknown;
  event_id?: unknown;
  event?: {
    type?: unknown;
    subtype?: unknown;
    user?: unknown;
    channel?: unknown;
    channel_type?: unknown;
    text?: unknown;
    bot_id?: unknown;
  };
};

/** Map a Slack `channel_type` to the InboundMessage chatType. Slack DMs are
 *  `im` (and `mpim` for group DMs); public/private channels are
 *  `channel`/`group`. Default to 'channel' for anything unrecognized. */
function mapChatType(channelType: unknown): InboundMessage['chatType'] {
  if (channelType === 'im') return 'private';
  if (channelType === 'mpim' || channelType === 'group') return 'group';
  return 'channel';
}

/** Classify a parsed Slack JSON body. See the module header for the contract.
 *
 *  - url_verification with a string `challenge` → { kind:'challenge' }.
 *  - event_callback carrying a usable `message` event → { kind:'event' } with
 *    the InboundMessage (channel 'slack', sender=event.user, chatId=event.channel,
 *    chatType mapped from channel_type) + the `event_id` for dedupe.
 *  - everything else (bot's own message [bot_id present or subtype
 *    'bot_message'], a non-message event, a missing user/channel/text, a
 *    malformed body) → { kind:'ignore' }. */
export function parseSlackBody(body: unknown): ParsedSlackBody {
  if (typeof body !== 'object' || body === null) return { kind: 'ignore' };
  const env = body as SlackEnvelope;

  if (env.type === 'url_verification') {
    return typeof env.challenge === 'string'
      ? { kind: 'challenge', challenge: env.challenge }
      : { kind: 'ignore' };
  }

  if (env.type !== 'event_callback') return { kind: 'ignore' };
  const event = env.event;
  if (typeof event !== 'object' || event === null) return { kind: 'ignore' };

  // Only act on user message events. Skip the bot's OWN messages (bot_id set or
  // subtype 'bot_message') to avoid echo loops, and any non-message event.
  if (event.type !== 'message') return { kind: 'ignore' };
  if (typeof event.bot_id === 'string' && event.bot_id.length > 0) return { kind: 'ignore' };
  if (event.subtype === 'bot_message') return { kind: 'ignore' };

  const user = event.user;
  const channel = event.channel;
  const text = event.text;
  if (typeof user !== 'string' || user.length === 0) return { kind: 'ignore' };
  if (typeof channel !== 'string' || channel.length === 0) return { kind: 'ignore' };
  if (typeof text !== 'string' || text.length === 0) return { kind: 'ignore' };

  const message: InboundMessage = {
    channel: 'slack',
    sender: user,
    chatId: channel,
    chatType: mapChatType(event.channel_type),
    text,
    raw: body,
  };
  const eventId = typeof env.event_id === 'string' ? env.event_id : undefined;
  return eventId !== undefined ? { kind: 'event', message, eventId } : { kind: 'event', message };
}

/** A bounded seen-set of Slack `event_id`s for retry dedupe. */
export type SlackDedupe = {
  /** True if this event id has already been marked. */
  seen(eventId: string): boolean;
  /** Record this event id as seen (evicting the oldest when over capacity). */
  mark(eventId: string): void;
};

/** Create a bounded {@link SlackDedupe}. `max` caps the retained ids; the
 *  oldest-inserted are evicted past the cap (Set preserves insertion order). */
export function createSlackDedupe(max: number = DEFAULT_DEDUPE_MAX): SlackDedupe {
  const seenIds = new Set<string>();
  return {
    seen(eventId: string): boolean {
      return seenIds.has(eventId);
    },
    mark(eventId: string): void {
      if (seenIds.has(eventId)) return;
      seenIds.add(eventId);
      while (seenIds.size > max) {
        const oldest = seenIds.values().next().value;
        if (oldest === undefined) break;
        seenIds.delete(oldest);
      }
    },
  };
}

/** The default fetch-based chat.postMessage transport. Only used in production
 *  (tests inject a mock). The bot token rides the Authorization header — never
 *  logged — and chat.postMessage's `ok:false` envelope is surfaced as an error
 *  without echoing the token. */
export function createDefaultSlackTransport(botToken: string): SlackTransport {
  return {
    async postMessage(channel: string, text: string): Promise<void> {
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `Bearer ${botToken}`,
        },
        body: JSON.stringify({ channel, text }),
      });
      if (!res.ok) {
        throw new Error(`slack chat.postMessage failed: HTTP ${res.status}`);
      }
      // Slack returns 200 with an { ok:false, error } envelope on logical
      // failures (bad channel, missing scope, …). Surface it without the token.
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (body.ok !== true) {
        throw new Error(`slack chat.postMessage returned not-ok: ${body.error ?? 'unknown'}`);
      }
    },
  };
}

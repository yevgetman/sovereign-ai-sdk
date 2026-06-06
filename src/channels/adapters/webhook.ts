// Phase F-T4 — the generic webhook adapter.
//
// The simplest, dependency-free channel: an inbound HTTP POST carrying a JSON
// body and an HMAC-SHA256 signature over the RAW request bytes. It proves the
// whole inbound→turn→outbound arc with nothing external to mock. Two pure
// pieces, both owned here so the gateway route stays a thin orchestrator:
//
//   * verifyWebhook  — authenticate the request. HMAC-SHA256 of the RAW body
//     keyed by the channel secret, compared CONSTANT-TIME against the presented
//     `sha256=<hex>` header. The raw bytes (not the parsed JSON) are the signed
//     payload — re-serializing parsed JSON would change the bytes and break the
//     signature. Returns false (never throws) on a missing/malformed header or a
//     mismatch, so the route maps it straight to 401.
//   * parseWebhook   — map the JSON body to an InboundMessage. Returns null on a
//     non-object body or a missing required field (sender / text), so the route
//     maps it to 400. `chatId` defaults to the sender; chatType is always
//     'private' for the generic webhook (v1 — richer routing is per-platform).
//
// SECURITY: the secret is never logged or echoed; verify runs BEFORE any parse
// or turn so an unsigned/forged request triggers no side-effect.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { InboundMessage } from '../types.js';

/** Inputs to {@link verifyWebhook}: the raw request body (the signed payload),
 *  the presented signature header, and the channel's shared secret. */
export type VerifyWebhookInput = {
  /** The RAW request body bytes as a string — the exact payload that was
   *  signed. Must NOT be re-serialized from parsed JSON (the bytes would
   *  change). */
  rawBody: string;
  /** The presented signature header value, expected as `sha256=<hex>`. May be
   *  undefined / null when the client omitted it. */
  signatureHeader: string | undefined | null;
  /** The channel's shared HMAC secret. */
  secret: string;
};

/** Verify an HMAC-SHA256 webhook signature in constant time.
 *
 *  Parses `sha256=<hex>` from the header, computes
 *  `HMAC-SHA256(secret, rawBody)` as hex, and compares the two constant-time.
 *  Returns false (never throws) on a missing/malformed header, an empty secret,
 *  or any mismatch — the route maps a false verdict to 401. The comparison is
 *  length-checked first (timingSafeEqual throws on unequal-length buffers); an
 *  attacker learning only "wrong length" leaks nothing about the secret. */
export function verifyWebhook(input: VerifyWebhookInput): boolean {
  const { rawBody, signatureHeader, secret } = input;
  if (typeof signatureHeader !== 'string' || signatureHeader.length === 0) return false;
  if (secret.length === 0) return false;

  // Accept only the explicit `sha256=<hex>` scheme. Anything else is malformed.
  const match = /^sha256=([0-9a-fA-F]+)$/.exec(signatureHeader.trim());
  if (match === null || match[1] === undefined) return false;
  const presentedHex = match[1].toLowerCase();

  const expectedHex = createHmac('sha256', secret).update(rawBody).digest('hex');

  // Constant-time compare. timingSafeEqual requires equal-length buffers, so
  // guard the length first (a hex-length mismatch is itself a non-match).
  if (presentedHex.length !== expectedHex.length) return false;
  return timingSafeEqual(Buffer.from(presentedHex, 'hex'), Buffer.from(expectedHex, 'hex'));
}

/** The minimal JSON body shape the generic webhook accepts. */
type WebhookBody = {
  sender?: unknown;
  text?: unknown;
  chatId?: unknown;
  threadId?: unknown;
};

/** Map a parsed webhook JSON body to an InboundMessage, or null when a required
 *  field is missing / mistyped.
 *
 *  Required: `sender` (non-empty string) and `text` (string). `chatId` defaults
 *  to the sender when absent (a 1:1 webhook conversation keys on the sender).
 *  `chatType` is always 'private' for the generic webhook (v1). A null return
 *  signals a 400 to the route. */
export function parseWebhook(body: unknown): InboundMessage | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as WebhookBody;
  if (typeof b.sender !== 'string' || b.sender.length === 0) return null;
  if (typeof b.text !== 'string') return null;
  const chatId = typeof b.chatId === 'string' && b.chatId.length > 0 ? b.chatId : b.sender;
  const msg: InboundMessage = {
    channel: 'webhook',
    sender: b.sender,
    chatId,
    chatType: 'private',
    text: b.text,
    raw: body,
  };
  if (typeof b.threadId === 'string' && b.threadId.length > 0) {
    msg.threadId = b.threadId;
  }
  return msg;
}

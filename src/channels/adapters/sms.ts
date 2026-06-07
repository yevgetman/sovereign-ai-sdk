// SMS channel adapter (provider: Twilio).
//
// SMS is the Slack adapter's shape (open webhook + signature verify + ack-fast-
// then-async reply via an injectable transport) PLUS the SMS-specific security
// model. A phone number is PUBLICLY TEXTABLE and SMS sender IDs can be spoofed,
// so the Twilio signature authenticates the TRANSPORT (the request came from
// Twilio) — NOT the SENDER. The sender gate is a separate explicit allow-list,
// owned by the route (routes/channels.ts), not here. This module owns the pure,
// independently-testable pieces so the route stays a thin orchestrator:
//
//   * verifySmsSignature — authenticate the request as Twilio's. Twilio's scheme
//     (VERIFIED against twilio.com/docs/usage/security + the twilio-node SDK at
//     build time): take the full request URL, append every POST parameter sorted
//     alphabetically by key (Unix case-sensitive) as `key + value` with NO
//     delimiters, HMAC-SHA1 that string keyed by the account AUTH TOKEN, base64-
//     encode, compare CONSTANT-TIME against the `X-Twilio-Signature` header.
//     Pinned by a known test vector in the test suite. Returns false (never
//     throws) on a missing/empty signature or token, or any mismatch → the route
//     maps a false verdict to 403.
//   * parseSmsBody — map the decoded form fields to an InboundMessage (channel
//     'sms', sender + chatId = From, chatType 'private', text = Body). The From
//     is validated as E.164-ish (`+` and digits) — it becomes a path-segment-
//     shaped part of the session key (a trace FILENAME), so a non-E.164 From is
//     rejected (null) at the SOURCE (the TraceWriter path sanitizer is the SINK
//     backstop). null → the route 400s with no turn.
//   * classifyKeyword — the mandatory SMS compliance classifier: STOP /
//     UNSUBSCRIBE / CANCEL / END / QUIT → 'stop'; START / UNSTOP → 'start';
//     HELP / INFO → 'help'; anything else → null. Case-insensitive + trimmed.
//   * the opt-out store — a small durable JSON file under
//     `<harnessHome>/channels/sms/optouts.json`, robust to a missing file, so an
//     opted-out number stays opted-out across restarts (D5).
//   * SmsTransport + the default Twilio Messages REST client — the delivery seam,
//     injectable so the whole adapter is testable with no live Twilio account.
//     The default POSTs to the Messages API with HTTP Basic auth (SID:authToken).
//
// SECURITY: the auth token is NEVER logged or echoed (not by verify, not by the
// transport, not by the opt-out store). Verification runs BEFORE any parse or
// turn (in the route) so an unsigned / forged request triggers no side-effect.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { InboundMessage } from '../types.js';

// ── signature verification ────────────────────────────────────────────────

/** Inputs to {@link verifySmsSignature}. `url` is the full public URL Twilio
 *  signed (protocol → end of query string); `params` is the DECODED POST field
 *  map; `signatureHeader` is the `X-Twilio-Signature` value (may be absent);
 *  `authToken` is the account auth token (the HMAC key). */
export type VerifySmsSignatureInput = {
  /** The full request URL Twilio signed (the URL it POSTed to). Behind a proxy
   *  this is the PUBLIC URL, reconstructed from forwarded headers by the route —
   *  not the gateway's internal URL. */
  url: string;
  /** The decoded inbound POST parameters (field name → value). */
  params: Record<string, string>;
  /** The presented `X-Twilio-Signature` header (base64). May be undefined/null
   *  when the client omitted it. */
  signatureHeader: string | undefined | null;
  /** The Twilio account auth token (the HMAC-SHA1 key). */
  authToken: string;
};

/** Build the exact string Twilio signs: the URL with every POST parameter,
 *  sorted alphabetically by key (Unix case-sensitive — `Array.prototype.sort`'s
 *  default code-unit order matches), appended as `key + value` with NO
 *  delimiters. VERIFIED against twilio-node's `getExpectedTwilioSignature`. */
function buildSignatureBase(url: string, params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
}

/** Verify a Twilio request signature in constant time.
 *
 *  Computes `base64(HMAC-SHA1(authToken, url + sorted(key+value)))` and compares
 *  it constant-time against the presented `X-Twilio-Signature`. Returns false
 *  (never throws) on a missing/empty signature, an empty auth token, or any
 *  mismatch — the route maps a false verdict to 403. The comparison is length-
 *  checked first (timingSafeEqual throws on unequal-length buffers); a length
 *  mismatch is itself a non-match and leaks nothing about the token. */
export function verifySmsSignature(input: VerifySmsSignatureInput): boolean {
  const { url, params, signatureHeader, authToken } = input;
  if (authToken.length === 0) return false;
  if (typeof signatureHeader !== 'string' || signatureHeader.length === 0) return false;

  const base = buildSignatureBase(url, params);
  const expected = createHmac('sha1', authToken)
    .update(Buffer.from(base, 'utf-8'))
    .digest('base64');

  const presentedBuf = Buffer.from(signatureHeader, 'utf-8');
  const expectedBuf = Buffer.from(expected, 'utf-8');
  if (presentedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(presentedBuf, expectedBuf);
}

// ── body parsing ──────────────────────────────────────────────────────────

/** Max length for an E.164-ish number. E.164 caps at 15 digits; we allow a
 *  generous 20 (+ an optional leading `+`) to be safe against shortcodes /
 *  alphanumeric-disabled senders while still bounding the session-key length. */
const MAX_NUMBER_LEN = 21;

/** E.164-ish allowlist for an inbound `From`: an optional leading `+` then 1–20
 *  digits. This is the SOURCE boundary against path traversal (the From becomes
 *  a path-segment-shaped part of the session key → a trace filename). It rejects
 *  separators / `..` / spaces / control chars by construction. (The TraceWriter
 *  path sanitizer is the SINK backstop; `+` is filesystem-safe and is sanitized
 *  there to `_` regardless, so the two boundaries compose.) */
const E164_RE = /^\+?[0-9]{1,20}$/;

/** True when `value` is a safe E.164-ish sender number (see {@link E164_RE}). */
export function isE164Number(value: string): boolean {
  if (value.length === 0 || value.length > MAX_NUMBER_LEN) return false;
  return E164_RE.test(value);
}

/** The minimal decoded-form shape parseSmsBody reads. Twilio POSTs more fields
 *  (To, MessageSid, AccountSid, NumMedia, …); only From + Body are consumed. */
type SmsForm = {
  From?: unknown;
  Body?: unknown;
};

/** Map a decoded Twilio inbound form to an InboundMessage, or null when From is
 *  missing/unsafe or Body is not a string.
 *
 *  - `sender` and `chatId` both = `From` (a 1:1 SMS conversation keys on the
 *    number); chatType is always 'private'; text = `Body`.
 *  - SECURITY: `From` is validated against {@link isE164Number} — a non-E.164
 *    number returns null → the route 400s with no turn.
 *  - `Body` may legitimately be empty (e.g. a media-only message); the pipeline's
 *    empty-text guard short-circuits an empty turn, so we accept any string here. */
export function parseSmsBody(form: unknown): InboundMessage | null {
  if (typeof form !== 'object' || form === null) return null;
  const f = form as SmsForm;
  if (typeof f.From !== 'string' || f.From.length === 0) return null;
  if (typeof f.Body !== 'string') return null;
  if (!isE164Number(f.From)) return null;
  return {
    channel: 'sms',
    sender: f.From,
    chatId: f.From,
    chatType: 'private',
    text: f.Body,
    raw: form,
  };
}

// ── sender allow-list gate ──────────────────────────────────────────────────

/** Resolve an inbound `From` to its mapped principal via the sender allow-list,
 *  or undefined when the sender is NOT allow-listed.
 *
 *  SECURITY (L1): uses `Object.hasOwn` rather than a bare `senders[from]` lookup
 *  so the gate is self-evidently safe regardless of what `from` contains — a
 *  `From` equal to an inherited prototype property name (`__proto__`,
 *  `constructor`, `toString`, `hasOwnProperty`, …) is NEVER treated as allow-
 *  listed, with no reliance on the E.164 regex upstream to neutralize such keys.
 *  Only an OWN, string-valued entry resolves. */
export function resolveSenderPrincipal(
  senders: Record<string, string>,
  from: string,
): string | undefined {
  if (!Object.hasOwn(senders, from)) return undefined;
  const principalId = senders[from];
  return typeof principalId === 'string' ? principalId : undefined;
}

// ── compliance keyword classification ───────────────────────────────────────

/** The mandatory SMS-compliance verdict {@link classifyKeyword} returns. */
export type SmsKeyword = 'stop' | 'start' | 'help';

const STOP_WORDS = new Set(['stop', 'unsubscribe', 'cancel', 'end', 'quit']);
const START_WORDS = new Set(['start', 'unstop']);
const HELP_WORDS = new Set(['help', 'info']);

/** Classify an inbound message body as an SMS compliance keyword, or null when
 *  it is a normal message. Case-insensitive + trimmed (the whole body must be
 *  the keyword — `STOP` opts out, but `please stop` is a normal message, matching
 *  Twilio's exact-keyword behavior). STOP/UNSUBSCRIBE/CANCEL/END/QUIT → 'stop';
 *  START/UNSTOP → 'start'; HELP/INFO → 'help'. */
export function classifyKeyword(text: string): SmsKeyword | null {
  const word = text.trim().toLowerCase();
  if (STOP_WORDS.has(word)) return 'stop';
  if (START_WORDS.has(word)) return 'start';
  if (HELP_WORDS.has(word)) return 'help';
  return null;
}

// ── durable opt-out store ───────────────────────────────────────────────────

/** On-disk shape of the opt-out store. A flat list of opted-out numbers. */
type OptOutFile = {
  optedOut: string[];
};

/** Resolve the opt-out file path under a harness home. */
function optOutPath(harnessHome: string): string {
  return join(harnessHome, 'channels', 'sms', 'optouts.json');
}

/** Read the set of opted-out numbers, robust to a missing/corrupt file (→ empty
 *  set). Never throws — a read failure must NOT block a turn or leak detail.
 *  Synchronous: reads are off the write path (the route checks isOptedOut inline)
 *  and a stale read across a concurrent write is harmless (worst case: one extra
 *  message before the opt-out lands; the write itself is serialized + atomic). */
export function readOptOuts(harnessHome: string): Set<string> {
  try {
    const text = readFileSync(optOutPath(harnessHome), 'utf-8');
    const parsed = JSON.parse(text) as OptOutFile;
    if (Array.isArray(parsed.optedOut)) {
      return new Set(parsed.optedOut.filter((n): n is string => typeof n === 'string'));
    }
    return new Set();
  } catch {
    return new Set();
  }
}

/** L2 — per-harness-home opt-out write serialization chain. Two STOPs from
 *  DIFFERENT numbers each do a read-modify-write of the SAME optouts.json; run
 *  concurrently (the route schedules them off independent inbound requests) a
 *  naive read-modify-write is last-writer-wins — both read the pre-write file,
 *  so one opt-out is lost. We serialize every mutation onto a per-home promise
 *  chain so each read-modify-write sees the prior write's result. Mirrors
 *  `serializePerSession` in pipeline.ts. Module-level so it spans every caller in
 *  a process. The map slot is reclaimed when its chain drains (no unbounded
 *  growth). */
const optOutWriteChains = new Map<string, Promise<unknown>>();

/** Run `task` after any in-flight opt-out write for `harnessHome` completes,
 *  chaining the next caller behind this one (settle-on-either-path so a thrown
 *  write never wedges the queue). Reclaims the map slot once the chain it
 *  installed drains and nothing newer replaced it. */
function serializeOptOutWrite<T>(harnessHome: string, task: () => Promise<T>): Promise<T> {
  const prior = optOutWriteChains.get(harnessHome) ?? Promise.resolve();
  const next = prior.then(task, task);
  optOutWriteChains.set(harnessHome, next);
  const cleanup = (): void => {
    if (optOutWriteChains.get(harnessHome) === next) {
      optOutWriteChains.delete(harnessHome);
    }
  };
  next.then(cleanup, cleanup);
  return next;
}

/** Atomically persist the full opted-out set (immutable: builds a fresh array,
 *  writes the whole file). Creates the parent dir if absent. Writes to a unique
 *  temp file then renames over the final path so a crash mid-write never leaves a
 *  half-written optouts.json (rename is atomic on the same filesystem). Mirrors
 *  the atomic-write pattern in delivery.ts. */
async function persistOptOuts(harnessHome: string, set: ReadonlySet<string>): Promise<void> {
  const path = optOutPath(harnessHome);
  await mkdir(dirname(path), { recursive: true });
  const payload: OptOutFile = { optedOut: [...set].sort() };
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
  await rename(tmpPath, path);
}

/** Read the current opted-out set asynchronously, robust to a missing/corrupt
 *  file (→ empty set). Used only inside the serialized write path so each
 *  read-modify-write observes the prior write. */
async function readOptOutsAsync(harnessHome: string): Promise<Set<string>> {
  try {
    const text = await readFile(optOutPath(harnessHome), 'utf-8');
    const parsed = JSON.parse(text) as OptOutFile;
    if (Array.isArray(parsed.optedOut)) {
      return new Set(parsed.optedOut.filter((n): n is string => typeof n === 'string'));
    }
    return new Set();
  } catch {
    return new Set();
  }
}

/** Record `number` as opted-out (idempotent). Serialized + atomic (see
 *  {@link serializeOptOutWrite} / {@link persistOptOuts}): the read-modify-write
 *  runs inside the per-home chain so concurrent STOPs from different numbers
 *  never lose a write. */
export function writeOptOut(harnessHome: string, number: string): Promise<void> {
  return serializeOptOutWrite(harnessHome, async () => {
    const set = await readOptOutsAsync(harnessHome);
    if (set.has(number)) return;
    set.add(number);
    await persistOptOuts(harnessHome, set);
  });
}

/** Clear `number`'s opt-out (re-opt-in; idempotent). Serialized + atomic, same
 *  as {@link writeOptOut}. */
export function clearOptOut(harnessHome: string, number: string): Promise<void> {
  return serializeOptOutWrite(harnessHome, async () => {
    const set = await readOptOutsAsync(harnessHome);
    if (!set.has(number)) return;
    set.delete(number);
    await persistOptOuts(harnessHome, set);
  });
}

/** True when `number` is currently opted-out. */
export function isOptedOut(harnessHome: string, number: string): boolean {
  return readOptOuts(harnessHome).has(number);
}

// ── delivery transport ──────────────────────────────────────────────────────

/** The transport seam the route drives to send a reply back over SMS. The
 *  default ({@link createDefaultSmsTransport}) calls the Twilio Messages REST API
 *  over `fetch`; tests inject a mock. */
export interface SmsTransport {
  /** Send a text SMS to `to` (an E.164 number). */
  sendMessage(to: string, body: string): Promise<void>;
}

/** Config for the default Twilio Messages transport. The auth token is the Basic-
 *  auth password and is NEVER logged. */
export type TwilioTransportConfig = {
  accountSid: string;
  authToken: string;
  fromNumber: string;
};

/** Build the default fetch-based Twilio Messages transport. Only used in
 *  production (tests inject a mock). VERIFIED against the Messages REST API docs:
 *  POST https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json, HTTP
 *  Basic auth (username=AccountSid, password=AuthToken), form-urlencoded
 *  From/To/Body. A non-2xx response is surfaced as an error WITHOUT echoing the
 *  token or the Basic-auth header. */
export function createDefaultSmsTransport(config: TwilioTransportConfig): SmsTransport {
  const { accountSid, authToken, fromNumber } = config;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
  // Basic auth: base64("SID:authToken"). Constructed once; never logged.
  const basic = Buffer.from(`${accountSid}:${authToken}`, 'utf-8').toString('base64');
  return {
    async sendMessage(to: string, body: string): Promise<void> {
      const form = new URLSearchParams({ From: fromNumber, To: to, Body: body });
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${basic}`,
        },
        body: form.toString(),
      });
      if (!res.ok) {
        // Surface the status only — never the token / auth header / body (which
        // can echo request detail). The message names the endpoint generically.
        throw new Error(`twilio Messages.create failed: HTTP ${res.status}`);
      }
    },
  };
}

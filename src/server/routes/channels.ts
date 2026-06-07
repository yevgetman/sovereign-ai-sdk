// Phase F-T4/T6 — the open gateway route for inbound channels (webhook + slack).
//
// `channelsRoute(runtime, channelsConfig, deps?)` returns a Hono sub-app mounted
// OPEN (before the /sessions/* bearer/principal auth, like /health and GET /). A
// channel request authenticates via its OWN transport credential (the webhook's
// HMAC signature; Slack's signing-secret signature), NOT the gateway's
// bearer/principal token — so it must be reachable without that token, and the
// per-channel verify is the gate.
//
// POST /channels/webhook/:id flow (verify BEFORE any side-effect):
//   1. resolve the enabled webhook channel for :id          → 404 if none;
//   2. read the RAW body + verify the HMAC over those bytes  → 401 on fail;
//   3. parse the JSON body into an InboundMessage            → 400 on bad JSON
//      or a missing required field;
//   4. runChannelTurn under the channel's principal + posture (F-T1/T2);
//   5. reply { reply: <text> } (200), or { silent: true } (200) when the model
//      declined.
//
// POST /channels/slack/events flow (ack-fast-then-async; verify BEFORE any
// side-effect):
//   1. resolve the enabled slack channel                    → 404 if none;
//   2. read the RAW body; if it's the url_verification handshake, verify the
//      signature then echo { challenge } (200);
//   3. verify the signing-secret signature over the raw body (incl. the replay
//      window)                                               → 403 on fail/stale;
//   4. parse; ignore (bot's own message / non-message)      → 200 ACK, no turn;
//   5. dedupe by event_id — a Slack retry of a seen event   → 200 ACK, no re-run;
//   6. SCHEDULE runChannelTurn + transport.postMessage as a background task and
//      return 200 IMMEDIATELY (Slack retries after ~3s, so the ACK must not wait
//      on the model). The reply is posted out-of-band.
//
// SECURITY: the channel secret (webhook secret; Slack signing secret + bot
// token) is never logged. Verification runs before the body is parsed and before
// any turn — an unsigned / forged / replayed request creates no session and runs
// no model call. The route owns no auth bypass: an unconfigured / disabled
// channel is simply not routable (404).

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  type SlackDedupe,
  type SlackTransport,
  createDefaultSlackTransport,
  createSlackDedupe,
  parseSlackBody,
  verifySlackSignature,
} from '../../channels/adapters/slack.js';
import {
  type SmsTransport,
  type TwilioTransportConfig,
  classifyKeyword,
  clearOptOut,
  createDefaultSmsTransport,
  isOptedOut,
  parseSmsBody,
  resolveSenderPrincipal,
  verifySmsSignature,
  writeOptOut,
} from '../../channels/adapters/sms.js';
import { parseWebhook, verifyWebhook } from '../../channels/adapters/webhook.js';
import { runChannelTurn } from '../../channels/pipeline.js';
import type { Runtime } from '../runtime.js';

/** Per-channel webhook config the route needs. Structural subset of
 *  `Settings['gateway']['channels']['webhook']` — kept local so app.ts /
 *  index.ts stay decoupled from the Zod schema module, mirroring how
 *  SessionSupervisorLike is declared in routes/sessions.ts. */
export type WebhookChannelConfig = {
  enabled?: boolean | undefined;
  secret?: string | undefined;
  principalId: string;
  permissionMode?: 'default' | 'ask' | undefined;
};

/** Per-channel Slack config the route needs (F-T6). Structural subset of
 *  `Settings['gateway']['channels']['slack']` — kept local so app.ts / index.ts
 *  stay decoupled from the Zod schema module (mirrors WebhookChannelConfig).
 *  `botToken` is only used to construct the DEFAULT transport — when the caller
 *  injects a SlackTransport (tests, or a custom delivery client) it is unused. */
export type SlackChannelConfig = {
  enabled?: boolean | undefined;
  signingSecret?: string | undefined;
  botToken?: string | undefined;
  principalId: string;
  permissionMode?: 'default' | 'ask' | undefined;
};

/** Per-channel SMS config the route needs (Twilio). Structural subset of
 *  `Settings['gateway']['channels']['sms']`. UNLIKE the other channels, SMS
 *  binds the SENDER to a principal via the `senders` ALLOW-LIST (a number is
 *  publicly textable; an inbound only drives a turn if its From is a key in this
 *  map). `accountSid`/`authToken`/`fromNumber` build the default Twilio transport
 *  + verify signatures (the token is never logged); `helpText` answers HELP. */
export type SmsChannelConfig = {
  enabled?: boolean | undefined;
  provider?: 'twilio' | undefined;
  accountSid?: string | undefined;
  authToken?: string | undefined;
  fromNumber?: string | undefined;
  /** The security gate: a map from an allowed sender E.164 number → a Phase-E
   *  principalId. An inbound whose From is NOT a key here runs NO turn. */
  senders?: Record<string, string> | undefined;
  helpText?: string | undefined;
  permissionMode?: 'default' | 'ask' | undefined;
};

/** The channels block threaded through buildAppWithRuntime / startServer. The
 *  webhook channel is wired in F-T4; the slack channel in F-T6; the SMS channel
 *  here (telegram is a poll-loop adapter with no inbound route). */
export type ChannelsConfig = {
  webhook?: WebhookChannelConfig | undefined;
  slack?: SlackChannelConfig | undefined;
  sms?: SmsChannelConfig | undefined;
};

/** Optional dependencies threaded into the channels route. All are injectable
 *  seams for tests / custom wiring; each has a production default.
 *
 *  - `slackTransport` — the chat.postMessage seam. Default = a real `fetch`
 *    client built from the configured bot token.
 *  - `slackDedupe` — the seen-event-id set for Slack retry dedupe. Default = a
 *    fresh bounded set owned by the route for its lifetime.
 *  - `onBackgroundTask` — invoked with each scheduled background promise (the
 *    Slack ack-fast-then-async turn + post). Production leaves it undefined (the
 *    route fires-and-forgets, swallowing its own errors); tests pass a collector
 *    so the async post can be deterministically awaited. */
export type ChannelsDeps = {
  slackTransport?: SlackTransport | undefined;
  slackDedupe?: SlackDedupe | undefined;
  /** The SMS send seam. Default = a real Twilio Messages `fetch` client built
   *  from the configured creds. Tests inject a mock to await the async reply. */
  smsTransport?: SmsTransport | undefined;
  onBackgroundTask?: ((p: Promise<void>) => void) | undefined;
};

/** The reserved id of the single configured webhook channel in v1. The
 *  `POST /channels/webhook/:id` path segment must equal this; any other id is a
 *  404. Reserved as the multi-channel addressing hook for later platforms. */
const WEBHOOK_CHANNEL_ID = 'default';

/** Fix carry-c — max inbound body size (bytes) for any /channels/* route. The
 *  route reads the FULL raw body (the HMAC is over the exact bytes), so a cap is
 *  applied BEFORE the read to stop a huge POST from being buffered into memory.
 *  1 MiB is generous vs a real chat message + envelope; an over-cap request is
 *  rejected 413 with no parse / verify / turn. */
const MAX_CHANNEL_BODY_BYTES = 1_048_576;

/** Reconstruct the PUBLIC URL Twilio signed (D3). Twilio computes its signature
 *  over the URL it POSTed to — i.e. the public-facing webhook URL. Behind a
 *  reverse proxy / load balancer the gateway sees an INTERNAL url (`c.req.url`),
 *  so we honor the standard `X-Forwarded-Proto` + `X-Forwarded-Host` headers when
 *  present to rebuild the externally-visible URL (preserving the path + query),
 *  falling back to `c.req.url` when unproxied. The operator must set the Twilio
 *  Messaging webhook to exactly this public URL (documented in usage.md). Only
 *  the FIRST value of a comma-joined forwarded header is used (the original
 *  client-facing hop). */
export function reconstructTwilioUrl(
  requestUrl: string,
  forwardedProto: string | undefined,
  forwardedHost: string | undefined,
): string {
  const firstHop = (v: string | undefined): string | undefined => {
    if (typeof v !== 'string' || v.length === 0) return undefined;
    const first = v.split(',')[0]?.trim();
    return first !== undefined && first.length > 0 ? first : undefined;
  };
  const host = firstHop(forwardedHost);
  if (host === undefined) return requestUrl;
  const proto = firstHop(forwardedProto) ?? 'https';
  // Rebuild scheme + host from the forwarded headers; keep the path + query from
  // the original URL. URL parsing is robust to the internal url shape.
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return requestUrl;
  }
  return `${proto}://${host}${parsed.pathname}${parsed.search}`;
}

/** Build the open channels sub-app. Only ENABLED channels are routable; a
 *  request to an unknown / disabled channel id is a 404 (existence-hiding — the
 *  caller learns nothing about which channels exist). `deps` injects the Slack
 *  transport / dedupe / background-task hook (all default to production wiring;
 *  see {@link ChannelsDeps}). */
export function channelsRoute(
  runtime: Runtime,
  channels: ChannelsConfig,
  deps: ChannelsDeps = {},
): Hono {
  const r = new Hono();

  // Fix carry-c — cap the inbound body on every /channels/* route BEFORE the
  // handler reads it (each handler does `await c.req.text()` over the full body
  // for HMAC verification). bodyLimit short-circuits an over-cap request with
  // 413 — no parse, no verify, no turn, nothing buffered past the limit.
  r.use('/channels/*', bodyLimit({ maxSize: MAX_CHANNEL_BODY_BYTES }));

  // One dedupe set lives for the route's lifetime so a Slack retry across
  // separate requests is recognised (a per-request set would never dedupe).
  const slackDedupe = deps.slackDedupe ?? createSlackDedupe();
  // Fire-and-forget scheduler. Tests pass a collector via deps.onBackgroundTask
  // to await the async post; in production we swallow background errors so an
  // out-of-band post failure can't crash the gateway (the ACK already returned).
  // `label` names the channel in the error line (never a secret — secrets are
  // never part of an error `detail`).
  const scheduleBackground = (label: string, work: () => Promise<void>): void => {
    const p = work().catch((err) => {
      const detail = err instanceof Error ? err.message : String(err);
      // Never log any signing secret / bot token / auth token — none is in `detail`.
      process.stderr.write(`[${label}] background turn failed: ${detail}\n`);
    });
    deps.onBackgroundTask?.(p);
  };

  r.post('/channels/webhook/:id', async (c) => {
    // (1) Resolve the enabled webhook channel for :id. v1 supports a single
    // configured webhook channel addressed by the reserved id 'default'; the
    // `:id` segment is the multi-channel hook for F-T5/T6. An :id that doesn't
    // match a configured channel, or an absent / disabled / secret-less channel,
    // is not routable → 404 (existence-hiding — never reveal which channels
    // exist).
    const cfg = channels.webhook;
    if (
      c.req.param('id') !== WEBHOOK_CHANNEL_ID ||
      cfg === undefined ||
      cfg.enabled !== true ||
      cfg.secret === undefined
    ) {
      return c.json({ error: 'not found' }, 404);
    }

    // (2) Read the RAW body BEFORE parsing — the HMAC is computed over the exact
    // bytes the client signed; re-serializing parsed JSON would change them and
    // break verification. Verify BEFORE any parse / turn so a forged request
    // triggers no side-effect.
    const rawBody = await c.req.text();
    const signatureHeader = c.req.header('x-signature');
    if (!verifyWebhook({ rawBody, signatureHeader, secret: cfg.secret })) {
      return c.json({ error: 'invalid signature' }, 401);
    }

    // (3) Parse the verified bytes into an InboundMessage. A non-object body or
    // a missing required field (sender / text) → 400. JSON.parse throwing on
    // malformed bytes is caught and mapped to the same 400.
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBody);
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const msg = parseWebhook(parsedJson);
    if (msg === null) {
      return c.json({ error: 'invalid webhook payload' }, 400);
    }

    // (4) Run one headless channel turn under the channel principal + safe
    // posture (F-T1/T2). permissionMode is forwarded when configured (defaults
    // to 'default' in the pipeline; 'bypass' is rejected there before any turn).
    const result = await runChannelTurn({
      runtime,
      msg,
      principalId: cfg.principalId,
      ...(cfg.permissionMode !== undefined ? { permissionMode: cfg.permissionMode } : {}),
    });

    // (5) Synchronous reply. A silent verdict (empty / [SILENT]-prefixed reply)
    // returns 200 with no reply text so the caller can distinguish "the model
    // declined" from "the model replied".
    if (result.silent === true || result.text === undefined) {
      return c.json({ silent: true }, 200);
    }
    return c.json({ reply: result.text }, 200);
  });

  // F-T6 — Slack Events API endpoint. Ack-fast-then-async: Slack retries a
  // delivery it doesn't ACK within ~3s, so the model turn + the reply post run
  // OUT OF BAND and we return 200 immediately. Verification (signing-secret HMAC
  // over the raw body + the replay window) runs BEFORE any parse / turn — a
  // forged / replayed request creates no session and runs no model call.
  r.post('/channels/slack/events', async (c) => {
    // (1) Resolve the enabled slack channel. An absent / disabled / signing-
    // secret-less channel is not routable → 404 (existence-hiding).
    const cfg = channels.slack;
    if (cfg === undefined || cfg.enabled !== true || cfg.signingSecret === undefined) {
      return c.json({ error: 'not found' }, 404);
    }
    const signingSecret = cfg.signingSecret;

    // (2) Read the RAW body BEFORE parsing — the signature is computed over the
    // exact bytes Slack signed; re-serializing parsed JSON would change them.
    const rawBody = await c.req.text();
    const timestamp = c.req.header('x-slack-request-timestamp');
    const signature = c.req.header('x-slack-signature');

    // Slack signs the url_verification handshake too, so verify it the same way;
    // only the response SHAPE differs ({ challenge } instead of an ACK). Verify
    // FIRST so an unsigned probe can't even learn the challenge echo behavior.
    if (!verifySlackSignature({ rawBody, timestamp, signature, signingSecret })) {
      return c.json({ error: 'invalid signature' }, 403);
    }

    // (3) Parse the verified bytes. JSON.parse throwing on malformed input is an
    // ignore (ACK 200) — Slack expects a 2xx so it stops retrying; a 4xx here
    // would trigger pointless retries of an un-actionable body.
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBody);
    } catch {
      return c.json({ ok: true }, 200);
    }
    const parsed = parseSlackBody(parsedJson);

    // (2b) url_verification handshake → echo the challenge (signature already
    // verified above). No turn runs.
    if (parsed.kind === 'challenge') {
      return c.json({ challenge: parsed.challenge }, 200);
    }

    // (4) Non-actionable event (bot's own message / non-message / missing
    // fields) → ACK 200 so Slack stops retrying; no turn, no post.
    if (parsed.kind === 'ignore') {
      return c.json({ ok: true }, 200);
    }

    // (5) Retry dedupe. Slack delivers at-least-once; a retry of a seen event_id
    // ACKs 200 without re-running the turn. (An event with no id can't be
    // deduped — it still runs; Slack always sends event_id for event_callback.)
    const { message, eventId } = parsed;
    if (eventId !== undefined) {
      if (slackDedupe.seen(eventId)) {
        return c.json({ ok: true }, 200);
      }
      // Mark BEFORE scheduling so an immediate retry (Slack can fire the next
      // attempt before our background turn finishes) is recognised as a dupe.
      slackDedupe.mark(eventId);
    }

    // (6) Schedule the turn + the reply post as a background task and ACK now.
    const slackTransport = deps.slackTransport ?? createDefaultSlackTransport(cfg.botToken ?? '');
    scheduleBackground('slack', async () => {
      const result = await runChannelTurn({
        runtime,
        msg: message,
        principalId: cfg.principalId,
        ...(cfg.permissionMode !== undefined ? { permissionMode: cfg.permissionMode } : {}),
      });
      // Silent verdict (empty reply or a [SILENT] prefix) → post nothing.
      if (result.silent === true || result.text === undefined || result.text.length === 0) {
        return;
      }
      await slackTransport.postMessage(message.chatId, result.text);
    });

    return c.json({ ok: true }, 200);
  });

  // SMS (Twilio) — open webhook + Twilio-signature verify + the SENDER ALLOW-LIST
  // gate + STOP/HELP/START compliance + ack-fast-then-async reply. TWO gates run
  // before any turn: the signature (transport — the request is really Twilio's)
  // AND the sender allow-list (sender — the number is mapped to a principal). A
  // phone number is publicly textable, so an unlisted/spoofed From must NEVER
  // drive a turn. An unlisted/opted-out/keyword inbound is ACKed 200 with no turn
  // and (by default) no reply body — never confirming whether the number is live.
  r.post('/channels/sms', async (c) => {
    // (1) Resolve the enabled sms channel. An absent / disabled / auth-token-less
    // channel is not routable → 404 (existence-hiding).
    const cfg = channels.sms;
    if (cfg === undefined || cfg.enabled !== true || cfg.authToken === undefined) {
      return c.json({ error: 'not found' }, 404);
    }
    const authToken = cfg.authToken;

    // (2) Read the RAW body (the form bytes Twilio signed) + decode the params.
    // Twilio POSTs application/x-www-form-urlencoded; the signature is over the
    // full URL + the sorted decoded params, so decode them for verification.
    const rawBody = await c.req.text();
    const params: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(rawBody)) {
      params[key] = value;
    }

    // (3) Reconstruct the public URL Twilio signed (honoring a reverse proxy)
    // and verify the X-Twilio-Signature over it. Verify BEFORE any parse / turn —
    // a forged / unsigned request triggers no side-effect. Fail → 403.
    const url = reconstructTwilioUrl(
      c.req.url,
      c.req.header('x-forwarded-proto'),
      c.req.header('x-forwarded-host'),
    );
    const signatureHeader = c.req.header('x-twilio-signature');
    if (!verifySmsSignature({ url, params, signatureHeader, authToken })) {
      return c.json({ error: 'invalid signature' }, 403);
    }

    // (4) Parse the verified form into an InboundMessage. A missing/unsafe From
    // (not E.164-ish) or a non-string Body → 400 (no turn). The From validation
    // is the SOURCE boundary against path traversal in the session key.
    const msg = parseSmsBody(params);
    if (msg === null) {
      return c.json({ error: 'invalid sms payload' }, 400);
    }
    const from = msg.sender;

    // (5) THE SENDER GATE. Resolve From → principalId via the allow-list. If the
    // sender is not a key, ACK 200 and return — no turn, no session, no reply by
    // default (don't confirm the number is live). This is the load-bearing SMS
    // security decision: the Twilio signature authenticated the TRANSPORT, not the
    // SENDER; an unknown number never reaches a tool-running agent. The lookup is
    // prototype-safe (`Object.hasOwn`, via resolveSenderPrincipal) so a `From`
    // shaped like an inherited property name is never treated as allow-listed.
    const senders = cfg.senders ?? {};
    const principalId = resolveSenderPrincipal(senders, from);
    if (principalId === undefined) {
      return c.json({ ok: true }, 200);
    }

    // (6) Compliance keywords (STOP / START / HELP) — handled WITHOUT a turn, and
    // BEFORE the opt-out check (so START always re-opts-in, even while opted-out).
    const keyword = classifyKeyword(msg.text);
    if (keyword === 'stop') {
      // Record the opt-out durably (serialized + atomic; awaited so the opt-out is
      // persisted before the ACK); never run a turn; deliver nothing.
      await writeOptOut(runtime.harnessHome, from);
      return c.json({ ok: true }, 200);
    }
    if (keyword === 'start') {
      // Re-opt-in durably (serialized + atomic; awaited before the ACK); no turn.
      // (A confirmation reply is a deliverability nicety left to the operator; v1
      // stays silent to match the no-leak posture.)
      await clearOptOut(runtime.harnessHome, from);
      return c.json({ ok: true }, 200);
    }
    if (keyword === 'help') {
      // Static help text, no turn. Only reply if helpText is configured (an empty
      // helpText stays silent rather than sending a blank message).
      const helpText = cfg.helpText;
      if (helpText !== undefined && helpText.length > 0) {
        const transport = resolveSmsTransport(deps, cfg);
        scheduleBackground('sms', async () => {
          await transport.sendMessage(from, helpText);
        });
      }
      return c.json({ ok: true }, 200);
    }

    // (7) Respect a standing opt-out: an opted-out sender's normal message ACKs
    // 200 with no turn and no delivery (until they START again).
    if (isOptedOut(runtime.harnessHome, from)) {
      return c.json({ ok: true }, 200);
    }

    // (8) Both gates passed + not a keyword + not opted-out → schedule the turn +
    // the async reply and ACK now. An agent turn exceeds Twilio's webhook timeout
    // (~10–15s), so the reply is posted out of band via the Messages REST API.
    const transport = resolveSmsTransport(deps, cfg);
    scheduleBackground('sms', async () => {
      const result = await runChannelTurn({
        runtime,
        msg,
        principalId,
        ...(cfg.permissionMode !== undefined ? { permissionMode: cfg.permissionMode } : {}),
      });
      // Silent verdict (empty reply or a [SILENT] prefix) → send nothing.
      if (result.silent === true || result.text === undefined || result.text.length === 0) {
        return;
      }
      await transport.sendMessage(from, result.text);
    });

    return c.json({ ok: true }, 200);
  });

  return r;
}

/** Resolve the SMS transport: an injected one (tests) or the default Twilio
 *  Messages client built from the configured creds. The creds are guaranteed
 *  present for an ENABLED channel by the schema superRefine + boot-time env
 *  resolution; defensive `?? ''` fallbacks keep a mis-wired caller failing at the
 *  transport (a clean Twilio HTTP error) rather than with an undefined
 *  interpolation. The auth token is never logged. */
function resolveSmsTransport(deps: ChannelsDeps, cfg: SmsChannelConfig): SmsTransport {
  if (deps.smsTransport !== undefined) return deps.smsTransport;
  const twilioConfig: TwilioTransportConfig = {
    accountSid: cfg.accountSid ?? '',
    authToken: cfg.authToken ?? '',
    fromNumber: cfg.fromNumber ?? '',
  };
  return createDefaultSmsTransport(twilioConfig);
}

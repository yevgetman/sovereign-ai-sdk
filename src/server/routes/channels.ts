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
import {
  type SlackDedupe,
  type SlackTransport,
  createDefaultSlackTransport,
  createSlackDedupe,
  parseSlackBody,
  verifySlackSignature,
} from '../../channels/adapters/slack.js';
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

/** The channels block threaded through buildAppWithRuntime / startServer. The
 *  webhook channel is wired in F-T4; the slack channel in F-T6 (telegram is a
 *  poll-loop adapter with no inbound route, so it is not addressed here). */
export type ChannelsConfig = {
  webhook?: WebhookChannelConfig | undefined;
  slack?: SlackChannelConfig | undefined;
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
  onBackgroundTask?: ((p: Promise<void>) => void) | undefined;
};

/** The reserved id of the single configured webhook channel in v1. The
 *  `POST /channels/webhook/:id` path segment must equal this; any other id is a
 *  404. Reserved as the multi-channel addressing hook for later platforms. */
const WEBHOOK_CHANNEL_ID = 'default';

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

  // One dedupe set lives for the route's lifetime so a Slack retry across
  // separate requests is recognised (a per-request set would never dedupe).
  const slackDedupe = deps.slackDedupe ?? createSlackDedupe();
  // Fire-and-forget scheduler. Tests pass a collector via deps.onBackgroundTask
  // to await the async post; in production we swallow background errors so an
  // out-of-band post failure can't crash the gateway (the ACK already returned).
  const scheduleBackground = (work: () => Promise<void>): void => {
    const p = work().catch((err) => {
      const detail = err instanceof Error ? err.message : String(err);
      // Never log the signing secret / bot token — neither is part of `detail`.
      process.stderr.write(`[slack] background turn failed: ${detail}\n`);
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
    scheduleBackground(async () => {
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

  return r;
}

// Phase F-T4 — the open gateway route for inbound channels (webhook v1).
//
// `channelsRoute(runtime, channelsConfig)` returns a Hono sub-app mounted OPEN
// (before the /sessions/* bearer/principal auth, like /health and GET /). A
// channel request authenticates via its OWN transport credential (the webhook's
// HMAC signature), NOT the gateway's bearer/principal token — so it must be
// reachable without that token, and the per-channel verify is the gate.
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
// SECURITY: the secret is never logged. Verification runs before the body is
// parsed and before any turn — an unsigned / forged request creates no session
// and runs no model call. The route owns no auth bypass: an unconfigured /
// disabled channel is simply not routable (404).

import { Hono } from 'hono';
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

/** The channels block threaded through buildAppWithRuntime / startServer. Only
 *  the webhook channel is wired in F-T4; telegram / slack land in F-T5/T6. */
export type ChannelsConfig = {
  webhook?: WebhookChannelConfig | undefined;
};

/** The reserved id of the single configured webhook channel in v1. The
 *  `POST /channels/webhook/:id` path segment must equal this; any other id is a
 *  404. Reserved as the multi-channel addressing hook for later platforms. */
const WEBHOOK_CHANNEL_ID = 'default';

/** Build the open channels sub-app. Only ENABLED channels are routable; a
 *  request to an unknown / disabled channel id is a 404 (existence-hiding — the
 *  caller learns nothing about which channels exist). */
export function channelsRoute(runtime: Runtime, channels: ChannelsConfig): Hono {
  const r = new Hono();

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

  return r;
}

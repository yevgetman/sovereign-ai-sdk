# SMS Channel (Twilio) — Design Spec

**Date:** 2026-06-06
**Status:** Draft (pre-implementation)
**Parent:** the Phase-F channel framework (`docs/specs/2026-06-06-phase-f-channels-design.md`, shipped v0.6.23) — this adds a fourth channel adapter (after webhook/Slack/Telegram). Named as a remaining surface in the `gateway-channel-surfaces` open-question.

## Goal

Let a user **text the harness from a phone and get a reply**, as a new channel on `sov gateway`, reusing the Phase-F pipeline (inbound→session→headless turn→outbound), per-channel principal isolation (Phase E), the safe-by-default permission posture, per-sender sessions, and memory+recall. SMS is delivered via a provider; **v1 = Twilio** (the canonical; the config carries a `provider` field so other providers can be added later). Built + tested against an **injected transport**; live operation needs an operator-provisioned Twilio number + A2P registration (documented setup, not provisioned here).

## Why this is a small build

The framework already does the hard parts. An SMS adapter is the **Slack adapter's shape**: an open HTTP inbound route on the gateway + a signature verify + a body parse + `runChannelTurn` + an async reply via the provider's REST API. The genuinely new design work is the **security model** (below) and **compliance** (STOP/HELP), not the pipeline.

## The security crux (this is what makes SMS different from Slack)

A Slack/Telegram channel's trust boundary is the workspace/bot — only members reach it. **An SMS number is publicly textable** — anyone who knows (or war-dials) the number can send it a message, and SMS sender IDs can be spoofed. The Twilio signature authenticates the **transport** (the request came from Twilio), NOT the **sender**. So the load-bearing decision: an inbound SMS must **only** drive a turn if its `From` number is on an explicit **allow-list mapped to a principal**. An unknown number never spawns a session against a tool-running agent.

## Locked design decisions

| ID | Decision |
|---|---|
| **D1** | **Provider model, v1 = Twilio.** `gateway.channels.sms: { provider: 'twilio', … }`. The adapter is the Twilio implementation; `provider` is the extensibility seam. The normalized `InboundMessage.channel` is `'sms'`. |
| **D2** | **Inbound = an open HTTP webhook** on the gateway: `POST /channels/sms` (mounted open like the webhook/Slack routes, before the `/sessions/*` auth — it authenticates via the provider signature, not the bearer token). Twilio POSTs `application/x-www-form-urlencoded` (`From`, `To`, `Body`, `MessageSid`, …). |
| **D3** | **Transport auth = Twilio request signature.** Verify the `X-Twilio-Signature` header (Twilio's scheme: an HMAC over the full request URL + the sorted POST params, keyed by the account **auth token**, base64; constant-time compare) BEFORE any parse/turn; fail → **403**, no turn. **The implementer MUST verify the exact current Twilio signature algorithm + the Messages REST API against Twilio's docs at build time** (use the official `twilio` SDK's `validateRequest` if it's already a dep or trivially addable, else implement the documented scheme) — don't hand-roll from memory. Mind the public-URL caveat: the signature is over the URL Twilio called, so a proxy/forwarded host must be handled (document the `webhookUrl`/host expectation). |
| **D4** | **Sender allow-list → principal (THE SECURITY GATE).** `gateway.channels.sms.senders: { "<E.164 number>": "<principalId>" }` — a map from an allowed sender number to a Phase-E principal id (∈ `gateway.principals`). An inbound whose `From` is **not a key** in the map does **not** run a turn (ignored — no reply, no session, no cost; optionally a single configurable "not authorized" reply, default off to avoid confirming the number is live). The session is per-sender (`buildSessionKey` uses `From`), and its owner is that sender's mapped principal → per-sender isolated memory/learning. (A single-operator "my phone texts my agent" = one entry; a small team = N entries, each isolated.) **Config validation: an enabled SMS channel MUST have a non-empty `senders` map, every value ∈ `principals`.** |
| **D5** | **Compliance: STOP / HELP / START.** Inbound text matching `STOP`/`UNSUBSCRIBE`/`CANCEL`/`END`/`QUIT` (case-insensitive, trimmed) is an **opt-out** — record the number as opted-out, do NOT run a turn, and do not deliver to opted-out numbers thereafter; `HELP`/`INFO` returns a static help string (no turn); `START`/`UNSTOP` re-opts-in. (Twilio's Advanced Opt-Out may also handle STOP carrier-side; the adapter must at minimum never treat these as a prompt and must respect opt-outs.) Opt-out state persists (a small file under `<harnessHome>/channels/sms/optouts.json`, or reuse an existing store — keep it simple + durable). |
| **D6** | **Reply = async via the Twilio Messages REST API** (ack the webhook fast with an empty `200`/empty TwiML, run `runChannelTurn` in the background, then `POST` the reply via `Messages.create` from the configured `fromNumber`) — because an agent turn exceeds Twilio's webhook timeout (~10–15 s). Mirrors the Slack ack-then-async pattern; **injectable `SmsTransport`** (`sendMessage(to, body)`), default = the Twilio REST client. `[SILENT]`/empty reply → send nothing. Long replies: SMS segments (~160 chars/segment) — Twilio auto-concatenates; note the cost/UX but no special handling v1. |
| **D7** | **Reuses Phase-F wholesale.** `runChannelTurn` (per-sender session, safe-by-default posture, memory+recall, history cap, error fallback, per-session serialization), `ChannelAdapter` contract, the channels route + `buildChannelListeners` wiring, env-first secrets. Channel id `'sms'`. |
| **D8** | **Config.** `gateway.channels.sms: { enabled?, provider: 'twilio', accountSid?, authToken?, fromNumber?, senders: {<E.164>: <principalId>}, helpText?, permissionMode? }`. Secrets env-first: `SOV_TWILIO_AUTH_TOKEN`, `SOV_TWILIO_ACCOUNT_SID`. Validation (enabled): `authToken` present (signature verify), `accountSid` + `fromNumber` present (reply), non-empty `senders` with every principalId ∈ `principals`; `permissionMode` ∈ {default, ask} (`bypass` rejected, as all channels). |

## Components

**Create:** `src/channels/adapters/sms.ts` (verify Twilio signature + parse form body → `InboundMessage`; the STOP/HELP/START classifier; the opt-out store; the `SmsTransport` + default Twilio REST client); the `POST /channels/sms` route in `src/server/routes/channels.ts`; tests `tests/channels/sms.test.ts`.
**Modify:** `src/config/schema.ts` (the `gateway.channels.sms` block + validation), `src/channels/listeners.ts` / `src/cli/gatewayCommand.ts` (env-secret resolution for the Twilio creds; the route mounts via the existing channels-route wiring — SMS is webhook-based, no poll loop), `docs/usage.md` (the SMS section + the Twilio setup steps), `docs/architecture.md`, `package.json` (+ possibly the `twilio` SDK dep, the implementer's call). `src/channels/pipeline.ts` is **unchanged** (SMS reuses `runChannelTurn`).

## Security / correctness notes

- **Two gates before a turn:** the Twilio signature (transport) AND the sender allow-list (sender). Either fails → no turn. Plus the safe-by-default posture (tools).
- **Sender → principal** is server-config-derived, never from message data; an allowed sender gets ITS principal's isolated memory/learning.
- **Don't confirm a live number:** an unlisted/opted-out inbound replies nothing by default (no "you're not authorized" leak unless the operator opts in).
- **Compliance is mandatory, not optional** (STOP/HELP); A2P 10DLC registration is an operator setup step (documented) — without it, US carriers filter the traffic (a deliverability, not a code, issue).
- Inbound `From`/ids feed `buildSessionKey` → validate them as safe segments (E.164 is `+` + digits; reject anything else) at the source, consistent with the webhook/Slack/Telegram source-id hardening + the TraceWriter sink sanitizer.
- Secrets (auth token) never logged; signature verify is constant-time.

## Out of scope (v1)

MMS / media, group SMS, delivery-status callbacks, multiple providers (v1 = Twilio), per-sender principal *auto-provisioning*, rich formatting, the A2P registration itself (operator setup). A non-Twilio provider, or a list-form `senders` convenience, are clean follow-ons.

## Testing + ship

TDD: signature verify (valid/bad → 403); unlisted sender → no turn/no session/no reply; STOP/HELP/START handled (no turn; opt-out respected); an allowed sender → ack-fast → async reply via a mock `SmsTransport`; per-sender→principal isolation; config validation (missing creds / empty senders / ghost principal / bypass rejected). Then a **hard adversarial security review** (it's a publicly-reachable, tool-running channel — the signature + the allow-list + the posture must hold; no way for an unlisted/spoofed sender to drive a turn or leak). Full gate green. Update `docs/usage.md` (configure `gateway.channels.sms` + the **Twilio setup steps**: buy a number, set the webhook URL to `https://<host>/channels/sms`, the auth token + account SID + from-number env vars, A2P 10DLC registration, STOP/HELP) + `docs/architecture.md` + the testing-log. Commit/push; `sov upgrade`; cut a release. Per `docs/conventions/autonomous-feature-builds.md`, executes immediately into the plan with no approval gate.

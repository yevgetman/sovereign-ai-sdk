# Phase F — Channel Framework + First Adapters — Design Spec

**Date:** 2026-06-06
**Status:** Draft (pre-implementation)
**Parent roadmap:** `specs/2026-06-05-run-anywhere-harness-roadmap-design.md` (Phase F / modules M6 + M7). **Depends on Phase D** (gateway supervisor, v0.6.21) **+ Phase E** (principals + per-user isolation, v0.6.22). The final run-anywhere phase.

## Goal

Let a **Slack / Telegram / generic-webhook message drive a real harness session and get a reply** — activating the dormant `src/channels/` contract into a working **inbound → session → headless turn → outbound** pipeline, hosted by the gateway, with each channel mapped to an isolated principal (Phase E) and a **safe-by-default permission posture** (a remote channel must NOT be able to run arbitrary tools). Adapters are built + fully tested against **mock/injected transports**; live operation needs real external credentials, which are documented setup steps (this build provisions no external accounts).

## What exists today (verified 2026-06-06)

- **`src/channels/types.ts`** — `InboundMessage { sender, channel, chatId, chatType, threadId?, text, attachments?, raw? }`, `DeliveryResult { ok, error?, silent? }`, `SecretTarget`, and a minimal `ChannelAdapter { id, secretTargets? }` shell.
- **`src/channels/sessionKey.ts`** — `buildSessionKey(msg)` → `agent:main:{channel}:{chatType}:{chatId}[:{threadId}]` (deterministic, stable per conversation).
- **`src/channels/delivery.ts`** — `send(target, content, harnessHome?, options?)`: `[SILENT]` prefix short-circuits; only `target='local'` (filesystem outbox) implemented; cron-outbox branch.
- **Cron headless-turn pattern** (`src/cron/wiring.ts`) to mirror: fresh session, `AgentRunner`, `ask = async () => 'deny'` (auto-deny), `extractFinalText(assistant)`, `disposeSession` in `finally`.
- **Phase E** — `gateway.principals`, `principalAuth`, `owner_id` (sessions owned + isolated memory/learning per principal), `upsertSession({ sessionId, owner, platform, metadata })` for find-or-create by a deterministic id.
- **Gateway** — `runGateway` boots runtime + the `SessionSupervisor` (`.unref()` loop) + `startServer` (Hono `buildAppWithRuntime`) + parks; shutdown stops the supervisor before `runtime.dispose()`.

## Design principles for this phase

- **One channel-agnostic pipeline; thin adapters.** The inbound→turn→outbound core is shared; each adapter only does **parse** (raw payload → `InboundMessage`), **verify** (authenticate the inbound), and **deliver** (reply via the channel API). Adding a channel = a small adapter, not new core.
- **Security-first (channels are an untrusted remote RCE surface).** A channel message must NOT inherit a local dev's allow-rules and must default to a posture where dangerous tools are denied. Each channel is an isolated principal (Phase E). Adversarial security review gates the ship.
- **Testable against injected transports.** Every adapter takes an injectable transport (HTTP client / poller) so the full pipeline is unit/integration-tested with mocks; live operation is a documented credential setup.
- **Reuse, don't reinvent.** Extend `src/channels/` + the cron headless-turn helpers + the gateway lifecycle; don't greenfield.

## Locked design decisions

| ID | Decision |
|---|---|
| **D1** | **Activate `src/channels/` into a working pipeline.** Extend the `ChannelAdapter` contract to: `id`; `verify(req) → { ok; message?: InboundMessage; challengeResponse? }` (authenticate + parse an inbound, or answer a handshake); `deliver(reply, msg, transport) → DeliveryResult` (send the outbound). Adapters are pure of turn logic. |
| **D2** | **Channel-agnostic pipeline** (`src/channels/pipeline.ts`): given an `InboundMessage` + the channel's resolved config (principal + posture), `runChannelTurn(...)`: (1) `sessionId = buildSessionKey(msg)`; (2) `runtime.sessionDb.upsertSession({ sessionId, owner: channelPrincipalId, platform: msg.channel, metadata: { kind: 'channel', channel, sender } })` (find-or-create → continuous per-(channel,sender) conversation, owned by the channel principal → Phase-E-isolated memory/learning); (3) run a **headless turn** mirroring cron (`AgentRunner`, the channel permission posture, `extractFinalText`, `disposeSession` in `finally`) — **except** the per-(channel,sender) session is NOT disposed-as-deleted; it persists for the next message (dispose tears down the in-memory context only, the Phase-D supervisor reclaims idle ones); (4) return the final text for the adapter to deliver (`[SILENT]`/empty → no reply). |
| **D3** | **Per-channel permission posture (X1 — SECURITY CRUX).** A channel turn runs with `mode: 'default'`, `ask = () => 'deny'` (auto-deny; no interactive approver), and **rule layers that DO NOT include the local dev's `settings.local.json` allow-rules** — by default an **empty/restricted** rule set, so anything requiring permission is denied (read-only/no-permission tools still work; `Bash`/`Write`/`Edit`/etc. are denied unless the operator adds explicit per-channel allows). This is **stricter than cron** (cron is operator-scheduled/trusted; a channel message is remote/untrusted). A channel's `permissionMode` may be configured but **`bypass` is rejected for channels** (a remote bypass = RCE). The tool pool also excludes `SUBAGENT_EXCLUDED_TOOLS` (cron CRUD / send_message / etc.) like the other headless surfaces. |
| **D4** | **Hosted by the gateway (D).** Channel listeners start/stop in `runGateway`: HTTP-inbound adapters (webhook, Slack events) mount **their own routes** on the gateway Hono app (`/channels/*`) that authenticate via the **channel's own mechanism** (HMAC / signing secret) — NOT the bearer `principalAuth` (these are open routes with adapter-level verification, mounted like `/health`). Poll-based adapters (Telegram `getUpdates`) run a `.unref()`'d loop started in `runGateway` and **stopped before `runtime.dispose()`** (mirror the supervisor ordering). Channels are off unless configured. |
| **D5** | **Generic webhook adapter (keystone — no external deps, fully testable).** `POST /channels/webhook/:channelId` with an **HMAC-SHA256 signature** header over the raw body (shared secret, env-first) → constant-time verify → parse JSON `{ sender, text, chatId?, ... }` → `InboundMessage` → pipeline → reply **synchronously in the HTTP response** (`{ reply }`). The reference adapter proving the whole arc; live + tested via `app.request`. |
| **D6** | **Telegram adapter** (real channel; mock-transport-tested). Bot API via **long-poll `getUpdates`** by default (no public endpoint required) — a `.unref()`'d loop over an **injectable transport** → parse updates → `InboundMessage` → pipeline → `deliver` via `sendMessage`. Real bot token resolves env-first (`SOV_TELEGRAM_BOT_TOKEN` > config). Built + tested against a mock transport (canned `getUpdates` + asserted `sendMessage`); the live bot token + (optional) webhook mode are documented setup. |
| **D7** | **Slack adapter** (real channel; mock-transport-tested). Events API: `POST /channels/slack/events` — verify the **Slack signing secret** (HMAC `v0=` over `v0:{timestamp}:{rawBody}`, constant-time, with a timestamp-freshness window against replay) + handle the `url_verification` challenge handshake; **ack within 3 s** then run the turn + post the reply **asynchronously** via `chat.postMessage` (injectable transport); dedupe Slack retries (`X-Slack-Retry-Num`). Real app + signing secret + bot token are documented setup. |
| **D8** | **Config** — `gateway.channels: { webhook?, telegram?, slack? }`, each `{ enabled?, principalId, permissionMode?, …secrets }` (`webhook.secret`, `telegram.botToken`, `slack.signingSecret` + `slack.botToken`), secrets env-first. **Validation:** an `enabled` channel must have its required secret(s) AND a `principalId` that **exists in `gateway.principals`** (so a channel maps to a real isolated principal); `permissionMode: 'bypass'` rejected for channels. |
| **D9** | **Security posture (hard review gate).** Channels are the highest-risk surface (remote inbound → agent). Adversarial review required: the X1 conservative posture actually holds (a channel can't run `Bash`/`Write` by default); auth verification is correct + constant-time + replay-resistant (webhook HMAC, Slack signing secret + timestamp, Telegram token secrecy); the channel principal isolation (E) holds for sessions + memory + learning; inbound parse isn't an injection/DoS vector; no local allow-rule inheritance. |

## Components

**Create:**
- `src/channels/adapter.ts` — the extended `ChannelAdapter` contract + a registry.
- `src/channels/pipeline.ts` — `runChannelTurn(...)` (the channel-agnostic inbound→turn→outbound core; reuses cron's headless-turn + the D3 posture).
- `src/channels/permission.ts` — `buildChannelCanUseTool(...)` (the D3 safe-by-default posture; no local-allow inheritance).
- `src/channels/adapters/webhook.ts`, `src/channels/adapters/telegram.ts`, `src/channels/adapters/slack.ts` — the three adapters (injectable transports).
- `src/server/routes/channels.ts` — the gateway HTTP routes (`/channels/webhook/:id`, `/channels/slack/events`) mounted open with adapter-level verification.
- `src/channels/listeners.ts` — start/stop the configured listeners (HTTP route registration hints + the Telegram poll loop) in the gateway lifecycle.
- Tests: `tests/channels/{pipeline,permission,webhook,telegram,slack}.test.ts`, `tests/channels/channelIsolation.test.ts` (the per-channel principal/permission isolation + security suite).

**Modify:**
- `src/channels/delivery.ts` — (optionally) route `deliver` through the adapter registry; keep `local`/`[SILENT]`.
- `src/config/schema.ts` — the `gateway.channels` block + validation (principalId∈principals; bypass rejected; required secrets).
- `src/server/app.ts` — mount `channelsRoute(runtime, channelsConfig)` (open, adapter-verified) when channels are configured.
- `src/cli/gatewayCommand.ts` — construct the channel listeners; start them; stop them before `runtime.dispose()`.
- `docs/03-cli-reference/usage.md`, `docs/02-architecture/runtime-architecture.md`, `package.json`.

## Security / correctness notes

- **No local allow-rule inheritance (the crux):** the channel `canUseTool` must be built WITHOUT `loadPermissionSettings({cwd,harnessHome})`'s local layers — an empty/channel-scoped rule set + auto-deny. A channel turn that tries `Bash`/`Write`/`Edit` is denied by default. The security review must prove this.
- **Each channel = an isolated principal** (Phase E): channel sessions are `owner_id = channelPrincipalId`, so their sessions, memory, and learning are isolated from other principals and from each other (per channel) — and never see a human user's data.
- **Auth verification:** webhook HMAC + Slack signing secret are constant-time + over the RAW body; Slack adds timestamp-freshness (replay window) + challenge handshake + retry dedupe. Telegram trusts the bot token (kept secret, env-first) + optionally a webhook secret. A failed verify → reject (401/403), never run a turn.
- **DoS / abuse:** the Phase-D supervisor + `maxConcurrentSessions` bound channel-spawned sessions; the per-turn `maxTurns` cap bounds work; `[SILENT]`/empty replies don't deliver.
- **Secrets** never logged; resolved env-first; redaction patterns already cover Slack tokens.

## Out of scope (later / founder-reserved)

- Rich channel UX (Slack blocks/buttons/reactions, Telegram inline keyboards, threads beyond basic, file attachments, in-channel slash commands), Slack Socket-Mode/WebSocket, multi-workspace Slack.
- **In-channel interactive permission approval** (channels auto-deny in v1 — no approve-from-Slack UI; a future enhancement).
- Provisioning real Slack/Telegram apps or a public webhook endpoint (operator setup steps, documented).
- Channels under the managed-multi-tenant model (founder-reserved, with Phase E's cross-tenant isolation).
- Outbound-initiated (agent-pushes-to-channel) flows beyond the reply-to-inbound path (cron's `send_message` is separate).

## Testing + ship

TDD: the permission posture (D3 — prove a channel can't run `Bash` by default) + the pipeline (find-or-create session, owner=channel principal, headless turn, capture reply) → each adapter against an injected transport (webhook HMAC verify + synchronous reply via `app.request`; Telegram poll→pipeline→sendMessage with a mock transport; Slack signing-secret verify + challenge + async post with a mock transport) → a **channel-isolation + security suite** (channel principal's sessions/memory/learning isolated; a bad signature is rejected; `bypass` config rejected; no local-allow inheritance) → a **hard adversarial security review** before ship. Full gate green. Update `docs/03-cli-reference/usage.md` (configuring each channel + the **real-credential setup steps** for Slack/Telegram + the security/permission posture) + `docs/02-architecture/runtime-architecture.md` (the channel layer) + a state snapshot + the `CLAUDE.md`/`AGENTS.md` pointer (byte-identical; **don't touch the ACTIVE FOCUS soak banner**) + the testing-log. Commit/push; `sov upgrade`; cut a release. Per `docs/05-conventions/autonomous-feature-builds.md`, executes immediately into the plan with no approval gate. **This phase completes the run-anywhere roadmap (A–F).**

# State of the build — Phase F: Channel framework + Slack/Telegram/webhook adapters (shipped; inbound channels drive isolated, safe-by-default sessions on the gateway — the run-anywhere roadmap A–F is now COMPLETE)

**HEAD:** the `chore(release): bump version 0.6.22 -> 0.6.23` commit (the Phase F channels run). **Release:** **v0.6.23** (2026-06-06).

**Predecessor:** [`docs/07-history/state/2026-06-06-phase-e-multi-user.md`](2026-06-06-phase-e-multi-user.md) (Phase E — Multi-user identity + state scoping shipped; named principals with isolated sessions/memory/learning; v0.6.22).

## What this snapshot is

The **sixth and final phase (Phase F / modules M6 + M7) of the run-anywhere, persistent, multi-channel harness roadmap** — a real phase, not a hardening run. It activates the dormant `src/channels/` contract into a working **inbound → session → headless turn → outbound** pipeline hosted by the gateway: a **Slack, Telegram, or generic-webhook message drives a real harness session and gets a reply**, with each channel mapped to an isolated Phase-E principal and a **safe-by-default permission posture** (a remote channel must NOT be able to run arbitrary tools). The three adapters are built + fully tested against **injected transports**; live Slack/Telegram operation needs real external credentials, which are documented operator setup steps (this build provisions no external accounts).

**This completes the run-anywhere roadmap — A through F are all shipped.** The harness has gone from a single-user, terminal-only, per-invocation tool to a run-anywhere, persistent, multi-user, multi-channel runtime base: a secure remote gateway (A), multi-client reconnect-safe transport (B), a reference browser UI (C), a persistent multi-session supervisor (D), multi-user identity + isolation (E), and now inbound channels (F).

Authoritative implementation docs in this repo:
- **Roadmap:** [`specs/2026-06-05-run-anywhere-harness-roadmap-design.md`](specs/2026-06-05-run-anywhere-harness-roadmap-design.md) (the program; A–F all marked shipped; roadmap COMPLETE)
- **Spec:** [`specs/2026-06-06-phase-f-channels-design.md`](specs/2026-06-06-phase-f-channels-design.md) (decisions D1–D9)
- **Plan:** [`plans/2026-06-06-phase-f-channels.md`](plans/2026-06-06-phase-f-channels.md) (F-T1…F-T9)

The roadmap + decision record (ADR H-0010, the multi-channel-gateway differentiator) stay canonical in `~/code/sovereign-ai-docs`; this repo owns the code and the implementation docs. **No new ADRs in this repo** — Phase F is additive + gateway-scoped (an activated `src/channels/` contract, a channel posture, three adapters, two open inbound routes, a poll-loop worker, and a `gateway.channels` config block), all decisions captured in the spec + commit messages. The default `sov` (TUI) / `sov serve` / `sov drive` surfaces are byte-unchanged: with no `gateway.channels` configured there are no channel routes, no workers, and no behavior change.

## Where this sits in the roadmap

Phase F is **piece 6 of 6 — the last one**. The roadmap is dependency-ordered:

```
A ──> B ──> C            (browser UI on a secure, robust transport)
 \     \
  \     └─> D ──> E ──> F   (persistent supervisor → multi-user → channels)
   └────────> D
```

- A — Secure remote gateway (M1) — ✅ shipped (v0.6.17 + v0.6.18 hardening).
- B — Multi-client session transport (M2) — ✅ shipped (v0.6.19).
- C — Reference web UI (M8) — ✅ shipped (v0.6.20).
- D — Persistent multi-session supervisor / service install (M3) — ✅ shipped (v0.6.21).
- E — Multi-user identity + state scoping (M4 + M5, security-reviewed) — ✅ shipped (v0.6.22).
- **F — Channel framework + Slack/Telegram/webhook adapters (M6 + M7, security-reviewed) — ✅ shipped (this snapshot, v0.6.23).**

**The run-anywhere roadmap (A–F) is COMPLETE.** Each phase was independently shippable; the program landed as six coherent released increments. A→B→C delivered the first complete "run-anywhere from a browser" arc; D made the gateway a persistent always-on backbone; E made it multi-user; F adds the inbound channels that let it be driven from Slack/Telegram/a webhook. The roadmap's out-of-scope/founder-reserved items (native mobile apps as separate client projects; horizontal scale/clustering; the managed-multi-tenant-vs-self-hosted decision; the agent-core rent-vs-build decision) remain exactly as reserved — not part of this roadmap's scope.

## What shipped (Phase F)

1. **Safe-by-default channel permission posture + adapter contract (F-T1; `src/channels/permission.ts`, `src/channels/adapter.ts`).** `buildChannelCanUseTool({ mode?, ruleLayers? })` builds the per-channel decider **WITHOUT** ever calling `loadPermissionSettings` — the load-bearing "no local-allow inheritance" choice. The asker is `async () => 'deny'` (no human at a channel boundary), so any `ask` fallthrough resolves to deny; `alwaysAllow` starts empty; `ruleLayers` defaults to `[]`. Net: `Bash`/`Write`/`Edit` are denied while read-only/permissionless tools run. `assertChannelPermissionMode(mode)` throws on `'bypass'` (a remote bypass is RCE) and on any non-`'default'`/`'ask'` value. The extended `ChannelAdapter` contract (`verify` → `{ ok, message?, challengeResponse? }`; `deliver(reply, msg, transport)`) keeps adapters pure of turn logic.

2. **Channel-agnostic inbound→turn→outbound pipeline (F-T2; `src/channels/pipeline.ts`).** `runChannelTurn({ runtime, msg, principalId, permissionMode? })`: `assertChannelPermissionMode` → `sessionId = buildSessionKey(msg)` (deterministic per `(channel, sender[, thread])`) → `runtime.sessionDb.upsertSession({ owner: principalId, platform: msg.channel, metadata: { kind:'channel', channel, sender } })` (find-or-create, owned by the channel principal → Phase-E-isolated memory + learning) → persist the inbound user message → run one headless turn (mirrors cron: `AgentRunner`, the channel posture, tool pool filtered against `SUBAGENT_EXCLUDED_TOOLS`, drain to terminal, `extractFinalText`) → persist the assistant turn → return `{ text }` or `{ silent }` (`[SILENT]`/empty) → `disposeSession` in `finally` (reclaims the in-memory context; the DB row persists for the next message; the Phase-D supervisor evicts idle ones). The `ToolContext` is the canonical `buildSessionToolContext`, which derives `userId` from the row's `owner_id` so memory + learning route under the channel principal's Phase-E namespace.

3. **Hydrated history → coherent multi-message conversations (F-T2 follow-up, `eb67031`).** Without seeding prior history, `AgentRunner` would cold-start every channel message. `runChannelTurn` now hydrates the session's prior transcript (`loadHistoryAsMessages` + `repairMissingToolResults` — the same projection + M10-audit orphan-tool-result repair the interactive turns route uses) into `initialMessages`, so the second message on a `(channel, sender)` continues the thread coherently. AgentRunner never writes to the DB, so feeding the persisted history back does not double-persist the new user message.

4. **`gateway.channels` config (F-T3; `src/config/schema.ts`).** `gateway.channels: { webhook?, telegram?, slack? }`, each `{ enabled?, principalId, <secret(s)>?, permissionMode? }` (`webhook.secret`; `telegram.botToken`; `slack.signingSecret` + `slack.botToken`). The `permissionMode` enum is `['default','ask']`, so **`bypass` is a parse error**, not a refine. The gateway `superRefine` requires, for each ENABLED channel, its secret(s) present (env-merged in pre-parse — see F-T7) AND a `principalId` that resolves to a declared `gateway.principals` id (so a channel maps to a real isolated principal). All blocks `.strict()`.

5. **Generic webhook adapter + open route (keystone, F-T4; `src/channels/adapters/webhook.ts`, `src/server/routes/channels.ts`).** `POST /channels/webhook/:id` (id `default` in v1; the `:id` is the multi-channel hook). `verifyWebhook` does a **constant-time HMAC-SHA256** over the RAW body keyed by the channel secret (`X-Signature: sha256=<hex>`); a bad/missing signature → **401** before any side-effect. `parseWebhook` maps the JSON body → `InboundMessage` (a non-object or missing `sender`/`text` → **400**). On success: `runChannelTurn` → synchronous `{ reply }` (or `{ silent: true }`). The reference adapter that proves the whole arc with nothing external to mock.

6. **Telegram adapter (F-T5; `src/channels/adapters/telegram.ts`).** `createTelegramListener({ botToken, principalId, permissionMode?, transport?, pollIntervalMs? })`: an `unref`'d `setInterval` poll loop over an **injectable `TelegramTransport`** (`getUpdates(offset)` / `sendMessage`) — no public endpoint required. Each update maps to an `InboundMessage` (skips non-message/no-text/the bot's own messages to avoid echo loops), drives `runChannelTurn`, and `sendMessage`s the non-silent reply; the offset advances past every update in a batch (even ones that throw) so a poisonous update isn't reprocessed forever; per-update try/catch keeps one bad update from killing the loop. The default transport is a `fetch` Bot API client; `botToken` resolves env-first (`SOV_TELEGRAM_BOT_TOKEN`).

7. **Slack Events adapter + route (F-T6; `src/channels/adapters/slack.ts`, route in `channels.ts`).** `POST /channels/slack/events`: `verifySlackSignature` does a **constant-time `v0=` HMAC** over `v0:{timestamp}:{rawBody}` keyed by the signing secret, with a **300-second replay window** (a stale timestamp → **403** even if the HMAC is valid). It answers the `url_verification` challenge handshake (signature verified first), **acks 200 within Slack's ~3 s budget**, then runs the turn + posts the reply **asynchronously** via an injectable `SlackTransport` (`chat.postMessage`). A bounded `event_id` dedupe set absorbs Slack's at-least-once retries (`X-Slack-Retry-Num`) so a slow turn isn't run twice. `signingSecret`/`botToken` env-first (`SOV_SLACK_SIGNING_SECRET`/`SOV_SLACK_BOT_TOKEN`).

8. **Gateway wiring (F-T7; `src/channels/listeners.ts`, `src/cli/gatewayCommand.ts`, `src/server/app.ts`/`index.ts`).** `resolveChannelsConfig(rawChannels, env)` merges env-sourced secrets into the raw `gateway.channels` object **before** the Zod parse (config wins over env; the env only fills an absent field) and throws a clear boot error naming the channel + field + env var if an enabled channel still lacks a secret. The webhook + Slack inbound routes mount **OPEN** (before the `/sessions/*` bearer/principal auth, like `/health` + `GET /`) when `channels` is passed to `buildAppWithRuntime`. `buildChannelListeners` constructs the Telegram poll-loop worker (if enabled), `start()`ed in `runGateway` after the supervisor and `stop()`ped **before** `runtime.dispose()` (mirrors the supervisor ordering). A one-line `channels: webhook, slack` enabled-names summary prints at boot — **never the secrets**.

9. **Channel isolation + security suite (F-T8; `tests/channels/channelIsolation.test.ts` + per-area suites).** Two channels mapped to different principals → their sessions/memory/learning are isolated (reusing the Phase-E observables); a channel turn CANNOT run `Bash`/`Write` by default **even with a local `allow Bash(*)` seeded on disk** (proves no local-allow inheritance); a webhook with a bad HMAC + a Slack event with a bad/stale signature are rejected with no turn; `bypass` config is rejected; the channel principal can't reach another principal's sessions via the API. Per-adapter suites: `tests/channels/{permission,pipeline,webhook,telegram,slack,listeners}.test.ts`.

## The adversarial security review — found + fixed a CRITICAL, re-reviewed SECURE-TO-SHIP

Per the roadmap's hard gate (X1; spec D9), Phase F got an **adversarial security review** over the whole surface (the D3 posture; webhook HMAC; Slack signing-secret + replay + challenge; Telegram token handling; the channel→principal isolation; inbound parse as an injection/DoS vector; no local-allow inheritance; secrets never logged). It **found a CRITICAL path-traversal arbitrary-file-write** and it was fixed (RED-before / GREEN-after) in `260de9f` before ship:

- **CRITICAL — path-traversal arbitrary-file-write via an attacker-controlled webhook `chatId`.** An inbound webhook `chatId` (or `sender`/`threadId`) containing `../` flowed through `buildSessionKey` into the session id, which becomes the trace **filename** (`<sessionId>.jsonl`) — so a forged-but-otherwise-valid request could escape the trace directory and write attacker-chosen bytes to an attacker-chosen path **before the model even ran**. Fixed **defense-in-depth at both boundaries**:
  - **Source boundary** (`src/channels/adapters/webhook.ts` `parseWebhook`): `sender`/`chatId`/`threadId` are validated against a safe-segment allowlist (`^[A-Za-z0-9_.-]+$`, length-capped, explicit `..` reject) — a violation returns `null` → the route **400**s with no turn.
  - **Sink boundary** (`src/trace/writer.ts`): the trace filename derivation collapses any `..` run to `_`, replaces path separators / control chars with `_`, and **containment-asserts** the resolved path stays under the traces dir (belt-and-suspenders even if a future caller bypassed the source check).

A re-review over the fixed surface returned **SECURE-TO-SHIP — no remaining Critical/High.** The conservative posture actually holds (a channel can't run `Bash`/`Write` by default, proven with a seeded local allow rule); auth verification is constant-time + replay-resistant (webhook HMAC; Slack signing secret + 300 s window; Telegram token kept secret + env-first); the channel principal isolation (E) holds for sessions + memory + learning; inbound parse is bounded; secrets are never logged.

## Known v1 limitations (documented, not fixed)

All judged non-blocking; recorded for a future pass:

1. **(a) Channel turns are uncompacted.** A channel conversation accrues history on one session and is not microcompacted — a very long single conversation could overflow the context window. Same caveat as cron; a follow-up, not a bug.
2. **(b) Channel sessions aren't individually API-addressable.** Their ids are colon-delimited (`agent:main:{channel}:{chatType}:{chatId}[:{threadId}]`), so they don't match the `/sessions/:id*` routes — fail-closed/secure (channel-managed; the Phase-D supervisor evicts idle ones; rows accrue like cron).
3. **(c) LOW hardening follow-ups.** No inbound body-size cap (gateway-wide — affects all routes, not channel-specific); and the Slack/Telegram inbound ids rely on the (airtight) trace-sink sanitizer rather than a source-level validator like the webhook adapter has (the sink containment-assert makes this safe, but a symmetric source check is the tidier belt-and-suspenders).
4. **(d) Live Slack/Telegram need real external credentials.** The adapters were built + tested against injected transports (+ a real-HMAC webhook e2e); provisioning real Slack/Telegram apps + secrets is the operator setup documented in `usage.md` — **not live-verified here.**
5. **(e) A minor structural type carry.** `StartServerOptions.channels` carries the `telegram` key (Telegram is a poll-loop worker with no inbound route, so the route layer ignores it) — harmless, structural.

## The real-credential setup (operator steps — documented, not provisioned here)

`usage.md` (the "Channels" section) carries the full operator setup for each channel:

- **Telegram** — message **@BotFather** → `/newbot` → a **bot token** → export `SOV_TELEGRAM_BOT_TOKEN`; enable `gateway.channels.telegram = { enabled, principalId }`. Long-poll, **no public endpoint needed**.
- **Slack** — create an app at api.slack.com/apps → copy the **Signing Secret** (`SOV_SLACK_SIGNING_SECRET`) + a `chat:write` **Bot User OAuth Token** (`SOV_SLACK_BOT_TOKEN`) → **Event Subscriptions** Request URL `https://<host>/channels/slack/events` (the gateway answers the `url_verification` challenge) → subscribe to `message` events; enable `gateway.channels.slack`. Needs a public HTTPS endpoint.
- **Webhook** — share `SOV_WEBHOOK_SECRET` with the caller; `POST /channels/webhook/default` with `X-Signature: sha256=<hmac>` (HMAC-SHA256 of the raw body). A `curl` example is included.

## Tests

- **TS suite — ~3067 pass / 0 fail / 14 skip** in a clean run. Up from the Phase-E v0.6.22 baseline (~2957) from the new channel posture + pipeline + config + three adapters + isolation/security coverage (`tests/channels/{permission,pipeline,webhook,telegram,slack,listeners,channelIsolation}.test.ts` + the schema + trace-writer sanitizer tests). Gate criterion unchanged: "no new failures beyond the known env-only set" (the ambient-config learning-observer tests pass on a clean `HARNESS_HOME` / in CI).
- **Lint + typecheck** — clean (`biome check`; `tsc --noEmit`).
- **Go suite** — unchanged by this phase (no `packages/tui/` change).
- **Post-upgrade binary smoke** — the released v0.6.23 binary boots a gateway configured with a `webhook` channel + a principal; `POST /channels/webhook/default` with a VALID `X-Signature` HMAC over the raw body returns a reply (200), and the SAME POST with a BAD signature returns **401**. Proves channels ship in the binary. Logged in `docs/06-testing/testing-log.md`.

## Notes

- **No bundle changes** — the Phase-F surface is entirely in `src/` (`channels/{permission,adapter,pipeline,listeners}.ts`, `channels/adapters/{webhook,telegram,slack}.ts`, `channels/delivery.ts`, `server/routes/channels.ts`, `server/app.ts`/`index.ts`, `cli/gatewayCommand.ts`, `config/schema.ts`, `trace/writer.ts`), `tests/`, and `docs/`. No `packages/tui/` change, no `bundle-default/` change.
- **Default surfaces unchanged.** The default `sov` (TUI), `sov serve` (OpenAI API), and `sov drive` (headless) experiences are byte-identical: with no `gateway.channels` configured there are no channel routes, no workers, and no behavior change. Channels run only on `sov gateway`.
- **Engine-agnostic by construction.** The pipeline drives `AgentRunner` + the SQLite session model + the channel routes, all above the HTTP+SSE protocol seam — so it survives a future agent-core swap, exactly like the rest of the gateway program. **The protocol is the seam.**
- **Learning-loop soak continues in parallel — untouched.** Recall is still **ON by default** (`learning.recall.enabled`, since v0.6.16) and capture + synthesis stay on; Phase F did not disable recall or learning (a roadmap execution requirement). Channel turns observe + recall under the channel principal's Phase-E namespace, so the loop runs unchanged for channels too. The `## ⚠️ ACTIVE FOCUS — Learning-loop soak` banner in `CLAUDE.md`/`AGENTS.md` stays the standing #1 focus; this gateway track is separate and parallel.

## Cross-repo record-keeping (flag for a docs-repo session)

The roadmap + decision record are canonical in `~/code/sovereign-ai-docs` and this repo can't commit there. A docs-repo session should reflect **Phase F shipped (v0.6.23)** and the **run-anywhere program COMPLETE (A–F all done)** against the multi-channel-gateway differentiator (ADR H-0010). Note: the Phase E close-out flagged that the **D + E** cross-repo sync was still pending; that sync now also needs **F** — so a single docs-repo session should reflect **D + E + F shipped + the roadmap COMPLETE** in one pass.

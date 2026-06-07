# SMS Channel (Twilio) · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Checkbox steps. Executes per `docs/conventions/autonomous-feature-builds.md` — no approval gates. Read the cited files first, then TDD. **Publicly-textable, tool-running channel — the signature + sender allow-list + posture are security-load-bearing; negative tests mandatory. VERIFY current Twilio specifics against Twilio's docs at build time (don't hand-roll from memory).**

**Goal:** Text the harness from a phone → a reply, as a `gateway.channels.sms` channel (v1 provider Twilio), reusing the Phase-F pipeline, per `docs/specs/2026-06-06-sms-channel-design.md`.

**Architecture:** An open `POST /channels/sms` webhook → verify the Twilio signature (transport) → gate on the sender allow-list + opt-out + STOP/HELP (sender/compliance) → ack fast → run `runChannelTurn` (the Phase-F pipeline, owner = the sender's mapped principal, safe-by-default posture) in the background → deliver async via the Twilio Messages REST API (injectable transport).

**Tech Stack:** TypeScript on Bun, Hono, Zod, `bun:test`, the `twilio` SDK (if added) / documented HMAC, injected `SmsTransport`.

---

## Investigation findings (cite while implementing)
- **Phase-F framework to reuse:** `src/channels/pipeline.ts` `runChannelTurn({ runtime, msg, principalId, permissionMode? })` (per-sender session via `buildSessionKey`, owner=principal, safe posture, memory+recall, history cap, error fallback, per-session serialization); `src/channels/adapter.ts` (the `ChannelAdapter` + `registerChannelAdapter`); `src/channels/permission.ts` (`buildChannelCanUseTool`, `assertChannelPermissionMode`); `src/channels/adapters/{webhook,slack,telegram}.ts` (REFERENCES — webhook for HMAC verify + the open route shape; slack for ack-fast-then-async + injectable transport + `isSafeSegmentId` reuse); `src/server/routes/channels.ts` (`channelsRoute` + the open-mount + `ChannelsDeps`/`scheduleBackground`); `src/channels/listeners.ts` + `resolveChannelsConfig` (env-secret injection); `src/config/schema.ts` (the `gateway.channels` block + superRefine).
- **Twilio (VERIFY at build time via Twilio docs / the `twilio` npm SDK):** the `X-Twilio-Signature` validation scheme (HMAC over URL+sorted-params, base64 — prefer the SDK's `validateRequest`); the Messages REST API (`POST /2010-04-01/Accounts/{SID}/Messages.json`, Basic auth `SID:authToken`, `From`/`To`/`Body`); inbound is `x-www-form-urlencoded` (`From`,`To`,`Body`,`MessageSid`). Confirm the current header name + algorithm + whether a `twilio` dep is warranted vs a small documented HMAC.

## File structure
**Create:** `src/channels/adapters/sms.ts`; `tests/channels/sms.test.ts`.
**Modify:** `src/config/schema.ts`, `src/server/routes/channels.ts`, `src/channels/listeners.ts` (+/or `src/cli/gatewayCommand.ts`) for env-secret resolution, `docs/usage.md`, `docs/architecture.md`, `package.json`.

## Conventions (every task)
`.js` imports; no mutation; `bun:test`; explicit types; constant-time signature compare; **two gates (signature + sender allow-list) before any turn/side-effect**; secrets env-first, never logged; reuse `runChannelTurn` (don't reinvent the turn). Gate (`bun run lint && bun run typecheck && bun run test`, baseline ~3100/0/14, no new failures). Atomic commits. **NO release until the final task.**

---

## S-T1 — config: `gateway.channels.sms` + validation (~15 min · Opus)
**Files:** `src/config/schema.ts`; extend `tests/config/schema.test.ts`.
- [ ] **Failing tests:** the `gateway.channels` object accepts `sms: { enabled:true, provider:'twilio', accountSid:'AC…', authToken:'tok', fromNumber:'+15550001111', senders: { '+15551234567':'wh' }, permissionMode:'default' }` when `wh` ∈ `gateway.principals`; **rejects** an enabled sms channel with: an empty `senders` map; a `senders` value (principalId) NOT in `principals`; a missing `authToken`/`accountSid`/`fromNumber`; `permissionMode:'bypass'`; `provider` other than `'twilio'`. Disabled/absent sms → valid.
- [ ] Red.
- [ ] **Implement:** add `sms: z.object({ enabled: z.boolean().optional(), provider: z.literal('twilio'), accountSid: z.string().optional(), authToken: z.string().optional(), fromNumber: z.string().optional(), senders: z.record(z.string(), z.string()).default({}), helpText: z.string().optional(), permissionMode: z.enum(['default','ask']).optional() }).strict().optional()` to the `gateway.channels` object. Extend the gateway `.superRefine`: for an enabled sms channel — `senders` non-empty; every `senders` value ∈ the principal-id set; `accountSid`+`authToken`+`fromNumber` present (in config OR resolvable from env — keep consistent with the channels env-injection-before-parse decision; if secrets come via env, the merge happens before parse, so require-present here). (Secret-vs-env: match how webhook/slack/telegram do it — env merged into the raw config before `.parse()`.)
- [ ] Green; gate. Commit `feat(config): gateway.channels.sms (Twilio) with sender→principal allow-list + bypass rejection`.

## S-T2 — the SMS adapter + route + wiring (~40 min · Opus)
**Files:** create `src/channels/adapters/sms.ts`; modify `src/server/routes/channels.ts`, `src/channels/listeners.ts`/`src/cli/gatewayCommand.ts`; create `tests/channels/sms.test.ts`.
**VERIFY the Twilio signature scheme + Messages API against Twilio's current docs first (WebFetch).**
- [ ] **Failing tests** (`tests/channels/sms.test.ts`, via `buildAppWithRuntime({ channels })` + `app.request`, MockProvider, principals incl. the mapped one, temp HARNESS_HOME, injected `SmsTransport`):
  - **signature:** `POST /channels/sms` with a valid `X-Twilio-Signature` (computed with the test auth token over the URL+params) + a form body from an ALLOWED sender → 200 ack; then (await the background work) `transport.sendMessage(<from>, <reply>)` called with the MockProvider reply; a session owned by the sender's mapped principal exists (`platform:'sms'`). **Bad/missing signature → 403, no turn.**
  - **sender allow-list:** a valid-signature inbound from an UNLISTED number → no turn (MockProvider.streamCalls 0), no session, no `sendMessage` (and, by default, no reply body).
  - **per-sender isolation:** two allowed senders mapped to different principals → their sessions owned by their respective principals (distinct memory/learning namespaces — reuse the Phase-E observable).
  - **STOP/HELP/START:** `Body:'STOP'` (and `stop`, `Unsubscribe`) → no turn, number recorded opted-out, subsequent allowed messages from it are NOT delivered until `START`; `HELP` → returns the configured `helpText` (no turn); `START` → re-opt-in. (Assert via streamCalls 0 + the opt-out store / the transport calls.)
  - **async reply:** confirm ack-fast (the route returns 200 before the turn completes) then the background `runChannelTurn` + `sendMessage` (use the `ChannelsDeps.onBackgroundTask` await hook from F-T6).
  - **safe text id:** an inbound `From` that isn't a valid E.164-ish safe segment → rejected (no turn).
- [ ] Red.
- [ ] **Implement** `src/channels/adapters/sms.ts`:
  - `verifySmsSignature({ url, params, signatureHeader, authToken })` — the Twilio scheme (prefer the `twilio` SDK `validateRequest`; else the documented HMAC), constant-time; false on missing/bad. `parseSmsBody(form): InboundMessage` (`channel:'sms'`, `sender`=`From`, `chatId`=`From`, `chatType:'private'`, `text`=`Body`; validate `From` via `isSafeSegmentId`-style E.164 check → null if unsafe). `classifyKeyword(text): 'stop'|'start'|'help'|null` (case-insensitive trimmed STOP/UNSUBSCRIBE/CANCEL/END/QUIT, START/UNSTOP, HELP/INFO). A small durable opt-out store (`<harnessHome>/channels/sms/optouts.json`, read/write helpers). `SmsTransport { sendMessage(to,body): Promise<void> }` + a default Twilio REST client (Basic auth, the Messages endpoint; token never logged).
  - In `src/server/routes/channels.ts`, add `POST /channels/sms`: read the RAW body + reconstruct the params + the public URL; `verifySmsSignature` (403 on fail); `parseSmsBody` (400 on unparseable / unsafe From); resolve the sender → principal from `cfg.senders` — **if not found, ack 200 + return (no turn)**; handle `classifyKeyword` (STOP→opt-out+ack; HELP→reply helpText; START→opt-in+ack; all WITHOUT a turn); if the sender is opted-out, ack + no turn; else **ack 200 immediately** and schedule `runChannelTurn({ runtime, msg, principalId, permissionMode })` + `transport.sendMessage(from, reply)` as a background task (skip on silent). Inject `SmsTransport` via `ChannelsDeps` (default = the real Twilio client built from the config creds).
  - Env-secret resolution: extend `resolveChannelsConfig` (or the gateway wiring) to merge `SOV_TWILIO_AUTH_TOKEN`/`SOV_TWILIO_ACCOUNT_SID` into `gateway.channels.sms` before parse. SMS is webhook-based (no poll loop) — it mounts via the existing channels route when configured; confirm `buildChannelListeners` doesn't need an SMS worker (no-op for sms).
- [ ] Green; gate. Commit `feat(channels): SMS adapter (Twilio webhook — signature + sender allow-list + STOP/HELP + async reply)`.

## S-T3 — adversarial security review (HARD GATE) (~ review + fixes · Opus)
- [ ] Dispatch a security reviewer over the SMS surface: the Twilio signature verify (correct scheme, constant-time, raw-body/URL reconstruction not spoofable, the forwarded-host/proxy URL caveat); the sender allow-list (an unlisted/spoofed `From` can NEVER drive a turn — the #1 check); opt-out respected; STOP/HELP never run a turn; the safe-by-default posture holds; secrets never logged; no `From`→path traversal (E.164 validation + the trace-sink sanitizer); no unlisted-number existence leak. Must reach **SECURE-TO-SHIP**.
- [ ] Fix every Critical/High (+ cheap Medium); re-review. Commit fixes.

## S-T4 — docs + close-out + release (~20 min · Opus)
**Files:** `docs/usage.md`, `docs/architecture.md`, `docs/testing-log.md`, `CLAUDE.md`+`AGENTS.md` (state pointer if a state doc is added — or just the index; **don't touch the soak banner**; `diff` empty), `package.json`.
- [ ] `docs/usage.md` — an "SMS" subsection under the channels section: configure `gateway.channels.sms` (provider, the `senders` map = allow-list + principal, env-first `SOV_TWILIO_*`); **the Twilio setup steps** (buy a number; set the Messaging webhook to `https://<host>/channels/sms` POST; the auth token + account SID + from-number; **A2P 10DLC registration**; STOP/HELP are handled); the security model (signature + allow-list + safe posture; sender numbers are the trust boundary); v1 limits (no MMS/group; Twilio-only).
- [ ] `docs/architecture.md` — note the SMS adapter (webhook + signature + allow-list + async reply, on the Phase-F pipeline).
- [ ] Testing-log entry. (If you add a state snapshot, update the CLAUDE.md/AGENTS.md pointer byte-identically; otherwise add the spec/plan to the CLAUDE.md index. Keep `diff CLAUDE.md AGENTS.md` empty.)
- [ ] **Release** per `docs/conventions/cutting-releases.md`: bump `package.json` (next patch — likely **v0.6.26**, confirm current); gate green; commit + push; `sov-releases/CHANGELOG.md` entry (user-facing: "Text the harness over SMS (Twilio) — an allow-listed, isolated channel with the same safe-by-default posture as the other channels"); tag; CI → success; `gh release view` (4 artifacts); `sov upgrade`; **post-upgrade smoke** (boot the upgraded gateway with an sms channel + a principal + a sender map + a fake auth token; `POST /channels/sms` with a valid signature from an allowed sender → 200 + (async) the mock/real transport path exercised; bad signature → 403; unlisted sender → no turn; verify `~/.sov/bin/sov --version`). Commit + push.

---

## Self-review
Spec coverage: D1 provider/config → S-T1; D2 open webhook route → S-T2; D3 signature verify → S-T2 (implementer verifies Twilio specifics) + S-T3 (review); D4 sender allow-list→principal (the crux) → S-T1 (validation) + S-T2 (gating) + S-T3 (review) + the isolation test; D5 STOP/HELP/opt-out → S-T2; D6 async reply via REST → S-T2; D7 reuse Phase-F → S-T2; D8 config+secrets → S-T1+S-T2. Every decision maps to a task.
Placeholder scan: none — concrete files, tests, the config shape, the security gates. The one deliberately-deferred-to-build-time item is the EXACT Twilio signature/API spec (the implementer verifies it against Twilio's docs — called out explicitly, not hand-waved).
Type/name consistency: `verifySmsSignature`, `parseSmsBody`, `classifyKeyword`, `SmsTransport`, `gateway.channels.sms.senders`, `runChannelTurn`, channel id `'sms'` — consistent S-T1…S-T4. Security points: two-gates-before-turn, constant-time, sender-allow-list, opt-out, no-existence-leak.

## Execution
Per the autonomous convention: S-T1→S-T4 subagent-driven (fresh Opus implementer per task + review; **S-T3 is a hard security gate**), no approval gates; ship at S-T4. Reuses the Phase-F pipeline; the learning-loop soak continues untouched.

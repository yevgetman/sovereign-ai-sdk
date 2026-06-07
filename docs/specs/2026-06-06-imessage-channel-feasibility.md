# iMessage Channel — Feasibility + Scoping Spike

**Date:** 2026-06-06
**Status:** Research / feasibility (NO code — decision input for the founder)
**Parent:** `docs/specs/2026-06-06-phase-f-channels-design.md` (the channel framework this would extend). Sibling to the shipped Telegram / Slack / webhook adapters.

## TL;DR

There is **no official programmatic iMessage API** and there never has been — Apple's only sanctioned messaging product, **Apple Messages for Business (AMB)**, is a *business↔customer* support channel (gray bubbles, MSP-gated, customer-initiates) and structurally **cannot** carry "let me text my own agent from my iPhone as a normal blue-bubble iMessage." The only real path is an **unofficial Mac-hosted bridge** (BlueBubbles, AirMessage, mautrix-imessage, or the newer beeper/steipete `imsg` libraries) that reads `chat.db` and sends via AppleScript / private frameworks.

On the harness side, **plugging a bridge into Phase F is genuinely cheap** — it's a poll-loop adapter nearly identical to the Telegram one we already shipped (~a day of subagent work). The cost is **entirely operational + risk**: a dedicated always-on Mac signed into the target Apple ID, Full Disk Access to the message database, **a real Apple-ID ban risk** (documented, no appeals process), and **ongoing fragility** — macOS point releases break the bridge's read/send path (a concrete 2026 example: macOS Tahoe changed the `chat.db` chat-GUID prefix and broke lookups).

**Recommendation: NO-GO by default — conditional GO only if a concrete, durable need justifies dedicating a Mac.** This is "feasible but operationally heavy + ToS-risky." If the founder wants iMessage-style reach *now* for low cost and low risk, **Telegram (already shipped) or the generic webhook + an iOS Shortcut** deliver ~90% of the felt value with none of the dedicated-Mac/ban/fragility tax.

## Why this question

Phase F shipped a clean channel framework: a `ChannelAdapter` contract (`verify` → parse to `InboundMessage` → `deliver`), a channel-agnostic `runChannelTurn` pipeline, per-channel mapping to an isolated Phase-E principal, a safe-by-default permission posture (channels can't run dangerous tools), per-(channel,sender) continuous sessions, and memory+recall participation. Adding a channel is *supposed* to be a thin adapter + config + a principal mapping. The natural next question: **does iMessage fit, and is it worth it?** This doc answers both, grounded in current (2026) sources.

## 1. Apple's official stance — there is no iMessage API

**No official personal-iMessage API exists, full stop.** Apple has never shipped a public API to send/receive iMessages programmatically and publishes zero integration documentation for it. The blue bubble is strictly peer-to-peer, built for friends and family, not for programmatic scale. ([Twilio — "The Blue Bubble (iMessage) is strictly Peer-to-Peer… There is no official API for iMessage"](https://www.twilio.com/en-us/blog/products/launches/the-power-of-the-grey-bubble--why-apple-messages-for-business-is); [Lindy — "There is no iMessage Business API. There is no developer program for Messages."](https://www.lindy.ai/blog/imessage-api-three-rewrites-one-apple-ban-and-what-actually-works))

The two things Apple *does* offer are **not** what we need:

- **iMessage Apps / Stickers** — an extension surface that lives *inside* the Messages UI for rich interactive content; it is **not** a way to send/receive messages from an external server. ([Apple Developer — Messages](https://developer.apple.com/documentation/Messages); [Apple Developer — iMessage Apps](https://developer.apple.com/imessage/))

- **Apple Messages for Business (AMB)** — the only sanctioned server-side messaging product, and it is a *customer-service* channel, not personal iMessage. Details below.

### Apple Messages for Business — what it actually is (and why it does NOT fit)

AMB (formerly "Business Chat") lets a **registered business** converse with **its customers** through an approved third party. Key structural facts, each of which independently disqualifies the "text my own agent" use case:

- **Business↔customer only, gray bubbles.** AMB messages render in a distinct **gray** bubble to mark them as corporate communications — a *separate system from personal iMessage that doesn't use the same protocol*. Your agent would not be a normal blue-bubble contact. ([Twilio](https://www.twilio.com/en-us/blog/products/launches/the-power-of-the-grey-bubble--why-apple-messages-for-business-is); gray-bubble framing also in [Lindy](https://www.lindy.ai/blog/imessage-api-three-rewrites-one-apple-ban-and-what-actually-works))

- **MSP-gated + approval process.** You can't integrate directly — you must go through an Apple-approved **Messaging Service Provider (MSP)**, and the brand account itself goes through an Apple approval that "can take a few days." Becoming an MSP is a heavy onboarding bar: full feature integration (List Pickers, rich objects, bot-management GUIs), CRM/OMS back-end connectors, asynchronous routing, and at least one live client actively using AMB. ([Apple — MSP Onboarding](https://register.apple.com/resources/messages/msp-onboarding/); [Apple — Messages for Business REST API](https://register.apple.com/resources/messages/msp-rest-api/); [Apple — End-to-end Overview](https://register.apple.com/resources/messages/messaging-documentation/end-to-end))

- **Customer initiates; identity is opaque.** Historically the **customer must send the first message**, and the business never receives the user's phone number / email / iCloud — only an anonymized **opaque ID** scoped to that conversation. ([Apple FAQ](https://register.apple.com/resources/messages/messaging-documentation/faq); [Twilio](https://www.twilio.com/en-us/blog/products/launches/the-power-of-the-grey-bubble--why-apple-messages-for-business-is))

- **2024–2025 change (noted, still doesn't help).** Apple added **Business Updates** + **Invitations** (mid-Sept 2024) letting approved businesses *proactively* message customers — but only for **approved use cases**, only where the customer already **consented and shared their number**, and still as a registered business. This loosens outbound for vetted brands; it does **nothing** for an individual wanting to DM their own agent. ([Quiq — Business Updates](https://quiq.com/blog/apple-messages-for-business-update/); [Messaging Advisory — Invitations](https://www.messagingadvisory.com/post/apple-messages-invitations-a-new-chapter-for-apple-messages-for-business))

- **No webhooks / arbitrary handling.** Even where AMB is reachable, a 2026 build guide characterizes it as template-driven with "**no webhooks or custom message handling**." ([Claw Messenger — iMessage bot, 2026](https://www.clawmessenger.com/blog/imessage-bot))

**Verdict on official:** AMB is the wrong tool — it's a vetted-business customer-support pipe, not a personal messaging API. An honest read of Apple's own docs confirms it **cannot** let "you text your own personal AI agent as a normal iMessage." Nothing in the 2025/2026 changes (Business Updates, RCS adoption, EU DMA pressure) opens a personal-iMessage programmatic surface; RCS interop and DMA pressure are about cross-platform/green-bubble and gatekeeper obligations, not a sanctioned personal-iMessage automation API.

## 2. Unofficial bridges — the only real path

Every working approach is the same shape: **run software on a Mac that's signed into the target Apple ID**, read inbound by watching `~/Library/Messages/chat.db` (the SQLite store, often via its `-wal` write-ahead log), and send outbound via **AppleScript** (basic) and/or **private Objective-C frameworks** (richer: tapbacks, edits, effects). They differ in what they expose to an external consumer and how invasive the send path is.

### BlueBubbles (the strongest fit)

- **Architecture:** TypeScript server app on macOS. Reads inbound by **polling `chat.db`**; sends via **AppleScript** for basics, with an optional **Private API bundle** (native Objective-C into Messages) for deeper features. ([BlueBubbles docs — server overview](https://docs.bluebubbles.app/server); [WebSearch summary, BlueBubbles architecture](https://github.com/BlueBubblesApp/bluebubbles-server))
- **API it exposes (what an adapter consumes):** a **REST API** under `$SERVER/api/v1` with **password/`guid` query-param auth**, plus **outbound webhooks** (10 event types incl. "New Messages") that POST to a URL you register, and a **Socket.IO** interface. Concretely: `POST /message/text` (send; needs `chatGuid` like `any;-;+1555…`, a `tempGuid`, text), `GET /message` / `POST /chat/query` / `GET /chat/:guid/message` (read), and `POST /webhook` to register a receiver; webhook payload carries `data.text`, `data.handle.address` (sender), `data.isFromMe`, `data.chats[0].guid`. ([BlueBubbles — REST API & Webhooks](https://docs.bluebubbles.app/server/developer-guides/rest-api-and-webhooks); [Setup & API gist](https://gist.github.com/hmseeb/e313cd954ad893b75433f2f2db0fb704); [Postman collection](https://documenter.getpostman.com/view/765844/UV5RnfwM))
- **macOS + permissions:** macOS 10.15+ (Catalina+), Apple ID active in Messages, **Full Disk Access REQUIRED** (to read `chat.db`), **Accessibility** for Private API features; remote access via Cloudflare/ngrok/Dynamic-DNS tunnels. ([Setup gist](https://gist.github.com/hmseeb/e313cd954ad893b75433f2f2db0fb704))
- **Health:** **actively maintained** — latest server **v1.9.9, 2025-05-16**, ~992★, ~1,762 commits. **License: Apache-2.0.** ([GitHub — bluebubbles-server](https://github.com/BlueBubblesApp/bluebubbles-server)) Caveat: a 2026 guide notes Apple **disabled BlueBubbles' developer certificate** so the app ships unsigned (an install-friction / trust signal, not a functional block). ([Claw Messenger, 2026](https://www.clawmessenger.com/blog/imessage-bot))

### AirMessage

- **Architecture:** native Mac relay server (legacy build was Java/jOOQ/SWT). Bridges iMessage to AirMessage clients; designed around **AirMessage Connect** (a relay you can self-host the open version of at `connect-open.airmessage.org`). It's built for *its own client apps*, not as a general REST surface for third-party adapters. ([GitHub — airmessage-server](https://github.com/airmessage/airmessage-server); [Install guide](https://airmessage.org/install/))
- **Health:** **likely maintenance-mode** — latest release **v4.1.4, 2024-10-19**; a tight Jul–Oct 2024 burst, then quiet. ([Releases](https://github.com/airmessage/airmessage-server/releases))
- **Fit:** weak for us — no clean documented REST/webhook contract to consume; you'd be coupling to its client-relay protocol. Not recommended over BlueBubbles.

### mautrix-imessage

- **Architecture:** a **Matrix↔iMessage puppeting bridge** (Go). Normal-Mac mode uses **AppleScript send + SQLite read + Contacts.framework**; a richer mode uses **Barcelona** to hook Apple's **private frameworks**, which **requires disabling SIP and AMFI**; also jailbroken-iOS (Brooklyn) and android-sms variants. Needs **a dedicated Mac** and a websocket proxy for appservice events. **License: AGPL-3.0.** ([GitHub — mautrix/imessage](https://github.com/mautrix/imessage); [mautrix docs — imessage](https://docs.mau.fi/bridges/go/imessage/index.html))
- **Fit for us:** poor *as a direct adapter target* — its "API" is the **Matrix protocol**, not a plain REST/webhook. We'd stand up a Matrix homeserver just to bridge into it, then write a Matrix client. That's a lot of moving parts for a single-user agent inbox. (It's the right tool if you *want* a Matrix ecosystem; we don't.) The AGPL also colors any tight coupling.

### Newer 2026 entrants (worth knowing)

- **beeper/platform-imessage** (Beeper/Automattic) — a **standalone Swift library + CLI** to send/receive/automate iMessage **locally, with SIP enabled**, reading `chat.db` and driving Automation/Accessibility APIs (not private-framework hooks). **Very active** (v0.24.3, **2026-06-06**; ~1,598 commits). **License: MIT.** Exposes a **CLI (JSON/YAML output) + Swift package + Node/TS bindings** — i.e. a local automation seam rather than a network API. ([GitHub — beeper/platform-imessage](https://github.com/beeper/platform-imessage))
- **steipete/`imsg`** — a `chat.db`-read-only CLI reaching a BlueBubbles-equivalent private-API surface; referenced by agent harnesses (OpenClaw) that have **deprecated BlueBubbles support in favor of driving `imsg` directly** over JSON-RPC, partly due to macOS schema churn. Honest about brittleness: "can get brittle after system updates, privacy permission resets, or database schema changes." ([OpenClaw — coming from BlueBubbles](https://docs.openclaw.ai/channels/bluebubbles); [openclaw/imsg](https://github.com/openclaw/imsg))
- **Managed APIs (no Mac you run):** Sendblue, Loop/LoopMessage, Linq, Claw Messenger — they run the Macs/Apple-IDs/anti-spam for you behind a REST/WebSocket API. ([Sendblue](https://www.sendblue.com/api); [LoopMessage](https://loopmessage.com/); [Claw Messenger](https://www.clawmessenger.com/blog/imessage-bot)) These move the ToS/ban/ops burden to a vendor — at the cost of routing your messages through a third party (a serious privacy/sovereignty tradeoff for a "Sovereign AI" harness) and a recurring bill.

## Options matrix

| Option | What it is | API an adapter consumes | Mac required? | Maintenance (2026) | License | ToS / ban risk | Fits "text my own agent"? |
|---|---|---|---|---|---|---|---|
| **Apple Messages for Business** | Sanctioned business↔customer channel | MSP REST API (gated) | No | Apple (official) | Apple terms | None (it's sanctioned) | **No** — business-only, gray bubble, MSP-gated, customer-initiates |
| **BlueBubbles** | OSS Mac server | **REST + webhooks + Socket.IO**, password auth | **Yes (dedicated)** | **Active** (v1.9.9, 2025-05) | Apache-2.0 | **High** (automates personal Apple ID) | **Yes** (best fit) |
| **AirMessage** | OSS Mac relay for its own clients | Client-relay protocol (no clean REST) | **Yes** | Maintenance-mode (v4.1.4, 2024-10) | OSS | **High** | Technically yes, poor adapter fit |
| **mautrix-imessage** | Matrix puppeting bridge | **Matrix protocol** (needs homeserver) | **Yes** | Active | AGPL-3.0 | **High** (worse w/ SIP off) | Yes, but heavy indirection |
| **beeper/platform-imessage** | Local Swift lib + CLI (SIP on) | **CLI / Swift / Node bindings** (local) | **Yes** | **Very active** (2026-06) | MIT | **High** | Yes (would need a local-exec or thin HTTP shim) |
| **Managed API** (Sendblue / Loop / Linq / Claw) | Vendor runs the Macs | Vendor REST/WebSocket | No | Vendor | Commercial | Vendor-absorbed (but they can be banned) | Yes — at cost of $$ + routing msgs through a third party |

## Recommended approach (if we proceed at all)

**BlueBubbles is the right bridge** for a self-hosted, sovereignty-respecting integration: it's actively maintained, Apache-2.0, and — uniquely among the OSS options — exposes a **plain REST + webhook + Socket.IO** contract that maps cleanly onto our `ChannelAdapter`. AirMessage and mautrix expose the wrong shape (client-relay / Matrix); the newer local libs (beeper/`imsg`) are excellent but expose a *local CLI/library*, not a network API, so an adapter would need a co-located shim. Keep beeper/`imsg` on the radar as a fallback if BlueBubbles' macOS-version compatibility degrades.

Within BlueBubbles, prefer the **outbound-webhook** intake (real-time, no busy-poll) when the Mac and the harness can reach each other, with a **poll fallback** (`GET /message` cursor) when only the harness can dial out to the Mac (e.g. via a tunnel) — mirroring how our Telegram adapter long-polls `getUpdates`.

## Phase-F integration sketch

The harness side is small and slots into the existing contract with no core changes. Mapping to what's already in `src/channels/`:

- **`InboundMessage`** (`src/channels/types.ts`): `channel: 'imessage'`, `sender = data.handle.address` (the Apple handle — phone/email), `chatId = data.chats[0].guid` (the BlueBubbles chat GUID, e.g. `any;-;+1555…`), `chatType: 'private' | 'group'`, `text = data.text`, `raw = <bluebubbles payload>`. This feeds `buildSessionKey(msg)` → a continuous per-(channel,sender) session exactly like Telegram/Slack.

- **`ChannelAdapter.verify(input)`** (`src/channels/adapter.ts`): two responsibilities. (1) **Authenticate the bridge→harness call** — BlueBubbles webhooks don't HMAC-sign by default, so the adapter authenticates via a shared secret on the receiving route (a path token / header we control on our `/channels/imessage/...` endpoint) plus optionally pinning the source; treat the bridge as a trusted *local* peer behind the tunnel. (2) **Parse** the BlueBubbles payload → `InboundMessage`, dropping `isFromMe === true` (echo-loop guard, same as Telegram's `from.is_bot` skip) and non-text events.

- **`ChannelAdapter.deliver(reply, msg, transport)`**: `POST $SERVER/api/v1/message/text?password=…` with `{ chatGuid: msg.chatId, tempGuid: <uuid>, message: reply }`. The `transport` is an injectable BlueBubbles REST client (mockable in tests, exactly like `TelegramTransport`).

- **Two intake topologies** (both already have precedent in Phase F):
  - **Webhook intake** (preferred): a gateway route `POST /channels/imessage/:secret` (open + adapter-verified, mounted like the Slack/webhook routes per D4/D5) that the BlueBubbles server POSTs to. Synchronous-ack then run the turn + `deliver`.
  - **Poll intake** (fallback): a `.unref()`'d loop calling `GET /message` with a stored cursor → parse → `runChannelTurn` → `deliver` — a near-verbatim clone of `src/channels/adapters/telegram.ts`.

- **`runChannelTurn` is reused unchanged** (`src/channels/pipeline.ts`): find-or-create the session owned by the iMessage principal, headless turn under the **safe channel posture**, capture reply, `[SILENT]`/empty → no send, dispose-context-in-`finally`. Memory + recall participate automatically.

- **Config** (`gateway.channels`, per D8): `imessage?: { enabled?, principalId, permissionMode?, serverUrl, password, webhookSecret?, allowedSenders: string[] }`, secrets env-first (`SOV_IMESSAGE_PASSWORD`, etc.). Validation reuses Phase F's rules: `principalId` must exist in `gateway.principals`; `permissionMode: 'bypass'` rejected.

### The security crux: sender allow-list

An Apple handle is **just an identifier** — anyone who knows the bridge's number can text it, and inbound is unauthenticated at the iMessage layer. So unlike a Slack signing secret or a Telegram bot scoped to a chat, **iMessage has no cryptographic sender authentication.** The mitigation is mandatory and explicit:

- **`allowedSenders` is REQUIRED and enforced in `verify`** — a strict allow-list of Apple handles (normalized phone/email). Any inbound from a sender not on the list is **dropped before `runChannelTurn`** (no row, no turn, no billable provider call). An empty/absent allow-list = the channel refuses to run (fail-closed), *not* "allow all." This is stricter than the other channels precisely because the transport offers no sender proof.
- **Phase-E principal isolation still applies:** the iMessage channel maps to its own principal; its sessions, memory, and learning are isolated, and it never inherits a local dev's allow-rules (`buildChannelCanUseTool` in `src/channels/permission.ts`). Even an allow-listed sender drives a turn that **cannot run `Bash`/`Write`/`Edit` by default** — the Phase-F safe posture holds.
- Net: two independent gates — *is this sender allow-listed?* (custom to iMessage) and *the safe-by-default tool posture* (inherited from Phase F). Both must pass.

### Hosting

The **BlueBubbles server runs on the Mac** (signed into the Apple ID, Full Disk Access). The **harness adapter** can be either **co-located on that same Mac** (simplest — `localhost` between bridge and gateway, no tunnel) or **remote** (the gateway elsewhere, reaching the Mac over a Cloudflare/ngrok/Tailscale tunnel; webhook intake then needs the Mac able to reach the gateway, or use poll intake so only the gateway dials out). Co-locating the gateway on the Mac is the cleanest single-box deployment.

## Operational requirements + risks (the real cost)

1. **A dedicated, always-on Mac signed into the Apple ID.** Practically a Mac mini that stays awake, unlocked enough for Messages to run, with the Apple ID you want the agent to "be." This is the dominant cost — hardware + power + a babysat box. ([mautrix docs require "a dedicated Mac"](https://docs.mau.fi/bridges/go/imessage/index.html); BlueBubbles implies continuous operation.)

2. **Full Disk Access + Accessibility grants.** The bridge reads the entire Messages database and (for Private API) drives Messages via Accessibility — broad local privilege on that machine. ([Setup gist](https://gist.github.com/hmseeb/e313cd954ad893b75433f2f2db0fb704))

3. **Apple-ID ban risk — real, documented, no appeal.** Automating a personal Apple ID **violates Apple's ToS** ("Apple's ToS prohibit automated messaging on personal accounts" — [Claw Messenger, 2026](https://www.clawmessenger.com/blog/imessage-bot)). Lindy's production account was **permanently banned within hours of launch**, with the post-mortem citing "a brand-new Apple account, high message volume on launch day, relatively low recipient diversity, and a heavily lopsided send-to-receive ratio," against an enforcement system that is "a black box with no published rate limits… no documentation on what triggers a ban, and no appeals process." ([Lindy](https://www.lindy.ai/blog/imessage-api-three-rewrites-one-apple-ban-and-what-actually-works)) For a *single-user personal agent* the risk profile is far milder than a launch-day blast (low volume, you-to-you), but it is **non-zero and unappealable** — budget a **burner Apple ID**, not your primary.

4. **Fragility — macOS updates break the bridge.** The read/send path is reverse-engineered against Apple internals, so OS updates break it. A concrete, current example: **macOS Tahoe (26.x)** changed Messages to create chats with an `any;-;` GUID prefix instead of `iMessage;-;`, breaking chat lookups for tools that assumed the old prefix. ([openclaw/openclaw#83375](https://github.com/openclaw/openclaw/issues/83375); fragility also called out generally — "can get brittle after system updates, privacy permission resets, or database schema changes," [openclaw/imsg](https://github.com/openclaw/imsg); "breaks with macOS updates, no official support," [Claw Messenger](https://www.clawmessenger.com/blog/imessage-bot)). Expect to **pin the macOS version and defer updates**, and to occasionally wait for the bridge maintainers to catch up after an Apple change.

5. **Security blast radius.** The bridge has **full access to every message on that Apple ID** and credentials to send as it. If the harness adapter or the Mac is compromised, so is the entire iMessage history. Keep the Apple ID dedicated, the Mac hardened, and the tunnel locked down.

6. **Reliability/deliverability.** Best-effort. Per-Apple-ID throughput is modest (Lindy cites ~**100–500 messages/hour**; fine for a personal agent), delivery depends on Messages.app actually running (Lindy literally health-checked `messagesAppRunning`), and there's no SLA.

## Effort estimate (calibrated)

Per the repo's estimation convention (sessions/dispatches/wall-minutes; subagent work runs ~5–10× human-time):

- **Harness adapter (the code):** **small — ~1 focused session / 1 subagent dispatch.** It's a near-clone of the Telegram adapter plus a BlueBubbles REST client and a sender allow-list in `verify`. Pattern, pipeline, config validation, and tests-against-injected-transport all already exist from Phase F. Estimate **~3–6 wall-hours** of subagent build incl. tests, the `gateway.channels.imessage` config block, and docs. This part is genuinely cheap.

- **The Mac/bridge/ops (the real cost):** **NOT a coding estimate — it's a standing commitment.** Procuring/dedicating a Mac, a burner Apple ID, BlueBubbles install + Full Disk Access + Private API + tunnel, then **ongoing** babysitting through macOS updates and possible Apple-ID friction. This is days of initial setup spread over calendar time **plus indefinite maintenance**, and it never goes to zero. **This dwarfs the adapter work and is the entire reason this is a hard call.**

## Founder go/no-go

**Lean: NO-GO by default. Conditional GO only if a concrete, durable need justifies a dedicated Mac + a burner Apple ID + accepting unappealable ban risk and ongoing fragility.**

The tradeoff, plainly:

- **The harness work is trivial** — a thin adapter we could ship in a session. If the only question were "can the framework absorb iMessage cleanly?", the answer is an easy yes, and Phase F was designed for exactly this.
- **But the framework cost isn't the cost.** The cost is a babysat always-on Mac, a burner Apple ID you're willing to lose, broad local privilege, and a read/send path that Apple breaks on its own schedule (Tahoe's GUID change is this quarter's example). For a "Sovereign AI" harness, the managed-API shortcut (Sendblue/Loop/Linq) also conflicts with the sovereignty thesis by routing your messages through a third party.
- **Cheaper substitutes already deliver most of the value.** **Telegram is shipped today** (zero extra hardware, a free bot, cryptographically scoped) and gives you "text my agent from my phone" right now. The **generic webhook adapter + an iOS Shortcut** ("Hey Siri, ask my agent…") is another zero-Mac path to phone-driven access. Both avoid the dedicated-Mac/ban/fragility tax entirely.

**Recommendation:** keep this spec as the on-ramp, but **don't build it speculatively.** Build it only when a specific, lasting requirement demands *iMessage specifically* (e.g., reaching iMessage-only contacts, or a hard "must be a blue bubble" constraint) — and when that day comes, the build is small; provisioning the Mac is the gate. Until then, point the felt need at **Telegram or the webhook+Shortcut path.**

## Sources

- Apple — [Messages for Business: MSP Onboarding](https://register.apple.com/resources/messages/msp-onboarding/) · [MSP REST API](https://register.apple.com/resources/messages/msp-rest-api/) · [End-to-end Overview](https://register.apple.com/resources/messages/messaging-documentation/end-to-end) · [FAQ](https://register.apple.com/resources/messages/messaging-documentation/faq)
- Apple Developer — [Messages framework](https://developer.apple.com/documentation/Messages) · [iMessage Apps](https://developer.apple.com/imessage/)
- [Twilio — The Power of the Grey Bubble](https://www.twilio.com/en-us/blog/products/launches/the-power-of-the-grey-bubble--why-apple-messages-for-business-is)
- [Quiq — Apple Business Updates (proactive)](https://quiq.com/blog/apple-messages-for-business-update/) · [Messaging Advisory — Invitations](https://www.messagingadvisory.com/post/apple-messages-invitations-a-new-chapter-for-apple-messages-for-business)
- [Lindy — iMessage API: Three Rewrites, One Apple Ban, and What Actually Works](https://www.lindy.ai/blog/imessage-api-three-rewrites-one-apple-ban-and-what-actually-works)
- BlueBubbles — [Server overview](https://docs.bluebubbles.app/server) · [REST API & Webhooks](https://docs.bluebubbles.app/server/developer-guides/rest-api-and-webhooks) · [GitHub server repo](https://github.com/BlueBubblesApp/bluebubbles-server) · [Setup & API gist](https://gist.github.com/hmseeb/e313cd954ad893b75433f2f2db0fb704) · [Postman collection](https://documenter.getpostman.com/view/765844/UV5RnfwM)
- AirMessage — [GitHub server](https://github.com/airmessage/airmessage-server) · [Releases](https://github.com/airmessage/airmessage-server/releases) · [Install guide](https://airmessage.org/install/)
- mautrix-imessage — [GitHub](https://github.com/mautrix/imessage) · [Docs](https://docs.mau.fi/bridges/go/imessage/index.html)
- [beeper/platform-imessage (GitHub)](https://github.com/beeper/platform-imessage)
- OpenClaw — [Coming from BlueBubbles](https://docs.openclaw.ai/channels/bluebubbles) · [openclaw/imsg](https://github.com/openclaw/imsg) · [macOS Tahoe GUID-prefix issue #83375](https://github.com/openclaw/openclaw/issues/83375)
- [Claw Messenger — How to Build an iMessage Bot in 2026](https://www.clawmessenger.com/blog/imessage-bot)
- Managed APIs — [Sendblue](https://www.sendblue.com/api) · [LoopMessage](https://loopmessage.com/)

# Run-Anywhere, Persistent, Multi-Channel Harness — Roadmap Design Spec

**Date:** 2026-06-05
**Status:** Draft (high-level roadmap; subordinate specs + plans authored incrementally per phase)
**Relationship:** Builds the **multi-channel gateway** differentiator named in ADR H-0010 (`~/code/sovereign-ai-docs/harness/decisions/0010-...`). Orthogonal to and parallel with the learning-loop soak (`docs/state/2026-06-04-learning-loop-spike-phase-1.md`) — the learning layer rides on top unchanged. Governed by `docs/conventions/autonomous-feature-builds.md`.

---

## Goal

Turn the harness from a **single-user, terminal-only, per-invocation** tool into a **run-anywhere, persistent, multi-channel runtime base** — installable on an arbitrary system and drivable from any interface (web app, iOS app, Slack, Telegram, the existing TUI, the OpenAI API) — that can be stood up as a **good-enough, owned, general-purpose Layer-2 harness for arbitrary use cases** without writing one from scratch each time.

This explicitly does **not** aim to out-velocity community frameworks like deepagents. It aims to be a **maintainable, quality, owned base** whose value is sovereignty + the differentiators (learning layer, task routing, local-model policy, gateway, bundle-as-data), not breadth of plumbing.

## Strategic framing (why this is consistent with H-0010, not a reversal)

- H-0010 says **rent the commodity agent-core plumbing, OWN the differentiators.** The **multi-channel gateway is one of the four named differentiators to own.** This roadmap builds that differentiator.
- **Engine-agnostic by construction.** Every gateway/persistence/channel piece talks to the agent runtime through the existing **HTTP+SSE protocol seam** (`src/server/schema.ts` + the routes), never the runtime's internals. So — exactly like the portable learning layer's four-port contract — the gateway survives a future agent-core swap (deepagents or a TS engine): you'd re-point the protocol adapter, not rebuild the gateway. **The protocol is the seam.**
- Therefore this track and the "rent vs build the core" question (the learning-loop spike's Phase 2) are **decoupled**: the gateway is built above the seam regardless of which engine eventually sits below it.

## Current state (the starting line — verified 2026-06-05)

The runtime is **already decoupled from the UI** (Phase 16.1): a per-invocation localhost Hono HTTP+SSE server hosts the runtime; the Go TUI, `sov drive`, and the OpenAI API server (`sov serve`) are all clients of it. What's missing for "run-anywhere/persistent/multi-channel":

| Capability | State today |
|---|---|
| UI ↔ runtime decoupling | ✅ done (HTTP+SSE protocol; 3 client surfaces prove it) |
| Native server remote-reachable | ❌ hard-bound `127.0.0.1`, no host override |
| Native server auth/authz | ❌ none (loopback-only by design); no CORS |
| Multi-client per session | ❌ single-subscriber bus; bus disposed on `turn_complete`; no reconnect/replay |
| Persistent multi-session server | ⚠️ partial — `sov serve` (OpenAI API) is persistent + auth'd + host-configurable but **stateless**; the native protocol has no persistent multi-session host; the **daemon (`src/daemon/`) is a built-but-dormant skeleton** |
| Always-on background activity | ✅ cron tick (default-on, in every runtime) |
| Multi-user / multi-tenant | ❌ single-user; memory scoped by project + profile only |
| Channel adapters (Slack/Telegram/web) | ❌ contract types only (`src/channels/`); no adapter, no inbound path |
| Reference non-terminal UI | ❌ none (TUI is the only interactive client) |

The OpenAI server (`sov serve`) already solves binding + auth + persistence for the **stateless completion** use case; the gap is the **rich, stateful, interactive native protocol** (permission prompts, tool events, slash/skills) over a secure, multi-client, persistent, multi-user, multi-channel surface.

## Design principles

1. **Gateway above the seam.** All new surfaces are clients of the HTTP+SSE protocol (or extend the server), never of runtime internals — keeps it engine-agnostic.
2. **Security-first for remote exposure.** The harness runs Bash + file tools; exposing it remotely is a real attack surface. Auth, authz, per-principal permission policy, and sane defaults (loopback unless explicitly opened) are non-negotiable, not bolt-ons.
3. **Modular + incremental.** Each phase is an independently shippable module with its own spec + plan + release, dependency-ordered so each build informs the next.
4. **Reuse, don't reinvent.** Extend the existing Hono server, the `sov serve` auth pattern, the dormant daemon skeleton, the channel-adapter contract, and the SQLite session model rather than greenfielding.
5. **Backward-compatible defaults.** The default `sov` (local TUI) experience is unchanged; every remote/persistent/multi-user capability is opt-in via config/flags.

## Module hierarchy

```
Run-anywhere harness
├── Tier 0 — Secure gateway core (the unlock)
│   ├── M1  Remote-exposable, authenticated gateway        (host bind + auth + CORS on the native protocol)
│   ├── M2  Multi-client session transport                 (multi-subscriber bus + reconnect-with-replay)
│   └── M3  Persistent multi-session server / supervisor   (always-on host owning many concurrent sessions)
├── Tier 1 — Identity & isolation
│   ├── M4  Multi-user identity + authz                     (per-principal auth, session ownership)
│   └── M5  Multi-user state scoping                        (user dimension in memory + sessions)
├── Tier 2 — Channels
│   ├── M6  Channel-adapter framework activation            (inbound ingestion → session routing → outbound)
│   └── M7  First channel adapters                          (Slack, Telegram, generic webhook/WebSocket)
├── Tier 3 — Clients
│   └── M8  Reference web UI                                (browser chat against the rich native protocol)
└── Cross-cutting (every phase)
    ├── X1  Security posture                                (per-principal/per-channel permission policy, sandboxing)
    ├── X2  Packaging & deploy                              ("install anywhere" — service/daemon install, config)
    └── X3  Config, docs, tests
```

## Prioritized phase roadmap (ordered by dev-effort leverage)

Ordering rule (per your "prioritize with respect to dev effort"): do the **cheapest high-leverage unlocks first**, respecting hard dependencies, so value lands early and each phase builds on the last. Effort is in subagent **dispatches** + rough token magnitude (per `docs/conventions/estimation.md`; subagent pace per the calibration memory).

### Phase A — Secure remote gateway (M1) · ~5–7 dispatches · ~250–350K
**✅ Shipped v0.6.17 (2026-06-05).** The `sov gateway` long-lived entrypoint serves the native HTTP+SSE protocol off-loopback with bearer auth + configurable host bind (loopback default) + CORS + a refuse-to-boot-when-exposed-without-auth guard; the TUI/serve/drive paths are byte-unchanged (auth/CORS are options-gated middleware). Security-reviewed **secure-to-ship**. See `docs/specs/2026-06-05-phase-a-secure-remote-gateway-design.md` (spec), `docs/plans/2026-06-05-phase-a-secure-remote-gateway.md` (plan), and `docs/state/2026-06-05-phase-a-gateway.md` (close-out).

**The unlock.** Make the native HTTP+SSE protocol reachable + safe off-loopback. Add a configurable host binding (default still `127.0.0.1`), a bearer-token auth layer (mirror the proven `sov serve` pattern: env > config > refuse-to-boot-when-exposed), CORS, and a `sov gateway` (or `sov serve --native`) long-lived entrypoint. Single-user, single-token to start.
**Depends on:** nothing. **Exit:** a remote client can authenticate and drive a full turn (incl. permission round-trip) over the network; loopback default + tests + a release.

### Phase B — Multi-client session transport (M2) · ~4–6 dispatches · ~200–300K
Replace the single-subscriber, dispose-on-turn-complete event bus with a **multi-subscriber bus + a bounded ring buffer + `Last-Event-ID` reconnect-with-replay**, so multiple devices can watch one session and a dropped mobile connection recovers mid-turn.
**Depends on:** A. **Exit:** two clients observe the same session concurrently; a client that disconnects mid-turn reconnects and replays missed events; tests + release.

### Phase C — Reference web UI (M8) · ~5–7 dispatches · ~250–400K
A minimal but real **browser chat client** against the rich native protocol (turns, streaming, tool cards, permission prompts, slash commands). Proves "any UI" end-to-end and becomes the dogfood client for everything after. (Frontend-design skill applies.) Ships as a static client served by the gateway.
**Depends on:** A, B. **Exit:** drive the harness from a browser over the network, including approving a permission prompt; tests + release.

### Phase D — Persistent multi-session supervisor (M3) · ~6–9 dispatches · ~350–500K
The always-on backbone: a long-lived server that **owns many concurrent sessions across clients** (not one-runtime-per-TUI), with session lifecycle (create/resume/evict), backed by the existing SQLite model. Decide: activate/repurpose the dormant `src/daemon/` skeleton vs. extend the native gateway into the supervisor. Folds the cron tick + (later) channel listeners under one supervised process.
**Depends on:** A, B. **Exit:** one process serves many simultaneous sessions/clients across restarts; the TUI/web/API all attach to it; tests + release.

### Phase E — Multi-user identity + state scoping (M4 + M5) · ~8–12 dispatches · ~500–700K
Per-principal auth (tokens/JWT, multiple users), **session ownership + authz** on the native protocol, and the **user dimension in memory + sessions** (resolves the standing "multi-user memory" blocker). Security-sensitive — gets adversarial review.
**Depends on:** A, D. **Exit:** two users have isolated sessions + memory through the same gateway; no cross-user access; security review + tests + release.

### Phase F — Channel framework + first adapters (M6 + M7) · ~8–12 dispatches · ~500–700K
Activate the channel-adapter contract: an **inbound ingestion path** (`InboundMessage` → `buildSessionKey` routing → turn → outbound delivery), hosted by the supervisor (D), authorized per user (E). Ship **Slack + Telegram** adapters and a **generic webhook/WebSocket** adapter, each with its own permission posture (X1).
**Depends on:** D, E. **Exit:** a Slack and a Telegram message each drive a real session and get a reply; tests + release.

**Cross-cutting (X1–X3) run inside every phase**, not as separate phases: each phase ships its security posture, config surface, docs, and tests.

### Dependency graph
```
A ──> B ──> C            (browser UI on a secure, robust transport)
 \     \
  \     └─> D ──> E ──> F   (persistent supervisor → multi-user → channels)
   └────────> D
```
A is the root unlock. A→B→C delivers the first visible "run-anywhere from a browser" milestone fast. D/E/F build the persistent, multi-user, multi-channel backbone.

## Cross-cutting concerns

- **X1 — Security posture.** Remote exposure of a tool-running agent is the central risk. Each surface ships: auth required when non-loopback (refuse to boot otherwise), per-principal/per-channel permission policy (a remote/Slack principal must NOT inherit a local dev's `allow Bash(*)`), and an explicit trust model documented per phase. Phase E gets an adversarial security review.
- **X2 — Packaging & deploy.** "Install anywhere" = the existing single-binary + a documented **service install** (run the supervisor as a background service) + a config story for host/port/auth/users/channels. Lands incrementally (A defines the entrypoint; D makes it a service).
- **X3 — Config, docs, tests.** Every phase extends `src/config/schema.ts`, updates `docs/`, and ships unit + integration + (where behavioral) semantic tests, per the autonomous-build convention.

## Out of scope / reserved

- **Native iOS/Android apps.** The gateway (A+B) makes them buildable, but the mobile app itself is a separate client project, not the harness repo. The roadmap delivers the *server contract* they'd target; a reference *web* client (C) is the in-repo proof.
- **Horizontal scale / clustering** (multiple supervisor nodes, shared session store across hosts) — single-node first; revisit only if a use case demands it.
- **Founder-reserved:** the agent-core rent-vs-build decision (learning-loop spike Phase 2) — independent of this track; and whether to host this as a managed multi-tenant service vs. self-hosted-only (affects how hard E must go on isolation).

## Execution approach

Per `docs/conventions/autonomous-feature-builds.md`, **incrementally**:
1. This roadmap spec (committed) is the organizing artifact.
2. For each phase in order: write the detailed spec (`docs/specs/`) → self-review → write the build plan (`docs/plans/`) → execute autonomously (subagent-driven) → ship (docs + tests + commit/push + `sov upgrade` + release) → let the shipped phase inform the next phase's spec.
3. The learning-loop soak continues untouched in parallel; gateway work must not disable recall/capture.

Each phase is independently valuable and independently shippable — the program can be paused after any phase with a coherent, released increment.

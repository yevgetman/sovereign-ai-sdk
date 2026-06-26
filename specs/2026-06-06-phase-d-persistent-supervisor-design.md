# Phase D — Persistent Multi-Session Supervisor — Design Spec

**Date:** 2026-06-06
**Status:** Draft (pre-implementation)
**Parent roadmap:** `specs/2026-06-05-run-anywhere-harness-roadmap-design.md` (Phase D / module M3). **Depends on Phase A** (gateway, v0.6.18) **+ Phase B** (multi-client transport, v0.6.19) **+ Phase C** (web UI, v0.6.20).

## Goal

Make the gateway a **sound always-on backbone**: a long-lived process that owns many concurrent sessions across clients **without leaking memory**, with explicit **session lifecycle** (list / delete / idle-evict) and a **concurrency bound**, backed by the existing durable SQLite model so sessions survive restarts. This closes Phase B's deferred D9 (idle-session bus eviction) and the noted carry-forward (interactive `buses`/`sessionContexts` maps accumulate until shutdown).

## What already exists (verified 2026-06-05/06 — the starting line)

The gateway is **already** a persistent multi-session host. These are NOT Phase D work:

- **Long-lived process** — `runGateway` parks forever; SIGINT/SIGTERM → `server.stop()` + `runtime.dispose()` (`src/cli/gatewayCommand.ts:137-161`).
- **Many concurrent sessions** — per-session `runtime.sessionContexts: Map` (`runtime.ts:442`, lazy via `getSessionContext` `:449`) + per-session module-level `buses: Map` (`eventBus.ts:229`, lazy via `getOrCreateBus`).
- **Durable + resumable** — every session is a SQLite row (`sessionDb.createSession`); `getSession`/`listSessions` exist; **resume-by-id already works** (`buildRuntime({ resumeId })` validates the row; in-memory context rebuilds lazily on first `getSessionContext`). So "survives restarts" is a property of the existing durable model + lazy rebuild.
- **Cron tick already supervised** — runs in the gateway's runtime (`cronEnabled !== false`).

## The actual gaps (Phase D scope)

1. **No reclamation.** Every session that runs a turn creates a context + bus that lives until full shutdown. A long-running gateway leaks one context + one bus (each holding a bounded ring + subsystems) per session, forever.
2. **No lifecycle routes** — no `GET /sessions` (list), no `DELETE /sessions/:id`.
3. **No concurrency bound** — unbounded session creation on a remotely-exposed, tool-running host (a DoS surface; principle #2 "security-first for remote exposure").
4. **Restart-resume is untested through the gateway** (the capability exists; Phase D proves + documents it).
5. **No "run as a service" deploy story** (cross-cutting X2 — "D makes it a service").

## Design principles for this phase

- **Reuse, don't reinvent (KISS).** Extend the gateway; do **not** resurrect the dormant `src/daemon/` skeleton (it would reinvent what the gateway already does).
- **Eviction is graceful + transparent.** Reclaiming an idle session flushes its learning/trace/trajectory (not a hard kill) and leaves the durable row intact — the session resumes lazily on the next request. No client ever loses an active turn or stream.
- **Backward-compatible + gateway-scoped.** The supervisor is constructed only in the gateway boot path; the TUI / `sov drive` / `sov serve` paths are byte-unchanged.
- **Deterministic.** The sweep uses an injectable clock (mirrors `CronRunner`'s fake-clock testability) and an `unref()`'d interval (mirrors the cron tick) so tests never hang.

## Locked design decisions

| ID | Decision |
|---|---|
| **D1** | **Extend the gateway into the supervisor; do NOT resurrect `src/daemon/`.** The gateway already parks forever, owns many concurrent sessions, persists them durably, and hosts the cron tick — Phase D adds the missing *lifecycle* layer on top. The `src/daemon/` skeleton stays dormant (its removal as dead code is a separate cleanup, out of scope here; noted in the close-out). |
| **D2** | **A `SessionSupervisor` abstraction** (`src/server/sessionSupervisor.ts`) owns: the periodic idle-sweep, the live-session count (for the cap), and a manual `sweep()` + `stats()`. It mirrors `CronRunner`: `start()` arms an `setInterval(...).unref?.()` at `idleSweepIntervalMs`; `stop()` clears it; an injectable `now: () => number` (default `Date.now`) + injectable interval for tests; an `idleSweepEnabled` opt-out. **Gateway-scoped:** constructed + `start()`ed in `runGateway` *after* `buildRuntime`, `stop()`ped in the SIGINT/SIGTERM handler **before** `runtime.dispose()` (so a sweep never races DB close — same ordering rule as the cron runner). |
| **D3** | **Idle-eviction rule.** A live in-memory session is evicted only when **ALL** hold: (a) **not turn-active** — `bus.isTurnActive() === false`; (b) **no connected subscribers** — `bus.getSubscriberCount() === 0`; (c) **idle past the TTL** — `now - lastActivityAt > idleSessionTimeoutMs`. Eviction = `await runtime.disposeSession(sessionId)` (**no `bus` arg** → no `session_summary` goodbye-card emit; it still flushes trace/learning/trajectory) **then** `disposeBus(sessionId)`. **The SQLite row is NOT deleted** — the session stays resumable. |
| **D4** | **Bus liveness surface (additive to `eventBus.ts`).** Add `getSubscriberCount(): number` (exposes `subscribers.size`); a `lastActivityAt` field (set at construction, bumped on `subscribe`, `publish`, and `markTurnStart`) + `getLastActivityAt(): number`; module helpers `liveBusSessionIds(): string[]` (`[...buses.keys()]`) and `peekBus(sessionId): ServerEventBus \| undefined` (map `.get`, **never creates**). `__test_busCount` re-expressed over `liveBusSessionIds`. All purely additive — no behavior change to existing callers. |
| **D5** | **Eviction + restart are the same transparent lazy-rebuild path.** After eviction (or a process restart, which starts with empty maps), the next `turns`/`events` request for that session rebuilds the context (`getSessionContext`) + bus (`getOrCreateBus`) from the durable row. Phase D **verifies + tests** this round-trip (create → dispose in-memory → resume continues); it builds no new persistence. |
| **D6** | **Session-management routes** (`src/server/routes/sessions.ts`, under the existing `/sessions/*` bearer auth). `GET /sessions` → `{ sessions: [...] }` from `sessionDb.listSessions(limit)`, each entry annotated with live state from `peekBus` (`live: boolean`, `turnActive: boolean`, `subscribers: number`). `DELETE /sessions/:id` → reclaim in-memory (`disposeSession` + `disposeBus`) **and** delete the durable row via a new FK-safe `sessionDb.deleteSession(sessionId)` → **204** (or 404 if the row never existed). DELETE is distinct from idle-eviction: it *removes* the session (not resumable); eviction is memory-only. |
| **D7** | **Concurrency cap** — `gateway.maxConcurrentSessions` (default **0 = unlimited**). Admission control at `POST /sessions`: if `supervisor.liveSessionCount() >= cap`, run an immediate `sweep()`; if still `>= cap`, reject **429** `{ error: "session capacity reached" }`. The cap bounds the **live in-memory** footprint (the real resource) — counted as live buses ∪ live contexts. (POST creates only a DB row, but session creation is the natural admission point; failing fast there beats failing a turn mid-conversation.) |
| **D8** | **Config (`src/config/schema.ts` `gateway` block, all optional).** `idleSessionTimeoutMs` (positive int, default **1_800_000** = 30 min), `idleSweepIntervalMs` (positive int, default **300_000** = 5 min), `maxConcurrentSessions` (nonneg int, default **0** = unlimited). Defaults mean a long-lived gateway reclaims sessions idle > 30 min every 5 min, out of the box. `idleSweepEnabled` is a code-level opt-out (Runtime/supervisor option, like `cronEnabled`) for tests / special hosts — not a user config field. |
| **D9** | **Scope = the native gateway only.** Constructed solely in `runGateway`; TUI / `sov drive` / `sov serve` unaffected. `sov serve`'s stateless `openai:`-namespaced sessions manage their own lifecycle and are out of scope. Multi-user ownership of sessions/streams is **Phase E**. Cross-process / distributed / clustered supervisors are out of program scope. |
| **D10** | **Service-install deploy story (X2).** `docs/03-cli-reference/usage.md` gains a "Run the gateway as a service" section with a **systemd** unit + a **macOS launchd** plist example (env-based `SOV_GATEWAY_TOKEN`/host/port; restart-on-failure), documenting the "install anywhere / persistent" deployment. Docs-only. |

## Components

**Create:**
- `src/server/sessionSupervisor.ts` — the `SessionSupervisor` class (D2): `constructor({ runtime, now?, idleSessionTimeoutMs?, idleSweepIntervalMs?, maxConcurrentSessions?, enabled? })`; `start()` / `stop()`; `sweep(): Promise<{ evicted: string[]; skipped: number }>`; `liveSessionCount(): number`; `stats(): { live: number; turnActive: number; subscribed: number }`. Pure of side effects beyond eviction; no Hono/HTTP knowledge.
- `tests/server/sessionSupervisor.test.ts` — unit tests with an injected clock + a MockProvider runtime.

**Modify:**
- `src/server/eventBus.ts` — D4 additive surface (`getSubscriberCount`, `lastActivityAt` + `getLastActivityAt`, `liveBusSessionIds`, `peekBus`).
- `src/server/routes/sessions.ts` — D6 routes (`GET /sessions`, `DELETE /sessions/:id`); D7 cap check threaded into `POST /sessions` (needs a supervisor handle on the route context / runtime).
- `src/agent/sessionDb.ts` — `deleteSession(sessionId)`: delete the row + FK-safe cascade (messages, session_compactions, tasks, token-usage rows as applicable); idempotent.
- `src/config/schema.ts` — D8 fields on the `gateway` block.
- `src/cli/gatewayCommand.ts` — construct + `start()` the supervisor after `buildRuntime`; thread it to the app/routes; `stop()` it first in the shutdown handler.
- `src/server/index.ts` / `src/server/app.ts` — thread the supervisor (or a `liveSessionCount` + `sweep` callback) into `buildAppWithRuntime` so `POST /sessions` (cap) and `GET/DELETE /sessions` can reach it. Keep it optional (absent in non-gateway servers → cap disabled, routes still serve list/delete via the runtime).
- `docs/03-cli-reference/usage.md` — supervisor behavior (idle eviction, the config knobs), `GET`/`DELETE /sessions`, and the D10 service-install section.
- `docs/02-architecture/runtime-architecture.md` — the supervisor surface + "the gateway is the persistent backbone."
- `package.json` — version bump at close-out.

**Tests:**
- `tests/server/sessionSupervisor.test.ts` — sweep evicts an idle session (not turn-active, 0 subscribers, stale); **skips** a turn-active one, a subscribed one, and a too-recent one; `liveSessionCount`; eviction calls `disposeSession` (no summary) + `disposeBus`; injected clock drives staleness deterministically.
- `tests/server/eventBus.test.ts` (extend) — `getSubscriberCount`, `lastActivityAt` bumps on subscribe/publish/markTurnStart, `peekBus` never creates, `liveBusSessionIds`.
- `tests/server/sessionsRoutes.test.ts` (new or extend) — `GET /sessions` lists + annotates; `DELETE /sessions/:id` reclaims + 204 + the row is gone (404 after); `POST /sessions` 429 at cap (after a sweep can't free room).
- `tests/agent/sessionDb.deleteSession.test.ts` — delete removes the row + cascaded children; idempotent; resume-by-id of a deleted id throws.
- `tests/server/restartResume.test.ts` — create + run a turn (MockProvider) → `disposeSession` + `disposeBus` (simulate eviction/restart) → a new turn on the same id rebuilds context from the DB + completes (no error, history preserved).
- Confirm existing `tests/server/*` (turns, gateway e2e, reconnect, the new `gatewayIntegration`) still pass (supervisor is gateway-scoped + additive).

## Security / correctness notes

- **No active-session disruption.** Eviction is gated on `!isTurnActive && subscribers===0` — a running turn or a watching client is never reclaimed; no mid-turn data loss, no stream cut.
- **Graceful finalization preserves the learning soak.** Eviction calls `disposeSession` (flushes the learning observer → the instinct corpus, writes the trajectory, closes the trace) — idle eviction *contributes* to learning rather than dropping it.
- **DELETE vs evict.** DELETE is FK-safe + removes the durable row (gone, not resumable); eviction is memory-only (resumable). Both are idempotent.
- **Resource bound for remote exposure.** The cap + the idle-sweep bound memory on a long-lived, possibly-exposed host (principle #2).
- **Dispose ordering.** The supervisor is `stop()`ped before `runtime.dispose()` (no sweep racing `sessionDb.close()`); each eviction's `disposeSession`/`disposeBus` are the same idempotent calls shutdown already makes.
- **Auth unchanged.** `GET`/`DELETE /sessions` are under the existing `/sessions/*` bearer auth; the cap + eviction add no bypass.
- **No cross-session leakage.** Eviction/DELETE operate per-session-id; the bus map is per-session keyed.

## Out of scope (later phases / deferred)

- Resurrecting / wiring `src/daemon/` (D1 chose extend-the-gateway; the skeleton's removal is a separate cleanup).
- Re-architecting the **TUI to attach to a shared running supervisor** (the web UI + OpenAI API already prove "attach to a running gateway"; the TUI's per-invocation server is fine — a future enhancement, not Phase D).
- Multi-user identity / session ownership / per-principal authz (**Phase E**).
- Channels (**Phase F**).
- LRU / capacity-pressure eviction of *active* sessions; distributed/clustered supervisors; horizontal scale (out of program scope).

## Testing + ship

TDD throughout: unit (supervisor + bus surface + `deleteSession`) → route/integration (list/delete/cap) → restart-resume. Full gate green (`bun run lint && bun run typecheck && bun run test`, no new failures). Update `docs/03-cli-reference/usage.md` (supervisor + lifecycle routes + config + service install) + `docs/02-architecture/runtime-architecture.md` (the supervisor surface) + a state snapshot + the `CLAUDE.md`/`AGENTS.md` pointer (byte-identical; **do not touch the ACTIVE FOCUS soak banner**) + the testing-log. Commit/push; `sov upgrade`; cut a release (the gateway gains the supervisor). Per `docs/05-conventions/autonomous-feature-builds.md`, executes immediately into the plan with no approval gate.

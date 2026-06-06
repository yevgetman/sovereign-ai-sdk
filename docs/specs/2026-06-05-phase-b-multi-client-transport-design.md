# Phase B — Multi-Client Session Transport — Design Spec

**Date:** 2026-06-05
**Status:** Draft (pre-implementation)
**Parent roadmap:** `docs/specs/2026-06-05-run-anywhere-harness-roadmap-design.md` (Phase B / module M2). **Depends on Phase A** (shipped v0.6.18).

## Goal

Make the session event transport **multi-client and reconnect-safe**, so the gateway can back real web/mobile UIs: **multiple clients can observe one session concurrently**, and **a client that drops mid-turn reconnects and replays the events it missed** (via `Last-Event-ID`). Today the bus is single-subscriber and disposed per-turn with no replay — a dropped connection loses events and two devices can't watch the same session. (Both gaps were spotlighted by the Phase A live browser test.)

## Current state (verified — `src/server/eventBus.ts`, `src/server/routes/events.ts`)

- **Single subscriber:** `ServerEventBus.subscribe(fn)` overwrites `this.subscriber`; only one consumer at a time.
- **Pre-subscribe buffer, not a replay ring:** events published before a subscriber attaches are queued in `this.buffer` and **drained-and-emptied** on subscribe (supports the "POST /turns then GET /events" pattern). It is not retained for replay.
- **Session-scoped monotonic `seq`:** `nextSeq()` accumulates across turns (per the file's own comment) — already the right anchor for `Last-Event-ID`. Frames emit `id: String(ev.seq)`.
- **Per-turn bus lifecycle:** the events route's `finally` calls `disposeBus(sessionId)` after the stream closes (turn_complete / turn_error / client disconnect), so the bus is destroyed each turn — no reconnect window.
- **Aborts:** bus-level `abortController` (fires on `close()`, plumbed into `query()`); per-turn `currentTurnAbort` (user cancel). `abortAllBuses()` (Phase A hardening) closes all buses before DB close on shutdown.
- CORS already allows the `Last-Event-ID` request header (Phase A).

## Locked design decisions

| ID | Decision |
|---|---|
| **D1** | **Multi-subscriber.** Replace the single `subscriber` with a `Set<subscriber>`. `subscribe(fn)` adds + returns an unsubscribe that removes; `publish` fans out to all. |
| **D2** | **Bounded replay ring.** Replace the drain-and-empty `buffer` with a bounded ring buffer retaining the last **N** published events (with their `seq`). N configurable (`gateway.eventBufferSize`, default 512). Oldest evicted past N. |
| **D3** | **Reuse the session-scoped `seq`** as the `Last-Event-ID` anchor (no change — it already accumulates across turns). |
| **D4** | **Reconnect replay.** `subscribe(fn, { lastEventId? })`: if `lastEventId` is given, first replay ring events with `seq > lastEventId` (in order), then attach live. If the requested id predates the ring window (overflow), replay from the oldest retained event (best-effort; a long-disconnect gap is bounded by N — documented). |
| **D5** | **Fresh-subscriber semantics (preserve the test/normal pattern).** A subscriber with NO `lastEventId` replays the **current turn's** buffered events (those at/after the current turn's start), then attaches live — so "POST /turns then GET /events" and a mid-turn late-joiner both see the active turn from its start, without replaying prior turns. The bus tracks `currentTurnStartSeq` via a new `markTurnStart()` called by the turns route at turn start. |
| **D6** | **Bus lifecycle moves per-turn → per-session.** Remove `disposeBus(sessionId)` from the events route's `finally` (only `unsubscribe()` there). The bus persists for the session so it can serve reconnects + multiple clients across turns. **Bus disposal moves to session disposal** (`runtime.disposeSession` must call `disposeBus`; full-shutdown `abortAllBuses` + `dispose` already handle the rest). |
| **D7** | **Per-turn stream contract preserved by default.** With no `?follow`, the stream still ends on `turn_complete`/`turn_error` (so `sov drive` + the documented re-subscribe-per-turn client are byte-compatible). |
| **D8** | **Optional persistent follow stream.** `GET /sessions/:id/events?follow=true` keeps the stream open across turns (does NOT stop on turn_complete) until the client disconnects — the natural mode for a web/mobile client that subscribes once and watches the whole session. Combine with `Last-Event-ID` for seamless reconnect. |
| **D9** | **Idle-session bus eviction is deferred to Phase D** (the persistent supervisor owns session lifecycle/eviction). Phase B bounds memory via the ring (N events/session) + disposes buses on session disposal; a long-lived gateway accumulating never-disposed sessions is a Phase-D concern (noted, not solved here). |

## Components

**Modify:**
- `src/server/eventBus.ts` — `Set` of subscribers (D1); bounded ring buffer replacing `buffer` (D2); `subscribe(fn, opts?: { lastEventId?: number })` with replay (D4/D5); `markTurnStart()` + `currentTurnStartSeq` (D5); keep `seq`/aborts/`close`/`disposeBus`/`abortAllBuses` semantics. Ring size injectable (default 512).
- `src/server/routes/events.ts` — read the `Last-Event-ID` header (+ fall back to a `?lastEventId` query param, since browser `EventSource` auto-sends the header but a `fetch`-stream client may prefer the query — document both); pass to `subscribe`; honor `?follow=true` (D8 — don't stop on turn_complete); **remove `disposeBus` from `finally`** (D6, only unsubscribe).
- `src/server/runtime.ts` — ensure per-session disposal (`disposeSession`) calls `disposeBus(sessionId)` (D6). Verify the turn path calls `bus.markTurnStart()` at turn start (add to `runTurnInBackground`/the turns route).
- `src/server/routes/turns.ts` (or `runTurnInBackground`) — call `bus.markTurnStart()` when a turn begins (D5).
- `src/config/schema.ts` — `gateway.eventBufferSize?` (positive int, default 512).

**Tests:**
- `tests/server/eventBus.test.ts` — multi-subscriber fan-out; ring retains last N + evicts; `subscribe({lastEventId})` replays seq>id then live; fresh subscribe replays current-turn-only (not prior turns) via `markTurnStart`; ring-overflow best-effort replay.
- `tests/server/eventsReconnect.test.ts` — drive a turn; a second concurrent subscriber sees the same events (fan-out); a subscriber that disconnects mid-turn and reconnects with `Last-Event-ID` replays exactly the missed events then completes; `?follow=true` stream survives a turn_complete and receives the next turn's events.
- Confirm existing `tests/server/*` (turns, gateway e2e, drive) still pass (the no-follow per-turn contract is unchanged).

## Out of scope (later phases)

Idle-session bus eviction + a true session-lifecycle manager (Phase D); multi-user ownership of sessions/streams (Phase E); the web UI that consumes this (Phase C); cross-process/distributed buses (out of program scope).

## Security / correctness notes

- Auth is unchanged: the events route is under `/sessions/*` bearer auth (Phase A); `?follow` and `Last-Event-ID` don't bypass it.
- Replay only ever serves events from the requested session's own ring (no cross-session leakage — buses are per-session keyed).
- Bounded ring (N) caps per-session memory; the abort/cancel semantics from Phase A + the hardening pass are preserved (bus `close()` still aborts in-flight work; `disposeBus` on session disposal).
- `?follow` streams are long-lived — they must still cooperatively end on client disconnect (the existing `requestSignal` abort handler) and on bus `close()`/session disposal, so they don't leak.

## Testing + ship

TDD throughout; unit (bus) + integration (concurrent subscribers, reconnect-replay, follow). Full gate green. Update `docs/usage.md` (gateway browser section: `Last-Event-ID` reconnect + `?follow` + the multi-client behavior — extend the canonical snippet to reconnect) + `docs/architecture.md` (the transport). Commit/push; `sov upgrade`; cut a release. Per `docs/conventions/autonomous-feature-builds.md`, executes immediately into the plan with no approval gate.

# Phase B — Multi-Client Session Transport · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Checkbox steps. Executes per `docs/conventions/autonomous-feature-builds.md` — no approval gates.

**Goal:** Make the session event transport multi-client + reconnect-safe, per `docs/specs/2026-06-05-phase-b-multi-client-transport-design.md`.

**Architecture:** Extend the existing per-session `ServerEventBus` to fan out to many subscribers + retain a bounded replay ring keyed by the existing session-scoped `seq`; serve `Last-Event-ID` reconnect-replay + an optional `?follow` persistent stream from the events route; move bus disposal from per-turn (the route's `finally`) to per-session (session disposal). Default (no `?follow`, no `Last-Event-ID`) stays byte-compatible with today's per-turn clients.

**Tech Stack:** TypeScript on Bun, Hono SSE, Zod. MockProvider for integration tests.

---

## Investigation findings (verified — `src/server/eventBus.ts`, `src/server/routes/events.ts`)

1. **`ServerEventBus`** (`eventBus.ts`): single `subscriber` (`:31`, overwritten in `subscribe` `:93-102`); pre-subscribe `buffer` drained-and-emptied on subscribe (`:32,95-98`); **session-scoped monotonic `seq`** (`:33,80-82`) — REUSE as the `Last-Event-ID` anchor; `close()` aborts the bus-level `abortController` (`:104-110`); `currentTurnAbort` (user cancel, `:42,59-78`). Module `Map` + `getOrCreateBus`/`disposeBus`/`abortAllBuses`/`__test_resetAllBuses` (`:117-174`).
2. **events route** (`events.ts`): `getOrCreateBus` → `subscribe` → `stream.writeSSE({ event: ev.type, id: String(ev.seq), data })` (`:58-62`); ends on `turn_complete`/`turn_error` (`:63-65`); `finally` → `unsubscribe()` + **`disposeBus(sessionId)`** (`:67-75`) ← the per-turn disposal to MOVE. The `requestSignal` abort handler (`:40-48`) prevents a park-forever leak — preserve it.
3. `ServerEvent` carries `seq` (the route reads `ev.seq`). Frames already emit `id: <seq>`, and CORS already allows `Last-Event-ID` (Phase A).
4. **markTurnStart site:** find where a turn begins (the turns route / `runTurnInBackground` in `src/server/routes/turns.ts` / `src/server/runtime.ts`) — call `bus.markTurnStart()` there, BEFORE the first event of the turn is published.
5. **Session disposal:** today `disposeBus` is called only by the events route + `abortAllBuses` (full shutdown). With D6, per-session disposal (`runtime.disposeSession`, find it in `src/server/runtime.ts`) MUST call `disposeBus(sessionId)` or buses leak.

## File structure
**Modify:** `src/server/eventBus.ts`, `src/server/routes/events.ts`, `src/server/routes/turns.ts` (or `runTurnInBackground`), `src/server/runtime.ts` (disposeSession), `src/config/schema.ts`, `docs/usage.md`, `docs/architecture.md`, `package.json`.
**Create tests:** `tests/server/eventBus.multiClient.test.ts`, `tests/server/eventsReconnect.test.ts`.

## Conventions (every task)
`.js` imports; one-line headers; no mutation; bun:test; preserve the abort/cancel semantics + the default per-turn contract. Pre-commit gate (`bun run lint && bun run typecheck && bun run test`, suite ~2778/0, no new failures). Atomic commits. **NO release until the final task.**

---

## Tasks

### T1 — bus core: multi-subscriber + replay ring + markTurnStart (~30 min · Opus)
**Files:** Modify `src/server/eventBus.ts`; test `tests/server/eventBus.multiClient.test.ts`.
- [ ] Write failing unit tests:
  - fan-out: two subscribers both receive a published event; unsubscribing one keeps the other.
  - ring retains last N + evicts oldest (construct a bus with small N, publish N+2, assert the ring holds the last N).
  - `subscribe(fn, { lastEventId })` replays ring events with `seq > lastEventId` in order, then delivers live; `lastEventId` below the window replays from the oldest retained (best-effort).
  - fresh `subscribe(fn)` (no opts) after `markTurnStart()` replays only events with `seq >= currentTurnStartSeq` (current turn), NOT prior-turn events.
  - `close()` still aborts the abort signal + stops delivery (idempotent).
- [ ] Run red.
- [ ] Implement in `ServerEventBus`: replace `subscriber` with `subscribers: Set<fn>`; `subscribe(fn, opts?: { lastEventId?: number })` → do the replay (per opts/markTurnStart) synchronously, then `subscribers.add(fn)`; return `() => subscribers.delete(fn)`. Replace `buffer` with a bounded ring (array capped at N, default 512; constructor/`getOrCreateBus` param). `publish` → assign via `nextSeq` (events already carry seq from the caller; keep that — DO NOT re-seq if the event already has one; verify how seq is currently assigned and preserve it), push to ring (evict past N), fan out to all subscribers. Add `markTurnStart()` (sets `currentTurnStartSeq = this.seq`) + the field. Keep `close`/aborts/`isClosed`/the cancel API intact.
- [ ] Run green; gate; commit `feat(transport): multi-subscriber event bus + bounded replay ring + markTurnStart`.

### T2 — config: `gateway.eventBufferSize` (~10 min · Opus)
**Files:** Modify `src/config/schema.ts` + thread into bus construction (`getOrCreateBus`/runtime); extend `tests/config/schema.test.ts`.
- [ ] Failing test: schema accepts `gateway.eventBufferSize: 256`; default behavior when absent (ring uses 512).
- [ ] Implement: add `eventBufferSize: z.number().int().positive().optional()` to the `gateway` block; thread the configured size into bus construction (where `getOrCreateBus` is first called per session, or a module default settable at runtime build). Keep 512 default.
- [ ] Green; gate; commit `feat(transport): configurable gateway.eventBufferSize`.

### T3 — route + lifecycle: Last-Event-ID, ?follow, per-session bus disposal (~30 min · Opus)
**Files:** Modify `src/server/routes/events.ts`, `src/server/routes/turns.ts` (markTurnStart), `src/server/runtime.ts` (disposeSession → disposeBus); test additions in `tests/server/eventsReconnect.test.ts` (route-level).
- [ ] Failing tests (route-level, via app.request / the server-test harness):
  - reconnect: subscribe with `Last-Event-ID: <n>` header → receives only events with seq > n (no duplicates); also accept `?lastEventId=<n>` query as a fallback.
  - `?follow=true` → the stream does NOT close on `turn_complete` (a subsequent turn's events arrive on the same stream); without `?follow`, it closes on `turn_complete` (unchanged).
  - lifecycle: after a non-follow stream closes, the bus is NOT disposed (still in the map / still replayable), and IS disposed when the session is disposed.
- [ ] Run red.
- [ ] Implement:
  - `events.ts`: read `Last-Event-ID` header (or `?lastEventId` query) → parse int → pass to `bus.subscribe(fn, { lastEventId })`. Honor `?follow=true`: when set, do NOT set `stopped = true` on `turn_complete`/`turn_error` (keep streaming until client disconnect). **Remove `disposeBus(sessionId)` from the `finally`** — keep only `unsubscribe()` + the abort-listener cleanup.
  - `turns.ts`/`runTurnInBackground`: call `bus.markTurnStart()` at turn start, before publishing the turn's first event.
  - `runtime.ts` `disposeSession(sessionId)`: call `disposeBus(sessionId)` so buses are reclaimed per-session (since the route no longer does). Keep `dispose()`/`abortAllBuses` as-is.
- [ ] Run green; gate; verify existing `tests/server/{turns,gatewayEndToEnd,...}` + `sov drive` semantics unchanged (no-follow path identical). Commit `feat(transport): Last-Event-ID reconnect + ?follow stream + per-session bus lifecycle`.

### T4 — integration: concurrent clients + reconnect + follow (~25 min · Opus)
**Files:** `tests/server/eventsReconnect.test.ts` (end-to-end via a MockProvider runtime + the real app).
- [ ] Drive a turn (MockProvider) and assert: (a) two concurrent SSE subscribers both receive the full event sequence (fan-out e2e); (b) a subscriber that consumes some events, disconnects mid-turn, then reconnects with `Last-Event-ID` set to its last seq, replays exactly the missed events and reaches `turn_complete` with no gaps/duplicates; (c) a `?follow=true` subscriber stays open across two sequential turns and receives both turns' events. Reuse the gateway/turns test harness + MockProvider reset discipline.
- [ ] Green; gate; commit `test(transport): concurrent subscribers, reconnect-replay, follow stream`.

### T5 — docs + close-out + release (~20 min · Opus; bump Sonnet-eligible)
**Files:** `docs/usage.md`, `docs/architecture.md`, `docs/testing-log.md`, `docs/state/<today>-phase-b-transport.md` (or extend), `CLAUDE.md`+`AGENTS.md` (state pointer), `package.json`.
- [ ] `docs/usage.md` gateway section: document multi-client (multiple devices watch one session), `Last-Event-ID` reconnect (extend the browser fetch-stream snippet to capture the last `id` and resume with `Last-Event-ID`), and `?follow=true` (subscribe once, watch the whole session). Note `gateway.eventBufferSize` (replay window) + the bounded-gap caveat on long disconnects.
- [ ] `docs/architecture.md`: update the transport description (multi-subscriber, ring, follow, per-session bus lifecycle).
- [ ] State snapshot + testing-log entry; update the state pointer in `CLAUDE.md`+`AGENTS.md` (keep byte-identical; **don't touch the ACTIVE FOCUS soak banner**; `diff` empty).
- [ ] Bump `package.json` (next patch, v0.6.19), gate green, `sov upgrade`, cut the release per `docs/conventions/cutting-releases.md`, verify `~/.sov/bin/sov --version`.
- [ ] Commit + push.

---

## Self-review
Spec coverage: D1 multi-subscriber→T1; D2 ring→T1; D3 reuse seq→T1; D4 Last-Event-ID replay→T1(core)+T3(route); D5 fresh=current-turn via markTurnStart→T1+T3(wiring); D6 per-session lifecycle→T3 (route stops disposing + runtime.disposeSession disposes); D7 per-turn default→T3 (no-follow unchanged, verified); D8 ?follow→T3; D9 eventBufferSize→T2 (idle-eviction explicitly deferred). Tests: unit (T1), config (T2), route+lifecycle (T3), e2e concurrent/reconnect/follow (T4). No placeholders; the seq-assignment preservation + the markTurnStart ordering are called out as the load-bearing correctness points. Type names (`subscribe(fn, {lastEventId})`, `markTurnStart`, `eventBufferSize`) consistent across tasks.

## Execution
Per the autonomous convention: T1→T5 subagent-driven, no approval gates, ship (release v0.6.19) at T5.

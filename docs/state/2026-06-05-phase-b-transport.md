# State of the build — Phase B: Multi-Client Session Transport (shipped; robust core + 4 hardening fixes)

**HEAD:** the `chore(release): bump version 0.6.18 -> 0.6.19` commit (the Phase B transport run). **Release:** **v0.6.19** (2026-06-05).

**Predecessor:** [`docs/state/2026-06-05-phase-a-gateway.md`](2026-06-05-phase-a-gateway.md) (Phase A — Secure Remote Gateway shipped + hardened; v0.6.18).

## What this snapshot is

The **second phase (Phase B / module M2) of the run-anywhere, persistent, multi-channel harness roadmap** — a real phase, not a hardening run. It makes the harness's **native HTTP+SSE session transport multi-client and reconnect-safe**, so the gateway (Phase A) can back real web/mobile UIs: **multiple clients can observe one session concurrently**, and **a client that drops mid-turn reconnects and replays the events it missed** (via `Last-Event-ID`). Both gaps were spotlighted by the Phase A live browser test — the bus was single-subscriber and disposed per-turn with no replay, so a dropped connection lost events and two devices couldn't watch the same session.

Authoritative implementation docs in this repo:
- **Roadmap:** [`docs/specs/2026-06-05-run-anywhere-harness-roadmap-design.md`](../specs/2026-06-05-run-anywhere-harness-roadmap-design.md) (the program; A–F; A + B now marked shipped)
- **Spec:** [`docs/specs/2026-06-05-phase-b-multi-client-transport-design.md`](../specs/2026-06-05-phase-b-multi-client-transport-design.md) (decisions D1–D9)

The roadmap + decision record (ADR H-0010, the multi-channel-gateway differentiator) stay canonical in `~/code/sovereign-ai-docs`; this repo owns the code and the implementation docs. **No new ADRs in this repo** — Phase B is purely additive, all decisions captured in the spec (D1–D9) + commit messages. The default per-turn single-client contract is unchanged (`sov drive` unaffected).

## Where this sits in the roadmap

Phase B is **piece 2 of 6**. The roadmap is dependency-ordered:

```
A ──> B ──> C            (browser UI on a secure, robust transport)
 \     \
  \     └─> D ──> E ──> F   (persistent supervisor → multi-user → channels)
   └────────> D
```

- A — Secure remote gateway (M1) — ✅ shipped (v0.6.17 + v0.6.18 hardening).
- **B — Multi-client session transport (M2) — ✅ shipped (this snapshot, v0.6.19).**
- C — Reference web UI. **Remaining.** (Now unblocked — it needs the robust, multi-client transport B delivers.)
- D — Persistent multi-session supervisor / service install. **Remaining.**
- E — Multi-user identity + state scoping (security-reviewed). **Remaining.**
- F — Channel framework + Slack/Telegram/webhook adapters. **Remaining.**

Each phase is independently shippable; the program can pause after any phase with a coherent released increment.

## What shipped (Phase B)

1. **Multi-subscriber bus (D1).** `src/server/eventBus.ts` — the single `subscriber` field is replaced by a `Set<subscriber>`. `subscribe(fn)` adds + returns an idempotent unsubscribe; `publish()` fans out to every subscriber. Multiple SSE streams (multiple clients) on one session now all receive every event.

2. **Bounded replay ring (D2).** The drain-and-empty pre-subscribe `buffer` is replaced by a bounded ring retaining the last **N** published events (with their `seq`), oldest evicted past N. N is `gateway.eventBufferSize` (default **512**); a non-positive/non-integer config value is clamped to the default so the window never shrinks below 512. Per-session memory is bounded by the ring.

3. **`Last-Event-ID` reconnect-with-replay (D3/D4).** The session-scoped, across-turns-accumulating `seq` is the reconnect anchor (unchanged — it already accumulated). `subscribe(fn, { lastEventId })` synchronously replays ring events with `seq > lastEventId` (in order, no duplicates) BEFORE attaching live; a cursor below the retained window replays best-effort from the oldest retained event (no crash — the gap is bounded by N, documented). Each SSE frame already emits `id: String(ev.seq)`.

4. **Fresh-subscriber current-turn replay (D5).** A subscriber with **no** `lastEventId` replays only the **in-progress turn** (events with `seq >= currentTurnStartSeq`), then goes live — so "POST /turns then GET /events" and a mid-turn late-joiner both see the active turn from its start, without replaying prior turns. The bus tracks `currentTurnStartSeq` via a new `markTurnStart()` called by the turn path at turn start; before any turn is marked, a fresh subscriber replays everything still retained (the exact pre-Phase-B drain-the-buffer behavior).

5. **Bus lifecycle moved per-turn → per-session (D6).** The events route no longer calls `disposeBus(sessionId)` in its `finally` (only `unsubscribe()` + abort-listener cleanup). The bus persists for the session so it can serve reconnects + multiple clients across turns. Disposal moved to **session disposal** (`runtime.disposeSession → disposeBus`, after `disposeSessionContext` so any `session_summary` event still publishes) and **full shutdown** (`runtime.dispose → abortAllBuses → the disposeSession walk → clearAllBuses`).

6. **Per-turn stream contract preserved by default (D7).** With no `?follow`, the stream still ends on `turn_complete`/`turn_error`, so `sov drive` + the documented per-turn programmatic client are byte-compatible. The default single-client contract is unchanged.

7. **Optional `?follow=true` persistent stream (D8).** `GET /sessions/:id/events?follow=true` keeps the stream open ACROSS turns (does NOT stop on the turn terminal) until the client disconnects or the bus closes — the natural mode for a web/mobile client that subscribes once and watches the whole session. Combines with `Last-Event-ID` for seamless reconnect.

8. **`gateway.eventBufferSize` config (X3).** `src/config/schema.ts` — `gateway.eventBufferSize?: z.number().int().positive().optional()` (default 512). `buildRuntime` calls `setDefaultRingSize(userSettings.gateway?.eventBufferSize ?? DEFAULT_MAX_RING)` once at boot so every runtime-minted bus (turns / events / scheduler) inherits the configured window without threading it through each call site.

**Idle-session bus eviction is explicitly deferred to Phase D (D9)** — see Known Phase-D item below.

## The correctness review + the 4 hardening fixes

After the T1–T3 build (multi-subscriber + ring + markTurnStart; `eventBufferSize`; the events-route reconnect/follow/lifecycle change) plus the concurrent-subscriber e2e test, Phase B got a **deep correctness review**. **The core came through robust** — the multi-subscriber fan-out, ring eviction, and replay slicing were correct. The review + the new test surfaced four sharp edges, all fixed TDD with atomic commits:

1. **`fix(server): isolate throwing subscribers in event bus fan-out`** (`6e9e054`) — a subscriber callback that throws (an SSE route's `onEvent`, a future cross-process forwarder) must never skip later subscribers or propagate back into the publisher (the turn loop / scheduler). `publish()` now wraps each `subscriber(event)` in try/catch → log to stderr + continue the fan-out.
2. **`fix(server): non-follow reconnect after a completed turn ends, not parks`** (`587690a`) — a NON-follow reconnect that replays nothing AND lands with no turn in progress (the turn already completed; its terminal is past the cursor) would park forever on the empty-queue Promise (the bus now closes only at session/shutdown teardown). Added `turnActive` + `isTurnActive()` to the bus (set by `markTurnStart()`, cleared by `publish()` on the terminal event); the events route captures the synchronous replay count and, if `!follow && replayedCount === 0 && !bus.isTurnActive()`, ends the stream immediately. Does not affect `?follow`, the normal POST-then-GET path (a turn IS active at subscribe), or a mid-turn reconnect (replay is non-empty).
3. **`fix(server): ?follow SSE stream closes when the bus is disposed`** (`6d8ec10`) — an open `?follow` stream (which never auto-ends on a turn terminal) would stay parked on the empty-queue Promise forever after the bus closed — a dangling connection outliving its session. Added the bus `abortSignal` as a SECOND stop source in the events route (mirroring `requestSignal`): if already aborted at attach, don't park; otherwise wake + stop on its `abort`. (`close()` also clears subscribers, so the loop must be woken explicitly.)
4. **`fix(server): full dispose() reclaims subscribe-only bus map entries`** (`9f58fc2`) — `dispose()` reclaims per-session buses by walking `sessionContexts → disposeBus`, but a session that only ever opened an events stream (subscribed → minted a bus via `getOrCreateBus`) and never ran a turn has NO sessionContext; `abortAllBuses()` closed its bus but never deleted the entry, so it lingered + accumulated across repeated build/dispose cycles in one process. Added `clearAllBuses()` (close idempotently + clear the whole map), called by `dispose()` after the per-session walk. Distinct from per-session `disposeBus`, `abortAllBuses` (closes but leaves entries for the walk), and the test-only `__test_resetAllBuses`.

## Tests

- **TS suite — ~2810 pass / 0 fail / 14 skip** in a clean run. Up from the post-Phase-A v0.6.18 baseline of ~2778, from the new bus + reconnect suites (`tests/server/eventBus.test.ts` — multi-subscriber fan-out, ring retain/evict, `subscribe({lastEventId})` replay seq>id then live, fresh current-turn-only replay via `markTurnStart`, ring-overflow best-effort; `tests/server/eventsReconnect.test.ts` — concurrent subscribers see the same events, mid-turn disconnect → reconnect with `Last-Event-ID` replays exactly the missed events then completes, `?follow=true` survives a `turn_complete`) plus the 4 hardening-fix tests. Gate criterion unchanged: "no new failures beyond the known env-only set" (the 3 ambient-config learning-observer tests pass on a clean `HARNESS_HOME` / in CI; this run was clean). Existing `tests/server/*` (turns, gateway e2e, drive) still pass — the no-follow per-turn contract is unchanged.
- **Lint + typecheck** — clean (`biome check` 642 files; `tsc --noEmit`).
- **Go suite** — unchanged by this phase (no `packages/tui/` change).

## Notes

- **No bundle changes** — the Phase-B surface is entirely in `src/` (`server/eventBus.ts`, `server/routes/events.ts`, `server/runtime.ts`, `server/routes/turns.ts`, `config/schema.ts`), `tests/`, and `docs/`. No `packages/tui/` change.
- **Default surfaces unchanged.** The default `sov` (TUI), `sov serve` (OpenAI API), and `sov drive` (headless) experiences are byte-identical; the multi-client transport is reachable through the same routes but the default no-`?follow` per-turn stream behavior is preserved exactly (D7).
- **Engine-agnostic by construction.** All of Phase B sits above the HTTP+SSE protocol seam (`src/server/schema.ts` + the routes), never the runtime's internals — so the transport survives a future agent-core swap, exactly like the rest of the gateway program.
- **Learning-loop soak continues in parallel — untouched.** Recall is still **ON by default** (`learning.recall.enabled`, since v0.6.16) and capture + synthesis stay on; the transport work did not disable recall or learning (a roadmap execution requirement — the learning layer rides above the protocol seam unchanged). The `## ⚠️ ACTIVE FOCUS — Learning-loop soak` banner in `CLAUDE.md`/`AGENTS.md` stays the standing #1 focus; this gateway phase is a separate, parallel track.

## Known Phase-D item (deferred — D9)

**Interactive-session buses accumulate until shutdown.** Phase B disposes a session's bus on **session disposal** (`disposeSession`) and reclaims all buses at full shutdown. But a long-lived gateway with many never-disposed interactive sessions accumulates one bus per session for the process lifetime. **Per-session memory is bounded by the ring** (`eventBufferSize` events/session), so this is a bounded leak, not an unbounded one — but the count of live buses is not capped. **Idle/TTL eviction or an explicit `DELETE /sessions/:id`** is the persistent supervisor's job — **Phase D** (M3), which owns session lifecycle (create/resume/evict). Noted here, not solved in Phase B (per the spec's D9 and the roadmap's out-of-scope split).

## Cross-repo record-keeping (flag for a docs-repo session)

The roadmap + decision record are canonical in `~/code/sovereign-ai-docs` and this repo can't commit there. A docs-repo session should reflect **Phase B shipped (v0.6.19)** against the multi-channel-gateway differentiator (ADR H-0010) and the run-anywhere program tracker (A + B done; C–F remain).

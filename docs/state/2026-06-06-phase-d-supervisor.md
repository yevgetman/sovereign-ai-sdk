# State of the build — Phase D: Persistent multi-session supervisor (shipped; idle eviction + session lifecycle, served by the gateway)

**HEAD:** the `chore(release): bump version 0.6.20 -> 0.6.21` commit (the Phase D persistent-supervisor run). **Release:** **v0.6.21** (2026-06-06).

**Predecessor:** [`docs/state/2026-06-06-phase-c-webui.md`](2026-06-06-phase-c-webui.md) (Phase C — Reference Web UI shipped; embedded single-file browser client served by the gateway; v0.6.20).

## What this snapshot is

The **fourth phase (Phase D / module M3) of the run-anywhere, persistent, multi-channel harness roadmap** — a real phase, not a hardening run. It turns the long-lived `sov gateway` into a **persistent multi-session host**: a process that owns many concurrent sessions across clients and across restarts, with a session-lifecycle layer (idle eviction, list, delete, concurrency cap) that keeps a days-long-uptime host healthy instead of accumulating in-memory session state for its whole lifetime. It closes Phase B's deferred D9 (idle bus eviction) and the noted carry-forward (interactive buses/contexts accumulating until shutdown).

Authoritative implementation docs in this repo:
- **Roadmap:** [`docs/specs/2026-06-05-run-anywhere-harness-roadmap-design.md`](../specs/2026-06-05-run-anywhere-harness-roadmap-design.md) (the program; A–F; A + B + C + D now marked shipped)
- **Spec:** [`docs/specs/2026-06-06-phase-d-persistent-supervisor-design.md`](../specs/2026-06-06-phase-d-persistent-supervisor-design.md)
- **Plan:** [`docs/plans/2026-06-06-phase-d-persistent-supervisor.md`](../plans/2026-06-06-phase-d-persistent-supervisor.md)

The roadmap + decision record (ADR H-0010, the multi-channel-gateway differentiator) stay canonical in `~/code/sovereign-ai-docs`; this repo owns the code and the implementation docs. **No new ADRs in this repo** — Phase D is purely additive + gateway-scoped (a background sweep, two new routes, an opt-in cap, three config knobs), all decisions captured in the spec + commit messages. The default `sov` (TUI) / `sov serve` / `sov drive` surfaces are byte-unchanged: they never construct the supervisor.

## Where this sits in the roadmap

Phase D is **piece 4 of 6**. The roadmap is dependency-ordered:

```
A ──> B ──> C            (browser UI on a secure, robust transport)
 \     \
  \     └─> D ──> E ──> F   (persistent supervisor → multi-user → channels)
   └────────> D
```

- A — Secure remote gateway (M1) — ✅ shipped (v0.6.17 + v0.6.18 hardening).
- B — Multi-client session transport (M2) — ✅ shipped (v0.6.19).
- C — Reference web UI (M8) — ✅ shipped (v0.6.20).
- **D — Persistent multi-session supervisor / service install (M3) — ✅ shipped (this snapshot, v0.6.21).**
- E — Multi-user identity + state scoping (security-reviewed). **Remaining.**
- F — Channel framework + Slack/Telegram/webhook adapters. **Remaining.**

Each phase is independently shippable; the program can pause after any phase with a coherent released increment. A→B→C delivered the first complete "run-anywhere from a browser" arc; **D makes that gateway a persistent, supervised always-on backbone** — the substrate E (multi-user) and F (channels) build on.

## Decision D1 — extend the gateway (the dormant `src/daemon/` skeleton stays dormant)

The roadmap left one open decision for this phase: activate/repurpose the built-but-dormant `src/daemon/` skeleton vs. extend the native gateway into the supervisor. **D1: extend the gateway.** The gateway (Phase A) is already the long-lived native-protocol host with the runtime, the multi-subscriber bus (Phase B), and the bundled web client (Phase C); the lifecycle layer is a natural extension of it, not a second process. The `src/daemon/` skeleton is left untouched (dormant) — no need to introduce a parallel host. This keeps everything gateway-scoped: the supervisor is constructed only in `runGateway`, so the TUI / `sov serve` / `sov drive` paths are byte-unchanged.

## What shipped (Phase D)

1. **`SessionSupervisor` — idle-session sweep (`src/server/sessionSupervisor.ts`).** A periodic, `unref`'d background sweep (mirrors `CronRunner`'s tick) that reclaims the **in-memory** state of idle sessions. The eviction rule: a candidate (the union of live event-bus ids and runtime `sessionContexts` ids) is reclaimed only when it is **NOT turn-active**, has **NO SSE subscribers**, AND its last activity is older than the idle TTL. Reclaim = `runtime.disposeSession(id)` (no bus arg — no SSE consumer remains, so no goodbye card) then `disposeBus(id)`. Each eviction is wrapped in try/catch (a failing eviction is counted skipped + logged, never thrown out of the sweep). Last-activity prefers the bus's in-memory timestamp (epoch ms), falling back to the persisted row's `lastUpdated` (epoch seconds → ms) for context-only sessions with no live bus.

   - **Graceful.** The dispose path is the normal session-disposal path — learning, trace, and trajectory state are flushed (the **learning corpus is written**); no data is dropped on eviction.
   - **Transparent (lazy rebuild = restart-resume).** Only the in-memory working set is freed — the **durable SQLite row is left intact**. The next request for that session (turn / event subscription / message fetch) lazily rebuilds it from disk. An evicted session is indistinguishable from a live one to the client, bar one cold rebuild. The same lazy-rebuild property gives **restart-resume**: a service restart (KeepAlive / Restart=on-failure) comes back up and clients reattach to their sessions by id — **proven** (restart-resume test).
   - **Defaults:** idle window `gateway.idleSessionTimeoutMs` = **1_800_000 ms (30 min)**; sweep cadence `gateway.idleSweepIntervalMs` = **300_000 ms (5 min)**.

2. **Lifecycle routes (`src/server/routes/sessions.ts`).**
   - **`GET /sessions`** — lists stored sessions, each annotated immutably with live in-memory state: `live` (a bus exists — `peekBus` never mints one on a miss), `turnActive` (a turn is in flight), `subscribers` (connected SSE clients). Optional `?limit` clamped to `[1, 100]`.
   - **`DELETE /sessions/:id`** — permanently removes a session: 404 before any teardown on an unknown id (no state mutated on a miss), else dispose the in-memory context + bus, then `SessionDb.deleteSession` (FK-safe) → **204**. Unlike idle eviction, this is destructive — the session does not resume.

3. **`POST /sessions` concurrency cap.** Opt-in via `gateway.maxConcurrentSessions` (default **0 = unlimited**). When the cap is a positive number and the live count is at the ceiling, the route first runs an idle **sweep**, then re-checks; it admits the request if the sweep freed room, otherwise refuses with **429** (`{ "error": "session capacity reached" }`). So an idle session never blocks a new one, but a host saturated with *active* sessions pushes back instead of growing unbounded. The route consults the supervisor through a minimal structural `SessionSupervisorLike` interface — absent supervisor ⇒ byte-unchanged create path (the non-gateway servers omit it).

4. **`SessionDb.deleteSession` (FK-safe; `src/agent/sessionDb.ts`).** One transaction: null out child sessions' `parent_session_id`, delete dependent `messages` (the AFTER-DELETE trigger keeps `messages_fts` in sync) + `session_compactions` rows, then delete the `sessions` row (the `tasks` table CASCADEs on parent / SET-NULLs on child automatically). Returns whether a row was removed.

5. **Bus liveness surface (`src/server/eventBus.ts`).** New read-only surface the cap + annotations + sweep read: `getSubscriberCount()` / `getLastActivityAt()` / `isTurnActive()` per bus, plus module-level `peekBus(id)` (returns the bus or undefined, never mints), `liveBusSessionIds()`, and `setDefaultRingSize`. The supervisor's `liveSessionCount()` is the size of the union of `liveBusSessionIds()` and `runtime.sessionContexts.keys()`.

6. **Config (`src/config/schema.ts`).** Three new optional, gateway-scoped fields under `gateway`: `idleSessionTimeoutMs` (positive-int ms), `idleSweepIntervalMs` (positive-int ms), `maxConcurrentSessions` (non-negative int; 0 = unlimited). `runGateway` threads them into the supervisor (conditional spread so an absent field falls through to the supervisor's own default under `exactOptionalPropertyTypes`; `maxConcurrentSessions` defaults to 0). The boot banner summarizes the **effective** policy: `idle-evict: reclaim sessions idle >30m every 5m; max-sessions: unlimited`.

7. **Gateway wiring + graceful shutdown (`src/cli/gatewayCommand.ts`).** The supervisor is constructed + `start()`ed in `runGateway` only, and passed into `startServer` / `buildAppWithRuntime` so `POST /sessions` can consult the cap. On SIGINT/SIGTERM the shutdown path stops the server, then `await supervisor.stop()` **before** `runtime.dispose()` — the same stop-then-teardown ordering the cron runner follows, so an in-flight sweep's DB reads can never race `sessionDb.close()`.

## The in-flight-guard / awaitable-stop hardening (`657f4e6`)

The sweep is serialized against itself and drainable on shutdown:
- **In-flight guard.** `sweep()` retains the promise of an in-flight pass; a re-entrant call (a sweep slower than the 5-min cadence overlapping the next tick) returns `{ evicted: [], skipped: 0 }` immediately rather than starting a second concurrent pass (mirrors `CronRunner`'s `inFlight`). The actual pass (`runSweep`) is only ever invoked behind that guard.
- **Awaitable `stop()`.** `stop()` clears the interval first (so no new sweep can be scheduled), then awaits + drains the in-flight sweep promise (swallowing its errors so a failing sweep can't break shutdown). This closes the shutdown race where a sweep's DB reads could outlive `sessionDb.close()`. `stop()` is idempotent. The interval is `unref`'d so it never holds the process open (tests want a clean exit; the gateway always has the HTTP server handle live).

## The review — READY TO SHIP

The phase was built T1–T7 with a keystone correctness review and a final whole-phase review:
- **Verdict: READY TO SHIP — no Critical / High findings.**
- **Dispose interaction safe.** The eviction path (`disposeSession` + `disposeBus`) is the normal disposal path; the supervisor never reclaims a turn-active or subscribed session, and the bus-liveness checks are read-only.
- **Shutdown race — LOW, and now closed.** The keystone review flagged the shutdown race (an in-flight sweep's DB reads outliving `sessionDb.close()`); the in-flight-guard / awaitable-`stop()` fix (`657f4e6`) closes it, and the gateway's shutdown path awaits `supervisor.stop()` before `runtime.dispose()`.

## Two known-LOW items (documented, not fixed)

Both are judged non-blocking for ship; recorded here for a future pass:

1. **TOCTOU in `sweep()`.** Between a candidate passing the not-turn-active / no-subscribers / idle-TTL checks and its `disposeSession` await completing, a new turn or subscription could land on that session. The window is tiny and the outcome is recoverable (the next request lazily rebuilds the just-evicted session), and it's gated behind the **30-min idle floor** — a session has to be untouched for half an hour before it's even a candidate, so a turn/subscribe landing in that microscopic window is vanishingly unlikely. A pre-dispose re-check (or a per-session lock) is the fix if it ever matters.
2. **`buildMockRuntime` opens the global `~/.harness/sessions.db`.** A pre-existing test-harness isolation smell (not introduced by Phase D): the mock-runtime test helper opens the real global session DB rather than an isolated temp one. Harmless to the shipped runtime; worth tightening when the test harness is next touched.

## Tests

- **TS suite — ~2861 pass / 0 fail / 14 skip** in a clean run. Up from the Phase-C v0.6.20 baseline (~2814) from the new supervisor + lifecycle-route + deleteSession + bus-liveness coverage (`sessionSupervisor` sweep / idle-fallback / restart-resume tests, the `GET`/`DELETE` `/sessions` + cap route tests, the `deleteSession` cascade/set-null test). Gate criterion unchanged: "no new failures beyond the known env-only set" (the ambient-config learning-observer tests pass on a clean `HARNESS_HOME` / in CI).
- **Lint + typecheck** — clean (`biome check`; `tsc --noEmit`).
- **Go suite** — unchanged by this phase (no `packages/tui/` change).
- **Restart-resume** — proven by test (a session disposed/evicted then lazily rebuilt from disk on the next request).
- **Post-upgrade binary smoke** — the released v0.6.21 binary boots a gateway that prints the `idle-evict:` summary line and serves `GET /sessions` → 200 (proves the supervisor + the new route ship in the binary). Logged in `docs/testing-log.md`.

## Notes

- **No bundle changes** — the Phase-D surface is entirely in `src/` (`server/sessionSupervisor.ts`, `server/eventBus.ts`, `server/routes/sessions.ts`, `agent/sessionDb.ts`, `cli/gatewayCommand.ts`, `config/schema.ts`, `server/index.ts`/`app.ts` options-threading), `tests/`, and `docs/`. No `packages/tui/` change, no `bundle-default/` change.
- **Default surfaces unchanged.** The default `sov` (TUI), `sov serve` (OpenAI API), and `sov drive` (headless) experiences are byte-identical; the supervisor is constructed only in `runGateway`, and the cap/annotations are no-ops when no supervisor is wired in.
- **Engine-agnostic by construction.** Everything sits above the HTTP+SSE protocol seam (`src/server/schema.ts` + the routes), never the runtime's internals — so it survives a future agent-core swap, exactly like the rest of the gateway program. **The protocol is the seam.**
- **Service install (X2).** `docs/usage.md` now ships a **systemd** unit and a **macOS launchd** plist example for running the gateway as a long-lived service, with the security posture (token required off-loopback; least-privileged user; TLS in front) called out. Restart-on-failure + the durable session store = lazy restart-resume.
- **Learning-loop soak continues in parallel — untouched.** Recall is still **ON by default** (`learning.recall.enabled`, since v0.6.16) and capture + synthesis stay on; Phase D did not disable recall or learning (a roadmap execution requirement — the learning layer rides above the protocol seam unchanged, and idle eviction goes through the graceful dispose path that **flushes the learning corpus**). The `## ⚠️ ACTIVE FOCUS — Learning-loop soak` banner in `CLAUDE.md`/`AGENTS.md` stays the standing #1 focus; this gateway phase is a separate, parallel track.

## Cross-repo record-keeping (flag for a docs-repo session)

The roadmap + decision record are canonical in `~/code/sovereign-ai-docs` and this repo can't commit there. A docs-repo session should reflect **Phase D shipped (v0.6.21)** against the multi-channel-gateway differentiator (ADR H-0010) and the run-anywhere program tracker (**A + B + C + D done; E–F remain**). This cross-repo sync (A/B/C/D shipped) is **still pending** for a future docs session.

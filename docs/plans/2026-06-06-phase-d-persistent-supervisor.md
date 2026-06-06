# Phase D — Persistent Multi-Session Supervisor · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Checkbox steps. Executes per `docs/conventions/autonomous-feature-builds.md` — no approval gates. Each task: read the cited files first to match exact current signatures, then TDD (red → green → commit).

**Goal:** Give the long-lived gateway a session-lifecycle layer — idle-session eviction, list/delete routes, a concurrency cap — so it owns many concurrent sessions without leaking memory, per `docs/specs/2026-06-06-phase-d-persistent-supervisor-design.md`.

**Architecture:** A gateway-scoped `SessionSupervisor` runs a periodic, `unref()`'d idle-sweep (mirroring `CronRunner`) that reclaims in-memory session state (`disposeSession` + `disposeBus`) for sessions that are not turn-active, have no subscribers, and are idle past a TTL — leaving the durable SQLite row resumable. Plus `GET`/`DELETE /sessions` routes, a `POST /sessions` cap, and a FK-safe `deleteSession`. The TUI / `sov drive` / `sov serve` paths are untouched (supervisor is built only in `runGateway`).

**Tech Stack:** TypeScript on Bun, Hono, Zod, `bun:test`, MockProvider for integration.

---

## Investigation findings (verified — cite while implementing)

- **Runtime session lifecycle** (`src/server/runtime.ts`): `sessionContexts: Map<string, SessionContext>` (`:442`, public); `getSessionContext(id)` lazy-build (`:449`); `disposeSession(id, opts?: { bus?: ServerEventBus }): Promise<void>` (`:462`, idempotent; emits `session_summary` on the bus **only if `opts.bus` is passed**); `dispose()` (`:475`) order = cronRunner → `abortAllBuses()` → walk `sessionContexts` → `clearAllBuses()` → `sessionDb.close()`.
- **Event bus** (`src/server/eventBus.ts`): class `:43-227`; `subscribers: Set<fn>` (`:44`); `ring` (`:50`); `turnActive` (`:68`) + `isTurnActive()` (`:151`) + `markTurnStart()` (`:138`); `publish()` (`:161`, clears `turnActive` on terminal); `subscribe(fn, opts?)` (`:202`); `close()`/`isClosed()` (`:216/:224`). Module: `buses: Map` (`:229`); `getOrCreateBus(id, maxRing?)` (`:250`); `disposeBus(id)` (`:259`); `abortAllBuses()` (`:283`); `clearAllBuses()` (`:309`); `setDefaultRingSize(n)` (`:246`); `__test_busCount()` (`:323`).
- **Sessions routes** (`src/server/routes/sessions.ts`): `POST /sessions` (`:24`, `sessionDb.createSession` → `{ sessionId, createdAt }` 201); `GET /sessions/:id` (`:37`); `GET /sessions/:id/messages` (`:50`); `isValidSessionId()` (`:19`). **No `GET /sessions`, no `DELETE`.**
- **SessionDb** (`src/agent/sessionDb.ts`): `createSession` (`:442`); `getSession` (`:569`); `listSessions(limit=20)` (`:534`, ordered `last_updated DESC` → `SessionListEntry[]`); columns incl. `created_at`, `last_updated`, `parent_session_id`, `metadata` (`:52-145`); cleanup helpers `cleanupPhantomReviews`/`cleanupOldCronSessions` (`:327/:360`) show the delete-with-cascade style to mirror. **No `deleteSession`.**
- **Gateway boot** (`src/cli/gatewayCommand.ts`): `runGateway` builds runtime (`:115`), `startServer` (`:120`), SIGINT/SIGTERM → `server.stop()` + `runtime.dispose()` → `exit(0)` (`:137-161`), parks forever (`:160`).
- **Cron tick pattern to mirror** (`src/cron/runner.ts:31-50`): `start()` → `setInterval(fn, ms)` then `timer.unref?.()`; `stop()` clears; `DEFAULT_TICK_INTERVAL_MS` (`:22`); opt-out via `cronEnabled` (`runtime.ts:287`); disposed at the front of `dispose()` before DB close.
- **App assembly** (`src/server/app.ts`): `buildAppWithRuntime(runtime, opts?)` mounts CORS → `/health` → `/`+`/ui` (open) → `app.use('/sessions/*', bearerAuth)` (when `opts.auth`) → routes. `startServer` is `src/server/index.ts:37`.

## File structure
**Create:** `src/server/sessionSupervisor.ts`; `tests/server/sessionSupervisor.test.ts`; `tests/server/sessionsRoutes.test.ts`; `tests/agent/sessionDb.deleteSession.test.ts`; `tests/server/restartResume.test.ts`.
**Modify:** `src/server/eventBus.ts`, `src/agent/sessionDb.ts`, `src/server/routes/sessions.ts`, `src/server/app.ts`, `src/server/index.ts`, `src/config/schema.ts`, `src/cli/gatewayCommand.ts`, `tests/server/eventBus.test.ts`, `docs/usage.md`, `docs/architecture.md`, `package.json`.

## Conventions (every task)
`.js` import specifiers; one-line file headers; **no mutation** (immutable updates); `bun:test`; explicit types on exports; `unknown`+narrow for untrusted; preserve all existing abort/cancel/per-turn semantics. Pre-commit gate `bun run lint && bun run typecheck && bun run test` (baseline ~2815/0, no new failures). Atomic commits. **NO release until T7.**

---

## T1 — bus liveness surface (D4) (~20 min · Opus)

**Files:** Modify `src/server/eventBus.ts`; extend `tests/server/eventBus.test.ts`.

Purely additive — no change to existing behavior. Read `eventBus.ts` first.

- [ ] **Write failing tests** in `tests/server/eventBus.test.ts`:
  - `getSubscriberCount()` returns 0 on a fresh bus, 1 after one `subscribe`, 0 after its unsubscribe.
  - `getLastActivityAt()` returns a number; it is bumped by `subscribe`, by `publish`, and by `markTurnStart` (use an injected/controlled clock if the bus accepts one — otherwise assert monotonic non-decrease across two calls separated by an activity).
  - `peekBus(id)` returns `undefined` for an unknown id and does **not** create a bus (`__test_busCount()` unchanged after a `peekBus` miss); returns the same instance as `getOrCreateBus(id)` after one exists.
  - `liveBusSessionIds()` returns `[]` initially, then the created ids; `__test_busCount() === liveBusSessionIds().length`.
- [ ] Run red.
- [ ] **Implement** (additive):
  - Add a `now: () => number` to the bus constructor (default `() => Date.now()`) for testability; store `lastActivityAt = this.now()` at construction.
  - Bump `this.lastActivityAt = this.now()` at the top of `subscribe`, `publish`, and `markTurnStart`.
  - `getSubscriberCount(): number => this.subscribers.size`.
  - `getLastActivityAt(): number => this.lastActivityAt`.
  - Module: `export function liveBusSessionIds(): string[] { return [...buses.keys()]; }`; `export function peekBus(sessionId: string): ServerEventBus | undefined { return buses.get(sessionId); }`. Re-express `__test_busCount` as `liveBusSessionIds().length`. Thread the optional `now` through `getOrCreateBus` if trivial; otherwise leave default.
- [ ] Run green; gate. Commit `feat(transport): bus liveness surface (subscriberCount, lastActivityAt, peekBus, liveBusSessionIds)`.

## T2 — SessionSupervisor: idle-sweep + stats + cap count (D2/D3/D7-count) (~35 min · Opus)

**Files:** Create `src/server/sessionSupervisor.ts` + `tests/server/sessionSupervisor.test.ts`.

Read `src/cron/runner.ts` (mirror the start/stop/unref pattern) + `runtime.ts:442-475` (the `disposeSession` signature) + the T1 bus surface.

- [ ] **Write failing unit tests** (`sessionSupervisor.test.ts`) — use a MockProvider runtime (see `tests/server/gatewayEndToEnd.test.ts` for the runtime-build harness) + create live buses via `getOrCreateBus`, and an injected `now`:
  - `sweep()` **evicts** a session whose bus is not turn-active, has 0 subscribers, and whose `lastActivityAt` is older than `idleSessionTimeoutMs` → asserts `disposeBus` ran (`peekBus(id) === undefined`) and `runtime.disposeSession` was called **without a `bus` arg** (spy: no `session_summary` published). Returns `{ evicted: [id], skipped: 0 }`.
  - `sweep()` **skips** a turn-active session (`bus.markTurnStart()` before, no terminal): not evicted.
  - `sweep()` **skips** a subscribed session (`bus.subscribe(fn)`): not evicted.
  - `sweep()` **skips** a too-recent session (lastActivityAt within the TTL): not evicted.
  - `liveSessionCount()` = size of (`liveBusSessionIds()` ∪ `runtime.sessionContexts.keys()`).
  - `start()` arms a timer that calls `sweep` on the injected interval (advance the injected clock + invoke the captured interval fn — or assert `setInterval` was called with the configured ms and the timer was `unref`'d); `stop()` clears it; constructing with `enabled: false` makes `start()` a no-op.
  - Eviction is gated so it never throws if `disposeSession` is mid-flight twice (idempotent).
- [ ] Run red.
- [ ] **Implement** `SessionSupervisor`:
  - `interface SupervisorOpts { runtime: Runtime; now?: () => number; idleSessionTimeoutMs?: number; idleSweepIntervalMs?: number; maxConcurrentSessions?: number; enabled?: boolean }` with constants `DEFAULT_IDLE_TIMEOUT_MS = 1_800_000`, `DEFAULT_SWEEP_INTERVAL_MS = 300_000`.
  - `liveSessionCount(): number` → `new Set([...liveBusSessionIds(), ...this.runtime.sessionContexts.keys()]).size`.
  - `async sweep()`: candidate ids = that same union. For each: `const bus = peekBus(id)`. If `bus && (bus.isTurnActive() || bus.getSubscriberCount() > 0)` → skip. Compute `lastActivity = bus ? bus.getLastActivityAt() : ((this.runtime.sessionDb.getSession(id)?.lastUpdated ?? 0) * 1000)` (DB `last_updated` is epoch **seconds** — verify + convert). If `this.now() - lastActivity <= this.idleTimeout` → skip. Else evict: `await this.runtime.disposeSession(id)` (no bus arg) then `disposeBus(id)`; collect. Wrap each eviction in try/catch (log + continue; never let one bad eviction abort the sweep). Return `{ evicted, skipped }`.
  - `start()`/`stop()` exactly per `CronRunner` (guard double-start; `setInterval(() => { void this.sweep(); }, interval).unref?.()`; `enabled === false` → no-op).
  - `stats()` → `{ live, turnActive, subscribed }` from the live set + bus inspection.
- [ ] Run green; gate. Commit `feat(gateway): SessionSupervisor — idle-session sweep + live-session count`.

## T3 — `sessionDb.deleteSession` (FK-safe) (D6 data layer) (~20 min · Opus)

**Files:** Modify `src/agent/sessionDb.ts`; create `tests/agent/sessionDb.deleteSession.test.ts`.

Read `sessionDb.ts` schema (`:52-145`) + the FK relationships + the existing cleanup deletes (`:327`, `:360`) to mirror the cascade style. **Load-bearing correctness point:** identify every table with a FK to `session_id` (messages, session_compactions, tasks, token-usage rows, and **child sessions via `parent_session_id`**) and handle each so the delete cannot raise a FK violation.

- [ ] **Write failing tests**:
  - create a session, save 2 messages + record token usage → `deleteSession(id)` → `getSession(id)` is `null`, `loadMessages(id)` is `[]`, and querying the child tables for that id returns nothing.
  - idempotent: `deleteSession` on an unknown id does not throw (returns e.g. `false`/`0`); a second `deleteSession` on the same id is a no-op.
  - a session with a **child** row (`parent_session_id = id`, e.g. a compaction/review fork): deleting the parent does not raise a FK error — assert the chosen policy (either the child's `parent_session_id` is set NULL, or the child is left and the parent row is gone — pick per the actual FK definition; if `ON DELETE` isn't declared, set children's `parent_session_id = NULL` before deleting the parent). Document the policy in a one-line comment.
  - resume-by-id of a deleted id throws `SessionNotFoundError` (exercise `buildRuntime({ resumeId })` or `getSession` → null path).
- [ ] Run red.
- [ ] **Implement** `deleteSession(sessionId: string): boolean` inside a transaction: null out / delete children per the FK policy, delete child-table rows (messages, compactions, tasks, token usage), delete the session row; return whether a row was removed. Mirror the prepared-statement + transaction style already in the file.
- [ ] Run green; gate. Commit `feat(sessions): FK-safe SessionDb.deleteSession`.

## T4 — session-management routes + cap (D6/D7) (~30 min · Opus)

**Files:** Modify `src/server/routes/sessions.ts` + `src/server/app.ts` (+ `src/server/index.ts` to pass the opt through); create `tests/server/sessionsRoutes.test.ts`.

Read `sessions.ts` + `app.ts` (`buildAppWithRuntime` opts + mount order). Add an **optional** supervisor handle so non-gateway servers omit it (cap disabled): extend `buildAppWithRuntime`'s opts with `supervisor?: { liveSessionCount(): number; sweep(): Promise<unknown>; maxConcurrentSessions: number }` (or pass the real `SessionSupervisor`; the route reads `liveSessionCount`/`sweep`/`maxConcurrentSessions`). GET/DELETE need only `runtime` + the T1 bus helpers.

- [ ] **Write failing tests** (`sessionsRoutes.test.ts`, via `buildAppWithRuntime` + `app.request`, MockProvider runtime):
  - `GET /sessions` → 200 `{ sessions: [...] }`; after creating 2 sessions both appear; each entry has `sessionId`, `createdAt`, and the annotations `live`/`turnActive`/`subscribers` (a session with a live bus + a subscriber shows `live:true, subscribers:1`; one with no bus shows `live:false`). Under auth: 401 without token.
  - `DELETE /sessions/:id` → 204; afterwards `GET /sessions/:id` → 404 and the bus is gone (`peekBus` undefined). DELETE of an unknown id → 404. Malformed id → 400. Under auth: 401 without token.
  - `POST /sessions` cap: with a supervisor whose `maxConcurrentSessions = 1` and `liveSessionCount()` stubbed to return `>= 1` even after `sweep()`, the 2nd `POST /sessions` → **429** `{ error: ... }`; with cap `0` (unlimited) or no supervisor → always 201.
- [ ] Run red.
- [ ] **Implement**:
  - `GET /sessions`: `runtime.sessionDb.listSessions(limit)` (accept `?limit`, clamp sane default), map each → `{ ...entry, live: !!peekBus(id), turnActive: peekBus(id)?.isTurnActive() ?? false, subscribers: peekBus(id)?.getSubscriberCount() ?? 0 }`. Immutable map.
  - `DELETE /sessions/:id`: validate id (400); if `getSession(id)` is null → 404; else `await runtime.disposeSession(id)` + `disposeBus(id)` + `runtime.sessionDb.deleteSession(id)` → 204.
  - `POST /sessions` cap: if `supervisor && supervisor.maxConcurrentSessions > 0 && supervisor.liveSessionCount() >= supervisor.maxConcurrentSessions`, `await supervisor.sweep()`, then re-check; if still `>=` → `c.json({ error: 'session capacity reached' }, 429)`. Else proceed as today.
  - Thread `supervisor` from `buildAppWithRuntime` opts to the sessions-route factory; `startServer` (`index.ts`) passes it through from its opts.
- [ ] Run green; gate (existing turns/gateway/reconnect tests unaffected — supervisor opt is absent there). Commit `feat(gateway): GET/DELETE /sessions + POST /sessions concurrency cap`.

## T5 — config: idle-timeout / sweep-interval / max-sessions (D8) (~10 min · Opus)

**Files:** Modify `src/config/schema.ts` (`gateway` block `:417-431`); extend `tests/config/schema.test.ts`.

- [ ] **Failing test**: the `gateway` block accepts `idleSessionTimeoutMs: 60000`, `idleSweepIntervalMs: 30000`, `maxConcurrentSessions: 5`; rejects negative/zero where required (`idleSessionTimeoutMs`/`idleSweepIntervalMs` must be positive ints; `maxConcurrentSessions` nonneg int); all optional (absent block still valid).
- [ ] Run red.
- [ ] **Implement**: add to the `gateway` object — `idleSessionTimeoutMs: z.number().int().positive().optional()`, `idleSweepIntervalMs: z.number().int().positive().optional()`, `maxConcurrentSessions: z.number().int().nonnegative().optional()`. Keep `.strict()`.
- [ ] Run green; gate. Commit `feat(config): gateway idle-timeout / sweep-interval / max-sessions`.

## T6 — gateway wiring + restart-resume proof (D2-wiring/D5/D9) (~25 min · Opus)

**Files:** Modify `src/cli/gatewayCommand.ts`; create `tests/server/restartResume.test.ts`.

Read `gatewayCommand.ts:86-161`. Construct the supervisor **only here** (gateway-scoped — D9).

- [ ] **Write failing test** (`restartResume.test.ts`, MockProvider runtime + the real app/turns path): create a session, run a turn to completion, assert history saved; then `await runtime.disposeSession(id)` + `disposeBus(id)` (simulating an eviction / process restart with empty maps); then run a **second** turn on the **same** `sessionId` → it rebuilds the context from the DB (`getSessionContext` lazily) and completes with no error, and `loadMessages(id)` contains both turns. (Proves D5: eviction/restart are transparent.)
- [ ] Run red (it should already pass if resume works — if so, this is a *characterization* test locking the behavior; keep it).
- [ ] **Implement wiring** in `runGateway`:
  - After `buildRuntime`, read the `gateway` config block → `const supervisor = new SessionSupervisor({ runtime, idleSessionTimeoutMs: cfg.gateway?.idleSessionTimeoutMs, idleSweepIntervalMs: cfg.gateway?.idleSweepIntervalMs, maxConcurrentSessions: cfg.gateway?.maxConcurrentSessions ?? 0 })`; `supervisor.start()`.
  - Pass `supervisor` into `startServer({ ..., supervisor })` → `buildAppWithRuntime(runtime, { auth, corsOrigins, supervisor })` (the cap from T4).
  - In **both** SIGINT and SIGTERM handlers: `supervisor.stop()` **before** `runtime.dispose()` (no sweep racing DB close).
  - Log a one-line boot summary (e.g. `idle-evict: sessions idle >Nm reclaimed every Mm; max-sessions: K|unlimited`).
- [ ] Run green; gate. Commit `feat(gateway): wire SessionSupervisor into the gateway lifecycle + restart-resume test`.

## T7 — docs + close-out + release (D10 + ship) (~25 min · Opus; bump Sonnet-eligible)

**Files:** `docs/usage.md`, `docs/architecture.md`, `docs/testing-log.md`, `docs/state/2026-06-06-phase-d-supervisor.md`, roadmap spec (mark Phase D shipped), `CLAUDE.md`+`AGENTS.md` (state pointer; **DON'T touch the soak banner**; `diff` empty), `package.json`.

- [ ] `docs/usage.md`: a "Persistent gateway / session lifecycle" subsection — idle eviction (what gets reclaimed + when; resume is transparent), `GET /sessions` (list + live annotations) and `DELETE /sessions/:id` (remove), the three `gateway.*` config knobs (defaults 30 m / 5 m / unlimited), and the **D10 "Run the gateway as a service"** section (a systemd unit + a macOS launchd plist example with env-based token/host/port + restart-on-failure).
- [ ] `docs/architecture.md`: the `SessionSupervisor` surface + "the gateway is the persistent backbone" (lazy rebuild = restart-resume; eviction is graceful finalization that still feeds the learning corpus).
- [ ] State snapshot `docs/state/2026-06-06-phase-d-supervisor.md` (match recent style): Phase D shipped — supervisor (idle eviction + cap), list/delete routes, `deleteSession`, restart-resume proven; the D1 extend-the-gateway decision (daemon skeleton stays dormant); test count; version (v0.6.21); D/E/F → E/F remain; learning soak continues in parallel.
- [ ] Update the most-recent-state pointer in `CLAUDE.md`+`AGENTS.md` (session-boot item 3 + Current-state table) to the new file; **leave the `## ⚠️ ACTIVE FOCUS — Learning-loop soak` banner untouched**; `diff CLAUDE.md AGENTS.md` MUST be empty (`cp CLAUDE.md AGENTS.md`).
- [ ] Append a `docs/testing-log.md` entry (build + gate + any close-out review).
- [ ] Mark Phase D `✅ Shipped v0.6.21 (2026-06-06)` in `docs/specs/2026-06-05-run-anywhere-harness-roadmap-design.md` (mirror A/B/C). Leave E/F.
- [ ] **Release** per `docs/conventions/cutting-releases.md`: bump `package.json` 0.6.20 → **0.6.21**; gate green; commit `chore(release): bump version 0.6.20 -> 0.6.21` (body: persistent session supervisor — idle eviction + list/delete routes + concurrency cap); push; update `/Users/julie/code/sov-releases/CHANGELOG.md` (user-facing: "Persistent gateway: idle sessions are reclaimed automatically; new GET/DELETE /sessions lifecycle routes + an optional concurrency cap"); commit+push public repo; `git tag v0.6.21 && git push origin v0.6.21`; watch CI to success; `gh release view v0.6.21 --repo yevgetman/sov-releases` (4 artifacts); `sov upgrade`; verify `~/.sov/bin/sov --version` → 0.6.21.
- [ ] Commit + push everything.

---

## Self-review

**Spec coverage:** D1 extend-gateway → T2/T6 (no daemon); D2 supervisor+unref+clock+gateway-scoped → T2 (class) + T6 (wiring/stop-before-dispose); D3 eviction rule → T2; D4 bus surface → T1; D5 transparent resume → T6 (restart-resume test); D6 list/delete routes → T4 + T3 (`deleteSession`); D7 cap → T4 (route) + T2 (`liveSessionCount`); D8 config → T5; D9 gateway-scoped → T6; D10 service-install docs → T7. Every decision maps to a task.

**Placeholder scan:** none — every task has concrete files (with line anchors), concrete test cases, concrete signatures.

**Type/name consistency:** `SessionSupervisor`, `liveSessionCount()`, `sweep()`, `stats()`, `getSubscriberCount()`, `getLastActivityAt()`, `lastActivityAt`, `peekBus()`, `liveBusSessionIds()`, `deleteSession()`, `maxConcurrentSessions`, `idleSessionTimeoutMs`, `idleSweepIntervalMs` — used identically across T1–T7. Load-bearing correctness points called out: T2 (DB `last_updated` is **seconds** → convert; per-eviction try/catch; no-bus-arg → no goodbye card), T3 (FK handling incl. `parent_session_id` children), T6 (`stop()` before `dispose()`).

## Execution

Per the autonomous convention: T1→T7 subagent-driven (fresh Opus implementer per task + spec-compliance review + code-quality review), no approval gates, no between-task check-ins; ship (release v0.6.21) at T7. A final whole-phase review before the release. The learning-loop soak continues untouched in parallel.

# State of the build — 2026-05-11 close-out

**Phase 16.0a HEAD:** `21ee4c2`
**Suite:** 1805/1805 unit + 58/58 semantic (semantic suite unchanged — Phase 16.0a has no agent-facing surfaces)
**Sov binary:** in sync with master (`21ee4c2`), `harness` alias installed alongside `sov`

This is a session close-out snapshot. The next session boots from CLAUDE.md and should read this file first.

## Where we are

Phases 0 through 13.5 and Phase 16.0a are shipped. The harness can now run overnight autonomous missions (Phase 13.5) and has the daemon infrastructure skeleton (Phase 16.0a): channel types, LRU session cache, approval queue, typed event bus, `startDaemon()` runner, and `harness daemon` CLI command. Phase 16.0b (Ink TUI as foreground subscriber of the daemon bus) is the logical next step.

Backlog items 12 and 13 closed 2026-05-11 (microcompaction settings wiring + post-compaction guard; shell AST analysis confirmed done). 1 open P3+ backlog item remains (17). None block further build-plan phases.

## What shipped today (2026-05-11)

### Phase 16.0a — Daemon infrastructure skeleton. Five tasks via subagent-driven development.

| Commit | Summary |
|---|---|
| `e457d29` | `src/channels/types.ts` + `sessionKey.ts` + `delivery.ts` — `InboundMessage`, `ChannelAdapter`, `SecretTarget`, `DeliveryResult`; `buildSessionKey`; `send()` with local outbox |
| `4c2300a` | `src/daemon/sessionCache.ts` — LRU `SessionCache` (Map-backed, delete+re-insert on access) |
| `0248df1` | `src/daemon/approvalQueue.ts` — `ApprovalQueue` with TTL expiry, `enqueue/dequeue/pending/expireStale` |
| `41f68a3` + `444d69c` | `src/daemon/types.ts` + `eventBus.ts` — `DaemonEvent` 7-variant union, `DaemonEventMap` mapped type, typed `DaemonEventBus` over Node `EventEmitter` |
| `2bc0ffa` | `src/daemon/runner.ts` + `src/main.ts` — `startDaemon()` acquires PID lock, inits bus/cache/queue, emits `daemon_started`; `harness daemon` CLI with SIGTERM/SIGINT handling |
| `21ee4c2` | Fix runner.ts: guard lock release in `try/finally` inside `shutdown()` so a throwing bus listener can't leak the lock |

Net test delta: **1769 → 1805** (+36 new unit tests across channels/sessionCache/approvalQueue/eventBus/runner).

### Earlier this session (same date)

Backlog items 12 and 13 (microcompaction settings wiring + post-compaction guard; shell AST analysis confirmed done): `cd5a37c` → `6667bb2`.

Phase 13.5 — scheduled-mission sub-agents: `fdf60d7` → `9aef892` (+52 unit tests, 1717 → 1769).

## Open backlog

Items 12, 13, and 24 closed since the 2026-05-07 snapshot. See `docs/post-phase-13-4-backlog.md`.

| # | Priority | Effort | Title | Status |
|---|---|---|---|---|
| 12 | P3 | half-day | Microcompaction (Phase 10 deepening) | closed 2026-05-11 |
| 13 | P3 | half-day | Shell AST analysis (Phase 7 deepening) | closed 2026-05-11 |
| 17 | P4 | multi-day | Eval-gated auto-promote | open |
| 24 | P3 | half-day | `maxToolCallsBeforeCheckin` knob | closed 2026-05-11 |

## Behavioral notes worth knowing next session

1. **Scheduled-mission wake lifecycle.** `sov chat --agent scheduled-mission --state-dir <dir>` is non-interactive — it runs one automated wake and exits. The `--state-dir` path must contain `mission.md` + `state.json` (created by `sov mission init`). The `.lock/` subdirectory is the overlap guard; if a launchd job fires while a wake is running, the second invocation prints "lock held" and exits 0. The lock is released in a `try/finally` in `runRepl`.

2. **`harness` alias.** The ops repo install.sh at `~/code/sovereign-ai-ops/mission/install.sh` uses `harness` (not `sov`) as the binary name and checks `harness --help | grep state-dir`. After `sov upgrade`, both `sov` and `harness` are on PATH; the `chat` command description now mentions `--state-dir` so the grep passes.

3. **`scheduled-mission` is name-routed, not role-routed.** It has no `role:` frontmatter field. It does not appear in the capability profile table for role lookups. It is reached only via `--agent scheduled-mission` from the CLI or `subagent_type: scheduled-mission` from a parent agent. It declares `supportsMissionState: true` to unlock the lifecycle gate in the REPL.

4. **Semantic test coverage for Phase 13.5.** The wake lifecycle (lock → FSM → auto-wake → sentinel → state write) cannot be tested by the current semantic driver (which pipes stdin prompts — but mission mode ignores stdin and uses the auto-wake path instead). The `agents-bundle-default-discoverable` test now includes `scheduled-mission` in its `mustSatisfy` criteria, covering registry discoverability. Full end-to-end semantic coverage would require driver enhancements (pre-run dir setup + `--state-dir` flag support) — deferred.

5. **Inherited notes from 2026-05-07** (still valid):
   - `bundle-default` is loaded by default; true "no memory" mode is rare in practice.
   - `HARNESS_HOME=/path printf ... | sov chat` pitfall — use `export` or `env` prefix.
   - WebSearch adds a 22nd tool when `webSearch.apiKey` is set; tests that pin exact tool counts must clear credentials.

## Where to start the next session

- **If continuing the build plan:** Phase 16.0b (Ink TUI as foreground subscriber of the daemon bus) is the logical next step after 16.0a. Read `~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md` for the full phase spec.
- **If picking up backlog:** item 17 (eval-gated auto-promote) is the only open item — it's multi-day.
- **If doing a soak / validation:** `harness daemon` — run `harness daemon` in one terminal and confirm it starts, prints `[daemon] started (PID N)`, and exits cleanly on Ctrl-C / SIGTERM. A second invocation while the first is running should print `[daemon] daemon already running (PID N)` and exit 1.

## Test-gate baseline

```
bun run typecheck   # tsc --noEmit, must exit 0
bun run lint        # biome check, 2 pre-existing warnings in src/permissions/shellSemantics.ts — accept those
bun test            # 1805/1805 unit
bun run test:semantic   # 58/58 (~5 min, ~$0.87 informational on subscription)
```

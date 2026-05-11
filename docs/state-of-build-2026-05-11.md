# State of the build — 2026-05-11 close-out

**Phase 13.5 HEAD:** `9aef892`
**Suite:** 1769/1769 unit + 58/58 semantic (semantic suite unchanged — agents discoverability test extended to cover `scheduled-mission`)
**Sov binary:** in sync with master (`9aef892`), `harness` alias installed alongside `sov`

This is a session close-out snapshot. The next session boots from CLAUDE.md and should read this file first.

## Where we are

Phases 0 through 13.5 are shipped. The harness can now run overnight autonomous missions: `sov chat --agent scheduled-mission --state-dir <path>` acquires an overlap lock, loads prior mission state, injects it into the system prompt, runs one bounded wake, parses the `MISSION_TRANSITION=<state>` sentinel, writes back state + wake log, and exits — ready to be woken again by launchd/cron.

The 4 open P3+ backlog items (12, 13, 17, 24) remain untouched. None block further build-plan phases.

## What shipped today (2026-05-11)

Phase 13.5 — scheduled-mission sub-agents. Eight tasks via subagent-driven development.

| Commit | Summary |
|---|---|
| `fdf60d7` | `src/mission/types.ts` + `src/mission/paths.ts` — all mission types and 6 canonical path helpers |
| `6adc7d9` | `src/mission/state.ts` — `loadMissionState`, `writeMissionState`, `appendWakeLog`, `acquireLock`, `releaseLock` |
| `5e51baa` | Fix state.ts: per-line malformed-entry isolation in wake-log reader, `.tmp` cleanup on rename failure, `fsmState` validation in writer |
| `d8685f8` | `src/mission/fsm.ts` — `shouldRun`, `applyTransition`, full transition table |
| `8938bd4` | `src/mission/segments.ts` — `buildMissionSegments` → cacheable goal/plan/state + ephemeral notes/wake-log `SystemSegment[]` |
| `cf20fa1` | `AgentDefinition.supportsMissionState: boolean`; FrontmatterSchema updated; `bundle-default/agents/scheduled-mission.md`; 7 test fixtures updated |
| `c0f9be2` | `terminalRepl.ts`: `ReplOpts.agentName?` + `stateDir?`; mission lifecycle (lock, FSM guard, segment injection, tool restriction via `buildToolScope`, auto-wake, sentinel + notes parsing, state write-back, wake-log append) |
| `8e170b5` | Fix terminalRepl.ts: try/finally wraps full post-mission-setup body to guarantee lock release on any exception in the ~600-line setup stretch |
| `8d7f293` | `src/cli/missionInit.ts` + `tests/mission/missionInit.test.ts`; `--agent`/`--state-dir` flags on `sov chat`; `sov mission init` subcommand; `harness` bin alias in `package.json` |
| `eb8b893` | Extract `DEFAULT_PER_WAKE_TURN_BUDGET` constant; add `afterEach` cleanup in missionInit tests |
| `9aef892` | Docs: semantic testing mapping table, testing log, chat command description updated to surface `--state-dir` in `harness --help` |

Net test delta: **1717 → 1769** (+52 new unit tests across mission types/paths/state/fsm/segments/loader/missionInit).

## Open backlog

Unchanged from the 2026-05-07 snapshot. See `docs/post-phase-13-4-backlog.md`.

| # | Priority | Effort | Title |
|---|---|---|---|
| 12 | P3 | half-day | Microcompaction (Phase 10 deepening) |
| 13 | P3 | half-day | Shell AST analysis (Phase 7 deepening) |
| 17 | P4 | multi-day | Eval-gated auto-promote |
| 24 | P3 | half-day | `maxToolCallsBeforeCheckin` knob |

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

- **If continuing the build plan:** read `~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md` and start the next phase after 13.5.
- **If picking up backlog:** items 12, 13, 24 are half-day each; item 17 is multi-day.
- **If doing a soak / validation:** run a live mission end-to-end: `sov mission init /tmp/sov-soak --goal "Count .ts files under src/ and write the count to count.txt" && sov chat --agent scheduled-mission --state-dir /tmp/sov-soak` — one wake should create the file.

## Test-gate baseline

```
bun run typecheck   # tsc --noEmit, must exit 0
bun run lint        # biome check, 2 pre-existing warnings in src/permissions/shellSemantics.ts — accept those
bun test            # 1769/1769 unit
bun run test:semantic   # 58/58 (~5 min, ~$0.87 informational on subscription)
```

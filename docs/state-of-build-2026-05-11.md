# State of the build — 2026-05-11 close-out

**Phase 16.0b HEAD:** post-cascade final-review batch (5 commits — see "Final review follow-ups" below). Pre-cascade HEAD was `147b892`.
**Phase 16.0a HEAD:** `21ee4c2` (still in history; close-out earlier this same date)
**Suite:** **1443/1443 unit** + 58/58 semantic (the 1700 → 1443 drop is fully accounted for by dead-code purge — see Final review follow-ups; semantic suite unchanged because Phase 16.0b ships no agent-facing surfaces)
**Sov binary:** in sync with master (post-cascade HEAD), `harness` alias installed alongside `sov`

This is a session close-out snapshot. The next session boots from CLAUDE.md and should read this file first.

## Where we are

Phases 0 through 13.5 and Phase 16.0a–b are shipped. The harness can now run overnight autonomous missions (Phase 13.5), has the daemon infrastructure skeleton (Phase 16.0a — channel types, LRU session cache, approval queue, typed event bus, `startDaemon()` runner, `harness daemon` CLI), and now mounts an Ink TUI as the default `sov` entry point with the foreground subscriber wired to the daemon bus (Phase 16.0b). The legacy readline REPL (`src/ui/terminalRepl.ts`) and its 11 helper UI modules have been deleted in favor of the Ink components. `sov chat` is gone; bare `sov` (and `harness`) open the TUI; `sov mission run --state-dir <path>` is the non-interactive scheduled-mission wake runner.

The unit count drop from 1820+ (prior peak after Tasks 2 + 4–7 added Ink helper tests) down to **1700** at HEAD is from deleting the readline REPL's helper tests alongside the readline REPL itself — **not a regression**. All remaining tests pass.

Backlog items 12, 13, and 24 closed earlier 2026-05-11. 1 open P3+ backlog item remains (17). None block further build-plan phases.

## What shipped today (2026-05-11) — Phase 16.0b

Phase 16.0b — Ink TUI + task event bus subscription. Ten tasks via subagent-driven development (with reviewer + spec gates between each). Commits flow from the 16.0a close-out (`1243c52`) through to HEAD (`147b892`).

| Commit | Task | Summary |
|---|---|---|
| `f4eea5f` | 1 | `build(deps): add ink + react for Phase 16.0b TUI; enable jsx: react-jsx` — Ink 5 + React 18 deps; `tsconfig.json` `jsx: react-jsx`; `bunfig.toml` jsx hint |
| `5e684af` | 2 | `feat(tasks): TaskManager emits task_update to daemon bus` — accepts an optional `bus: DaemonEventBus` ctor param; emits on `task_create / running / completed / failed / cancelled / timed_out` lifecycle transitions |
| `8cc7b46` | 2 fu | `fix(tasks): wrap bus emits in safeEmit to isolate listener throws` — listener exceptions are caught and discarded so a buggy subscriber can't blow up the task lifecycle |
| `e9d5445` | 3 | `refactor(mission): extract non-interactive wake into src/cli/missionRun.ts` — pulls the scheduled-mission auto-wake path out of `terminalRepl.ts` so deleting the readline REPL doesn't break the launchd path |
| `f82974f` | 4 | `feat(ui): Ink TUI scaffold — App + pure UiState reducer` — new `src/ui/ink/` directory; `App.tsx` mounts Ink; `state.ts` is a pure reducer with `Action` discriminated union; `types.ts` defines `UiState` shape |
| `bbe48b0` | 4 fu | `fix(ui): rename ink/index.ts to .tsx for JSX; correct reducer/types comments` |
| `c680ba5` | 5 | `feat(ui): Transcript component renders messages by role` — distinct visual treatments for user / assistant / tool / system; streaming-friendly child of `App` |
| `f5b1751` | 6 | `feat(ui): Prompt input — Enter submits, Ctrl-C aborts, Backspace edits` — controlled input via `useInput`; emits submit events the agent loop consumes |
| `57fc876` | 7 | `feat(ui): StatusLine component — profile, cwd, provider, model, cost, thinking indicator` — bottom-of-screen status surface fed from `UiState` |
| `a8d357c` | 8 | `feat(ui): wire Ink TUI to agent loop + daemon bus` — `startInkTUI()` boots a daemon, mounts the React tree, subscribes to `task_update` (renders task progress in the transcript), runs the agent turn loop on submit. **Subscription side only** — the emit side requires lifting `SubagentScheduler / sessionDb / traceWriter / hookRunner` into the same scope; that wiring is deferred to Phase 16.0c. `task_create` is exposed but throws "no task manager" if invoked (same posture as `missionRun.ts`). |
| `e90d54d` | 9 | `feat(cli): bare 'sov' opens Ink TUI; remove 'chat' command; add 'sov mission run'` — Commander `chat` subcommand deleted; default action routes to `startInkTUI(opts)`; `mission run --state-dir <path>` is the non-interactive entry the launchd hook uses; `src/ui/terminalRepl.ts` + 11 helper UI modules deleted |
| `147b892` | 9 fu | `fix(cli): remove stale 'sov chat' references from user-facing strings` — splash hint, in-session resume hint, and error messages now say `sov` instead of `sov chat` |

Net test delta: the prior Phase 16.0a baseline at `21ee4c2` was 1805/1805. Through Tasks 2 + 4–7 the count peaked at ~1820+ as Ink helper tests landed. Task 9's deletion of `terminalRepl.ts` and 11 helper UI modules dropped helper tests; the close-out at HEAD is **1700/1700** — a net drop from peak, but a strict subset of the 1805 baseline plus the new Ink coverage. **No regressions.**

### Earlier this session (same date)

Phase 16.0a — Daemon infrastructure skeleton: `e457d29` → `21ee4c2` (+36 unit tests, 1769 → 1805). Five tasks via subagent-driven development. See the file's earlier history in git for the full close-out detail.

## Final review follow-ups (post-cascade, 2026-05-11)

After the 13-commit Phase 16.0b cascade closed at `147b892`, the final whole-branch review surfaced four issues that warranted same-day fixes plus a docs update. The user picked: fix bugs + purge dead code now; defer slash command dispatch to Phase 16.0c. Five commits landed in sequence:

| Commit | Summary |
|---|---|
| `718e0c9` | `fix(ui): startInkTUI passes profile name to <App>, not the home path` — the StatusLine was rendering the full `~/.harness/profiles/<name>/` path as the profile segment because `startInkTUI` forwarded `home` (filesystem path from `resolveHarnessHome()`) instead of calling `getActiveProfile()`. |
| `82f5fad` | `fix(ui): Prompt disables Enter while agent turn is in flight` — without a re-entrancy guard, hitting Enter mid-turn would launch a second concurrent `query()` generator whose stream events would interleave with the first, corrupting the reducer transcript state. `Prompt` now accepts `disabled?: boolean`; `App` passes `state.status !== 'idle'`. Marker dims to `⋯` while disabled. Added a 4th test case. |
| `92953e2` | `refactor(cleanup): purge ~4,200 LoC of dead modules orphaned by terminalRepl removal` — 17 production modules (commands/info, commands/pickers, commands/registry, commands/reviewOps, commands/sessionOps, commands/taskOps, commands/types, skills/commands, ui/autocomplete, ui/inputEditor, ui/inputHistory, ui/keypress, ui/markdownStream, ui/picker, ui/sessionSummary, ui/textBuffer, ui/toolFooter) + 21 test files. Test count dropped 1701 → 1443. **Notable:** `src/commands/registry.ts` (slash command registry) is in this list — its deletion makes the 16.0c slash-dispatch deferral explicit. Kept: `commands/toolScope.ts` (used by `cli/missionRun.ts`), `permissions/prompt.ts` (`previewToolInput` is consumed by `canUseTool.ts`), `ui/modal.ts` + `ui/box.ts` + `ui/theme.ts` (transitively reached via `permissions/prompt.ts`). |
| `83dc957` | `docs(usage): align with Phase 16.0b CLI surface` — `docs/usage.md` reworked: top-of-file note flagging the 16.0b/16.0c boundary, CLI Flags table reduced to the two flags that actually exist on bare `sov`, CLI Subcommands table updated, common-workflow examples updated to use `sov config set` instead of vanished flags. Sections deeper in the doc (REPL UX, slash commands, etc.) still describe steady-state behavior — flagged at the top. |
| (this commit) | `docs: flag slash command dispatch as Phase 16.0c P0 headline item` — CLAUDE.md + state-of-build updated to reflect the post-cascade reality. |

Test gate at post-cascade HEAD: typecheck clean, lint clean (2 pre-existing warnings), 1443/1443 unit.

## What's deferred to Phase 16.0c

The Phase 16.0b plan reviewer flagged several items as deliberately out of scope for 16.0b. The final post-cascade review elevated slash command dispatch to the P0 headline item — the dead-code purge removed `src/commands/registry.ts` and the whole dispatch surface goes with it. The next session must not misremember these as already shipped.

**Slash command dispatch (P0 — headline 16.0c lift).** The Ink TUI ships without `/help`, `/cost`, `/tasks`, `/compact`, `/review`, `/skills`, `/tools`, `/context-budget`, `/config`, `/model`, `/settings`, `/theme`, `/copy`, `/export`, `/init`, `/commit`, `/clear`, `/compact`, `/rollback`, `/resume`, `/stats`, `/quit`, `/about`, `/permissions`. Typing a `/`-prefixed message currently goes to the model as plain text. Phase 16.0c rebuilds dispatch on top of the Ink TUI: parsing `/`-prefixed input in `useAgentTurn`, routing to a registry reconstructed inside the new Ink architecture (separate concern from the deleted `src/commands/registry.ts` which was tightly coupled to the readline REPL), rendering results in the transcript. Tests for the rebuilt registry should colocate with the Ink TUI to avoid the prior false-confidence pattern.

**Daemon-level compression threshold (build item 5).** Out of 16.0b scope per the user's choice. When a cached session is >85% of the model context, compact before the new turn enters the agent. Phase 16.0c work.

**TaskManager construction wiring.** Task 8 added the **subscription** side of `task_update` (the Ink TUI listens). The **emit** side requires lifting the full subagent machinery — `SubagentScheduler`, `sessionDb`, `traceWriter`, `hookRunner` — into the same scope as `startInkTUI()`. Currently `task_create` is exposed in the tool pool but throws "no task manager" if the model tries to invoke it (same as `missionRun.ts` did). The `bus: daemon.bus` ctor arg added in Task 2 is ready; 16.0c needs to instantiate `TaskManager` with that arg and plumb it through.

**Full agent-loop knobs at the CLI surface.** `--provider`, `--model`, `--max-tokens`, `--permission-mode`, `--resume`, `--db`, `--no-cache`, `--no-preflight`, `--transcript`, `-v / --verbose`, `--legacy-input`, `--capture-fixture`, `--replay-fixture`, `--agent`, `--state-dir` — all of these were available on the deleted `sov chat`. They are NOT yet forwarded to `startInkTUI`. Currently only `--bundle` works at the bare-`sov` surface. These plumb through during the 16.0c TaskManager + session-DB lift.

**Eval runner regression.** `src/eval/runner.ts` still spawns `sov chat --db ...` which is now broken. `bun run eval` does not work on master. Fixing requires a non-interactive multi-turn entry point — `sov mission run` is single-shot wake, not multi-turn — so 16.0c needs to either (a) add a `sov run --headless` flag to the Ink entry or (b) build a separate non-interactive multi-turn runner. A NOTE comment lives in `src/main.ts:290` flagging this.

**`daemon_stopping`-after-unmount timing.** The `daemon_stopping` event fires after Ink unmounts, so the subscription handler is already detached. Cosmetic; the event is recorded in the trace, just not surfaced in the TUI before exit. Phase 16.0c may want to pre-unmount-emit.

**`process.exit(0)` on Ctrl-C in Prompt.** The current Ctrl-C handler in `src/ui/ink/Prompt.tsx` calls `process.exit(0)` directly, bypassing the `finally` block in `startInkTUI` that would otherwise call `daemon.shutdown()` and flush the memory provider. This was the pre-existing behavior of `terminalRepl.ts`'s Ctrl-C path and was preserved through 16.0b; worth fixing in 16.0c — emit a clean-shutdown event and let the React tree unmount + the finally block run.

### Known minor quirks (not regressions)

**`sov chat` becomes a positional arg.** Commander treats unknown subcommand strings as positional args to the default action. So `sov chat` does not print "unknown command" — it mounts the TUI with `chat` as a positional. Acceptable for 16.0b ship; no easy fix without re-adding `chat` as a deprecation shim.

### Behavior changes worth flagging

**Bare `sov` is now interactive.** The default Commander action mounts Ink. Previously bare `sov` invoked `chat` (also interactive), so functionally equivalent — but the new default exits the TUI when the user presses Ctrl-C, not exits the shell. Smoke test confirms: `sov --help` lists no `chat` command; bare `sov` mounts the TUI; Ctrl-C exits the TUI cleanly.

**`harness` alias.** The npm bin mapping continues to map both `sov` and `harness` to `src/main.ts`, so the launchd hook in the ops repo (`~/code/sovereign-ai-ops/mission/install.sh`) continues to work. After `sov upgrade`, both binaries are on PATH; the `mission run` subcommand description mentions `--state-dir`.

## Open backlog

Items 12, 13, and 24 closed earlier 2026-05-11. See `docs/post-phase-13-4-backlog.md`.

| # | Priority | Effort | Title | Status |
|---|---|---|---|---|
| 12 | P3 | half-day | Microcompaction (Phase 10 deepening) | closed 2026-05-11 |
| 13 | P3 | half-day | Shell AST analysis (Phase 7 deepening) | closed 2026-05-11 |
| 17 | P4 | multi-day | Eval-gated auto-promote | open |
| 24 | P3 | half-day | `maxToolCallsBeforeCheckin` knob | closed 2026-05-11 |

## Behavioral notes worth knowing next session

1. **The default `sov` invocation now mounts Ink.** No more `sov chat`. The default Commander action constructs a daemon, mounts the React tree, subscribes to `task_update`, and runs the agent turn loop on each prompt submit.

2. **`sov mission run --state-dir <path>` is the launchd entry.** Non-interactive scheduled-mission wake; pulls FSM/lock/state from `src/cli/missionRun.ts`. The mission lifecycle (overlap lock via mkdir, FSM terminal-state early-exit, system-prompt injection, auto-wake user message, sentinel parsing, wake-log append, atomic state write-back, lock release in try/finally) is intact and identical to the prior `sov chat --agent scheduled-mission --state-dir <path>` path; only the CLI surface changed.

3. **TaskManager wiring is half-built on purpose.** The bus subscription side ships in 16.0b so the TUI can render task progress *if* an emit path existed. The emit path (full TaskManager construction inside `startInkTUI`) is 16.0c — a single-line ctor change once the `SubagentScheduler / sessionDb / traceWriter / hookRunner` are lifted into the same scope. Until then, `task_create` is exposed but throws.

4. **`harness` alias.** As before — both `sov` and `harness` map to `src/main.ts` via the package.json `bin` field.

5. **`scheduled-mission` is name-routed, not role-routed.** Unchanged from 13.5. No `role:` frontmatter; reached only via `subagent_type: scheduled-mission` from a parent or `--agent scheduled-mission` from the CLI. Declares `supportsMissionState: true`.

6. **Semantic test coverage.** Phase 16.0b adds **0 new semantic tests** (audited, none required — the TUI is a presentation surface; existing slash commands and tools route through the same registry/permission system as `terminalRepl.ts` did). Suite stays at 58/58.

7. **Inherited notes from 2026-05-07** (still valid):
   - `bundle-default` is loaded by default; true "no memory" mode is rare in practice.
   - `HARNESS_HOME=/path printf ... | sov chat` pitfall — use `export` or `env` prefix. NOTE: `sov chat` is gone; the corresponding pitfall now applies to bare `sov` (though Ink's stdin handling differs from readline so the failure mode is different in practice).
   - WebSearch adds a 22nd tool when `webSearch.apiKey` is set; tests that pin exact tool counts must clear credentials.

## Where to start the next session

- **If continuing the build plan:** Phase 16.0c is the natural next step. **P0 headline lift is slash command dispatch** — the dead-code purge in commit `92953e2` removed `src/commands/registry.ts` entirely, so the TUI currently has no slash dispatch path. Rebuild dispatch on top of the Ink TUI (parse in `useAgentTurn`, route to a fresh registry, render in the transcript). Then the rest of the deferred items — daemon-level compression threshold, TaskManager construction lift into `startInkTUI`, full agent-loop knobs at the CLI, eval-runner re-wire, daemon_stopping timing, Ctrl-C memory flush. Read `~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md` Phase 16.0 for the full spec.
- **If picking up backlog:** item 17 (eval-gated auto-promote) is the only open item — multi-day.
- **If doing a soak / validation:** `bun src/main.ts --help` should NOT list `chat`; should list `mission` and `daemon`. Bare `bun src/main.ts` in a TTY should mount the Ink TUI. `bun src/main.ts mission run --help` should describe the non-interactive wake. Typing `/help` at the Ink prompt currently sends the literal string to the model — confirms slash dispatch is missing.

## Test-gate baseline

```
bun run typecheck   # tsc --noEmit, must exit 0
bun run lint        # biome check, 2 pre-existing warnings in src/permissions/shellSemantics.ts — accept those
bun test            # 1443/1443 unit
bun run test:semantic   # 58/58 (~5 min, ~$0.87 informational on subscription); NOT run for this docs-only commit
```

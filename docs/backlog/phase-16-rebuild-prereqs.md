# Phase 16 — foreground rebuild prerequisites

> **Authoritative phase plan:** `docs/specs/2026-05-13-phase-16-1-tui-rebuild-design.md` §9. This backlog enumerates the 24 subsystems any new foreground must wire; the spec assigns them to milestones M4–M8.

When Phase 16 is retried (as Phase 16.1 per the open-question resolution in `docs/state/archive/2026-05-12.md`), it must follow Rule 1 of `docs/postmortems/2026-05-12-phase-16-revert.md`: the new foreground surface ships alongside the existing one (`src/ui/terminalRepl.ts`) behind an opt-in flag, not as a replacement. This file enumerates the subsystems any new foreground surface must wire — captured here so the next attempt doesn't re-discover them through a close-out audit.

These are the surfaces that were silently broken in the Phase 16.0b Ink TUI. They all exist on master today (post-revert) and are wired through `src/ui/terminalRepl.ts`. The new foreground surface must wire each one to parity before it can be considered a real alternative.

## Critical — agent loop will misbehave silently without these

| # | Status | Surface | What it does | Source location |
|---|---|---|---|---|
| 1 | `[ ]` | **Hooks system** | PreToolUse / PostToolUse / UserPromptSubmit / Stop hooks fire around tool calls per `~/.harness/settings.json` `hooks` block | `src/hooks/runner.ts`, `src/hooks/consent.ts` |
| 2 | `[ ]` | **MCP client pool** | stdio MCP servers connect; their tools wrap as `mcp__<server>__<tool>` and enter the tool pool | `src/mcp/client.ts`, `src/mcp/toolWrapper.ts` |
| 3 | `[ ]` | **Permission prompt UI** | When a tool needs consent in `ask` mode, the user gets a modal prompt with `[y]es / [n]o / [a]lways` | `src/permissions/prompt.ts` (readline asker), `src/permissions/canUseTool.ts` |
| 4 | `[ ]` | **Sub-agent scheduler** | AgentTool + task_create delegate to bounded child sessions with per-lane semaphores and a global write-path lock | `src/runtime/scheduler.ts`, `src/runtime/laneSemaphores.ts`, `src/runtime/semaphore.ts`, `src/runtime/agentRunner.ts` |
| 5 | `[ ]` | **TaskManager construction** | `task_create` etc. depend on a live `TaskManager` in CommandContext — without it the tool throws "no task manager" | `src/tasks/manager.ts`, `src/tasks/store.ts` |
| 6 | `[x]` (M4 — 2026-05-14) | **Session DB persistence** | Every turn writes to `~/.harness/sessions.db`; `--resume <id>` rehydrates frozen system prompt + history | `src/agent/sessionDb.ts`, `src/agent/sessionRecovery.ts` |
| 7 | `[ ]` | **Compactor** | `/compact` summarizes prior turns into a child session with rollback lineage; `shouldCompactProactively` triggers above the configured threshold | `src/compact/compactor.ts`, `src/compact/microcompact.ts` |
| 8 | `[ ]` | **Microcompaction** | Per-part tool-result clearing during a long turn to keep context bounded | `src/compact/microcompact.ts` + `shouldMicrocompact` |
| 9 | `[x]` (M4 — 2026-05-14) | **Preflight checks** | Provider auth + tool-calling smoke check at startup | `src/providers/preflight.ts` |
| 10 | `[ ]` | **Trace writer** | Phase 10.5 — `~/.harness/traces/<session-id>.jsonl` per-turn event log feeds `sov trace show` | `src/trace/writer.ts` |
| 11 | `[ ]` | **Trajectory capture** | The Sovereign moat — ShareGPT-shaped JSONL per session, redacted at write | `src/trajectory/writer.ts`, `src/trajectory/redact.ts`, `src/trajectory/shareGpt.ts` |
| 12 | `[ ]` | **Learning observer** | Per-tool-call observation stream → instinct corpus | `src/learning/observer.ts`, `src/learning/paths.ts`, `src/learning/project.ts` |
| 13 | `[ ]` | **Review manager / review fork** | `memory_propose` / `skill_propose` propose-then-promote lifecycle; `/review` slash command | `src/review/manager.ts`, `src/review/consolidate.ts`, `src/review/stall.ts` |
| 14 | `[ ]` | **Local-model router** | Phase 10.6 — `RouterProvider` dispatches to cheap models when a router config is present; `RouterAuditLogger` records decisions | `src/router/provider.ts`, `src/router/auditLogger.ts` |

## Major — feature loss is user-visible but recoverable

| # | Status | Surface | What it does | Source location |
|---|---|---|---|---|
| 15 | `[ ]` | **Context-overflow auto-recovery** | On `isContextOverflowError`, clear-child-session and retry with a fresh seed | `createClearedChildSession` (`src/agent/sessionRecovery.ts`) |
| 16 | `[ ]` | **Capture / replay for eval runner** | `--capture-fixture` writes a fixture; `--replay-fixture` reads it back without LLM calls | `src/eval/replay/capture.ts`, `src/eval/replay/loader.ts`, `src/eval/replay/provider.ts`, `src/eval/replay/toolPool.ts` |
| 17 | `[ ]` | **`@file:path` reference expansion** | Inline file references in user prompts get expanded to the file's contents | `src/context/references.ts` |
| 18 | `[ ]` | **Subdirectory hint state** | `CLAUDE.md` awareness from subdirectories — agent picks up CLAUDE.md files in cwd's parent chain | `src/context/subdirectoryHints.ts` |
| 19 | `[ ]` | **Skill-as-slash-command** | Skills with `whenToUse` triggers register as `/skillname` slash commands via `buildSkillCommands` | `src/skills/commands.ts` |
| 20 | `[ ]` | **Skill visibility filtering** | Per-turn `filterSkillRegistry` narrows the visible skill set to the active toolsets | `src/skills/visibility.ts` |
| 21 | `[ ]` | **Goodbye summary** | Session metrics block (cost, tokens, duration, turn count) renders on REPL exit | `src/ui/sessionSummary.ts` |
| 22 | `[ ]` | **Stall / no-op detection** | Phase 13.3 — sliding-window emits `stall_detected` trace events when the model loops or makes no progress | `src/review/stall.ts` |
| 23 | `[x]` (M4 — 2026-05-14) | **Full CLI flag forwarding** | Every flag accepted by `sov` (`--provider`, `--model`, `--max-tokens`, `--permission-mode`, `--resume`, `--db`, `--no-cache`, `--no-preflight`, `--transcript`, `-v`, `--legacy-input`, `--capture-fixture`, `--replay-fixture`, `--agent`, `--state-dir`) must reach the new foreground entry-point | `src/main.ts` — chat subcommand action handler |
| 24 | `[ ]` | **Tool-result expand registry** | `/expand [N]` re-renders the Nth-most-recent tool block with no truncation | `commandContext.expandToolBlock` wiring |

## How to use this list

When designing Phase 16.1:

1. **Start with Rule 1.** The new surface lands as an opt-in (`sov --ui ink` or similar) while terminalRepl stays the default. Do NOT delete terminalRepl until parity is independently audited.
2. **Pick a small foreground scaffold first** — the bare TUI (mount + render + dispatch one input → one output). Verify it works end-to-end with NO subsystems wired.
3. **Wire subsystems in this priority order:**
   - First: 6 (Session DB), 9 (Preflight), 23 (CLI flag forwarding) — bare correctness.
   - Second: 1 (Hooks), 3 (Permission prompts), 4 (Sub-agent scheduler) — the surfaces users notice when missing.
   - Third: 7+8 (Compactor + microcompaction), 15 (overflow recovery) — keep long sessions alive.
   - Fourth: 2 (MCP), 5 (TaskManager), 13 (Review), 12 (Learning), 10+11 (Trace + Trajectory) — full feature parity with the Hermes-pattern layer.
   - Fifth: 14 (Router), 16 (Capture/Replay), 17 (@file expansion), 18 (Subdir hints), 19+20 (Skill-as-slash + visibility), 21 (Goodbye summary), 22 (Stall detection), 24 (Expand registry) — polish.
4. **Independent parity audit before flipping the default.** Per Rule 3 of the retrospective: confirm by reading the import list of `src/ui/terminalRepl.ts`, not by recall. If a subsystem is wired in terminalRepl but not the new surface, parity isn't reached.
5. **Document deprecation timeline explicitly** before deleting terminalRepl. Give users at least one stable release where both surfaces coexist.

## Reference points

- `docs/postmortems/2026-05-12-phase-16-revert.md` — Rules 1-4 governing this work.
- `docs/state/archive/2026-05-12.md` — Phase 16.0a / revert close-out snapshot (historical).
- `origin/archive/ink-tui-2026-05-12` — preserved Phase 16.0b/c work, useful as a reference for the Ink architecture and the Wave 1 slash dispatch design but **not** as a starting point for the rebuild (its deletion-first lineage is exactly what we're avoiding).
- `git show e90d54d` — the Phase 16.0b deletion commit, useful as a record of what was removed when terminalRepl went away the first time.
- `git show 92953e2` — the orphan-module purge that compounded the deletion.

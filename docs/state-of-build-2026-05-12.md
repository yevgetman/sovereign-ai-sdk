# State of build — 2026-05-12

**Branch:** master
**HEAD:** `a7d8989` (P19 of Wave 1)
**Suite:** 1495 unit / 58 semantic (59 declared; suite driver broken pending Phase 16.0c follow-up)

## Phase 16.0c Wave 1 — slash command dispatch (shipped)

### What landed

The slash command dispatch mechanism is back, after being orphaned by the Phase 16.0b terminalRepl deletion. Wave 1 = the parser + registry + dispatcher + 10 plumbing-light commands that need no further plumbing lifts.

### Commits (18 atomic commits at the base of Wave 1)

| SHA | Subject |
|---|---|
| `88921d0` | feat(commands): define CommandContext + LocalCommand types for Wave 1 |
| `394f64a` | feat(commands): slash parser + dispatcher scaffold |
| `b15ee31` | test(commands): registry build + dispatch unit tests |
| `e0b061d` | feat(ui): UiState gets sessionCost + usage_delta/transcript_cleared/command_output events |
| `c325552` | feat(ui): useAgentTurn forwards usage_delta to reducer (App.tsx wires opts in Task 18) |
| `aa34f88` | feat(commands): /about prints harness identity |
| `6def7e2` | feat(commands): /help lists registered commands with chalk styling |
| `995c505` | feat(commands): /clear delegates to ctx.clearHistory |
| `9f7cfd0` | feat(commands): /quit (/exit) calls ctx.requestExit |
| `bb5dad8` | feat(commands): /cost prints token totals and USD estimate |
| `4a10434` | feat(commands): /model shows current or calls ctx.setModel |
| `6e1e570` | feat(commands): /tools and /skills list active registries |
| `34b614e` | feat(commands): /permissions shows mode and rule layers |
| `4613532` | feat(commands): /config restores show/path/get/set/unset verbs |
| `76d0841` | feat(commands): wire WAVE_1_COMMANDS array (10 commands) |
| `12aaaa1` | feat(ui): useSlashDispatch routes slash input via the registry |
| `4ccd3e6` | feat(ui): App routes /-prefix via useSlashDispatch + holds latestStateRef |
| `a7d8989` | feat(ui): wire CommandContext + refs into startInkTUI; route /-prefix to dispatch |
| `c249613` | test(semantic): /help and /clear round-trip case |

### New surfaces

- **Parser + registry + dispatcher**: `src/commands/types.ts`, `src/commands/registry.ts` (parser, `buildCommandRegistry`, `dispatchSlashCommand`, `formatHelp`, `HELP_COMMAND`, `WAVE_1_COMMANDS` array)
- **Command modules**: `src/commands/info.ts` (`/about`, `/tools`, `/skills`, `/permissions`), `src/commands/sessionOps.ts` (`/clear`, `/quit`, `/cost`, `/model`), `src/commands/configCommand.ts` (`/config`)
- **Ink hook**: `src/ui/ink/hooks/useSlashDispatch.ts` — routes `/`-prefixed input through the registry, dispatches `command_output` (success) or `system_message` (unknown / error) reducer events.
- **App routing**: `src/ui/ink/App.tsx` — slash-prefix branch in `onSubmit`, new `commandContext` + `latestStateRef` + `uiDispatchRef` props
- **Reducer additions**: `src/ui/ink/state/types.ts` + `reducer.ts` — `sessionCost` slot; `usage_delta`, `transcript_cleared`, `command_output` events; `command_output` TranscriptMessage variant
- **useAgentTurn**: now forwards `StreamEvent.usage_delta` to the reducer via `estimateCostUsd`, so `/cost` reflects live token totals.
- **Transcript**: `command_output` variant renders without dimColor so chalk-styled `/help` output survives.
- **CommandContext**: built in `startInkTUI` from refs (`historyRef`, `providerRef`, `modelRef`, `providerNameRef`); getters keep `providerName`/`model` live; `setModel`/`clearHistory` emit reducer events via `uiDispatchRef`.

### Suite + lint state

- `bun run typecheck` clean
- `bun run lint` clean (2 pre-existing shellSemantics warnings unrelated to this work)
- `bun run test` — **1495/1495** (delta from baseline 1454: +41 new tests across commands + Ink hooks + reducer)
- `bun run test:semantic` — declared 59/59, runnable 0/59 because the driver still spawns the deleted `sov chat` subcommand. Driver re-wire is a separate Phase 16.0c lift.

## What's next

Per the seven-wave decomposition in `docs/superpowers/specs/2026-05-12-phase-16-0c-wave-1-slash-dispatch-design.md`:

| Wave | Scope | Plumbing lift required |
|---|---|---|
| 2 | `/resume`, `/stats`, `/rollback`, `/export` | Session DB lift into `startInkTUI` |
| 3 | `/compact` | Compactor against multi-turn history |
| 4 | `/tasks` | `TaskManager` construction lift |
| 5 | `/review` | Review fork lift |
| 6 | `/context-budget`, `/expand`, `/init`, `/copy` | Budget audit + tool-block expansion |
| 7 | `/commit` | Prompt-command pathway |

Also still open in Phase 16.0c:
- Driver re-wire (semantic + eval runners both spawn the deleted `sov chat`)
- Daemon-level compression threshold
- TaskManager construction lift
- Agent-loop CLI knob forwarding

## Open backlog

Item 17 (eval-gated auto-promote, P4) remains open from the post-Phase-13.4 backlog. See `docs/post-phase-13-4-backlog.md`.

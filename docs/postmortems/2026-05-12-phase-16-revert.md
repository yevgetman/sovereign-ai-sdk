# Retrospective — Phase 16 revert (2026-05-12)

This is a written-down lesson, not a status snapshot. The team chose to revert
Phase 16.0a/b/c and roll back to the last green pre-Ink state at commit
`e9d5445`. This file captures **why** and **what to do differently next time a
foreground surface gets refactored**, so the pattern isn't repeated.

## What happened

Phase 16.0b (2026-05-11) replaced the readline-based `src/ui/terminalRepl.ts`
with an Ink 5 + React 18 TUI. The follow-up cleanup commit `92953e2` deleted
~4,200 LoC of "orphaned" modules — including the entire `src/commands/`
directory that held the slash command parser, registry, dispatcher, and all
command implementations.

Phase 16.0c began the rebuild of slash dispatch on top of the new Ink
architecture. Wave 1 (parser + registry + dispatcher + 10 plumbing-light
commands) shipped successfully across ~25 commits and ~3 days of focused work
(2026-05-12).

During the close-out review of Wave 1, an honest accounting of what was
silently broken in the new Ink TUI surfaced a much larger gap: hooks, MCP,
permission prompts, sub-agent scheduler, trace writer, trajectory capture,
learning observer, review manager, microcompaction, preflight, local-model
router, capture/replay, context-overflow recovery, `@file:path` expansion,
subdirectory hints, skill-as-slash-command, skill visibility filtering, session
DB persistence, compactor, TaskManager construction, context budget audit, the
HarnessInfo tool surface, the goodbye summary, and full CLI flag forwarding —
~20 surfaces wired in the deleted terminalRepl that the Ink TUI didn't yet
have.

Forward-fix was estimated at ~15-20 days of plumbing-lift work, rebuilding
features that already existed in git history. The team chose to revert.

## Why this happened

Three reasons stacked, in order of significance:

### 1. Deletion-first refactor without a parallel-surface period

The Ink TUI deletion (`e90d54d`) removed `terminalRepl.ts` and switched bare
`sov` to mount Ink — in a single commit. There was no period where both
surfaces ran side-by-side. There was no `--ui ink` opt-in flag, no feature
gate, no migration test plan.

The same pattern repeated in `92953e2` — every helper module that had been
imported only by `terminalRepl.ts` was deleted in one commit. This included
the entire `src/commands/` directory, which represented Phases 7-13 of slash
command development work — months of accumulated functionality.

When the deletion landed, the Ink TUI was a presentation surface with no
slash dispatch, no hooks, no MCP, no permission prompts, no trace writer, no
review fork, etc. Each was independently rebuildable, but the deletion
preceded the rebuilds. The codebase entered a state of *advertised
functionality that didn't work*.

### 2. Architecture difference made trivial port impossible

The Ink TUI plumbs state fundamentally differently than terminalRepl. The
deleted code used closures, direct stdout writes, and inline imperative
control flow. Ink uses pure-reducer state, async-generator streams,
React lifecycle, and event-driven dispatch. Slash commands could not be
mechanically ported; they needed a new `useSlashDispatch` hook, a
`CommandContext` built from refs instead of closures, output routed through
`command_output` reducer events, and `latestStateRef`/`uiDispatchRef`
cross-boundary patterns.

This meant the *deleted* slash command code was largely unusable for restoring
the *new* surface. But this is exactly the case for keeping the old surface
alive *during* the rewrite — terminalRepl could have continued serving users
while Ink was built and matured behind a flag, then default-flipped once Ink
reached parity.

### 3. Phasing optimized for ship-size, not user continuity

Phase 16.0b was framed as "land the Ink TUI; defer slash dispatch to 16.0c."
This was a deliberate scope-management choice — a smaller, more reviewable
commit set. But it had no thought-out failure mode for the period between the
two phases. When 16.0b shipped, users had a TUI with no commands. When 16.0c
Wave 1 shipped, users had a TUI with 10 of ~30 commands. Each shipped phase
was reviewable in isolation; the cumulative experience was a regressed product.

The phasing assumed users would tolerate the regression. They did not.

## What to do differently — durable rules

### Rule 1: Never delete a working foreground surface in the same commit that adds a new one

When introducing a new foreground surface (TUI rewrite, new CLI subcommand
hierarchy, new web UI), the old surface stays in the tree, callable via flag
or alternate command. Specifically:

- A new TUI lands as `sov --ui <new>` or `sov <new-command>`. The existing
  surface remains the default.
- Deletion of the old surface happens **only** after:
  1. The new surface has shipped to users
  2. Feedback has been collected
  3. Feature parity has been independently audited (not self-attested)
  4. A defined deprecation period has elapsed

### Rule 2: Never delete helper modules in the same series as a foreground refactor

The `92953e2` cleanup deleted `src/commands/`, `src/ui/sessionSummary.ts`,
`src/ui/box.ts` references, `src/commands/info.ts`, etc. — modules that were
orphaned by the foreground deletion. This was the wrong move. Helper modules
*should* sit unused for a long time during a refactor, as scaffolding for
reintegration.

Replace the "purge orphans" heuristic with: a module only gets deleted after
its last logical consumer has been rebuilt and shipped, *and* the module has
been confirmed unimportable from any of the supported entry points
(interactive, daemon, sub-agents, mission, eval-runner).

### Rule 3: Audit "silently broken" surfaces before declaring a phase complete

When a phase replaces a foreground surface, the close-out gate must include an
explicit parity audit. For each subsystem the old surface wired (hooks, MCP,
permissions, scheduler, etc.) — does the new surface wire it? Audit by
reading the import list of the deleted file, not by recall. If a subsystem is
wired in the old surface but not the new, the phase is incomplete.

This is mechanical work. It can be automated: `git show <deletion-commit> -- <old-file>`
gives the import list; `grep` confirms each import in the new file. The audit
must be checked into `docs/state-of-build-*.md` before the phase is called
shipped.

### Rule 4: Phases that span destabilizing changes ship behind a feature flag

A phase that flips users to a fundamentally different surface should ship the
flip behind `~/.harness/config.json` opt-in (e.g., `tui: "ink"`). The default
stays on the proven surface until the new one demonstrates parity in real
usage over a measurable period.

This is more work in the moment. It's much less work than recovering from
broken-by-default state.

## What we kept from Phase 16

Reverting to `e9d5445` discarded Phase 16.0b (Ink TUI) and Phase 16.0c (our
slash-on-Ink work). It kept Phase 16.0a — the daemon skeleton — because that
was structurally independent and didn't break anything.

The Ink TUI code remains in git history and on `origin/master` until the
force-push that makes this branch master. After that, it's recoverable from
the reflog and via the explicit backup branch.

When the team is ready to revisit a foreground refactor, the Ink work is
available as a reference for the *approach* — but the rebuild should follow
Rule 1 above: Ink ships alongside terminalRepl, not as a replacement, until
parity is independently audited.

## Concrete artifacts that survived the revert

- **`tests/semantic/framework/judges/stringMatch.ts`** — deterministic
  literal-substring judge backend. Useful for cases where the expected output
  is a precise string and no LLM judgment is needed. Independent of the TUI
  choice. Ported manually as part of the revert.

That's it. Everything else from the Ink era stays on the historical branch
for reference but doesn't enter the working tree.

## Honest assessment

The Phase 16 work wasn't bad engineering in isolation — the Ink TUI is a
plausible architecture, the daemon skeleton is solid, and the slash dispatch
on Ink was implemented carefully. The mistake was the *interaction* between
the surface rewrite and the cleanup of old code. Two reasonable individual
choices ("rewrite the foreground surface" + "delete orphaned code") composed
into an unreasonable cumulative outcome.

When in doubt: **keep the working thing alive longer than feels necessary.**
You can always delete code later. You cannot un-break a user's workflow.

# Decisions

This file records runtime-local design choices. Larger product and architecture ADRs still live in `~/code/sovereign-ai-docs/`.

## 2026-05-03 - Vim Mode Deferred Indefinitely

The Wave-5 vim-mode plan (~500 LOC: NORMAL/INSERT/VISUAL state machine over the Wave-4 TextBuffer) is deferred. ~70-80% of users don't use Vim, and the LOC-to-felt-value ratio is worse than even Phase-11 hooks. The Wave-4 input editor's TextBuffer already supports every operation a vim layer would need, so adding vim later is a small additive change rather than a refactor.

Reasoning: the polish wave was at diminishing returns. The next 500 LOC spent on capability (hooks, MCP, trajectory capture) beats the next 500 LOC spent on more polish. Vim mode comes back to the table only if a real user asks for it.

## 2026-05-03 - Wave-4 Input Editor With `--legacy-input` Safety Hatch

The Wave-4 raw-mode input editor replaces readline as the default when `process.stdin.isTTY === true`. Bugs that only surface in real terminals (cursor positioning under reflow, modifier-key reporting on uncommon terminals, paste-burst edge cases) won't be caught by unit tests. The `--legacy-input` flag forces the legacy `readline` + `queuedQuestion` path so users can fall back without losing functionality.

Piped stdin always uses the legacy path automatically — the new editor's terminal assumptions don't fit non-TTY input, and CI / scripted sessions need the proven readline behavior.

`queuedQuestion.ts` stays in the codebase indefinitely. Removing it would require replacing the legacy fallback with something else; the cost-to-benefit ratio doesn't favor that.

## 2026-05-03 - Theme Tokens Instead Of Direct `chalk.<color>(...)`

Wave-3 introduced a semantic token registry (`src/ui/theme.ts`) that replaces literal `chalk.<color>(...)` calls in high-traffic renderers. Renderers ask for roles (`accent`, `statusError`, `diffAdded`) instead of concrete colors. Three built-in themes (`dark` / `light` / `no-color`) swap the role-to-color mapping; custom themes from `~/.harness/themes/*.json` are deferred but the registry is structured to absorb them.

Reasoning: theme support was already a felt need (light-terminal users get bad contrast under cyan-on-default; CI / transcript users want stripped output). The token system also makes future contrast / accessibility tweaks (high-contrast theme, colorblind-friendly palette) a config change rather than a code-wide sweep.

The migration is invisible under the dark theme — every existing test passes without assertion changes. Lower-traffic renderers (markdownStream, sessionSummary, info, registry) keep direct chalk calls; sweeping them is mechanical but low-value until a theme actually needs to override their styling.

## 2026-05-03 - Modal Frame For Permission Prompts (Wave 1)

Permission prompts are rendered as a yellow-bordered box (`withModal()` in `src/ui/modal.ts`) instead of an inline `[permission] ...` text line. The framed shape can't be visually buried by concurrent decorator output: the modal raises a module-level `modalActive` flag that decorators (`thinking`, `toolSlot`) consult before writing.

The actual answer is still read through the readline `question()` the REPL owns — we don't open a second readline. The modal is a richer-looking prompt, not a parallel input system.

Reasoning: the prior inline format (`[permission] Bash ls src/`) was a known pain point — under streaming text, the spinner's `\r + clear-line` could clobber the prompt mid-read. The framed box plus the modal-active flag fix both sides of that bug.

## 2026-04-28 - Context-Percentage Trigger For Microcompaction

Microcompaction uses a context-percentage trigger (tool results > 40% of estimated context) rather than Qwen Code's idle-timeout trigger (clear after N minutes of inactivity). The idle-timeout design assumes a user walks away and returns; our harness is continuously model-operated, so idle time is rare but context bloat is constant. The percentage trigger fires when it matters (tool results are crowding out conversational context) regardless of wall-clock time.

## 2026-04-28 - Virtual Tool Name For Cross-Tool Permission Resolution

Shell AST analysis maps read-only Bash commands to `Read` via a `virtualToolName` method on the Tool interface. The alternative was teaching the rule engine to understand shell commands directly, which would have violated the principle that domain semantics stay delegated to tools (Invariant #6). The `virtualToolName` approach lets any tool declare a mapping without the permission system knowing about specific tool input shapes.

## 2026-04-28 - Qwen Code Patterns As Targeted Deepenings

The Qwen Code analysis identified six patterns worth lifting. Two (microcompaction, shell AST) deepened completed phases and landed as immediate implementation. Four (loop detection, tool lazy loading, subagent exclusion set, memory consolidation) are integrated into upcoming phases in `harness-build-plan@6`. Patterns explicitly skipped: MCP OAuth, modifiable tools, SDKs, aggressive auto-memory. See `sovereign-ai-docs/harness/docs/reference/qwen-code-analysis.md`.

## 2026-04-27 - Follow The Maturity-First Build Order

`sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md@6` is the canonical remaining build order. The runtime repo should treat Phase 10.5 soak/evals/traceability, Phase 10.6 local-router hardening, and Phase 10.7 profiles as the next maturity work before hooks, MCP, sub-agents, task parallelism, and reviewed self-learning. Broad channel/API surfaces are optional reach work, not core private-harness maturity.

Reasoning: the harness is for private use with a local or hybrid LLM, not for launching a competing agent product. The capability gap that matters most is robustness: traceable behavior, profile isolation, reliable local-model routing, recursive sub-agents, bounded parallelism, and Hermes-style propose-then-promote learning.

## 2026-04-26 - Keep Business Context Outside The Runtime Repo

The harness repo documents runtime behavior, extension points, and operational usage. Product strategy, business context, and ADR H-0003 remain in the sibling docs repo.

Reasoning: this repo is intended to be deployable as runtime code against different client bundles. Pulling client-zero business context into `src/` or repo-local runtime docs would make the runtime less portable.

## 2026-04-26 - Treat README As Orientation, Not Phase Ledger

Detailed phase completion notes moved to `CHANGELOG.md`. The README keeps current status, setup, usage, and links to deeper docs.

Reasoning: the phase log was useful but made the README harder to scan for new developers. Keeping the log preserves history while making the first-read path shorter.

## 2026-04-26 - Document Extension Surfaces Before Future Phases

The repo now has `docs/architecture.md` and `docs/extending.md` before Phase 11 starts.

Reasoning: phases 0-10 established the core contracts. Hooks, MCP, sub-agents, review, and routing will be easier to implement consistently if the existing extension surfaces are explicit first.

## 2026-04-26 - Split Operator Usage From README

The repo now has `docs/usage.md` for day-to-day runtime operation. The README keeps quick-start commands and links to the full guide.

Reasoning: install, architecture, development, and operator behavior were competing for space in the README. A dedicated usage guide makes common workflows easier to find without losing detail.

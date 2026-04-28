# Decisions

This file records runtime-local design choices. Larger product and architecture ADRs still live in `~/code/sovereign-ai-docs/`.

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

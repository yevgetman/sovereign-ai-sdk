# Decisions

This file records runtime-local design choices. Larger product and architecture ADRs still live in `~/code/sovereign-ai-docs/`.

## 2026-04-26 - Keep Business Context Outside The Runtime Repo

The harness repo documents runtime behavior, extension points, and operational usage. Product strategy, business context, and ADR H-0003 remain in the sibling docs repo.

Reasoning: this repo is intended to be deployable as runtime code against different client bundles. Pulling client-zero business context into `src/` or repo-local runtime docs would make the runtime less portable.

## 2026-04-26 - Treat README As Orientation, Not Phase Ledger

Detailed phase completion notes moved to `CHANGELOG.md`. The README keeps current status, setup, usage, and links to deeper docs.

Reasoning: the phase log was useful but made the README harder to scan for new developers. Keeping the log preserves history while making the first-read path shorter.

## 2026-04-26 - Document Extension Surfaces Before Future Phases

The repo now has `docs/architecture.md` and `docs/extending.md` before Phase 11 starts.

Reasoning: phases 0-10 established the core contracts. Hooks, MCP, sub-agents, review, and routing will be easier to implement consistently if the existing extension surfaces are explicit first.

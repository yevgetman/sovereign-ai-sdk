# Phase 16.1 M10 — Parity Audit Implementation Plan

**Spec:** [`docs/specs/2026-05-16-phase-16-1-m10-parity-audit-design.md`](../specs/2026-05-16-phase-16-1-m10-parity-audit-design.md)
**Approach:** A (parallel-everywhere with audit-as-canary)
**Mode:** Fully autonomous execution

## Task list (ordered)

### Phase 1 — Setup

- **T1.1** Inspect existing semantic-suite infrastructure (`tests/semantic/`) to determine the cheapest path for server-mode suite invocation. Choose between:
  - **Path 1:** Shell wrapper that boots `sov --ui tui` server, drives via HTTP+SSE.
  - **Path 2:** TS adapter that imports server-mode runtime construction and drives turns programmatically.
  Whichever is < half-session of work.
- **T1.2** Draft the 7-agent soak prompt set in `docs/state/2026-05-16-tui-parity-audit-soak/PROMPTS.md`. Categories mirror 2026-05-07.
- **T1.3** Design renderer-fidelity fixture corpus structure under `tests/parity/renderer-fixtures/`. Pick 5–10 representative tool-result envelopes.

### Phase 2 — Verification (parallel)

- **T2.1** Dispatch 4 Opus subagents for the mechanical import audit. Slices:
  - Subagent 1: imports L1–23
  - Subagent 2: imports L24–46
  - Subagent 3: imports L47–69
  - Subagent 4: imports L70–92
  Each subagent must:
  1. Read `src/ui/terminalRepl.ts` to extract the import set in its slice.
  2. For each import, search `src/server/`, `src/cli/sovTuiLauncher.ts`, `src/cli/dispatch.ts`, `src/main.ts` `--ui tui` branch, and `packages/tui/internal/` for the imported symbol's equivalent wiring.
  3. Classify: WIRED / PARTIALLY-WIRED / UNWIRED.
  4. For UNWIRED + PARTIALLY-WIRED: classify severity (CRITICAL/HIGH/MEDIUM/LOW).
  5. Return a markdown table.
- **T2.2** Run semantic suite on REPL path: `bun run test:semantic --judge string-match` (string-match judge for deterministic baseline; switch to anthropic-api if surface is too narrow).
- **T2.3** Run semantic suite via server-mode driver (Path 1 or 2 from T1.1).
- **T2.4** Run 7-agent soak on `--ui tui` with `ANTHROPIC_API_KEY` + `-m claude-haiku-4-5-20251001`. Capture transcripts to soak dir.
- **T2.5** Run renderer-fidelity fixture-corpus diff. Threshold: ≤5% character delta per fixture post-normalization.

### Phase 3 — Synthesis

- **T3.1** Aggregate 4 subagent reports + suite results + soak transcripts + renderer diffs.
- **T3.2** Write signed-off report at `docs/state/2026-05-16-tui-parity-audit.md`. Include:
  - Executive summary (CRITICAL/HIGH/MEDIUM/LOW counts; pass-set parity status; soak verdict; renderer-fidelity verdict)
  - Per-import audit table
  - Per-suite-case pass-set delta table
  - Per-soak-agent transcript-summary table
  - Renderer-fidelity per-fixture diff table
  - Final disposition: M11 unblocked / blocked / blocked-pending-fixes
- **T3.3** Land 4 ADRs in `DECISIONS.md`:
  - M10-01: Mechanical-audit-by-parallel-subagents methodology
  - M10-02: Semantic-suite-on-both-paths invocation pattern (whichever T1.1 chose)
  - M10-03: Severity-classified disposition rule
  - M10-04: Soak baseline reconstruction from backlog items 18–24
- **T3.4** Update:
  - `docs/state/2026-05-16-m10.md` — new state snapshot (M10 close-out)
  - `CLAUDE.md` + `AGENTS.md` — state-snapshot pointer + session-boot reading list
  - `docs/testing-log.md` — testing-log entry (newest-first)
  - `docs/backlog/phase-16-rebuild-prereqs.md` — header reflects M10 close-out
  - `docs/backlog/post-phase-13-4.md` — any new MEDIUM/LOW backlog items

### Phase 4 — Close-out

- **T4.1** Pre-commit gate: `bun run lint && bun run typecheck && bun run test`. Must all pass.
- **T4.2** `sov upgrade` if `src/` / `bundle-default/` / `packages/tui/` changed.
- **T4.3** Diff `CLAUDE.md` vs. `AGENTS.md` (byte-identical mirror per CLAUDE.md rule).
- **T4.4** Commit work in atomic logical chunks per `docs/conventions/lint-and-commit.md`:
  1. Spec + plan commit
  2. Renderer-fixture corpus commit (if any new files)
  3. Server-mode-driver commit (if T1.1 Path 1/2 added code)
  4. Soak prompts commit
  5. Audit report + ADRs + state snapshot + boot pointer commit
- **T4.5** `git push origin master`

## Decision authority during execution

User authorized **fully autonomous decision-making** for:
- Bug fixes uncovered during the audit
- Plan-B fallbacks when Plan A is over-scoped
- Severity classification of any gaps surfaced
- Test additions where gaps are caught
- Documentation updates and pointer maintenance

User must be re-engaged only if:
- A CRITICAL gap surfaces that requires non-trivial new code (more than ~1 session of fix work)
- The audit fundamentally changes the M10/M11 sequencing (e.g., requires a new milestone interposed)
- Pre-commit gate cannot pass without bypassing safety (forbidden by CLAUDE.md)

## Estimated effort

- Phase 1: ~30 min
- Phase 2: ~60 min (parallel dispatch + suite runs + soak)
- Phase 3: ~45 min
- Phase 4: ~15 min
- **Total: ~2.5 sessions**

Cost budget: $2.00 ceiling, $1.80 expected. Most cost is the soak ($0.15) + semantic suites ($1.74 across both paths).

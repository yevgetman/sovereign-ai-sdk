# Phase 16.1 M10 — Parity Audit Design

**Date:** 2026-05-16
**Status:** Active — autonomous execution by Approach A (parallel-everywhere with audit-as-canary)
**Predecessor:** [`docs/specs/2026-05-13-phase-16-1-tui-rebuild-design.md`](2026-05-13-phase-16-1-tui-rebuild-design.md) §9 + §10 (defines M10's acceptance criteria)
**Governing rule:** Postmortem Rule 3 — *audit by reading the deleted file's import list, not by recall; check audit into `docs/state-of-build-*.md` before the phase is called shipped* ([`docs/postmortems/2026-05-12-phase-16-revert.md`](../postmortems/2026-05-12-phase-16-revert.md))

## 1. Purpose

M10 is the **independent parity audit** gating M11's default-flip from `--ui repl` (terminalRepl-based) to `--ui tui` (Go Bubble Tea client + HTTP+SSE runtime).

The audit answers, *mechanically and independently from the M4–M8 build context*:

> **Has the new `--ui tui` foreground reached parity with the existing `--ui repl` foreground on every subsystem `terminalRepl.ts` wires?**

The audit produces a signed-off report at `docs/state/<date>-tui-parity-audit.md` enumerating each of the 24 subsystems + every additional terminalRepl import not on the 24-list, with a per-item parity verdict and severity classification for any gap.

## 2. Acceptance criteria (from the rebuild spec §9, reaffirmed)

M10 is complete when **all four** components have produced their artifacts and the signed-off report is committed:

1. **Mechanical import audit** — Every import in `src/ui/terminalRepl.ts` (92 imports / 2334 LoC) verified-wired through to the server-mode runtime or Go TUI client. Per Postmortem Rule 3: by file-read, not by recall.
2. **Semantic-suite identical-pass-set on both paths** — Existing TS semantic suite (`bun run test:semantic`) drives the REPL path; a server-mode driver runs the same suite against the HTTP+SSE-booted runtime. Pass sets must be identical (modulo skip-classifications documented in the report).
3. **7-agent REPL soak vs 2026-05-07 baseline** — Same prompt set (reconstructed from backlog items 18–24's descriptions) run on `--ui tui` w/ Anthropic Haiku 4.5; comparison against the 41/41 baseline.
4. **Renderer-fidelity fixture-corpus** — Same N inputs rendered on both surfaces, diff'd against a tolerance threshold (whitespace + ANSI-code normalization allowed; semantic content must match).

## 3. Approach A — parallel-everywhere with audit-as-canary

### 3.1 Phases

```
Phase 1 — Setup (sequential, ~30 min)
  T1.1 Inspect existing test infrastructure; determine whether a new
       server-mode semantic-suite driver is needed or the existing TS
       suite can be invoked against a server-spawned runtime via a thin
       adapter.
  T1.2 Reconstruct/design the 7-agent soak prompt set from backlog
       items 18-24 + cover the same categories (tool surface; sub-agent
       runtime + tasks; slash commands; CLI subcommands; state
       persistence; Phase 13.4 instinct corpus; error/edge/multi-turn).
  T1.3 Design the renderer-fidelity fixture corpus (input → expected
       rendered output on both surfaces).

Phase 2 — Verification (parallel)
  T2.1 Dispatch 4 Opus subagents in parallel for the mechanical
       import audit, each given a ~23-import slice of terminalRepl.ts.
       Each verifies its slice is wired through the server-mode
       runtime + Go TUI; reports parity verdict per import.
  T2.2 Run semantic suite on REPL path (existing `bun run
       test:semantic`).
  T2.3 Run semantic suite via server-mode driver (Phase 1 output).
  T2.4 Run 7-agent soak on `--ui tui` with Haiku 4.5; compare vs
       baseline.
  T2.5 Run renderer-fidelity fixture-corpus diff.

Phase 3 — Synthesis (sequential)
  T3.1 Aggregate findings; severity-classify gaps
       (CRITICAL/HIGH/MEDIUM/LOW).
  T3.2 Write signed-off report at
       `docs/state/2026-05-16-tui-parity-audit.md`.
  T3.3 Land 4 ADRs in `DECISIONS.md` (M10-01..04 covering the audit
       methodology, the suite-both-paths invocation pattern, the
       severity-classified disposition rule, and the soak baseline
       reconstruction).
  T3.4 Update CLAUDE.md/AGENTS.md state-snapshot pointer; testing-log
       entry; M11 prereq backlog (any MEDIUM/LOW gaps documented
       there).

Phase 4 — Close-out (sequential)
  T4.1 Pre-commit gate: `bun run lint && bun run typecheck && bun
       run test`. All three required (CLAUDE.md hard rule).
  T4.2 `sov upgrade` if any `src/` / `bundle-default/` / `packages/tui/`
       change.
  T4.3 Push to origin/master.
```

### 3.2 Disposition rule (severity-classified)

| Severity | Definition | Disposition |
|----------|------------|-------------|
| CRITICAL | A subsystem terminalRepl wires has *no* equivalent wiring through the server-mode runtime, AND its absence would silently corrupt or break a user workflow. | **Blocks M11.** M10 cannot ship until fixed. |
| HIGH | A subsystem is wired but with a behavioral delta that produces user-visible regression on common workflows. | **Blocks M11.** M10 cannot ship until fixed. |
| MEDIUM | Wired with a delta confined to edge cases or non-default flags. | M10 ships with the gap documented; goes into M11 prereq backlog. |
| LOW | Cosmetic / paper-cut / undocumented-corner deltas. | M10 ships with the gap documented; goes into post-flip polish backlog. |

### 3.3 Audit-as-canary semantics

The mechanical audit dispatches first (its subagents are fast — they read files and report) so it can interrupt downstream verification work if a CRITICAL gap surfaces. If the audit comes back clean (the expected case given 24/24 prereq checkboxes), downstream verification proceeds and consumes the audit's output as input to the report.

### 3.4 Cost ceiling

- Semantic suite on REPL path: ~$0.87 (subscription, 58 cases × ~$0.015/case at Haiku 4.5)
- Semantic suite on server-mode path: ~$0.87 (same suite, second invocation)
- 7-agent soak on `--ui tui`: ~$0.05–$0.15 (7 prompts × short multi-turn × Haiku 4.5)
- Real-Anthropic visual smoke (folded into the soak): marginal
- **Total budget:** ~$2.00 ceiling, ~$1.80 expected

## 4. Components & data flow

### 4.1 Mechanical import audit

**Input:** `src/ui/terminalRepl.ts` (file path; subagents read it directly).
**Slices:**
- Subagent 1: imports lines 1–23 (≈ node:fs, agent loader, bundle, commands registry, compactor)
- Subagent 2: imports lines 24–46 (≈ config, context, core, eval/replay, hooks, learning)
- Subagent 3: imports lines 47–69 (≈ mcp, memory, mission, permissions, providers, review)
- Subagent 4: imports lines 70–92 (≈ router, runtime, skills, tasks, tools, trace, trajectory)

**Per-subagent task:**
1. Read terminalRepl.ts; extract the import set in the assigned slice.
2. For each import, locate where (or whether) the imported symbol/module is referenced in:
   - `src/server/` (server-mode runtime)
   - `src/cli/sovTuiLauncher.ts` / `src/cli/dispatch.ts` (TUI entry points)
   - Server-mode initialization code in `src/main.ts`'s `--ui tui` branch
   - `packages/tui/internal/` (Go TUI consumers via HTTP+SSE)
3. Classify: WIRED (matches terminalRepl wiring shape) / PARTIALLY-WIRED (some calls present, some missing — describe) / UNWIRED (no equivalent found).
4. For UNWIRED + PARTIALLY-WIRED: classify severity per §3.2.
5. Output: a structured report (markdown table) for the slice.

**Output:** 4 per-slice reports → synthesized into the audit report's import-by-import table.

### 4.2 Semantic-suite invocation on both paths

**REPL path:** existing `bun run test:semantic` — default `--binary sov` drives `sov chat` (terminalRepl).

**TUI/server-mode path:** the semantic suite's `--binary` flag accepts any stdin-driven binary. The TUI itself is interactive Bubble Tea and not stdin-driven; we instead drive a **headless server-mode** invocation: a thin shell wrapper that boots `sov --ui tui` server, drives turns via HTTP+SSE, and prints final output to stdout in the suite-expected format.

If creating that wrapper proves to be more than ~half a session of work, we degrade to **Plan B**: invoke the same suite cases via a TypeScript test file that imports the server-mode runtime construction path directly (without the Go client), drives turns programmatically, and asserts pass/fail with the same judge backends. This avoids the HTTP+SSE wire while still exercising the server-mode subsystem wiring.

### 4.3 7-agent soak prompts (reconstructed)

Each agent runs a category-focused multi-turn conversation on `--ui tui`. Outputs (tool-use trace + final assistant text + any error surfaces) are captured to `docs/state/2026-05-16-tui-parity-audit-soak/` for diff vs. baseline.

| Agent | Category | Sample prompt sketch | Expected baseline behavior |
|-------|----------|----------------------|----------------------------|
| A | Tool surface battery | "Build me a small TypeScript utility with a date formatter; use Glob, Read, Write, Edit; run Bash to check it parses." | Tool-use loop hits 5+ tools, envelope output, no errors |
| B | Sub-agent runtime + tasks | "Spawn a sub-agent to summarize the README.md in 3 bullets and report back via task_create / task_get." | task_create/get chain, sub-agent loop spawned and closed |
| C | Slash commands | "/help; /info; /skills; /resume <id>; /compact; /memory list; /review list" | All slash commands echo expected output |
| D | CLI subcommands | (Out-of-band — outside the soak; verified via direct `sov` invocations) | Skipped in soak; verified separately |
| E | State persistence | "Save a memory observation; restart; verify it persists; resume an earlier session by UUID" | Sessions DB writes + reads cleanly |
| F | Phase 13.4 instinct corpus | "Repeatedly invoke a tool that should generate observations; check `instincts/` dir for observations.jsonl" | Observer fires per turn |
| G | Error/edge/multi-turn | "Trigger context-overflow recovery; trigger permission prompt; ambiguous prompt to test stall detection" | Recovery triggers, prompt UI renders, stall_detected emitted |

### 4.4 Renderer-fidelity fixture corpus

**Inputs:** 5–10 representative tool-result envelopes (Bash output, Glob result, Read result, Edit result, FileWrite result, multi-turn assistant text with code blocks) → rendered through:
- terminalRepl's `renderToolBlock` / `renderHint` path
- Go TUI's `internal/render/` path (via HTTP+SSE event consumption)

**Diff method:** ANSI-strip + whitespace-collapse + line-trim, then character-level diff. **Tolerance threshold:** ≤ 5% character delta per fixture (lipgloss might add a trailing newline or wrap at a different column — those don't count as semantic deltas).

Fixture corpus stored under `tests/parity/renderer-fixtures/` (new directory).

## 5. Deliverables

| Artifact | Location | Purpose |
|----------|----------|---------|
| Signed-off report | `docs/state/2026-05-16-tui-parity-audit.md` | Postmortem-Rule-3-compliant attestation |
| 4 ADRs | `DECISIONS.md` (M10-01..04) | Methodology, suite-both-paths invocation, severity disposition, soak reconstruction |
| Renderer fixtures | `tests/parity/renderer-fixtures/` (new) | Reusable for M11/M12 verification |
| 7-agent soak transcripts | `docs/state/2026-05-16-tui-parity-audit-soak/` | Replay record for future regression analysis |
| State-snapshot supersession | `docs/state/2026-05-16-m10.md` | Successor to `2026-05-16.md`, M10 close-out |
| CLAUDE.md / AGENTS.md pointer | Updated state-snapshot link | Next-session boot |
| Testing-log entry | `docs/testing-log.md` (newest-first) | Per CLAUDE.md testing-log obligation |

## 6. Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Mechanical audit surfaces a CRITICAL gap | low | high | Audit-as-canary stops downstream work; raises to user; documented as a delta blocking M11 |
| Server-mode semantic-suite driver harder than expected | medium | medium | Plan B fallback (in-process TS adapter, no HTTP wire) |
| 7-agent soak baseline-reconstruction inaccuracy | medium | low | Documented; if a "regression" surfaces that's actually a baseline-prompt drift, flag in report |
| Renderer-fidelity tolerance too loose / too tight | medium | low | Threshold is tunable; first run informs the threshold |
| Real-LLM cost ceiling overrun | low | low | $2.00 ceiling is generous; abort if exceeded |
| Parallel-subagent file-edit interference | low | medium | Audit subagents are READ-ONLY; no file edits in audit phase |

## 7. Out of scope for M10

- **M11 default flip** — only after M10's signed-off report shows no CRITICAL or HIGH gaps.
- **M12/M13 terminalRepl deprecation + removal** — separate plans.
- **Fixing MEDIUM/LOW gaps surfaced by M10** — those go into the backlog; can be picked up between phases.
- **Adding new TUI features** — the audit verifies parity, not feature additions.

## 8. Postmortem-rule compliance check

- **Rule 1** — `src/ui/terminalRepl.ts` is **read-only** through M10. No edits. Verified by `git diff master -- src/ui/terminalRepl.ts` at close-out.
- **Rule 2** — no helper module deletion in M10. Verified by `git diff master --diff-filter=D -- src/` at close-out.
- **Rule 3** — this audit IS the Rule 3 compliance for Phase 16.1. Mechanical, file-read-based, checked-in.
- **Rule 4** — `--ui tui` remains opt-in through M10. M11 is the flip.

## 9. Sign-off

This spec is committed atomically alongside its implementation plan ([`docs/plans/2026-05-16-phase-16-1-m10-parity-audit.md`](../plans/2026-05-16-phase-16-1-m10-parity-audit.md)) before any audit work begins. User authorized fully autonomous execution from spec-write through close-out push.

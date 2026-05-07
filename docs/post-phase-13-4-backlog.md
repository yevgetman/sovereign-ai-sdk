# Post-Phase-13.4 Backlog

This document is the record of truth for items not part of the canonical build plan that have surfaced as v0 limits, deferred polish, or architectural extensions during the Phase 13.3 + 13.4 work shipped on 2026-05-06. Future sessions can pick these up without re-deriving context.

These items are deliberately NOT in `~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md` — they are smaller follow-ups, polish, and known v0 trade-offs documented in commit messages, code comments, and the testing log. The build plan's next phase is Phase 13.5 (scheduled-mission sub-agents); these backlog items are orthogonal and can land between phases or as time permits.

**Last sync:** 2026-05-06. Master at `55b966a`. Suite 1583/1583 unit + 58/58 semantic.

## Priority order

P0 (correctness / data integrity):
1. MEMORY.md cap enforcement on `/review approve`
2. Auto-promote provenance preservation gap audit (verify cc334cc fix is complete)

P1 (UX / observability):
3. `/review revoke <id>` undo path
4. Consolidation deletes original entries (currently appends only)
5. Status mapping at observer site upgraded to 4-state (denied + cancelled)
6. Better confidence ramp-up for cross-project promotion (defaults are too conservative for typical use)

P2 (architectural extensions):
7. Pick `review-memory` vs `review-skill` based on child shape (currently always `review-memory`)
8. Per-child trace files in addition to consolidated parent trace
9. `ReviewForkPromptContext` field rename (`trajectoryPath`/`tracePath` re-purposed for consolidation)
10. Synthesizer dispatch rhythm — currently user-turn only; activity-burst trigger missing
11. Concurrency between multiple `sov` sessions writing to same observations.jsonl

P3 (qwen-amendment deepenings — orthogonal to 13.x):
12. Microcompaction (Phase 10 deepening)
13. Shell AST analysis (Phase 7 deepening)

P4 (small ergonomics + nits):
14. `_resetProjectIdCache` test helper exported from production code
15. `nameFromRemote` heuristic loses nested-namespace context
16. `cleanupPhantomReviews` runs only at session boot (long sessions accumulate)
17. Eval-gated auto-promote (currently auto-promote is straight bypass)

---

## P0 items

### 1. MEMORY.md cap enforcement on `/review approve`

- Priority: P0
- Status: open
- Source: original C1 follow-up (deferred from Phase 13.3 polish batches)
- Recommendation: Pre-flight the bounded-memory cap (`src/memory/bounded.ts:10-13` defines `MEMORY.md=2200`, `USER.md=1375`) before `appendFileSync` in `src/commands/reviewOps.ts`'s `applyMemoryApproval`. If approval would exceed, return a clear error suggesting `/review consolidate` or manual trimming. Alternatively, emit a warning + still append (current silent truncate-on-load is the worst of both).
- Evidence: `applyMemoryApproval` blindly appends; `src/memory/bounded.ts` enforces the cap at *load* time but no one stops approval from blowing past it. End result: approval succeeds, then the memory loader silently truncates on next session start. User has no warning.
- Impact: Silently lost memory entries; user thinks they approved a proposal but the next session it's gone.
- Likely code areas:
  - `src/commands/reviewOps.ts` (`applyMemoryApproval`)
  - `src/memory/bounded.ts` (cap constants)
- Effort: ~30 min

### 2. Auto-promote provenance preservation gap audit

- Priority: P0 (verification, not new code)
- Status: open
- Source: testing-log entry for commit `e516a43`; code comment in `MemoryProposeTool.ts` auto-promote branch
- Recommendation: Walk through the auto-promote bypass path with one of each input shape (memory proposal with empty `sourceExcerpt`, with `--` in excerpt, with very long body) and confirm the provenance HTML comment renders correctly in `MEMORY.md` AND survives a round-trip through `parseMarkdownFrontmatter`-equivalent on the next session boot. The C2 fix (commit `e516a43`) added the comment but no integration test verifies the comment is parser-tolerant.
- Evidence: Code comment in `escapeForHtmlComment` says "double-dashes squashed to single to avoid HTML comment parser confusion" — implies a real concern, but no test loads the resulting `MEMORY.md` through the memory loader.
- Impact: If a malformed comment breaks the memory loader, auto-promote could silently drop user memory.
- Likely code areas:
  - `src/tools/MemoryProposeTool.ts` (auto-promote branch)
  - `src/tools/SkillProposeTool.ts` (auto-promote branch)
  - Memory loader's frontmatter / body parser
- Effort: ~1 hr (verification + 1-2 round-trip tests)

---

## P1 items

### 3. `/review revoke <id>` undo path

- Priority: P1
- Status: open
- Source: original C3 follow-up (deferred from Phase 13.3 polish batches)
- Recommendation: New verb `/review revoke <id>` that removes the appended block from `MEMORY.md` (using the `<!-- proposal:<id> -->` marker as a delimiter) and moves the proposal from `approved/` to `rejected/`. Track which IDs were approved so revoke can find the block.
- Evidence: No undo on accidental approvals; user must hand-edit MEMORY.md.
- Impact: Once-and-done friction; not data-loss.
- Likely code areas:
  - `src/commands/reviewOps.ts` (new verb)
  - `src/memory/` (block extraction)
- Effort: ~2 hrs

### 4. Consolidation deletes original entries

- Priority: P1
- Status: open
- Source: original C4 follow-up; code comment in `applyConsolidationApproval` says "actually deleting the affected entries from MEMORY.md is left as a follow-up. v0 appends the consolidation result; user removes originals manually."
- Recommendation: When approving a `ConsolidationProposal`, parse `affectedEntries` from frontmatter, find each entry's `<!-- proposal:<id> -->` marker in MEMORY.md, remove those blocks, then append the consolidated entry. Bonus: emit a one-line summary of which originals were removed.
- Evidence: `src/commands/reviewOps.ts:applyConsolidationApproval` only appends.
- Impact: Memory bloat over time; user must manually remove originals after approving consolidation.
- Likely code areas:
  - `src/commands/reviewOps.ts` (`applyConsolidationApproval`)
- Effort: ~3 hrs (block extraction + integration tests)

### 5. Status mapping at observer site upgraded to 4-state

- Priority: P1
- Status: open
- Source: T2 implementer's "concerns" report on commit `429a4ff`; T2 status mapping is 2-state only
- Recommendation: Thread `denied` and `cancelled` ObservationStatus values through to the orchestrator's PostToolUse intercept site. Currently those terminal states early-return before PostToolUse fires. Either:
  - Tag the observed status from each early-return path with a `let observedStatus: ObservationStatus = 'success'` variable updated as we walk through error/denied/cancelled branches, then read it at PostToolUse
  - Move the observer notify earlier in the dispatch flow (before the early returns)
- Evidence: Documented as known limitation in `src/core/orchestrator.ts:516-535` comment.
- Impact: Negative-example mining for the synthesizer is degraded — denials and signal-cancellations don't reach the corpus. The synthesizer can't learn "user rejects this pattern" from observations.
- Likely code areas:
  - `src/core/orchestrator.ts` (early-return paths around tool dispatch)
- Effort: ~2 hrs

### 6. Better confidence ramp-up for cross-project promotion

- Priority: P1
- Status: open
- Source: T11 integration test note + T13 testing-log follow-up
- Recommendation: Re-tune `REINFORCEMENT_K` (currently 0.04) OR start instincts at a higher initial confidence floor. Today, `reinforce(0, 12)` produces ~0.10 — meaning a single instinct with 12 supporting observations is well below the 0.7 cross-project promotion threshold. Reaching 0.7 requires many synthesizer reinforcement passes, which only happens with sustained reinforcement across multiple sessions. Real-world behavior: cross-project promotion may never fire on typical 1-2 hour usage patterns.
- Options:
  - (a) Initial confidence = `reinforce(BASELINE, evidence_count)` where `BASELINE ≈ 0.4` so a 12-evidence proposal lands at ~0.5 (still below 0.7 — needs reinforcement, but not as far)
  - (b) Bump `REINFORCEMENT_K` to ~0.15 so 12 evidence yields ~0.4
  - (c) Lower the cross-project promotion threshold from 0.7 to 0.5 in `src/learning/promotion.ts`
- Tuning choice depends on real soak data. Run a 5-session soak (different real projects, different real workflows) and check what confidence ranges appear before adjusting.
- Evidence: T11's integration test had to use `{ minConfidence: 0.05 }` to make cross-project promotion fire deterministically with synthetic data.
- Impact: Cross-project promotion is theoretically wired but practically unreachable in v0 timeframes.
- Likely code areas:
  - `src/learning/confidence.ts` (constants)
  - `src/learning/promotion.ts` (threshold)
- Effort: ~1 hr tuning + dependent on real-soak observations

---

## P2 items

### 7. Pick `review-memory` vs `review-skill` based on child shape

- Priority: P2
- Status: open
- Source: original D1 follow-up
- Recommendation: `onChildCompletion` currently always fires `review-memory`. Add a heuristic: if the child made `tool_call_count >= 4` AND used 3+ distinct tools, ALSO fire `review-skill`. Or: pick based on the child's session shape (multiple tools = procedural, candidate skill; single tool repeated = pattern, candidate memory).
- Evidence: Skill-extractable workflows go un-distilled because `review-skill` only fires on `onToolIteration` (every 50 tool calls), not on child completions.
- Impact: Skill proposals are sparse compared to memory proposals.
- Likely code areas:
  - `src/review/manager.ts` (`onChildCompletion`)
  - Heuristic logic (could land in `src/review/triage.ts` or similar)
- Effort: ~3 hrs

### 8. Per-child trace files in addition to consolidated

- Priority: P2
- Status: open
- Source: original D2 follow-up; round-2 REPL testing finding
- Recommendation: Keep the consolidated parent timeline (works well for `sov trace show`), but ALSO write a small per-child file with just that child's events to `<harnessHome>/traces/<childSessionId>.jsonl`. Parent file remains the source of truth for chronology; child files give a fast path for `sov trace show <childId>` without filtering the parent.
- Evidence: Round-2 testing found that child events are tagged with `sessionId` (Fix #1, `cc334cc`) but separate files don't exist. Filtering `~/.harness/traces/<parent>.jsonl` works but isn't elegant.
- Impact: Operator UX — `sov trace show <childId>` requires parent context to find the file.
- Likely code areas:
  - `src/runtime/scheduler.ts` (where the wrapped traceRecorder lives)
  - `src/trace/writer.ts` (could spin up a per-child writer)
- Effort: ~2 hrs

### 9. `ReviewForkPromptContext` field rename

- Priority: P2
- Status: open
- Source: original C5 follow-up; T10 noted the smell
- Recommendation: Currently `trajectoryPath` and `tracePath` are re-purposed for consolidation (mapped to MEMORY.md / USER.md paths). Rename to `primaryFile` / `secondaryFile` OR add a typed `kind: 'review' | 'consolidation' | 'synthesizer'` discriminator with explicit fields per kind.
- Evidence: Comment in `src/review/consolidate.ts` acknowledges: "We re-purpose the trajectory/trace fields as MEMORY.md / USER.md paths."
- Impact: Maintainability / readability — mild.
- Likely code areas:
  - `src/review/fork.ts` (interface)
  - `src/review/consolidate.ts`, `src/review/manager.ts` (callers)
  - `src/learning/synthesizer.ts` (similar pattern)
- Effort: ~1 hr (refactor + test updates)

### 10. Synthesizer dispatch on activity-burst rhythm

- Priority: P2
- Status: open
- Source: testing-log Phase 13.4 entry
- Recommendation: Currently `synthesizerEveryN` triggers on user-turn count only. A 30-tool-call burst inside a single user turn doesn't fire the synthesizer mid-turn. Add an `onToolIteration` counter for the synthesizer too, OR make the trigger a max-of-the-two ("fire when either user-turn OR tool-iteration counter trips").
- Evidence: A user can do a substantial chunk of work in one turn (e.g., one prompt → 30 AgentTool calls) and the synthesizer never fires until the next user turn.
- Impact: Synthesizer is reactive to user-typing rhythm rather than actual learning signal.
- Likely code areas:
  - `src/review/manager.ts` (extend `onToolIteration` to also tick `synthesizerSince`)
- Effort: ~30 min

### 11. Concurrency between multiple `sov` sessions writing to observations.jsonl

- Priority: P2
- Status: open
- Source: not exercised in build; theoretical
- Recommendation: `LearningObserver`'s write-chain serializes within a single process. Two `sov` sessions running concurrently in the same project (and same `HARNESS_HOME`) both append to the same `observations.jsonl`. POSIX atomic-append on small writes (`O_APPEND` from Node's `appendFile`) should be safe for single-line records, but we haven't verified. Add a stress test: spawn 2 `sov` instances against the same project, fire 100 tool calls each, confirm no torn lines in `observations.jsonl`.
- Evidence: Not tested.
- Impact: Latent risk; manifests only with multi-session concurrency.
- Likely code areas:
  - `src/learning/observer.ts` (write-chain)
- Effort: ~1 hr (stress test + verification)

---

## P3 items — qwen-amendment deepenings

These are documented in `~/code/sovereign-ai-docs/harness/docs/runtime/qwen-amendment-build-plan.md`. They're orthogonal to Phase 13.x and can land at any time.

### 12. Microcompaction (Phase 10 deepening)

- Priority: P3
- Status: open
- Source: qwen-amendment-build-plan
- Notes: We already have basic microcompaction (`src/core/query.ts:330+`). The qwen-amendment deepening adds tool-result-aware compaction strategies. ~1 session.

### 13. Shell AST analysis (Phase 7 deepening)

- Priority: P3
- Status: open
- Source: qwen-amendment-build-plan
- Notes: Adds AST-based shell-command analysis (e.g., `rm -rf` detection at the AST level rather than regex). ~1 session.

---

## P4 items — small ergonomics + nits

### 14. `_resetProjectIdCache` test helper exported from production code

- Priority: P4
- Status: open
- Source: T1 spec review
- Recommendation: Move `_resetProjectIdCache` from `src/learning/project.ts` to a `tests/learning/_helpers.ts` module. Production code shouldn't expose `_`-prefixed test helpers.
- Effort: ~15 min

### 15. `nameFromRemote` loses nested-namespace context

- Priority: P4
- Status: open
- Source: T1 implementer flag
- Recommendation: Currently `nameFromRemote('https://example.com/group/sub/repo.git')` yields `repo`. For nested namespaces we lose `group/sub` context. Could switch to `last-two-segments` if we want to preserve org/repo distinction.
- Impact: Project name in `harness learning status` output may collide for projects with the same trailing path component.
- Effort: ~15 min

### 16. `cleanupPhantomReviews` runs only at session boot

- Priority: P4
- Status: open
- Source: not exercised in build; theoretical
- Recommendation: Currently the cleanup sweep (`SessionDb.cleanupPhantomReviews`, commit `e516a43`) fires once per `sov chat` invocation. A long-running session that never reboots accumulates phantoms during its own lifetime. Add a periodic sweep — e.g., every N user turns OR on `/review activity` invocation if `>10` phantoms detected.
- Effort: ~30 min

### 17. Eval-gated auto-promote

- Priority: P4
- Status: open
- Source: build plan note (eval-gated form mentioned but explicitly deferred); CLAUDE.md follow-ups
- Recommendation: Currently `settings.review.autoPromote{Memory,Skills}: true` bypasses the pending queue entirely. The build plan envisions an eval-gated form: "auto-promote after N passing evals." Implementation: when a proposal lands in pending and N eval runs pass with that proposal applied (in a sandbox), auto-promote. Requires the eval-runner from Phase 10.5 to know about pending proposals, which is a substantial feature on its own.
- Effort: ~1-2 days (would warrant its own phase)

---

## How to use this document

Pick any item by priority + effort match for your session length:
- 30-min slot: items 5, 10, 14, 15, 16
- 1-2 hr slot: items 1, 2, 4, 6, 8, 11
- Half-day slot: items 3, 7, 9, 12, 13
- Multi-day: item 17

Cross off completed items by changing `Status: open` → `Status: complete (YYYY-MM-DD)` and recording the commit SHA in a brief follow-up paragraph.

When finishing the document (everything closed), move it to `docs/archive/` rather than deleting — the rationale + evidence have ongoing value.

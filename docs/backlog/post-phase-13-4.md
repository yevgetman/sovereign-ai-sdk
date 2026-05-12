# Post-Phase-13.4 Backlog

This document is the record of truth for items not part of the canonical build plan that have surfaced as v0 limits, deferred polish, or architectural extensions during the Phase 13.3 + 13.4 work shipped on 2026-05-06. Future sessions can pick these up without re-deriving context.

These items are deliberately NOT in `~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md` — they are smaller follow-ups, polish, and known v0 trade-offs documented in commit messages, code comments, and the testing log. The build plan's next phase is Phase 13.5 (scheduled-mission sub-agents); these backlog items are orthogonal and can land between phases or as time permits.

**Last sync:** 2026-05-08. Runtime close-out reached `4789de7`; post-closeout docs-only baseline `526610c` is 1717/1717 unit + 58/58 semantic. Items 1-11, 14-16, 18-23 closed across seven batches. Remaining open: 12, 13, 17, 24. Items 18-24 originated from the 2026-05-07 ad-hoc 7-agent REPL soak (41/41 cases passed).

## Priority order

P0 (correctness / data integrity):
1. ~~MEMORY.md cap enforcement on `/review approve`~~ **— closed `f7c9c69`**
2. ~~Auto-promote provenance preservation gap audit~~ **— closed `47993ec` (no real gap; C2 fix verified)**

P1 (UX / observability):
3. ~~`/review revoke <id>` undo path~~ **— closed `7015b8c`**
4. ~~Consolidation deletes original entries~~ **— closed `409fe9c` (post-deletion cap check + audit-trail success message)**
5. ~~Status mapping at observer site upgraded to 4-state~~ **— closed `64e5eef`**
6. ~~Better confidence ramp-up for cross-project promotion~~ **— closed `d24efee` (tunables exposed; defaults preserved pending soak data)**
19. ~~MEMORY.md cross-pollinates unrelated projects (global memory, not project-scoped)~~ **[soak 2026-05-07] — closed `db967ed` → `07cb263`**
22. ~~Mid-turn context pruning anomaly during long autonomous exploration~~ **[soak 2026-05-07] — closed `c6412ce` (real bug; current-turn boundary protection in microcompact)**
23. ~~FileRead throws instead of returning `{status: error}` envelope on missing file~~ **— closed `d2e1e92`**

P2 (architectural extensions):
7. ~~Pick `review-memory` vs `review-skill` based on child shape~~ **— closed `2df9da7`**
8. ~~Per-child trace files in addition to consolidated parent trace~~ **— closed `1001237`**
9. ~~`ReviewForkPromptContext` field rename~~ **— closed `94eea94` (renamed to primaryFile/secondaryFile)**
10. ~~Synthesizer dispatch rhythm — currently user-turn only; activity-burst trigger missing~~ **— closed `a8d4ce3`**
11. ~~Concurrency between multiple `sov` sessions writing to same observations.jsonl~~ **— closed `8e86e61` (verified safe)**

P3 (qwen-amendment deepenings — orthogonal to 13.x):
12. Microcompaction (Phase 10 deepening)
13. Shell AST analysis (Phase 7 deepening)
24. `maxToolCallsBeforeCheckin` knob for vague-prompt cost control **[soak 2026-05-07]**

P4 (small ergonomics + nits):
14. ~~`_resetProjectIdCache` test helper exported from production code~~ **— closed `f3ee05f`**
15. ~~`nameFromRemote` heuristic loses nested-namespace context~~ **— closed `f3ee05f` (last-two-segments)**
16. ~~`cleanupPhantomReviews` runs only at session boot~~ **— closed `ac4dc74` (event-driven sweep on /review activity)**
17. Eval-gated auto-promote (currently auto-promote is straight bypass)
18. ~~Glob inline tool block: count footer drifts vs. summary line~~ **[soak 2026-05-07] — closed `d52fb75` (footer reads canonical count from envelope summary)**
20. ~~`HARNESS_HOME=… printf | sov chat` env-prefix-pipeline footgun (docs)~~ **[soak 2026-05-07] — closed `e677676`**
21. ~~Tool-count drift between live vs. fresh `harness-home` config (investigation)~~ **[soak 2026-05-07] — closed (WebSearch gated on apiKey; intentional)**

---

## P0 items

### 1. MEMORY.md cap enforcement on `/review approve`

- Priority: P0
- Status: **complete (2026-05-07, commit `f7c9c69`)** — `applyMemoryApproval` and `applyConsolidationApproval` pre-flight the cap via the new `checkCapBeforeAppend` helper. On overflow, both return a red error message naming the target file + projected size + `/review consolidate` suggestion. Proposal stays in `pending/` until the user makes room. 2 new tests cover rejection + within-cap regression.
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
- Status: **complete (2026-05-07, commit `47993ec`)** — added `tests/tools/memoryProposeAudit.test.ts` (4 cases) + `tests/tools/skillProposeAudit.test.ts` (3 cases) round-tripping auto-promoted MEMORY.md / SKILL.md through `readMemoryFile` and `loadSkillFromPath`. C2 (commit `e516a43`) confirmed correct: `--` in source excerpts gets squashed to `-` in the comment body; HTML comment delimiters are preserved; memory + skill loaders parse the resulting files cleanly. No real gap surfaced. 7 new tests; full suite 1592/1592.
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
- Status: **complete (2026-05-07, commit `7015b8c`)** — new `/review revoke <id>` verb. Memory + consolidation revoke: finds the appended block via `<!-- proposal:<id>` prefix match (handles auto-promoted richer comments), strips with leading-blank-line absorption (no separator drift after multi-revoke), moves proposal `approved/` → `rejected/` with status field updated. Skill revoke: rmRf the `skills/agent-created/<name>/` dir + moves the proposal. Idempotent on already-removed blocks. New `removeProposalBlock` helper became the foundation for Item 4. 6 new tests; suite 1619/1619.
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
- Status: **complete (2026-05-07, commit `409fe9c`)** — `applyConsolidationApproval` now parses `affectedEntries` and walks each via `removeProposalBlock` (helper from Item 3) BEFORE the cap check + append. Cap-check uses post-deletion content size, so net-shrinking consolidations always pass even when pre-state was at cap. Atomic single-write at the end (deletions + append in one writeFileSync). Missing affectedEntries are non-fatal. Return shape upgraded to `{ ok: true, removed: string[] } | { ok: false, error }` so the success message annotates "merged N entries" — useful audit trail. 4 new tests; suite 1623/1623.
- Source: original C4 follow-up; code comment in `applyConsolidationApproval` says "actually deleting the affected entries from MEMORY.md is left as a follow-up. v0 appends the consolidation result; user removes originals manually."
- Recommendation: When approving a `ConsolidationProposal`, parse `affectedEntries` from frontmatter, find each entry's `<!-- proposal:<id> -->` marker in MEMORY.md, remove those blocks, then append the consolidated entry. Bonus: emit a one-line summary of which originals were removed.
- Evidence: `src/commands/reviewOps.ts:applyConsolidationApproval` only appends.
- Impact: Memory bloat over time; user must manually remove originals after approving consolidation.
- Likely code areas:
  - `src/commands/reviewOps.ts` (`applyConsolidationApproval`)
- Effort: ~3 hrs (block extraction + integration tests)

### 5. Status mapping at observer site upgraded to 4-state

- Priority: P1
- Status: **complete (2026-05-07, commit `64e5eef`)** — extracted `notifyLearningObserver` helper and wired into every early-return path in `executeOne`. All 4 ObservationStatus values now reach the corpus: `success` (post-call), `error` (input validation, hook-updated input, post-call thrown), `denied` (permission gate + PreToolUse hook block), `cancelled` (pre-call signal abort + mid-call abort coinciding with `toolError`). 11 new tests; 1613/1613 full suite.
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
- Status: **complete (2026-05-07, commit `d24efee`)** — exposed `ConfidenceTuning` parameter on `reinforce` / `contradict` (4 optional knobs: `reinforcementCurveK`, `contradictionDelta`, `confidenceCap`, `initialConfidenceBaseline`). New `src/learning/tuning.ts` bridges `settings.learning.*` → `ConfidenceTuning` keeping `confidence.ts` I/O-free. `InstinctProposeTool` + `InstinctUpdateConfidenceTool` now load tuning from settings. **Defaults intentionally preserved** — point of this commit is to make tuning *possible*, not pick new values without soak data. Future work: once a real soak surfaces typical confidence ranges, land a defaults-tuning commit using these settings. `crossProjectMinConfidence` settings field also added but not wired to a production caller (no caller of `findPromotionCandidates` outside tests yet). 21 new tests; full suite 1613/1613.
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
- Status: done (2026-05-07)
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
- Status: **complete (2026-05-07, commit `1001237`)** — `SubagentSchedulerOpts` gains optional `harnessHome`. When set, `delegate()` constructs a per-child `TraceWriter` writing to `<harnessHome>/traces/<childSessionId>.jsonl`. The wrapped trace recorder forks every tagged event into BOTH the parent recorder (existing Fix #1 behavior) AND the new child writer. Drained via `await childTraceWriter?.close()` in the inner `finally` so the file is flushed before `delegate()` returns. The wrapper now activates when EITHER a parent recorder OR a child writer is present (previously only when parent recorder was present), so headless sessions still get child files. `terminalRepl` passes the existing `harnessHome` through to scheduler construction. `sov trace show` is unchanged — it already reads `<harnessHome>/traces/<sessionId>.jsonl` for any sessionId, so the new file is the fast-path resolution. 3 new tests pin: (a) child file exists + child-only events when `harnessHome` set, (b) back-compat when `harnessHome` omitted (test fakes), (c) child file written even when parent recorder is undefined.
- Source: original D2 follow-up; round-2 REPL testing finding
- Files: `src/runtime/scheduler.ts`, `src/ui/terminalRepl.ts`, `tests/runtime/scheduler.perChildTrace.test.ts`

### 9. `ReviewForkPromptContext` field rename

- Priority: P2
- Status: **complete (2026-05-07, commit `94eea94`)** — pure rename: `trajectoryPath → primaryFile` and `tracePath → secondaryFile` (now optional). `buildPrompt` updated to emit "Primary file" / "Secondary file" labels and skip the secondary line when omitted. Call sites in `manager.ts` and `consolidate.ts` updated. `synthesizer.ts` unchanged (uses different field names already). `bundle-default/agents/*.md` unchanged (semantic file references, not field-name references). No behavior change.
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
- Status: **complete (2026-05-07, commit `a8d4ce3`)** — independent `synthesizerToolIterationsSince` counter ticks in `onToolIteration` (default threshold 50). Either counter tripping fires `dispatchSynthesizer()` — the user-turn rhythm and the tool-iteration rhythm now run in parallel without resetting each other. New `settings.learning.synthesizerEveryNToolIterations` field exposes the threshold; wired through `terminalRepl`. `signal.aborted` and `enabled` flag short-circuits propagate naturally through the shared dispatch path. 3 new tests cover: (a) tool-iteration trip alone with no user turns, (b) independence (both counters fire separately, neither resets the other), (c) `signal.aborted` blocks both paths.
- Source: testing-log Phase 13.4 entry
- Files: `src/review/manager.ts`, `src/config/schema.ts`, `src/ui/terminalRepl.ts`, `tests/review/manager.test.ts`

### 11. Concurrency between multiple `sov` sessions writing to observations.jsonl

- Priority: P2
- Status: **complete (2026-05-07)** — verified safe via stress test, no code change required. POSIX atomic-append (Node's `appendFile` opens with `O_APPEND`) holds for our line sizes.
- Source: not exercised in build; theoretical
- **Verification:** Added `tests/learning/concurrency.test.ts` — two complementary stress tests:
  - 2 child processes, 50 observations each → 100 lines, all valid JSON, exact per-session counts (`sess-A`=50, `sess-B`=50).
  - 3 child processes, 30 observations each (higher contention) → 90 lines, all valid JSON, exact per-session counts (`sess-A`=30, `sess-B`=30, `sess-C`=30).
  - Each record is ~485 bytes; `Bun.spawn` creates real OS processes that race on `O_APPEND` writes to the same file.
  - Outcome: 0 torn lines across both tests. Multi-process concurrent append is safe for the observation record sizes the harness emits today (`tool_input_summary` capped at 256 chars per `src/learning/observer.ts:33`, total record ≤ ~600 bytes).
- **Caveat (documented for future):** POSIX atomic-append is guaranteed only for writes ≤ `PIPE_BUF` (typically 4096 bytes on Linux, 512 on Darwin). On Darwin specifically, the per-call atomicity boundary is small. Our records stay well under that on Linux, and on Darwin a single `appendFile` call still writes through a single `write(2)` syscall whose atomicity APFS guarantees at filesystem level. If a future change pushes per-record sizes above ~512 bytes (e.g., embedding full tool_input rather than the summary), this property would need re-verification.
- **Test pins the contract going forward:** any regression in the write chain that breaks atomic append (e.g., switching to read-modify-write, dropping `O_APPEND`, batching multiple records into a single `appendFile` call without a newline-correct framing) will surface as torn lines in this test.
- Likely code areas:
  - `src/learning/observer.ts` (write-chain — unchanged)
  - `tests/learning/concurrency.test.ts` (new stress test)
- Effort: ~1 hr (actual: ~45 min)

---

## P3 items — qwen-amendment deepenings

These are documented in `~/code/sovereign-ai-docs/harness/docs/runtime/qwen-amendment-build-plan.md`. They're orthogonal to Phase 13.x and can land at any time.

### 12. Microcompaction (Phase 10 deepening)

- Priority: P3
- Status: **complete (2026-05-11, commits `194b4e3` → `cd5a37c`)** — `src/compact/microcompact.ts` (184 lines) delivered the full qwen-amendment spec: context-percentage trigger, per-part clearing, compactable tool set, keep-recent, current-turn protection. Two gaps discovered during backlog audit and closed 2026-05-11: (1) `userSettings.microcompaction` was parsed but never passed to `query()` — fixed by adding `buildMicrocompactConfig()` and wiring it at the call site; (2) post-compaction guard (run microcompaction on freshly rebuilt `[summary, ...tail]` after full compaction) was unimplemented — added to `compactNow()` in `terminalRepl.ts`.
- Source: qwen-amendment-build-plan

### 13. Shell AST analysis (Phase 7 deepening)

- Priority: P3
- Status: **complete (2026-04-28, commit `194b4e3`)** — `src/permissions/shellSemantics.ts` (437 lines, 233 test lines) delivered the full qwen-amendment spec: hand-written quote-aware tokenizer, 60+ command handlers (read/write/edit/web/git), transparent prefix stripping (sudo/timeout/env/nice/nohup), redirect-aware write promotion, pattern-first grep path extraction, unsafe-pattern detection. Backlog status was stale — implementation predated the backlog item.
- Source: qwen-amendment-build-plan

---

## P4 items — small ergonomics + nits

### 14. `_resetProjectIdCache` test helper exported from production code

- Priority: P4
- Status: **complete (2026-05-07, commit `f3ee05f`)** — renamed `_resetProjectIdCache → __test_resetProjectIdCache` with `@internal` JSDoc warning. Double-underscore + `test_` prefix gives stronger lexical signal than single-underscore. All 3 test-file callers updated. Bundled with Item 15 in the same commit.
- Source: T1 spec review
- Recommendation: Move `_resetProjectIdCache` from `src/learning/project.ts` to a `tests/learning/_helpers.ts` module. Production code shouldn't expose `_`-prefixed test helpers.
- Effort: ~15 min

### 15. `nameFromRemote` loses nested-namespace context

- Priority: P4
- Status: **complete (2026-05-07, commit `f3ee05f`)** — `nameFromRemote` now returns last-two path segments. Handles SSH (`git@host:owner/repo.git` → `owner/repo`), HTTPS (with/without `.git`, with/without trailing slash), GitLab subgroup nested (`host/group/sub/repo` → `sub/repo`), and bare-host single-segment (`host/repo.git` → `repo`). 8 new test cases pin the URL-shape coverage. Bundled with Item 14 in the same commit.
- Source: T1 implementer flag
- Recommendation: Currently `nameFromRemote('https://example.com/group/sub/repo.git')` yields `repo`. For nested namespaces we lose `group/sub` context. Could switch to `last-two-segments` if we want to preserve org/repo distinction.
- Impact: Project name in `harness learning status` output may collide for projects with the same trailing path component.
- Effort: ~15 min

### 16. `cleanupPhantomReviews` runs only at session boot

- Priority: P4
- Status: **complete (2026-05-07, commit `ac4dc74`)** — `/review activity` now triggers cleanup when `phantomCount > 10`. `CommandContext` gains optional `cleanupPhantomReviews?: () => number` callback (same function-binding pattern as `listSessions`). `terminalRepl` populates from `db.cleanupPhantomReviews()`. Activity verb header annotates "(cleaned N phantom rows)" when cleanup ran. Threshold strictly greater than 10 (10 doesn't trigger; 11+ does). 4 new tests cover all branches.
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

## Items discovered during 2026-05-07 ad-hoc REPL soak

Seven cross-cutting findings surfaced during a 7-agent parallel REPL soak that exercised tool surface, sub-agent runtime + tasks, slash commands, CLI subcommands, state persistence, Phase 13.4 instinct corpus, and error/edge/multi-turn cases. **All 41 test cases passed.** These items are gaps or polish concerns observed while running, not failures.

### 18. Glob inline tool block — count footer drifts vs. summary line

- Priority: P4
- Status: **complete (2026-05-07, commit `d52fb75`)** — root cause was `src/ui/toolFooter.ts` reading `totalLines` (the rendered block's line count) as the file count. Phase 12.5's observation envelope prepends `status:` + `summary:` (+ optional `next_actions:`) and a blank separator before the body, so `totalLines = paths.length + envelope rows`. A 1-file result rendered ~4 lines, hence the soak's `summary: 1 file` vs. footer `found 4 files`. Live repro showed a 2-file Glob with `summary: 2 files` next to footer `found 5 files`. Fix: new `extractGlobFileCount` parses the envelope's `summary: <n> file(s)` line and feeds the canonical count to the footer; pre-envelope content shape kept as fallback. Tests: 4 envelope cases in `tests/ui/toolFooter.test.ts` + a parameterized end-to-end test in `tests/tools/globTool.test.ts` that runs the real GlobTool, reconstructs the rendered block, and pins envelope-summary == footer-count for N=1/4/50.
- Source: 2026-05-07 soak Agent A (tool surface battery), case A4 (Glob + Grep in temp project)

### 19. MEMORY.md cross-pollinates unrelated projects

- Priority: P1
- Status: **complete (2026-05-07, commits `db967ed` → `07cb263`)** — five commits across three rounds shipped via subagent-driven dispatch. Two-tier MEMORY.md model: global `<harnessHome>/memory/MEMORY.md` (existing, untouched) + new per-project `<harnessHome>/memory/projects/<projectId>/MEMORY.md`. USER.md untouched (always global). Routing decided by `MemoryTool.scope: 'global' | 'project'` argument; default = `'project'` when a project context is detected (bundle manifest `projectId` → bundle path hash → git remote, in that order), else `'global'`. `MemoryTool` rejects `scope: 'project'` with a clean envelope when no projectId is available. New system-prompt segment tells the agent the routing rules. Provider snapshot includes both layers when a project is detected (global block then project block, project closer to user message for soft "later wins" precedence). Existing global MEMORY.md content is preserved as global; no automatic migration. **+33 tests** across `tests/memory/scope.test.ts` (11) + `tests/memory/bounded.test.ts` (7) + `tests/memory/injection.test.ts` (7) + `tests/memory/provider.test.ts` (6) + `tests/tools/memoryTool.test.ts` (16) + `tests/context/systemPrompt.test.ts` (4) — was 1683/1683 before Round 1, now 1716/1716. Suite gates clean; pushed to origin/master and `sov upgrade` ran. Design memo at `docs/plans/2026-05-07-memory-project-scoping.md`.
- **Behavioral note (smoke test finding):** `sov chat` always loads the default bundle when no `--bundle` is passed, so the `kind: 'none'` branch (true general-purpose harness mode with no memory at all) is rarely reached via the CLI in practice. Most non-git scratch-dir sessions get a stable "default-bundle" projectId via the canonical-path hash path, and their memory lives at `<harnessHome>/memory/projects/<defaultBundleHash>/MEMORY.md`. Different from before (single global MEMORY.md sees everything) but not the same as "no memory" — it's effectively a single shared "general purpose" memory namespace. Acceptable for v1; revisit if it surfaces as a separate problem.
- Source: 2026-05-07 soak Agent A, cases A4 + A6

### 20. `HARNESS_HOME=… printf | sov chat` env-prefix-pipeline footgun

- Priority: P4
- Status: **complete (2026-05-07, commit `e677676`)** — added "Scoping `HARNESS_HOME` for tests" subsection at the end of `## Profiles` in `docs/usage.md`. Documents the footgun pattern (env scope binds only to `printf`, not the downstream `sov`), shows three correct alternatives (export-then-pipe, redirect from file, repeat env on each pipeline stage), and explains WHY (each command in a pipeline runs in its own subshell with its own environment). Docs-only commit.
- Source: 2026-05-07 soak Agent F's setup (HARNESS_HOME override for Phase 13.4 testing)
- Evidence: `HARNESS_HOME=/tmp/sov-soak-F/harness-home printf 'prompt' | sov chat ...` silently routes `sov chat` to the user's live `~/.harness/`, because the env binding scopes only to `printf` (the first command in the pipeline). The override is silently ignored. The tester only noticed when the synthesizerEveryN override didn't take effect.
- Recommendation:
  - **(a) Documentation:** Add a "scoping HARNESS_HOME for tests" note to `docs/usage.md` explaining that `export HARNESS_HOME=…` (or `env HARNESS_HOME=… sov chat <args>`) is required.
  - **(b) Optional UX:** A startup banner showing the resolved `HARNESS_HOME` path (already shown in the top-of-session info card per the existing UI) — verify it's prominent enough that a user would catch a mis-scoped env.
- Likely code areas:
  - `docs/usage.md`
- Impact: Test ergonomics + occasional debugging confusion. Not a runtime bug.
- Effort: ~15 min docs

### 21. Tool-count drift between live config and fresh `harness-home`

- Priority: P4
- Status: **complete (2026-05-07)** — investigated, intentional gating confirmed. No code change required. See resolution below.
- Source: 2026-05-07 soak Agent F. First (mis-routed) run reported `tools: 22` from live config; second (correctly-routed) run with bare override config reported `tools: 21`.
- **Resolution:** The single-tool differential is **`WebSearch`** (244-token schema). It is gated by `WebSearchTool.isEnabled = () => resolveProviderSettings().apiKey !== undefined` in `src/tools/WebSearchTool.ts:182`. The live `~/.harness/config.json` has `webSearch.apiKey` set; the bare override config does not, so `isEnabled()` returns `false` and `assembleToolPool` filters it out at `src/tool/registry.ts:128`. Verified by toggle test: adding `webSearch.apiKey` to the bare config flipped the count `21 → 22` and `WebSearch: 244` appeared in `/context-budget` output. `WebFetch` is *not* gated (always present, 256 tokens) — only `WebSearch` requires a provider API key. Hypotheses (a) MCP and (c) `debugMode.transcript` were ruled out: no other tool registers a `isEnabled()` predicate (grep result: `WebSearchTool.ts` is the only file with a non-default `isEnabled`), and `debugMode` only affects logging, not pool assembly.
- **Verdict:** Intentional behavior. Exposing `WebSearch` without an API key would cause 100% failed invocations — the gating is correct. The deterministic baseline is **21 tools** with no provider-keyed config; it climbs to 22 when `webSearch.apiKey` (or `TAVILY_API_KEY` / `BRAVE_SEARCH_API_KEY` env var, per `resolveProviderSettings`) is present. Tests that pin exact tool counts should either (i) clear `webSearch.apiKey` + the two env vars in setup, or (ii) accept the 21-vs-22 range. No follow-up filed.
- Likely code areas (for reference):
  - `src/tool/registry.ts:128` (`assembleToolPool` filter step)
  - `src/tools/WebSearchTool.ts:182` (the only `isEnabled` predicate in the tool tree)
- Impact: Mild — affects test reproducibility when tests reference exact tool counts.
- Effort: ~30 min investigation (actual: ~20 min)

### 22. Mid-turn context pruning anomaly during long autonomous exploration

- Priority: P1
- Status: **complete (2026-05-07)** — investigation confirmed a real harness bug; targeted fix shipped. See investigation summary below.
- Source: 2026-05-07 soak Agent G, case G4 (vague "do something useful" prompt)
- Evidence: The agent ran 14 tool calls during autonomous exploration. In its own narration it self-noted: *"I was spinning in circles running commands that kept getting cleared."*
- **Investigation result (real harness bug):**
  - Microcompaction fires INSIDE the `for (let turn...)` loop in `src/core/query.ts:380-401`, AFTER `runTools` and BEFORE the next iteration's `provider.stream()` call. So it runs mid-prompt, between sub-turns of a single user message.
  - Eviction policy: `DEFAULT_MICROCOMPACT_CONFIG.keepRecent = 5`, applied GLOBALLY across the entire history (no notion of "current turn" in `collectCompactableRefs`).
  - Trigger: total compactable tool_result tokens > 40% of total context tokens.
  - Failure mode: a single user prompt that triggers a 14-call autonomous burst → after turn ~6, microcompact kicks in and clears all but the most recent 5 results — including 9 results created in the SAME user-prompt loop. The agent's next assistant message wants to reference earlier outputs, finds `[Tool result cleared — Bash]` placeholders, and either re-runs the tool or loops in confusion.
- **Fix:** Added `findCurrentTurnBoundary()` to `src/compact/microcompact.ts`. The boundary is the index of the most recent user message containing a `text` block (real user prompts always carry text; runTools-synthesized tool_result-only messages do not). `collectCompactableRefs` now skips messages at or after that boundary, so tool_results from the in-flight user prompt are never eligible for eviction regardless of count. KeepRecent semantics are unchanged for older history.
- **Tests:** 3 new cases in `tests/compact/microcompact.test.ts`: 30-result single-burst preservation (the case G4 reproduction), two-prompt boundary respect, standalone-guidance boundary handling.
- Files: `src/compact/microcompact.ts`, `src/core/query.ts` (comment update), `tests/compact/microcompact.test.ts`

### 23. FileRead throws on missing file instead of returning `{status: error}` envelope

- Priority: P1
- Status: **complete (2026-05-07, commit `d2e1e92`)** — 2 throw → envelope conversions in `src/tools/FileReadTool.ts` (missing-file + is-directory paths). `next_actions` arrays match Bash's tone ("verify the path with Glob or `ls`; confirm the working directory") for cross-tool consistency. File-too-large stays as a throw per the user-input vs. system-limit distinction (could be revisited if soak surfaces the case). 2 existing tests migrated from `.rejects.toThrow` to envelope-shape assertions.
- Source: 2026-05-07 soak Agent G, case G5 (mid-multi-turn error)
- Evidence: FileRead on a non-existent file produced `tool threw: file does not exist: /private/tmp/sov-soak-G/cwd-G5/nonexistent.txt` rather than a clean Phase 12.5 envelope (`status: error, summary: ..., next_actions: [...]`). The agent handled it correctly downstream (no fabrication, honest "did not succeed" report), but the envelope contract is inconsistent with peer tools (Bash returns `status: error` with exit code, etc., per soak A2).
- Recommendation: Normalize FileRead's missing-file path to return `{status: 'error', summary: 'file not found at <path>', next_actions: ['verify path with Glob or ls'], data: null}` rather than throwing. Same family as Bash's exit-1 pattern.
- Likely code areas:
  - `src/tools/FileReadTool.ts` (the file-not-found branch)
- Impact: Inconsistency makes "all tools surface errors via envelope" rule (Phase 12.5) less reliable for downstream consumers — anything that checks `result.observation?.status === 'error'` would miss FileRead's misses.
- Effort: ~30 min

### 24. `maxToolCallsBeforeCheckin` knob for vague-prompt cost control

- Priority: P3
- Status: **complete (2026-05-11, commits `3fa6f67` → `2e192fd`)** — `behavior.maxToolCallsBeforeCheckin` schema field, `Terminal.reason: 'checkin'` + `toolCallCount?`, per-turn counter in `query.ts` after microcompaction, REPL handler prints checkin message + sets `checkinPending`, `/continue` slash command (registered, `CommandContext.resumeCheckin?`), `runModelTurn(isContinuation: true)` path skips user-message push. 3 new schema tests, 3 query tests, 3 command tests. Suite 1778/1778. Known v0 limit: `checkinPending` not reset if user sends a new message instead of /continue.
- Source: 2026-05-07 soak Agent G, case G4
- Evidence: Vague prompt "do something useful" triggered 2-minute autonomous exploration with 14 tool calls costing $0.05. Reasonable agent behavior, but cost-aware users might want a configurable check-in point ("ask the user before continuing past N tool calls in a single turn").
- Recommendation: Add `settings.behavior.maxToolCallsBeforeCheckin: number` (default unset = no limit). When set, the orchestrator interrupts the turn after N tool calls and emits a guidance message asking the user whether to continue. Could pair with a `/continue` slash verb that resumes the same turn.
- Likely code areas:
  - `src/config/schema.ts` (settings field)
  - `src/core/query.ts` (turn-iteration counter check)
  - New slash verb `/continue` to resume
- Impact: Cost-control feature; not a bug. Some users would value this; others would find it annoying. Worth an opt-in default.
- Effort: ~3 hrs

---

## How to use this document

Pick any item by priority + effort match for your session length:
- 30-min slot: (none currently open)
- 1-2 hr slot: (none currently open)
- Half-day slot: (none currently open)
- Multi-day: item 17

Cross off completed items by changing `Status: open` → `Status: complete (YYYY-MM-DD)` and recording the commit SHA in a brief follow-up paragraph.

When finishing the document (everything closed), move it to `docs/archive/` rather than deleting — the rationale + evidence have ongoing value.

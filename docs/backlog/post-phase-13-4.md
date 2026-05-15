# Post-Phase-13.4 Backlog

This document is the record of truth for items not part of the canonical build plan that have surfaced as v0 limits, deferred polish, or architectural extensions during the Phase 13.3 + 13.4 work shipped on 2026-05-06. Future sessions can pick these up without re-deriving context.

These items are deliberately NOT in `~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md` — they are smaller follow-ups, polish, and known v0 trade-offs documented in commit messages, code comments, and the testing log. The build plan's next phase is Phase 13.5 (scheduled-mission sub-agents); these backlog items are orthogonal and can land between phases or as time permits.

**Last sync:** 2026-05-15. Runtime close-out reached the Phase 16.1 M7 close-out commit (six Hermes-layer subsystems wired into the server-mode runtime — MCP client pool, TaskManager DaemonEventBus integration, trace writer, trajectory capture, learning observer, review manager); 1965/1965 unit tests green. Items 1-11, 14-16, 18-23, 25-28, 31-37 closed across fifteen batches. Items 25-30 added 2026-05-14 from Phase 16.1 M5 close-out + M5.1 review (T6/T7/T9 follow-ups + router-mode default-provider gap). Items 31-33 added 2026-05-14 from Phase 16.1 M6 final whole-branch review (turns-route validation + resume regression-test gap + asymmetric isClosed guards). Items 34-36 added 2026-05-15 from M6 pre-smoke critical bug-hunt (Anthropic alternation hazard + overflow matcher unverified vs real providers + cosmetic compaction-token-delta on tiny sessions). Item 37 added 2026-05-15 from M6 smoke pre-flight (user noted `sov --version` doesn't print the git SHA). Items 38-39 added 2026-05-15 from Phase 16.1 M7 T5/T6 reviews (reviewAutoPromote* settings snapshot gap + Go TUI mirror for SessionSummaryEvent). Remaining open: 17, 29, 30, 38, 39. Items 18-24 originated from the 2026-05-07 ad-hoc 7-agent REPL soak (41/41 cases passed). Items 25-30 originated from the Phase 16.1 M5 T10 / M5.1 reviews. Items 31-33 originated from the Phase 16.1 M6 final whole-branch review. Items 34-36 originated from the M6 pre-smoke deep-dive review (three parallel Opus reviewers focused on server flow, TUI/wire, and edge cases). Item 37 originated from M6 smoke pre-flight. Items 38-39 originated from Phase 16.1 M7 reviews.

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
34. ~~Anthropic strict-alternation hazard with `assistant`-role compaction summary~~ **— closed `4653737` (synthetic bridge user inserted between summary and tail when tail[0].role === 'assistant')**
35. ~~`isContextOverflowError` substring matcher unverified against real provider error shapes~~ **— closed `1212a42` (real Anthropic overflow probed; matcher catches `'prompt is too long'`; JSDoc + test pin the contract)**

P3 (qwen-amendment deepenings — orthogonal to 13.x):
12. Microcompaction (Phase 10 deepening)
13. Shell AST analysis (Phase 7 deepening)
24. `maxToolCallsBeforeCheckin` knob for vague-prompt cost control **[soak 2026-05-07]**
25. ~~Server-side `SubagentScheduler` does not receive `availableProviders`~~ **[M5 T6 2026-05-14] — closed `3b07110` (M5.1)**
26. ~~Server-side `SubagentScheduler` does not receive `artifactsRoot`~~ **[M5 T6 2026-05-14] — closed `3b07110` (M5.1)**
27. ~~Server-side `LaneSemaphores` cap config not wired from settings~~ **[M5 T6 2026-05-14] — closed `3b07110` (M5.1)**
31. ~~M3.4 turns route does not validate `:id` shape~~ **[M6 review 2026-05-14] — closed `b9a4ad8` (added `isValidSessionId` guard at top of POST /sessions/:id/turns handler; mirrors sibling routes)**
32. ~~Resume-after-compaction regression test~~ **[M6 review 2026-05-14] — closed `09da469`**
36. ~~`estimatedAfterTokens > estimatedBeforeTokens` cosmetic on small sessions~~ **[M6 review 2026-05-15] — closed 2026-05-15 (early-return guard in `compactSession`; `noOp: true` flag wired through all callers)**
38. `reviewAutoPromoteMemory` / `reviewAutoPromoteSkills` snapshot gap in `parentToolContext` **[M7 T6 2026-05-15]**

P4 (small ergonomics + nits):
14. ~~`_resetProjectIdCache` test helper exported from production code~~ **— closed `f3ee05f`**
15. ~~`nameFromRemote` heuristic loses nested-namespace context~~ **— closed `f3ee05f` (last-two-segments)**
16. ~~`cleanupPhantomReviews` runs only at session boot~~ **— closed `ac4dc74` (event-driven sweep on /review activity)**
17. Eval-gated auto-promote (currently auto-promote is straight bypass)
18. ~~Glob inline tool block: count footer drifts vs. summary line~~ **[soak 2026-05-07] — closed `d52fb75` (footer reads canonical count from envelope summary)**
20. ~~`HARNESS_HOME=… printf | sov chat` env-prefix-pipeline footgun (docs)~~ **[soak 2026-05-07] — closed `e677676`**
21. ~~Tool-count drift between live vs. fresh `harness-home` config (investigation)~~ **[soak 2026-05-07] — closed (WebSearch gated on apiKey; intentional)**
28. ~~Server-side TaskManager not wired to `DaemonEventBus`~~ **[M5 T7 2026-05-14] — closed `bfaeaad` (M7 T2; `Runtime.daemonEventBus` constructed in `buildRuntime` and threaded into `new TaskManager({...,bus})`)**
29. lipgloss `Style.Copy()` deprecation in Go TUI permission modal **[M5 T9 2026-05-14]**
33. ~~Asymmetric `bus.isClosed()` guards in turns route~~ **[M6 review 2026-05-14] — closed `79a5c39` (dropped all three redundant guards; eventBus.publish is idempotent on closed buses)**
37. ~~`sov --version` should print the git SHA (currently shows static `0.1.0`)~~ **[M6 smoke 2026-05-15] — closed `a89b03c` + `4bd849c`**
39. Go TUI mirror struct for `SessionSummaryEvent` not added **[M7 T6 2026-05-15]**

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

## Items discovered during Phase 16.1 M5 close-out (2026-05-14)

Five follow-ups surfaced from the M5 T10 code-quality review (server-side sub-agent + permission round-trip + Go TUI permission modal). All are construction-scope gaps versus terminalRepl's mature wiring — deferred to keep M5 a focused construction milestone, not blocked work. None affect the M5 acceptance criteria; the server-side TUI launcher is functional with the current defaults. Land alongside the broader server-side settings-cascade work (M6 or later) or as part of the parity audit before the `--ui tui` default-flip.

**Update 2026-05-14:** Items 25, 26, 27 closed in commit `3b07110` (M5.1) — the three settings-cascade gaps at the `SubagentScheduler` / `LaneSemaphores` construction site, bundled because they all touch the same lines. Items 28 (DaemonEventBus wiring) and 29 (lipgloss `Style.Copy()` deprecation) remain open.

### 25. Server-side `SubagentScheduler` does not receive `availableProviders`

- Priority: **P2** (bumped from P3 after empirical confirmation during M5 manual smoke 2026-05-14)
- Status: **complete (2026-05-14, commit `3b07110` — M5.1)** — `buildRuntime` now threads `availableProviders` via a new `resolveSubagentAvailableProviders(resolved)` pure helper. For single-provider mode the list is `[providerName]`; for router metadata it's `[localProvider, frontierProvider]`. Mirrors terminalRepl.ts:887-902. Three new tests pin the helper semantics (single-provider, router-mode, defensive fallback on partial router metadata) + one end-to-end test asserts the value reaches the scheduler at construction time. **Deviation from backlog description:** the backlog described the source as `userSettings.providers.available`, but no such schema field exists — terminalRepl derives the list from `resolved.metadata.provider` and the router lane metadata. The fix mirrors terminalRepl's actual pattern, not the backlog's paraphrase.
- Source: Phase 16.1 M5 T10 code-quality review (T6 follow-up); confirmed user-visible during M5 manual smoke scenario 3
- Original recommendation: `buildRuntime` in `src/server/runtime.ts` constructs `SubagentScheduler` without threading `availableProviders` from `userSettings`. terminalRepl reads `userSettings.providers.available` (or the equivalent) and passes it through so the scheduler's lane planner skips providers the user doesn't have credentials for. Server-side, the scheduler currently defaults to all four (`anthropic`, `openai`, `openrouter`, `ollama`) and may attempt to dispatch to a provider that will fail at the first auth check.
- Original evidence: terminalRepl's scheduler construction site (lines ~879-955) reads `availableProviders` from the settings cascade; `buildRuntime`'s equivalent call site does not. **2026-05-14 manual smoke:** with parent on `anthropic/claude-haiku-4-5`, dispatching the `explore` subagent routed the child to `ollama/llama3.1:70b` (capability-profile default for `role: explore`); on a machine without that local model the child errored immediately and the parent gracefully degraded to running Bash itself. Sessions table at `~/.harness/sessions.db` shows the parent_session_id linkage is correct — only the provider/model choice is wrong.

### 26. Server-side `SubagentScheduler` does not receive `artifactsRoot`

- Priority: P3
- Status: **complete (2026-05-14, commit `3b07110` — M5.1)** — `buildRuntime` now threads `artifactsRoot` via the new `resolveSubagentArtifactsRoot(harnessHome, bundle)` helper. Returns `<bundle>/state/artifacts` for client bundles (non-default-bundle), else `harnessHome` (the trajectory writer joins `/trajectories` to whichever root). Mirrors terminalRepl.ts:927-930. Two new tests pin the helper semantics + one end-to-end test asserts the value reaches the scheduler at construction time. Phase 13.3 review daemon + Phase 13.4 instinct corpus pipelines now see M5-launched session data.
- Source: Phase 16.1 M5 T10 code-quality review (T6 follow-up)
- Original recommendation: `buildRuntime` does not pass `artifactsRoot` to `SubagentScheduler`, which disables per-child trajectory capture in server mode. terminalRepl sets `artifactsRoot: <harnessHome>/artifacts/` so each child writes `samples.jsonl` + `failed.jsonl` under the artifacts tree, feeding the offline learning / review pipelines. Server-mode sessions silently skip this capture.

### 27. Server-side `LaneSemaphores` cap config not wired from settings

- Priority: P3
- Status: **complete (2026-05-14, commit `3b07110` — M5.1)** — `buildRuntime` now threads `maxConcurrentLocal` / `maxConcurrentFrontier` from `userSettings.router.*` via the new `resolveLaneSemaphoresOpts(userSettings)` helper. Undefined values are omitted so unset lanes stay unbounded (per laneSemaphores.ts:29-32). Mirrors terminalRepl.ts:879-886. Three new tests pin the helper semantics (empty, local-only, frontier-only, both) + two integration tests through `buildRuntime` assert: (a) cap-blocks-acquire when local cap=1 (a second `acquire('local')` suspends until the first releases), and (b) frontier lane stays unbounded when only local cap is configured.
- Source: Phase 16.1 M5 T10 code-quality review (T6 follow-up)
- Original recommendation: `buildRuntime` constructs `new LaneSemaphores({})` (empty caps = unbounded). terminalRepl reads `userSettings.router.maxConcurrentLocal` and `userSettings.router.maxConcurrentFrontier` and passes them through so production deployments can throttle concurrent sub-agent dispatch per lane. Server-mode runs are effectively uncapped today.

### 28. Server-side TaskManager not wired to `DaemonEventBus`

- Priority: P4
- Status: **complete (2026-05-15, commit `bfaeaad`)** — `buildRuntime` constructs a `new DaemonEventBus()` per-runtime and passes it to `new TaskManager({ store, scheduler, bus })`. M7 T2 contract closes here: TaskManager lifecycle events (`task_created`, `task_progress`, `task_completed`, `task_failed`) publish onto the bus from server-mode the same way they do in terminalRepl. No subscriber wired inside the server process itself in M7 — review/learning observe via the orchestrator's direct ToolContext call-sites (per ADR M7-06). The bus is plumbing-only here; cross-process daemon subscribers can attach in future without rewiring the runtime construction. `Runtime.daemonEventBus` field exposes the bus for the integration smoke (verified by `tests/server/m7Full.test.ts`) and any future subscriber that needs the handle.
- Source: Phase 16.1 M5 T10 code-quality review (T7 follow-up)
- Recommendation: `buildRuntime` constructs `TaskManager` without subscribing the daemon event bus. terminalRepl's TaskManager publishes lifecycle events (`task_started`, `task_completed`, `task_failed`) onto `DaemonEventBus` so the Phase 16.0a daemon (currently dormant) and any future review/learning consumers can subscribe. Server-mode TaskManager today only emits events onto the parent session's SSE feed; nothing outside the live session sees them.
- Evidence: terminalRepl's TaskManager construction includes a `DaemonEventBus` subscriber wiring step; `buildRuntime` omits it.
- Impact: M5 is unaffected (the daemon is dormant; no subscriber exists yet). Becomes a real gap when M7's review/learning subsystems land in server mode — they'll need the daemon-bus integration to fire.
- Likely code areas:
  - `src/server/runtime.ts` (`buildRuntime` — `TaskManager` construction)
  - `src/runtime/taskManager.ts` (verify the daemon-bus injection point)
- Effort: ~45 min — depends on whether the daemon-bus subscriber API is settled. May overlap with the M7 review/learning wire-up; can defer until that work starts.

### 29. lipgloss `Style.Copy()` deprecation in Go TUI permission modal

- Priority: P4
- Status: open
- Source: Phase 16.1 M5 T10 code-quality review (T9 follow-up)
- Recommendation: `packages/tui/internal/components/permission.go` calls `.Copy().Bold(true)` on a `lipgloss.Style`. The `Copy()` method is deprecated in modern lipgloss (`>= 0.10`) because `Style` values are value-type semantically — `.Bold(true)` already returns a new style without mutating the receiver. Replace `style.Copy().Bold(true)` with `style.Bold(true)` directly.
- Evidence: lipgloss release notes mark `Copy()` deprecated; the linter on packages/tui will eventually catch this.
- Impact: Cosmetic — no rendering difference today. Future lipgloss versions may remove `Copy()`, which would break the build.
- Likely code areas:
  - `packages/tui/internal/components/permission.go` (the only `Copy().Bold(true)` call introduced in T9)
- Effort: ~5 min — single-line edit, no logic change.

### 30. Server-mode `subagentDefaultProvider`/`subagentDefaultModel` not specialized for router mode

- Priority: P4
- Status: open
- Source: Phase 16.1 M5.1 final whole-branch review (2026-05-14)
- Recommendation: `buildRuntime` in `src/server/runtime.ts:455-456` passes `defaultProvider: resolved.transport.name` and `defaultModel: resolved.model` directly to `SubagentScheduler`. terminalRepl computes `subagentDefaultProvider`/`subagentDefaultModel` specially for router mode (`src/ui/terminalRepl.ts:908-917`) so child agents launched from a router-mode parent get sensible defaults instead of the literal `'router'` provider string.
- Evidence: server-mode does NOT support `--provider router` yet (no `buildRouterResolvedProvider` equivalent in the server build), so the gap is hypothetical today. Becomes a real bug if/when router support lands in server mode.
- Impact: Latent. M5.1's `availableProviders` fix correctly handles the router-metadata case for the available-provider list, but the default-provider/model fall-through is still uncomputed. A router-mode parent in server mode would dispatch children with `defaultProvider: 'router'` which doesn't resolve.
- Likely code areas:
  - `src/server/runtime.ts` (`buildRuntime` — extract `resolveSubagentDefaultProvider/Model(resolved)` alongside the M5.1 helpers, wire at the construction site)
  - `src/ui/terminalRepl.ts:908-917` (reference pattern)
- Effort: ~30 min — same shape as M5.1's three helpers; bundle with any future "wire router into server mode" work.

---

## Items discovered during Phase 16.1 M6 final whole-branch review (2026-05-14)

Three follow-ups surfaced from the M6 (long-session survival) final whole-branch review. None affect the M6 acceptance criteria; the long-session survival path is functionally complete and the suite is green at 1924/1924. The first two pin pre-existing gaps M6 made visible (turns-route asymmetry vs. its sibling routes; resume-after-compaction lineage isn't covered by an explicit regression test). The third is a stylistic asymmetry that could be cleaned up in either direction.

### 31. M3.4 turns route does not validate `:id` shape

- Priority: P3
- Status: **complete (2026-05-15, commit `b9a4ad8`)** — Added `isValidSessionId(sessionId)` guard at the very top of the `POST /sessions/:id/turns` handler in `src/server/routes/turns.ts`, before any work. Returns `{ error: 'invalid session id' }` with status 400 on malformed input — same wire shape as `sessions.ts:39`, `events.ts:20`, `approvals.ts:23`, `compact.ts:41`. Import combined with existing `loadHistoryAsMessages` per Biome's type-first rule. New test in `tests/server/turns.test.ts` ("returns 400 for invalid session id") pins the contract — confirmed RED before fix (received 202, also triggered a `SQLITE_CONSTRAINT_FOREIGNKEY` cascade in the persistence test running afterwards — direct empirical evidence of the impact described below), GREEN after. Pre-commit gate: 1939 pass / 0 fail.
- Source: Phase 16.1 M6 final whole-branch review (2026-05-14)
- Recommendation: `src/server/routes/turns.ts:79-80` reads `c.req.param('id')` and uses it directly as the `sessionId` for the bus + background-turn dispatch — no `isValidSessionId` check. Sibling routes (`sessions.ts`, `events.ts`, `approvals.ts`, `compact.ts`) all call `isValidSessionId(sessionId)` and 4xx on malformed ids. Add the same guard at the top of the POST `/sessions/:id/turns` handler.
- Evidence: pre-existing asymmetry from M3.4 (the turns route was the first server route landed; the `isValidSessionId` helper was added later for sessions/events). M6 made it visible because the new compact route (sibling) DOES validate, so the inconsistency now stands out next to its peers.
- Impact: A malformed id (e.g., one containing characters outside `[A-Za-z0-9_-]`) would currently flow into `getOrCreateBus` and the persisted user message — neither call sanitizes the id, so it would echo unsanitized into SSE event payloads and the sessions table. Not exploitable today (the id is server-stored and read-back; no third-party render), but the validation contract is what keeps that property true.
- Likely code areas:
  - `src/server/routes/turns.ts:79-80` (single validation call before `getOrCreateBus`)
  - `tests/server/turns.test.ts` (regression test pinning 400 on malformed id)
- Effort: ~30 min (single validation call + test).

### 32. Resume-after-compaction regression test

- Priority: P3
- Status: **complete (2026-05-15, commit `09da469`)** — Added one new test in `tests/compact/compactor.test.ts` inside the existing `describe('compactSession', …)` block. The test seeds a 6-message parent history, runs `compactSession` with `tailTokenBudget: 1, minTailMessages: 1` (so the no-op short-circuit at `compactor.ts:130` cannot fire), confirms a real compaction happened (`result.noOp` falsy, `newSessionId !== parentSessionId`, lineage row persisted), then asserts (a) `db.loadMessages(parent)` returns the original 6 messages — first and last contents match the seeded history verbatim, (b) `db.loadMessages(child)` returns the summary+tail shape with `HANDOFF_SUMMARY_NOTE` at index 0, and (c) parent's first message content ≠ child's first message content — the strongest direct evidence that the two ids resolve to distinct message streams. GREEN on first run (invariant held by construction); verified meaningfulness via reasoning — three independent assertions would fail if `loadMessages` were ever changed to walk lineage forward. Pre-commit gate: 1940 pass / 0 fail (was 1939, delta +1).
- Source: Phase 16.1 M6 final whole-branch review (2026-05-14)
- Recommendation: `--resume <parentId>` after compaction works by construction — sessionDb is immutable + the lineage row persists — so a future user resuming a parent session can walk the lineage chain and discover the post-compaction child. But no test pins this. Backlog row 7's earlier wording mentioned "rollback lineage"; that's covered by `--resume` walking the lineage chain, but the property is not exercised. Add a unit-level test that: (a) runs a turn that triggers proactive compaction, (b) confirms the lineage row exists, (c) `--resume`s the parent id and verifies the resumed session loads the parent's pre-compaction history (not the child's post-compaction state).
- Evidence: lineage table populated by `compactSession` at `compactor.ts:145`; resume reads from the parent id directly, doesn't auto-walk to the latest descendant. The "stay on parent" semantic is intentional (resume = "go back to where I was when this happened") but not pinned.
- Impact: A future refactor that changed resume to "auto-pivot to latest descendant" would silently break this contract. The test would land that change as an explicit regression.
- Likely code areas:
  - `tests/cli/resume.test.ts` or `tests/server/turns.compactionResume.test.ts` (new file)
  - `src/cli/resume.ts` (reference: how resume reads from sessionDb)
- Effort: ~30 min.

### 33. Asymmetric `bus.isClosed()` guards in turns route

- Priority: P4
- Status: **complete (2026-05-15, commit `79a5c39`)** — Dropped all three `if (!bus.isClosed())` wrappers in `src/server/routes/turns.ts` (M6 T4 first-overflow turn_error path, M6 T4 second-overflow turn_error path, normal turn_complete path). The catch's turn_error publish was already unguarded — all four publish sites in `runTurnInBackground` now share the same shape. `ServerEventBus.publish` at `eventBus.ts:50-57` is the single source of truth for closed-state behavior (idempotent short-circuit on `this.closed === true`). Pure de-indent diff: 21 insertions, 27 deletions. No behavior change. Pre-commit gate: 1938 pass / 0 fail.
- Source: Phase 16.1 M6 final whole-branch review (2026-05-14)
- Recommendation: `src/server/routes/turns.ts` lines 397/410 guard `bus.publish(...)` with `if (!bus.isClosed())` (the second-overflow turn_error and the normal turn_complete paths). Line 419 (the catch's turn_error publish) does NOT guard. Functionally safe — `ServerEventBus.publish` at `eventBus.ts:51` already short-circuits when `closed === true`, so the guards are redundant — but visually asymmetric. Pick one direction: drop both guards (preferred — eventBus is the single source of truth for the closed-check) or add the missing guard at line 419 for symmetry.
- Evidence: `src/server/eventBus.ts:50-57` shows `publish()` is idempotent on closed buses. The two existing guards are no-ops.
- Impact: Cosmetic. No runtime difference.
- Likely code areas:
  - `src/server/routes/turns.ts` (lines 397, 410, 419)
- Effort: ~10 min.

---

## Items discovered during M6 pre-smoke critical bug-hunt (2026-05-15)

The user requested a focused, critical code-side review before running the three M6 manual smoke scenarios. Three parallel Opus reviewers covered server flow, Go TUI / wire fidelity, and cross-cutting edge cases. The most-load-bearing finding (multi-turn SSE was broken in the TUI by an M3-era design gap) was fixed in commit `3365fb3` + `f1f5bda` — those scenarios are now smoke-ready. Three items below are the remaining real risks that warrant follow-up but did not block the smoke.

### 34. Anthropic strict-alternation hazard with `assistant`-role compaction summary

- Priority: **P2**
- Status: **complete (2026-05-15, commit `4653737`)** — Picked Option A (synthetic bridge user). `compactSession` now inserts `{role: 'user', content: [{type: 'text', text: '(continuing from summary)'}]}` between the assistant-role handoff summary and `tail[0]` when (and only when) `tail[0]?.role === 'assistant'`. The bridge is persisted via `db.saveMessage`, included in the returned `result.tail`, and accounted for in `estimatedAfterTokens` so reported numbers stay honest. Both downstream consumers — `src/server/routes/turns.ts` (DB-reload via `hydrate()`) and `src/ui/terminalRepl.ts` (uses `result.tail` directly) — receive the alternation-safe history without caller changes. `createClearedChildSession` in `src/agent/sessionRecovery.ts` was reviewed and has no symmetric hazard (it adds no messages). New regression test in `tests/compact/compactor.test.ts` ("persisted child history alternates user/assistant when tail starts with assistant") — confirmed RED before fix (consecutive `assistant` roles), GREEN after. Existing "does not split assistant tool_use / user tool_result pairs into the tail" test was updated to find the `tool_use` index dynamically (the synthetic user now sits before it) — the underlying alignment invariant is preserved. Pre-commit gate: 1937 pass / 0 fail. Token tax is small (~5 tokens) and only paid when the guard fires.
- Source: M6 pre-smoke critical review (2026-05-15) — Agent 3 cross-cutting findings, Q3
- Recommendation: `compactSession` (`src/compact/compactor.ts:113-116, 133-137`) persists the summary as `{role: 'assistant', content: [{type: 'text', text: HANDOFF_SUMMARY_NOTE + summary}]}`. The next turn's history is `[summary(assistant), ...tail, userMessage]`. Anthropic's API requires alternating user/assistant. If `tail[0]?.role === 'assistant'` (which `alignTailStart` at `compactor.ts:223` may produce when walking backward to keep tool_use/tool_result pairs intact), the request becomes `[assistant_summary, assistant_tail0, ...]` — two consecutive assistants → Anthropic 400 (`messages: roles must alternate`). OpenAI is lenient and accepts; Anthropic rejects. Mock provider in tests accepts anything → integration tests do not surface this.
- Recommended fix: in `compactSession`, after building the new child's `[summary, ...tail]` sequence, check `tail[0]?.role`. If `'assistant'`, either (a) prepend a synthetic minimal `user` message (e.g., `{role: 'user', content: [{type: 'text', text: '(continuing from summary)'}]}`) between summary and tail, OR (b) flip the summary's role to `'user'` so the sequence becomes `[user_summary, assistant_tail0, ...]` (still alternating, model still consumes the summary). Option (b) is one-line but changes the conversational framing slightly; option (a) preserves framing.
- Evidence: `src/providers/anthropic.ts:84-91` — the SDK throws on the next stream call. `BadRequestError` with `error.message` containing `roles must alternate` would surface as `Terminal{reason:'error', error}` — NOT caught by `isContextOverflowError` (so no recovery), surfaced to user as `turn_error` with the verbatim Anthropic message.
- Impact: **Real-world bug** for any non-trivial session smoked against Anthropic. The user's basic smoke ("hello + /compact + how are you") happens to land in the safe regime (tail = `[user, assistant]` so summary-prepend yields `[assistant_summary, user, assistant]` which is valid). But longer conversations where the tail boundary lands on an assistant message will 400.
- Likely code areas:
  - `src/compact/compactor.ts` (around line 145, after the lineage-recording write)
  - `src/agent/sessionRecovery.ts:20` (`createClearedChildSession` — verify symmetric handling if the tail-cap happens there)
- Effort: ~1 hr — fix + a Bun unit test that constructs a parent history whose tail starts with `assistant`, runs `compactSession`, and asserts the new child's persisted history alternates correctly.

### 35. `isContextOverflowError` substring matcher unverified against real provider error shapes

- Priority: **P2**
- Status: **complete (2026-05-15, commit `1212a42`)** — Probed real Anthropic SDK with a 330K-token user message against `claude-haiku-4-5-20251001`. Caught `BadRequestError` (status=400, type=`invalid_request_error`) with `err.message` of the form `'400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 200039 tokens > 200000 maximum"},...}'`. The existing `'prompt is too long'` substring catches it; no matcher extension was needed. JSDoc on `isContextOverflowError` now documents the verified shape. New `tests/providers/errors.test.ts` pins the real Anthropic shape + the OpenAI-style + the synthetic fixture against the matcher (12 cases total). M6 T4's overflow-recovery branch is provably wired against the live Anthropic format — Scenario 3 smoke can proceed with confidence. Note: Anthropic uses status **400** for overflows, not 413, so the `ProviderHttpError && status === 413` shortcut is irrelevant for Anthropic but kept for OpenAI-compatible providers. OpenAI + Ollama probes deferred until those scenarios become smoke priorities (the substring list already covers their published shapes plausibly).
- Source: M6 pre-smoke critical review (2026-05-15) — Agent 1 server-flow findings, Q8
- Recommendation: `src/providers/errors.ts:81-92` matches context-overflow via substring scan on `err.message` (`'context length'`, `'context window'`, `'maximum context'`, `'context_length_exceeded'`, `'prompt is too long'`) plus a `ProviderHttpError && status === 413` shortcut. T4's tests use `tests/helpers/transportWrappers.ts:107` which throws `new Error('context length exceeded by 12000 tokens')` — synthetic shape, not the actual provider error format. The matcher is plausible against Anthropic's `BadRequestError` (which formats `error.message` to include the body, typically containing "prompt is too long: N tokens > 200000 maximum") and OpenAI's `ProviderHttpError` body (typically contains both "context length" and "context_length_exceeded"), but **has never been verified in production code in this repo**. If the matcher misses, T4's overflow-recovery never fires; the user sees `turn_error` instead of `─ auto-compacted` and reasonably concludes recovery is broken.
- Recommended fix: write a one-shot probe test (gated behind `INTEGRATION_REAL_PROVIDER=1` env or similar — not part of the default suite) that fires a single deliberate overflow against real Anthropic + real OpenAI + real Ollama, captures the thrown error, asserts `isContextOverflowError(err)` returns true. Document the verified error shapes in a code comment on `isContextOverflowError`. If any provider's shape doesn't match, extend the substring list. Pair with M6 Scenario 3 manual smoke pre-flight.
- Evidence: `src/providers/errors.ts:81-92` (the matcher); `tests/helpers/transportWrappers.ts:107` (the synthetic test fixture); `src/providers/anthropic.ts:84-91` (where the throw happens); `src/providers/openai.ts:136-143` (OpenAI's throw).
- Impact: **Latent bug for Scenario 3 manual smoke.** Could waste real-API tokens on a smoke that misses recovery silently. Also affects auto-recovery for any user hitting overflow in production.
- Likely code areas:
  - `src/providers/errors.ts` (matcher)
  - `tests/integration/` (new probe test file — likely needs new directory)
- Effort: ~1.5 hrs — probe + each-provider verification + matcher extension if needed + JSDoc on `isContextOverflowError`.

### 36. `estimatedAfterTokens > estimatedBeforeTokens` cosmetic on small sessions

- Priority: P3
- Status: **complete (2026-05-15)** — Option (a) shipped: explicit early-return guard in `compactSession` returns a no-op result (`parentSessionId === newSessionId`, `noOp: true`) when `head.length === 0`. All three callers (proactive + recovery in turns route, /compact route, terminalRepl `compactNow`) key off `result.noOp` to skip the SSE event, the session-id pivot, and the misleading visual marker. The TUI's `compactCompleteMsg` handler renders "─ nothing to compact (history already fits)" instead of "─ compacted — new session <prefix>" on the no-op shape. Existing tests that constructed tiny histories were updated to seed 6 filler messages so they exercise the happy path. New unit + integration tests pin the no-op contract end-to-end (TS + Go). Full TS suite: 1938 pass / 0 fail / 4827 expects.
- Source: M6 pre-smoke critical review (2026-05-15) — Agents 1+3, Q1
- Recommendation: `compactSession` (`src/compact/compactor.ts:105-106, 154-157`) computes `estimatedBefore = systemPromptTokens + estimateMessagesTokens(history)` and `estimatedAfter = systemPromptTokens + summaryMessage + tail`. For a small history (say 2 messages) where `selectTailStart` returns 0 (full history fits in tail budget), `tail = entireHistory`, and `after = before + summaryMessageTokens` — strictly larger by ~70 tokens. Verified empirically by autonomous smoke: 2-message session reported `before=2247, after=2318`. The TUI's transcript marker renders `─ auto-compacted — 2247→2318 tokens — ...` which looks like compaction is broken even though the algorithm is correct (no head to summarize, so the operation is a no-op-plus-summary-message-overhead).
- Recommended fix options:
  - (a) **Early-return guard in `compactSession`**: when `head.length === 0`, skip compaction entirely and return a result indicating "nothing to compact" — caller (proactive / recovery / `/compact` route) decides whether to surface this as a no-op or treat it as success-with-nothing-changed.
  - (b) **Friendlier marker text**: TUI renders `─ compacted (already minimal — 0 messages summarized)` when `before <= after`. Server side stays unchanged.
  - (c) **Both**: guard server-side AND improve TUI marker for the case where compaction was meaningful but the delta is tiny.
- Evidence: `src/compact/compactor.ts:91-170` (the calculation); autonomous smoke output from 2026-05-15 (saved in `docs/testing-log.md` 2026-05-15 entry); `packages/tui/internal/app/app.go:407-432` (the marker rendering).
- Impact: **Cosmetic but credibility-impacting** for the user's first M6 smoke against a fresh session. They'll see "after > before" and reasonably think compaction is broken. Doesn't affect the underlying mechanism (large sessions produce real reductions; verified by `compactor.test.ts` plus the math: 100-message session goes 154,400 → 3,159 tokens).
- Likely code areas:
  - `src/compact/compactor.ts` (early-return guard)
  - `packages/tui/internal/app/app.go` (marker text)
  - `src/server/compactor.ts` (passthrough — unchanged)
- Effort: ~30-45 min — server-side guard is the most defensive (also helps with #34 since skipping compaction skips the alternation-hazard message append) plus a unit test asserting the early-return shape.

### 37. `sov --version` should print the git SHA (not just the package.json `0.1.0`)

- Priority: P4
- Status: **complete (2026-05-15, commits `a89b03c` + `4bd849c`)** — Runtime resolution in `src/version.ts` (preferred over postinstall-write — fewer moving parts, no Bun-trust requirement). Two resolvers tried in order: (1) `<install-root>/.bun-tag` — canonical for `bun install -g git+ssh://...` (Bun writes the resolved 40-char SHA there and does NOT ship `.git/`); (2) `git rev-parse --short HEAD` — fallback for dev `bun link` / working-tree mode. Bare semver final fallback if neither artifact present. TDD with three tests in `tests/version.test.ts`: format-regex (`/^\d+\.\d+\.\d+(-[a-f0-9]{7,})?$/`), package.json prefix, and a git-checkout SHA equality assertion (the last was RED before implementation, GREEN after). Initial implementation only used git rev-parse; post-`sov upgrade` smoke at commit `a89b03c` revealed `sov --version` still printed bare `0.1.0` because the global install has no `.git/` directory — fixed in `4bd849c` by adding the `.bun-tag` resolver. Empirical post-upgrade: `sov --version` prints `0.1.0-4bd849c`; `git rev-parse --short HEAD` matches; `bun src/main.ts --version` also surfaces the same suffix. `/health` route and any future VERSION-consuming surface picks up the SHA transparently. Full TS suite: 1940 → 1943 pass / 0 fail (+3 tests).
- Source: M6 manual smoke pre-flight (2026-05-15) — user noticed `sov --version` prints `0.1.0` with no commit SHA after `sov upgrade`. Currently the only way to confirm which commit the global binary is pinned to is `bun pm ls -g 2>&1 | grep sov` (which shows the git ref). Worth surfacing in `--version` output for the manual-smoke pre-flight ritual ("did my upgrade actually take?").
- Recommendation: `src/main.ts` Commander `.version(...)` call currently passes the static `package.json` version. Change to: read the install SHA at build/install time (a postinstall script can write a `version.ts` with the resolved SHA) OR shell out to `git rev-parse HEAD --short` if the binary lives inside a git checkout (it does, post-`sov upgrade` — `~/.bun/install/global/node_modules/@yevgetman/sov/`). Easier path: write the SHA into `package.json`'s `version` field via the postinstall script (e.g., `0.1.0-3365fb3`).
- Evidence: User feedback during M6 smoke session (2026-05-15). `bun pm ls -g 2>&1 | grep sov` already exposes the git ref; just lift it into `--version`.
- Impact: Pre-flight ergonomics for any future manual smoke or "did upgrade work?" debug session. Removes a small but real source of confusion ("which version am I running?").
- Likely code areas:
  - `src/main.ts` (the `.version(...)` Commander call)
  - `package.json` postinstall script
  - Possibly: `bin/sov` shim
- Effort: ~30 min if going the postinstall-write-version route; ~10 min if just shelling out to `bun pm ls -g`.

---

## Items discovered during Phase 16.1 M7 reviews (2026-05-15)

Two follow-ups surfaced during the M7 Hermes-layer parity work. Neither blocked M7 acceptance — the six-subsystem wiring landed end-to-end (1965/1965 tests green; integration smoke at `tests/server/m7Full.test.ts`). Each is a small downstream parity / mirror gap to land alongside the consumer that will exercise it.

### 38. `reviewAutoPromoteMemory` / `reviewAutoPromoteSkills` snapshot gap in `parentToolContext`

- Priority: P3
- Status: open
- Source: Phase 16.1 M7 T6 code-quality review (carry-forward, 2026-05-15)
- Recommendation: `src/server/sessionContext.ts:168-177` builds a minimal `parentToolContext` snapshot for `ReviewManager` covering `cwd`, `sessionId`, `harnessHome`, `agents`, `subagentScheduler`, `taskManager`, `parentToolPool`. The snapshot omits `reviewAutoPromoteMemory` and `reviewAutoPromoteSkills` — two booleans that `MemoryProposeTool` (`src/tools/MemoryProposeTool.ts:54`) and `SkillProposeTool` (`src/tools/SkillProposeTool.ts:105`) read off `ctx` to decide whether to skip the review queue and promote the proposal immediately. A user who sets `review.autoPromoteMemory: true` in their config will find the flag silently inert when proposals dispatch from review-fork sub-agents because the parent's `ToolContext` snapshot doesn't carry it. Server-mode `buildSessionToolContext` (`src/server/routes/turns.ts:139-158`) also doesn't thread these two booleans, so the same gap exists at the turn-time ToolContext shape — not just the review-fork snapshot. Wire both through, reading from `userSettings.review?.autoPromoteMemory` / `userSettings.review?.autoPromoteSkills` at the same `readConfig()` call `buildSessionContext` already makes.
- Evidence: file paths above; `MemoryProposeTool` reads `ctx.reviewAutoPromoteMemory`; `buildSessionContext` and `buildSessionToolContext` neither set the field. Same parity-gap shape as item #28 (also pre-T2): plumbing for a feature the user thinks they configured.
- Impact: A user configuring `review.autoPromoteMemory` or `review.autoPromoteSkills` to `true` in server mode sees no behavioral change — proposals still queue. The pre-T6 review-fork dispatch path never exercised these, so this gap is technically pre-existing, but T6 made the surface area explicit.
- Likely code areas:
  - `src/server/sessionContext.ts:168-177` (the `parentToolContext` snapshot)
  - `src/server/routes/turns.ts:139-158` (per-turn `buildSessionToolContext`)
  - `src/tools/MemoryProposeTool.ts:54` (read site)
  - `src/tools/SkillProposeTool.ts:105` (read site)
- Effort: ~30 min — two two-line edits + a regression test asserting auto-promotion fires when the flag is set in user settings.

### 39. Go TUI mirror struct for `SessionSummaryEvent` not added

- Priority: P4
- Status: open
- Source: Phase 16.1 M7 T6 code-quality review (carry-forward, 2026-05-15)
- Recommendation: M6's `CompactionCompleteEvent` got a corresponding Go struct at `packages/tui/internal/transport/types.go:144` so the TUI can deserialize the SSE wire event. M7 T6's `SessionSummaryEvent` (`src/server/schema.ts:114-118`) was added to the TS-side Zod discriminated union but no Go mirror was added — `--ui tui` won't deserialize the event when M9 visual polish wires the goodbye card. Add a `SessionSummaryEvent` struct (`Type`, `Seq`, `SessionID`, `TotalDispatched`, `ByAgent map[string]int`) to `types.go` matching the JSON shape, plus a `DecodeSessionSummary` helper alongside `DecodeCompactionComplete`.
- Evidence: `packages/tui/internal/transport/types.go` (CompactionCompleteEvent precedent); `src/server/schema.ts:114-118` (TS-side SessionSummaryEvent shape).
- Impact: M7 alone — the event is emitted but no Go consumer exists yet, so the gap is dormant. Becomes a real visible bug when M9 wires the styled goodbye card and the TUI fails to decode the event at session disposal.
- Likely code areas:
  - `packages/tui/internal/transport/types.go` (mirror struct + decode helper)
  - Tests in `packages/tui/internal/transport/` (decode round-trip)
  - Future M9 polish work in `packages/tui/internal/app/app.go` (render path)
- Effort: ~30 min — straightforward mirror + decode test; pairs naturally with M9 styled-goodbye-card work.

---

## How to use this document

Pick any item by priority + effort match for your session length:
- 10-min slot: item 29 (lipgloss `Style.Copy()` deprecation — single-line edit) or item 37 (sov --version SHA — small ergonomics)
- 30-min slot: item 32 (resume-after-compaction regression test) or item 30 (only if router server-mode is on the near roadmap)
- 1-2 hr slot: item 28 (DaemonEventBus wiring)
- Half-day slot: (none currently open)
- Multi-day: item 17

Cross off completed items by changing `Status: open` → `Status: complete (YYYY-MM-DD)` and recording the commit SHA in a brief follow-up paragraph.

When finishing the document (everything closed), move it to `docs/archive/` rather than deleting — the rationale + evidence have ongoing value.

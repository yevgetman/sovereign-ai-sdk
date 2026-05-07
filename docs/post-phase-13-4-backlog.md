# Post-Phase-13.4 Backlog

This document is the record of truth for items not part of the canonical build plan that have surfaced as v0 limits, deferred polish, or architectural extensions during the Phase 13.3 + 13.4 work shipped on 2026-05-06. Future sessions can pick these up without re-deriving context.

These items are deliberately NOT in `~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md` — they are smaller follow-ups, polish, and known v0 trade-offs documented in commit messages, code comments, and the testing log. The build plan's next phase is Phase 13.5 (scheduled-mission sub-agents); these backlog items are orthogonal and can land between phases or as time permits.

**Last sync:** 2026-05-07. Master at `409fe9c`. Suite 1623/1623 unit + 58/58 semantic. Items 1, 2, 3, 4, 5, 6, 22, 23 closed in three batches (commits `f7c9c69`, `47993ec`, `d2e1e92`, then `d24efee`, `64e5eef`, `c6412ce`, then `7015b8c`, `409fe9c`). Items 18-24 added from 2026-05-07 ad-hoc 7-agent REPL soak (41/41 cases passed; cross-cutting findings added below).

## Priority order

P0 (correctness / data integrity):
1. ~~MEMORY.md cap enforcement on `/review approve`~~ **— closed `f7c9c69`**
2. ~~Auto-promote provenance preservation gap audit~~ **— closed `47993ec` (no real gap; C2 fix verified)**

P1 (UX / observability):
3. ~~`/review revoke <id>` undo path~~ **— closed `7015b8c`**
4. ~~Consolidation deletes original entries~~ **— closed `409fe9c` (post-deletion cap check + audit-trail success message)**
5. ~~Status mapping at observer site upgraded to 4-state~~ **— closed `64e5eef`**
6. ~~Better confidence ramp-up for cross-project promotion~~ **— closed `d24efee` (tunables exposed; defaults preserved pending soak data)**
19. MEMORY.md cross-pollinates unrelated projects (global memory, not project-scoped) **[soak 2026-05-07]**
22. ~~Mid-turn context pruning anomaly during long autonomous exploration~~ **[soak 2026-05-07] — closed `c6412ce` (real bug; current-turn boundary protection in microcompact)**
23. ~~FileRead throws instead of returning `{status: error}` envelope on missing file~~ **— closed `d2e1e92`**

P2 (architectural extensions):
7. Pick `review-memory` vs `review-skill` based on child shape (currently always `review-memory`)
8. Per-child trace files in addition to consolidated parent trace
9. `ReviewForkPromptContext` field rename (`trajectoryPath`/`tracePath` re-purposed for consolidation)
10. Synthesizer dispatch rhythm — currently user-turn only; activity-burst trigger missing
11. Concurrency between multiple `sov` sessions writing to same observations.jsonl

P3 (qwen-amendment deepenings — orthogonal to 13.x):
12. Microcompaction (Phase 10 deepening)
13. Shell AST analysis (Phase 7 deepening)
24. `maxToolCallsBeforeCheckin` knob for vague-prompt cost control **[soak 2026-05-07]**

P4 (small ergonomics + nits):
14. `_resetProjectIdCache` test helper exported from production code
15. `nameFromRemote` heuristic loses nested-namespace context
16. `cleanupPhantomReviews` runs only at session boot (long sessions accumulate)
17. Eval-gated auto-promote (currently auto-promote is straight bypass)
18. Glob inline tool block: count footer drifts vs. summary line **[soak 2026-05-07]**
20. `HARNESS_HOME=… printf | sov chat` env-prefix-pipeline footgun (docs) **[soak 2026-05-07]**
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

## Items discovered during 2026-05-07 ad-hoc REPL soak

Seven cross-cutting findings surfaced during a 7-agent parallel REPL soak that exercised tool surface, sub-agent runtime + tasks, slash commands, CLI subcommands, state persistence, Phase 13.4 instinct corpus, and error/edge/multi-turn cases. **All 41 test cases passed.** These items are gaps or polish concerns observed while running, not failures.

### 18. Glob inline tool block — count footer drifts vs. summary line

- Priority: P4
- Status: open
- Source: 2026-05-07 soak Agent A (tool surface battery), case A4 (Glob + Grep in temp project)
- Evidence: Glob's status envelope reported `summary: "1 file"` but the rendered inline footer in the REPL output said `"found 4 files"` for the same call. The actual filesystem state matched the summary (1 file by the specific pattern asked). The footer aggregates differently from the summary.
- Likely code areas:
  - `src/ui/` (inline tool block renderer — the footer aggregation logic that picks a count to display)
- Recommendation: Trace which renderer path emits the footer count vs. the summary line; reconcile to the same source value (probably `result.data.length` or the artifact array length).
- Impact: User-visible UI inconsistency; no correctness issue (status envelope is correct).
- Effort: ~30 min

### 19. MEMORY.md cross-pollinates unrelated projects

- Priority: P1
- Status: open (design discussion needed)
- Source: 2026-05-07 soak Agent A, cases A4 + A6
- Evidence: A fresh session running tests in `/tmp/sov-soak-A` had its commentary colored by content from `~/.harness/memory/MEMORY.md` describing an unrelated project (`resume-as-code` module tree). The agent referenced "the core resume-as-code module tree" while doing a generic Glob test that had nothing to do with that project. The memory file is loaded globally regardless of cwd / project_id.
- Question for design discussion: Is global memory the intended model, or should `MEMORY.md` be project-scoped (loaded only when cwd matches the originating project)? The auto-memory subsystem already has a project_id concept (Phase 13.4) — could we route project-scoped memory entries through a per-project path while keeping `USER.md` truly global?
- Likely code areas:
  - `src/memory/bounded.ts` (path resolution)
  - `src/memory/provider.ts` (load logic)
- Recommendation: Triage with the user. If project-scoped memory is desired, split MEMORY.md → `<harnessHome>/memory/MEMORY.md` (global) + `<harnessHome>/memory/projects/<projectId>/MEMORY.md` (per-project). Loader unions them at session start, with the project version taking precedence on conflict.
- Impact: Currently low-frequency leak (most users don't switch projects often), but for users working across multiple projects this is mildly confusing.
- Effort: Discussion + ~2-3 hrs implementation if pursued.

### 20. `HARNESS_HOME=… printf | sov chat` env-prefix-pipeline footgun

- Priority: P4
- Status: open
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
- Status: open (discussion)
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
- 30-min slot: items 10, 14, 15, 16, 18, 20
- 1-2 hr slot: items 1, 2, 4, 6, 8, 11, 22
- Half-day slot: items 3, 7, 9, 12, 13, 19, 24
- Multi-day: item 17

Cross off completed items by changing `Status: open` → `Status: complete (YYYY-MM-DD)` and recording the commit SHA in a brief follow-up paragraph.

When finishing the document (everything closed), move it to `docs/archive/` rather than deleting — the rationale + evidence have ongoing value.

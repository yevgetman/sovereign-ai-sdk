# Testing Log

Append to this log whenever harness testing is performed, including automated test runs, semantic checks, manual CLI checks, and REPL smoke sessions. Entries should capture enough detail for a future maintainer to understand what was exercised, what passed, what failed, and whether a finding was an expected limitation or a regression.

Use newest-first ordering.

## Entry Format

```markdown
## YYYY-MM-DD - Short Title

- Scope:
- Environment:
- Commands:
- Manual / REPL coverage:
- Result:
- Regressions / follow-ups:
```

## 2026-04-27 - Boundary REPL Harness Test

- Scope: Comprehensive boundary-pushing REPL test of the Phase-10 harness against the real Sovereign AI docs bundle, covering context references, tools, ask-mode permissions, slash commands, memory, skills, subdirectory hints, compaction, rollback, resume, persistence, and runtime artifacts.
- Environment:
  - Repo: `/Users/julie/code/sovereign-ai-harness`
  - Bundle: `/Users/julie/code/sovereign-ai-docs`
  - Working directory: `/tmp/sovereign-boundary-work.zGe6d2`
  - `HARNESS_HOME`: `/tmp/sovereign-boundary-home.CsORUr`
  - Session DB: `/tmp/sovereign-boundary-work.zGe6d2/sessions.db`
  - Provider/model: `anthropic / claude-sonnet-4-6`
  - Parent session: `fe56f15d-bab4-4f87-a144-ca5534e18914`
  - Compacted child session: `bed122a2-8140-4ace-b02f-6d1772902558`
- Commands:
  - `HARNESS_HOME=/tmp/sovereign-boundary-home.CsORUr bun /Users/julie/code/sovereign-ai-harness/src/main.ts chat --bundle /Users/julie/code/sovereign-ai-docs --db /tmp/sovereign-boundary-work.zGe6d2/sessions.db --permission-mode ask --no-cache`
  - `HARNESS_HOME=/tmp/sovereign-boundary-home.CsORUr bun /Users/julie/code/sovereign-ai-harness/src/main.ts chat --bundle /Users/julie/code/sovereign-ai-docs --db /tmp/sovereign-boundary-work.zGe6d2/sessions.db --resume fe56f15d-bab4-4f87-a144-ca5534e18914 --permission-mode ask --no-cache`
  - `sqlite3 /tmp/sovereign-boundary-work.zGe6d2/sessions.db "select ... from sessions; select ... from session_compactions; select session_id,count(*) from messages group by session_id;"`
  - `curl -fsS --max-time 2 http://127.0.0.1:11434/api/tags`
  - `bun run lint`
  - `bun run test`
  - `bun run typecheck`
- Manual / REPL coverage:
  - Verified basic provider streaming with `BOUNDARY_START_OK`.
  - Exercised `@file:notes/alpha.md`, `@file:notes/nested/beta.ts:1-20`, and `@folder:notes` with sentinel confirmations.
  - Tried `@file:./suspicious.md`; the prompt-injection-looking file was included in user-turn context and the model ignored the malicious instruction.
  - Exercised `FileWrite -> FileRead -> FileEdit -> Grep -> Glob` on `src/demo.ts`, ending with `BOUNDARY_TOOL_LOOP_OK`.
  - Exercised ask-mode permissions: allowed a `FileWrite`, answered `always` for a narrow `FileEdit`, allowed read-only `pwd && ls`, and denied `printf SHOULD_NOT_WRITE > denied.txt`.
  - Verified `denied.txt` was absent and `.harness/settings.local.json` persisted only `FileEdit(/private/tmp/sovereign-boundary-work.zGe6d2/src/demo.ts)`.
  - Exercised `/help`, `/cost`, `/model`, and prompt-backed `/commit`; `/commit` was blocked by scoped tool permissions because the generated `cd ... && git status` command fell outside the allowed git scope.
  - Exercised `memory` `view` and `replace`; confirmed `$HARNESS_HOME/memory/USER.md` contained the boundary preference and the next turn produced `BOUNDARY_MEMORY_RECALL_OK`.
  - Loaded a project-local skill, discovered it via `skills_list`, inspected it via `skill_view`, read its reference file, and invoked `/boundary-check BOUNDARY_SKILL_OK`.
  - Exercised subdirectory hint loading by reading `notes/nested/beta.ts`; the appended hint included `BOUNDARY_HINT_OK`.
  - Ran `/compact`; child session `bed122a2-8140-4ace-b02f-6d1772902558` was created with separate compaction cost lanes and Anthropic Haiku auxiliary summarization.
  - Verified child continuity with `BOUNDARY_CHILD_OK`, then `/rollback` restored the parent with 56 messages and `BOUNDARY_ROLLBACK_OK`.
  - Exited and resumed the parent session; the resumed session produced `BOUNDARY_RESUME_OK` and recalled prior sentinels.
  - Queried SQLite to confirm parent/child rows, lineage, and message counts: parent 60 messages, child 29 messages.
  - Checked provider availability; only `ANTHROPIC_API_KEY` was configured in `.env`, and local Ollama was unavailable on `127.0.0.1:11434`, so no cross-provider REPL probe was run.
- Result:
  - Passed. The Phase-10 CLI harness stayed coherent through a long real REPL workflow with tools, permissions, memory, skills, compaction, rollback, resume, and persistence.
  - Passed. `bun run lint` checked 99 files with no fixes applied.
  - Passed. `bun run test` reported 232 passing tests, 0 failures, and 600 assertions across 37 files.
  - Passed. `bun run typecheck`.
- Regressions / follow-ups:
  - `@file:./suspicious.md` content was included even though it contained obvious prompt-injection text. The model did not follow the malicious instruction, but context-reference expansion may need the same suspicious-content screening/fencing guarantee expected from local context files.
  - In `--permission-mode ask`, the read-only Bash command `pwd && ls` still prompted, which is safe but friction-heavy. The model later described it as "no prompt needed"; the observed behavior is the source of truth.
  - `/commit` generated `cd /tmp/... && git status`, which was denied by the scoped command rules. That confirms scope enforcement, but the prompt command may need to avoid `cd` or the scope may need a safe cwd-aware git-status pattern if `/commit` should work from arbitrary cwd values.
  - Manual `/compact` on this not-yet-large session compacted 0 messages and increased estimated tokens from 14100 to 14312 because the preserved tail plus handoff overhead exceeded pruned content. Behavior and lineage were correct; this is a useful UX/data point for Phase 10.5.
  - No cross-provider run was performed because OpenAI/OpenRouter credentials were absent and Ollama was not running.

## 2026-04-27 - Agent Boot Path Refresh

- Scope: Documentation-only maintenance for `AGENTS.md` and `CLAUDE.md` boot paths, replacing stale Desktop/root planning-doc paths with the current docs-repo locations.
- Environment:
  - Repo: `/Users/julie/code/sovereign-ai-harness`
  - Runtime: Bun 1.3.13
- Commands:
  - `bun run lint`
  - `bun run test`
- Manual / REPL coverage:
  - None. This changed agent-session instructions only.
- Result:
  - Passed. `bun run lint` checked 99 files with no fixes applied.
  - Passed. `bun run test` reported 232 passing tests, 0 failures, and 600 assertions across 37 files.
- Regressions / follow-ups:
  - No regressions found.
  - No live REPL smoke was run because no runtime behavior changed.

## 2026-04-27 - Runtime Plan Resequencing Docs

- Scope: Runtime-local documentation alignment with `sovereign-ai-docs` `harness-build-plan@5` and the maturity-first remaining build order.
- Environment:
  - Repo: `/Users/julie/code/sovereign-ai-harness`
  - Runtime: Bun 1.3.13
- Commands:
  - `bun run lint`
  - `bun run test`
- Manual / REPL coverage:
  - None. This was a documentation-only change to README orientation and runtime-local decisions.
- Result:
  - Passed. `bun run lint` checked 99 files with no fixes applied.
  - Passed. `bun run test` reported 232 passing tests, 0 failures, and 600 assertions across 37 files.
- Regressions / follow-ups:
  - No regressions found.
  - No live REPL smoke was run because no runtime behavior changed.

## 2026-04-26 - Testing Log Documentation Validation

- Scope: Commit validation for adding the harness testing log and the standing logging directive in agent instructions.
- Environment:
  - Repo: `/Users/julie/code/sovereign-ai-harness`
  - Runtime: Bun 1.3.13
- Commands:
  - `bun run lint`
  - `bun run test`
- Manual / REPL coverage:
  - None. This was a documentation-only change; the automated gates were run to satisfy the repo's commit discipline.
- Result:
  - Passed. `bun run lint` checked 99 files with no fixes applied.
  - Passed. `bun run test` reported 232 passing tests, 0 failures, and 600 assertions across 37 files.
- Regressions / follow-ups:
  - No regressions found.

## 2026-04-26 - Holistic REPL Smoke Test After Phase 10

- Scope: End-to-end harness runtime smoke test against the Sovereign AI docs bundle, including automated gates, interactive REPL behavior, tool execution, slash commands, compaction, rollback, and session persistence.
- Environment:
  - Repo: `/Users/julie/code/sovereign-ai-harness`
  - Bundle: `/Users/julie/code/sovereign-ai-docs`
  - Working directory: `/tmp/sovereign-holistic-smoke.oCpqnE`
  - `HARNESS_HOME`: `/tmp/sovereign-harness-home.ac2ybp`
  - Session DB: `/tmp/sovereign-holistic-smoke.oCpqnE/sessions.db`
  - Provider/model: `anthropic / claude-sonnet-4-6`
  - Session: `88a5de8d-32fe-43b6-8ae8-364b8c3f416d`
  - Compacted child session: `9049349a-8165-4aa5-b3cf-e2b4d5ab0ae4`
- Commands:
  - `HARNESS_HOME=/tmp/sovereign-harness-home.ac2ybp bun /Users/julie/code/sovereign-ai-harness/src/main.ts chat --bundle /Users/julie/code/sovereign-ai-docs --db /tmp/sovereign-holistic-smoke.oCpqnE/sessions.db --permission-mode ask --no-cache`
  - `bun run lint`
  - `bun run test`
  - `bun run typecheck`
- Manual / REPL coverage:
  - Verified basic provider streaming with an exact sentinel response: `SMOKE_BASIC_OK`.
  - Verified `@file:` context expansion with `seed.txt`.
  - Verified `@folder:` context expansion with `@folder:./subdir` and sentinel response `SMOKE_FOLDER_OK`.
  - Exercised `FileWrite` and `FileRead` behind `ask` permission prompts by creating and reading `smoke_out.txt` with sentinel content `SMOKE_TOOL_OK`.
  - Exercised `Bash` with an interactive permission prompt using `pwd && ls`.
  - Exercised search/listing behavior via `Glob` and confirmed `smoke_out.txt`.
  - Exercised the `memory` tool with `{"action":"view"}`.
  - Exercised `skills_list`.
  - Exercised `/cost`, `/help`, `/compact`, and `/rollback`.
  - Verified post-rollback conversation continuity with sentinel response `SMOKE_ROLLBACK_OK`.
  - Queried SQLite directly to confirm persisted parent/child sessions, message counts, compaction usage lanes, and lineage.
- Result:
  - Passed. REPL startup, model turns, tool execution, permission prompts, slash commands, compaction, rollback, and persistence all worked.
  - `bun run lint` passed.
  - `bun run test` passed with 232 passing tests and 0 failures.
  - `bun run typecheck` passed.
- Regressions / follow-ups:
  - No regressions found.
  - `@folder:subdir,` treated the comma as part of the path and failed. Retesting with `@folder:./subdir` worked. Treat as syntax sensitivity unless later UX requirements call for punctuation-tolerant parsing.
  - `/compact` on this short session increased the estimated token count slightly because handoff overhead exceeded pruned content. Command behavior and lineage were correct.

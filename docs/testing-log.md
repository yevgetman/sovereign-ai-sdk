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

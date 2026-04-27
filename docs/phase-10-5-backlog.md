# Phase 10.5 Backlog

This document is the record of truth for fixes discovered during the Phase-10
soak tests on 2026-04-27. It turns the testing-log findings into implementation
backlog items. Keep this file current until the items are closed or moved into
a more formal issue tracker.

Source tests:

- `docs/testing-log-2026-04-27.md` — Boundary REPL Harness Test
- `docs/testing-log-2026-04-27.md` — Real-World Website Build Harness Test

## Priority Order

1. Repair interrupted tool-use persistence.
2. Serialize interactive permission prompts.
3. Make `/clear` repair or bypass malformed persisted state.
4. Improve `max_tokens` recovery and large-edit behavior.
5. Normalize `~` paths in filesystem tools.
6. Add cheap completion validation guidance for code/web artifacts.
7. Reduce ask-mode friction for obviously read-only calls, if desired.
8. Convert the website run into a repeatable eval.
9. Screen/fence `@file` context-reference content for prompt injection.
10. Improve `/commit` scoped Bash behavior from arbitrary cwd values.

## 1. Interrupted Tool-Use Persistence Can Corrupt Sessions

- Priority: P0
- Status: open
- Evidence: In the website test, an inspection turn launched three concurrent
  Bash reads. After overlapping permission prompts stalled the REPL, Ctrl-C
  interrupted the turn. The assistant `tool_use` blocks were persisted without
  matching next-message `tool_result` blocks. Anthropic rejected every later
  provider request with:

  ```text
  messages.N: `tool_use` ids were found without `tool_result` blocks immediately after
  ```

- Impact: One interrupted turn can make a session unrecoverable on resume.
- Likely code areas:
  - `src/core/query.ts`
  - `src/core/orchestrator.ts`
  - `src/ui/terminalRepl.ts`
  - `src/agent/sessionDb.ts`
- Desired behavior: persisted transcripts must always satisfy provider message
  invariants, including after user interrupt, permission abort, provider error,
  or tool execution error.
- Implementation notes:
  - Prefer guaranteeing that every assistant message with `tool_use` blocks is
    followed by a user message containing one `tool_result` per tool id, even
    when the turn is interrupted.
  - Options:
    - Synthesize `tool_result` blocks with `is_error: true` and content like
      `tool call interrupted before execution` for all unresolved tool ids.
    - Or change persistence so assistant tool-use messages are saved only
      atomically with their matching tool-result user message.
  - Be careful not to lose already-completed tool results if only part of a
    tool batch was interrupted.
- Acceptance criteria:
  - Interrupting during permission prompts or tool execution leaves a valid
    transcript.
  - Resuming the interrupted session does not produce a provider 400.
  - The model can continue after seeing error tool results for interrupted
    calls.
- Test ideas:
  - Unit/integration test for `query()` where provider emits assistant
    `tool_use`, permission prompt/tool execution is aborted, and the yielded or
    persisted messages include matching error `tool_result` blocks.
  - REPL smoke: trigger multiple tool calls, interrupt at permission prompt,
    resume, and ask a normal follow-up.

## 2. Concurrent Permission Prompts Can Overlap And Stall The REPL

- Priority: P0
- Status: open
- Evidence: In the website test, three concurrent Bash reads caused three
  permission prompts to print at once. After answering, the REPL stopped making
  progress until Ctrl-C.
- Impact: Ask-mode can deadlock or create confusing prompt UX when concurrent
  tool batches require human decisions.
- Likely code areas:
  - `src/core/orchestrator.ts`
  - `src/permissions/prompt.ts`
  - `src/permissions/canUseTool.ts`
- Desired behavior: only one interactive permission prompt should be active at
  a time.
- Implementation notes:
  - Run permission checks serially before concurrent execution, then execute
    allowed calls in parallel.
  - Or wrap the readline asker in a mutex so concurrent calls queue prompts.
  - Preserve concurrency for the actual read-only calls after permissions are
    resolved.
- Acceptance criteria:
  - A batch of concurrent tool calls that all require prompts displays prompts
    one by one.
  - Answering all prompts lets the batch complete without manual interruption.
  - Denying one call does not block allowed calls from producing results.
- Test ideas:
  - Orchestrator test with three concurrency-safe tools and an async asker that
    records prompt ordering.
  - REPL smoke with three Bash/FileRead calls under `--permission-mode ask`.

## 3. `/clear` Does Not Repair Persisted Malformed History

- Priority: P1
- Status: open
- Evidence: `/clear` recovered the live REPL after the malformed tool-use
  transcript, but resuming the same session reloaded the invalid persisted
  history and produced the same Anthropic 400 until `/clear` was run again.
- Impact: `/clear` is only an in-memory escape hatch; it does not make a broken
  persisted session safe to resume.
- Likely code areas:
  - `src/ui/terminalRepl.ts`
  - `src/agent/sessionDb.ts`
  - `src/commands/registry.ts`
- Desired behavior: the user has a durable recovery path from malformed or
  unwanted history.
- Implementation notes:
  - First fix item 1 so new corrupt sessions are not created.
  - Then decide whether `/clear` should:
    - create a new child session with the same frozen system prompt and empty
      history,
    - mark older messages ignored,
    - or insert repair tool results for orphaned tool-use blocks.
  - A separate `/repair` command may be cleaner if `/clear` should remain
    local-only.
- Acceptance criteria:
  - After `/clear` or `/repair`, quitting and resuming does not reload invalid
    provider history.
  - The original raw transcript remains available for debugging or lineage if
    practical.
- Test ideas:
  - Seed a DB with orphaned tool-use history, run repair, and assert loaded
    messages are provider-valid.
  - REPL smoke: corrupt, recover, quit, resume, continue.

## 4. Default `maxTokens` Is Too Low For Real Coding/Web Work

- Priority: P1
- Status: open
- Evidence: The website test repeatedly hit `max_tokens` while the model was
  drafting a large CSS rewrite. It often emitted no tool call before stopping.
  Resuming the same session with `--max-tokens 12000` allowed the workflow to
  proceed.
- Impact: realistic front-end edits can stall or waste expensive turns.
- Likely code areas:
  - `src/main.ts`
  - `src/ui/terminalRepl.ts`
  - `src/core/query.ts`
  - `src/providers/*`
  - `src/context/systemPrompt.ts`
- Desired behavior: hitting `max_tokens` should be obvious and recoverable, and
  the model should avoid huge chat-visible drafts when a tool write is needed.
- Implementation notes:
  - Consider raising the CLI default max tokens for coding sessions.
  - If the provider stops with `max_tokens`, surface a warning with next-step
    guidance.
  - Add prompt guidance to prefer direct tool writes or smaller `FileEdit`
    patches over printing full replacement files in assistant text.
  - Consider an automatic continuation only if the transcript remains valid and
    cost behavior is transparent.
- Acceptance criteria:
  - When `message_stop` is `max_tokens`, the REPL tells the user clearly.
  - Large-file editing prompts are more likely to produce tool calls than
    chat-visible code dumps.
  - A real website/CSS iteration can complete without manual max-token tuning,
    or the tuning path is obvious.
- Test ideas:
  - Provider fixture with `stop_reason: max_tokens` and assertion that the REPL
    surfaces the reason.
  - Repeat the website-style CSS rewrite eval with default settings.

## 5. Filesystem Tools Do Not Normalize `~` Paths

- Priority: P2
- Status: open
- Evidence: The harness initially tried `FileWrite` with
  `~/code/harness-website-test-2026-04-27/index.html`, got a tool error, then
  recovered by writing relative paths.
- Impact: models and users naturally use `~`; failing it creates unnecessary
  retries and permission prompts.
- Likely code areas:
  - `src/tools/FileReadTool.ts`
  - `src/tools/FileWriteTool.ts`
  - `src/tools/FileEditTool.ts`
  - `src/tools/GrepTool.ts`
  - `src/tools/GlobTool.ts`
  - `src/tools/permissionMatchers.ts`
- Desired behavior: leading `~` expands to the current user's home directory
  before path validation, permission matching, and filesystem access.
- Acceptance criteria:
  - `FileRead("~/some/file")` and equivalent absolute path behave the same.
  - Permission rules still match deterministically after normalization.
  - Sensitive-path blocking still applies after expansion.
- Test ideas:
  - Focused tool tests for `~`, `~/...`, and non-leading `~` literals.
  - Permission matcher tests for normalized home paths.

## 6. Add Cheap Completion Validation For Code/Web Artifacts

- Priority: P2
- Status: open
- Evidence: The harness claimed the website was ready before running
  `node --check estimator.js`. External validation found a syntax error caused
  by unescaped apostrophes inside single-quoted strings. After receiving the
  validator error, the harness fixed it.
- Impact: the agent can declare success before doing inexpensive local checks.
- Likely code areas:
  - `src/context/systemPrompt.ts`
  - maybe future eval/skill guidance rather than hard-coded runtime logic
- Desired behavior: when creating or editing code-like artifacts, the model
  should run cheap available validators before finalizing.
- Implementation notes:
  - Keep this generic and tool-driven, not product-specific.
  - Guidance examples:
    - JS: `node --check file.js` when Node is available.
    - TS/Bun repo: `bun run typecheck` or targeted test when appropriate.
    - Static site: run a local server or at least check referenced files.
  - Avoid forcing validators when no relevant tool/runtime is present.
- Acceptance criteria:
  - Website-style tasks include a syntax/reference check before final answer.
  - The model reports if it cannot run a validator.
- Test ideas:
  - Real-world website eval asserts `node --check` appears before final claim
    when JS is created.

## 7. Ask-Mode Read-Only Friction

- Priority: P3
- Status: open
- Evidence: `pwd && ls` prompted under `--permission-mode ask`. This is safe,
  but noisy. The model later described it as if no prompt had been needed; the
  observed behavior is the source of truth.
- Impact: high prompt friction encourages autopilot approvals.
- Likely code areas:
  - `src/permissions/canUseTool.ts`
  - `src/tools/BashTool.ts`
  - `src/config/settings.ts`
- Decision needed: should `ask` mean every tool invocation asks, or should
  read-only/concurrency-safe calls skip prompts unless rules force `ask`?
- Acceptance criteria if changed:
  - Read-only calls allowed by tool self-check can run without prompting in
    default/ask mode unless an explicit ask/deny rule applies.
  - Mutating or unknown-safety calls still prompt.
- Test ideas:
  - Permission tests for read-only Bash allowlist under ask mode.
  - Regression test that explicit `ask` rules still force prompting.

## 8. Convert Website Build Into A Repeatable Eval

- Priority: P2
- Status: open
- Evidence: The website test found several issues not covered by unit tests:
  default token limits, malformed interrupt persistence, missing JS validation,
  path normalization, and ask-mode friction.
- Impact: without a repeatable eval, regressions in end-to-end agent behavior
  will remain manual and expensive to rediscover.
- Likely landing area:
  - future `src/evals/` or `tests/evals/` per Phase 10.5
- Desired behavior: a scripted or semi-scripted eval can replay the imperfect
  prompt sequence and run deterministic artifact checks.
- Acceptance criteria:
  - Eval creates a disposable website workspace.
  - Eval prompts the harness or a harness test double through the rough user
    sequence.
  - Eval checks files exist, JS parses, local server returns 200, references are
    valid, and late rename is complete.
  - Eval records cost/token/session metadata.
- Test ideas:
  - Start with a manual checklist codified as a script that validates the
    artifact after a human-driven run.
  - Later add provider fixture or local model mode for repeatability.

## 9. `@file` Context References Need Injection Screening/Fencing

- Priority: P2
- Status: open
- Evidence: Boundary REPL test loaded `@file:./suspicious.md` containing obvious
  prompt-injection language. The content was included in user-turn context. The
  model ignored it, but context-reference expansion did not appear to block or
  clearly fence it the same way local context files are screened.
- Impact: explicit file references can carry malicious instructions into the
  turn.
- Likely code areas:
  - `src/context/references.ts`
  - `src/context/injectionDefense.ts`
- Desired behavior: context-reference file contents should be labeled, fenced,
  bounded, and screened consistently with other external/local context surfaces.
- Acceptance criteria:
  - Suspicious `@file` content is blocked or clearly marked as untrusted data.
  - Existing line-range and folder reference behavior remains intact.
- Test ideas:
  - Add tests for suspicious `@file` body, invisible Unicode, and oversized
    referenced files.

## 10. `/commit` Prompt Scope Is Too Brittle Around `cd`

- Priority: P3
- Status: open
- Evidence: Boundary REPL test ran `/commit dry run...`; the prompt command
  generated `cd /tmp/... && git status`, which was denied because scoped Bash
  rules allowed `git status` but not `cd ... && git status`.
- Impact: scope enforcement worked, but `/commit` may fail in normal use if the
  model includes cwd setup in the command.
- Likely code areas:
  - `src/commands/registry.ts`
  - `src/commands/toolScope.ts`
  - `src/tools/BashTool.ts`
- Desired behavior: `/commit` remains narrowly scoped but works from arbitrary
  cwd values without encouraging broad shell allowances.
- Implementation options:
  - Strengthen the `/commit` prompt to say commands already run from the repo
    cwd and must not include `cd`.
  - Add a scoped safe pattern for `cd <cwd> && git ...` only if the path equals
    the active cwd.
  - Prefer prompt tightening first; pattern expansion can become subtle.
- Acceptance criteria:
  - `/commit` can run `git status`, `git diff`, `git add`, and `git commit`
    from the current cwd.
  - It still denies arbitrary shell commands and arbitrary `cd` chains.
- Test ideas:
  - Command-scope tests for generated `git status` without `cd`.
  - Negative tests for `cd /tmp && rm -rf ...` or unrelated chained commands.


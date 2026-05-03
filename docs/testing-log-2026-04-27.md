# Testing Log

Append to this log whenever harness testing is performed, including automated test runs, semantic checks, manual CLI checks, and REPL smoke sessions. Entries should capture enough detail for a future maintainer to understand what was exercised, what passed, what failed, and whether a finding was an expected limitation or a regression.

Use newest-first ordering.

Implementation backlogs from these findings live in
[`phase-10-5-backlog.md`](phase-10-5-backlog.md) and
[`post-phase-10-5-repl-backlog.md`](post-phase-10-5-repl-backlog.md).

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

## 2026-05-03 - Phase 10.5c Wave 2 — Pickers & slash command coverage

- Scope: Wave 2 of the REPL polish plan. New `src/ui/picker.ts` (raw-mode picker primitive: ↑/↓/PgUp/PgDn/Home/End/Enter/Esc, generic over T, falls back to null on non-TTY), `SessionDb.listSessions()` + `updateSessionModel()` (newest-first session list with first-user-message-as-title fallback; persisted /model picks). New slash commands: `/about`, `/tools`, `/skills`, `/stats`, `/permissions`, `/quit` (+ `/exit`/`/q` aliases), `/copy` (clipboard via pbcopy/wl-copy/xclip/xsel/clip.exe shell-out), `/resume` (picker over recent sessions, prints resume command — in-process swap deferred to Wave 4), `/model` (picker over provider models when no arg, persisted via DB), `/export` (md/jsonl/json picker, writes session-<short-id>.<ext> to cwd), `/init` (prompt command that scans the project and writes CONTEXT.md). `/help` rewritten as a category-grouped 2-column table (session / info / config / files / git / skills / other) with ANSI-aware visible-width padding. CommandContext extended with bundlePath, listSessions, getMetrics, skills, getLastAssistantText, getMessages, getPermissions, requestExit. `EXIT_COMMANDS` short-circuit removed from terminalRepl.ts — /quit now flows through the registry like every other command. Hard-coded text-only `/model` and `/clear`/`/help`/`/cost` from the original COMMANDS list left intact (clear/cost stay text-only; help got the table refactor in-place; model is now picker-or-arg).
- Environment: Bun 1.3.13 / Darwin 25.2.0; harness commit pre-change was `69d7bca`.
- Commands:
  - `bunx tsc --noEmit`
  - `bun run lint`
  - `bun run test`
  - `bun run tests/_smoke/wave2-smoke.ts`
- Manual / REPL coverage:
  - Smoke renderer printed `/help` (correctly aligned across categories), `/about` (boxed info card), `/skills` (with source tags), `/permissions` (mode + always-allow + persistent layers), `/stats` (mid-session summary card mirrors goodbye summary), `/init` (prompt-command shape with allowedTools), and `/export` empty-history graceful path.
  - Pickers (`/resume`, `/model` no-arg, `/export` no-arg) require a TTY and were not exercised in this run; the live REPL is the appropriate test surface for those. The `/help` output explicitly cites tab-completion as Wave 4 work, matching the build plan.
  - Did not exercise `/init` end-to-end against a live model (would write a real CONTEXT.md to the harness repo). Covered by unit tests asserting prompt-command shape and target-path argument handling.
- Result:
  - Typecheck clean. Lint clean (2 pre-existing warnings unchanged). **530/530 tests pass** (37 new test cases: 8 picker navigation, 8 sessionDb listSessions+updateSessionModel, 11 info commands, 8 export+init, plus updated existing tests). Test fixture extracted to `tests/commands/_makeCtx.ts` so future commands don't ripple boilerplate to every test file.
- Regressions / follow-ups:
  - No regressions. Existing 18 command tests still pass without assertion changes; only the local makeCtx() builder was replaced with a shared helper.
  - `/resume` does NOT do an in-process session swap — it prints `sov --resume <uuid>` as a hint and the user runs it in a fresh REPL. In-process swap is gated on Wave 4 (input editor), where we own more of the cursor model. The pain point ("must remember UUID") is fixed even without in-process loading.
  - Picker uses the same full-screen-clear pattern as `configMenu.ts`. Inline (non-clearing) rendering is a Wave 3/4 candidate — keeps conversation history visible during the pick. Acceptable for Wave 2 since the user is in a focused mode while picking.
  - Type-to-filter inside the picker is Wave 4 work (lands with the input editor so all keypress handling stays cohesive).
  - `/copy` shell-outs to pbcopy/wl-copy/xclip/xsel/clip.exe in priority order. If none are available the command prints the assistant text inline so the user can manually copy — graceful but not silent.

## 2026-05-03 - Wave 1 hotfix: FileEdit diff line-context

- Scope: Subagent-driven verification of Wave 1 surfaced a UX gap: the FileEdit diff renderer printed the raw `old_string`/`new_string` substrings (`- hello world` / `+ hello sovereign`) instead of the full line containing the change. Hotfix adds an optional `preContent` to `DiffRenderOpts`. When provided, the renderer scans the file content for `old_string`, computes the surrounding line(s), and renders those full lines as `-`/`+` blocks with a 1-based line number. Multi-occurrence edits (`replace_all: true`) annotate the head with `(applied N× across M occurrences)` and render only the first hunk to avoid dominating the screen. Falls back to substring rendering when the match is missing, when `old_string` is empty, or when `preContent` is omitted — all existing tests pass unchanged. Wired through `terminalRepl.ts`: at `tool_use` time for FileEdit, the file is `readFileSync`-snapshotted before the orchestrator dispatches the tool; the snapshot is consumed at `tool_result` time and threaded into the renderer.
- Environment: Bun 1.3.13 / Darwin 25.2.0; harness commit pre-change was `fac3906`.
- Commands:
  - `bun run lint`
  - `bun run test`
  - `bunx tsc --noEmit`
  - `bun run tests/_smoke/wave1-smoke.ts`
- Manual / REPL coverage:
  - Smoke renderer now exhibits both modes side-by-side: "FileEdit substring-only (no preContent)" prints the old `(1 replacement)` substring view; "FileEdit with line context (preContent provided)" prints `src/example.ts:2` with the full line `const greeting = "hello world";` becoming `const greeting = "hello sovereign";`. The replace_all sample shows `data.txt:1  (applied 4× across 4 occurrences)`.
  - End-to-end live REPL not re-driven; the verifying subagent exercised the path against Anthropic Haiku and reported the substring rendering as the gap, so this hotfix targets exactly that surface. Re-running the verification walkthrough manually is the right way to confirm the new line-context output against a real model.
- Result:
  - Lint clean (2 pre-existing warnings unchanged). **493/493 tests pass** (7 new diff tests covering: full-line render, line number, multi-line `old_string`, multi-occurrence note, fallback when match missing, fallback when `old_string` empty, large hunk truncation under non-verbose).
- Regressions / follow-ups:
  - No regressions; Wave 1's existing 14 diff tests continue to pass under the new renderer because they don't pass `preContent`.
  - Renderer reads only the FIRST occurrence's hunk for `replace_all` edits. Showing every hunk would be cleaner but blows the budget for big files; the current "applied N× across M occurrences" note is the right Wave 1 affordance. Multi-hunk rendering is a Wave 2 candidate if the gap proves felt.
  - FileWrite still renders as additive (no pre-content read for overwrites). Unchanged from Wave 1's design — the "wrote N bytes" + content-as-+ block is sufficient signal.

## 2026-05-03 - Phase 10.5b Wave 1 — REPL polish foundations

- Scope: Wave 1 of the multi-wave REPL polish plan. New `src/ui/modal.ts` (framed permission overlay with `isModalActive()` flag), `src/ui/contextMeter.ts` (per-session token-utilization tracker with one-shot pre-compaction warning), `src/ui/footer.ts` (pre-prompt status line: provider · model · ctx % · cost · perms · tools · bundle), `src/ui/diff.ts` (inline FileEdit/FileWrite diff renderer). Wired into `src/permissions/prompt.ts` (asker now uses `withModal`), `src/ui/thinking.ts` (suppresses tick while modal active), `src/ui/toolSlot.ts` (multi-line errors show `+N more lines` hint), `src/ui/terminalRepl.ts` (meter updates on `usage_delta`, footer printed before each prompt frame, diff rendered after successful FileEdit/FileWrite, splash banner shows count of loaded allow-rules), and `src/config/schema.ts` (new optional `ui.{footer,contextMeter,diffRender}` section). Smoke renderer at `tests/_smoke/wave1-smoke.ts`.
- Environment: Bun 1.3.13 / Darwin 25.2.0; harness commit pre-change was `934193a`.
- Commands:
  - `bunx tsc --noEmit`
  - `bun run lint`
  - `bun run test`
  - `bun run tests/_smoke/wave1-smoke.ts`
  - `HARNESS_CONFIG=/tmp/sov-test-config.json sov config set ui.contextMeter.warnAtPercent 70` (round-tripped through the schema)
  - `sov --help` and `sov config get ui` (no regression to existing CLI surface)
- Manual / REPL coverage:
  - Smoke renderer printed all three footer zones (ok / warn / danger), the permission modal frame, and FileEdit + FileWrite diffs (non-verbose, both with truncation). Visual output matched design intent: cyan-grey footer, yellow-bordered modal box, red `-` / green `+` diff lines.
  - `sov config set ui.contextMeter.warnAtPercent 70` round-tripped through the new schema entry without the strict-zod check rejecting it.
  - Could not exercise the live REPL end-to-end without an LLM endpoint in this sandbox; `--no-preflight` runs against `--provider ollama --model placeholder` are deferred until a follow-up dogfood pass on a connected machine.
- Result:
  - Typecheck clean (`bunx tsc --noEmit` zero output). Lint clean (2 pre-existing `noNonNullAssertion` warnings in `src/permissions/shellSemantics.ts:219,343` unchanged — not from this wave). **486/486 tests pass** (4 new test files: modal/contextMeter/footer/diff = 42 new tests; existing thinking suite picked up one nested-modal-suppression test = 43 total additions).
- Regressions / follow-ups:
  - No regressions. Existing `prompt.test.ts`, `toolSlot.test.ts`, `thinking.test.ts` all green against the new wiring without test edits to their assertions (the modal contract was additive).
  - Known limitation: footer is rendered as a "pre-prompt status line" rather than a true bottom-pinned scroll-region footer. Sufficient for Wave 1 polish; the scroll-region upgrade is gated on the input-editor work in Wave 4 (10.5e).
  - Diff renderer renders the agent's intent (old_string → new_string) for FileEdit, not a fresh re-read of post-edit file contents. For Wave 1 this is the right tradeoff — no extra I/O, no race against the orchestrator's tool dispatch. Re-read-from-disk diffs can be considered when the input editor lands and we own more of the cursor model.
  - Phase-10-5 backlog (`docs/phase-10-5-backlog.md`) entries unaffected; Wave-2/3/4/5 designs in the plan remain the next units of work.

## 2026-05-01 - Binary rename: sovereign → sov

- Scope: shortened CLI invocation. `package.json` `bin` mapping changed `"sovereign"` → `"sov"`; commander `.name('sovereign')` → `.name('sov')`; error-message prefix `harness:` → `sov:`; resume hint and max-tokens warning print `sov --resume ...`; WebSearch missing-API-key error references `sov config set ...`; in-source comments referring to the binary updated; active docs (README.md, docs/usage.md, docs/architecture.md) updated. Historical CHANGELOG entries and prior testing-log entries left verbatim.
- Environment: Bun 1.3.13 / Darwin 25.2.0; pre-rename harness commit was `5fa77c4`.
- Commands:
  - `bun unlink && rm -f ~/.bun/bin/sovereign && bun link` (refresh global symlink under the new name)
  - `bun run typecheck`
  - `bun run lint`
  - `bun run test`
  - `sov --help`
  - End-to-end: `mkdir -p /tmp/sov-rename-test && cd /tmp/sov-rename-test && unset HARNESS_BUNDLE && sov --no-preflight --provider ollama --model placeholder < /dev/null`
- Manual coverage:
  - `~/.bun/bin/sov` symlink points to `src/main.ts`; `~/.bun/bin/sovereign` no longer exists.
  - `sov --help` shows `Usage: sov [options] [command]`.
  - End-to-end run printed `to resume: sov --resume <uuid>` (no `--bundle` arg since no bundle was found in `/tmp`).
- Result:
  - Typecheck clean. Lint clean (2 pre-existing warnings unchanged). 435/435 tests pass.
- Regressions / follow-ups:
  - No regressions. Tests don't assert the literal binary name in resume-hint strings, so test changes weren't needed.
  - User-facing impact: anyone with `bun link` already installed needs to delete `~/.bun/bin/sovereign` and re-`bun link` to pick up the new name (documented in the CHANGELOG entry).

## 2026-05-01 - Bundleless / generic-agent mode

- Scope: `sovereign` no longer requires a harness bundle. `resolveBundlePath` now returns `string | null` instead of throwing; new `loadBundleIfPresent` returns null when the path is null or has no `index.yaml`. `Bundle` becomes `Bundle | null` through the REPL — five `bundle.root` reads gated, splash and resume hints handle `null`. `ToolContext.bundleRoot` and `LoadSkillsOptions.bundleRoot` made optional; skill loader skips the three bundle-relative roots when unset. Sovereign-flavored "canonical AI entity of the business" framing moved out of `BASE_INSTRUCTIONS` (now generic) and into `state/CONTEXT.md` of `sovereign-ai-docs` under a new `## Identity and voice` section, per CLAUDE.md rule #9.
- Environment: Bun 1.3.13 / Darwin 25.2.0; harness commit pre-change was `f92f84a`.
- Commands:
  - `bun run typecheck`
  - `bun run lint`
  - `bun run test`
  - End-to-end (bundleless): `mkdir -p /tmp/sovereign-no-bundle-test && cd /tmp/sovereign-no-bundle-test && bun /Users/julie/code/sovereign-ai-harness/src/main.ts chat --no-preflight --provider ollama --model placeholder < /dev/null`
  - End-to-end (bundled): `cd ~/code/sovereign-ai-docs && bun /Users/julie/code/sovereign-ai-harness/src/main.ts chat --no-preflight --provider ollama --model placeholder < /dev/null`
- Manual coverage:
  - Bundleless run: splash showed `no bundle` instead of a path; session created and exited cleanly; `[debug] transcript →` line appeared.
  - Bundled run: splash showed `/Users/julie/code/sovereign-ai-docs`; identical exit path.
  - `bun src/main.ts chat --help` still lists `--bundle` flag with unchanged semantics.
- Result:
  - Typecheck clean. Lint clean (2 pre-existing warnings unchanged). 435/435 tests pass (added 8: 4 in `tests/bundle/loader.test.ts`, 1 in `tests/skills/loader.test.ts`, 1 in `tests/ui/splash.test.ts`, 1 in `tests/ui/terminalMessages.test.ts`, 1 in `tests/context/systemPrompt.test.ts`).
- Regressions / follow-ups:
  - No regressions. Bundled mode end-to-end behavior unchanged because `loadBundleIfPresent` falls through to `loadBundle` whenever `index.yaml` exists.
  - Follow-up: docs-repo `state/CONTEXT.md` is now load-bearing for bundle-mode identity language. If a future client bundle is created, its CONTEXT.md must include an equivalent identity section or the model loses the first-person voice instruction.
  - Out of scope: Claude-Code-style auto-discovery of `CLAUDE.md`/`AGENTS.md` from CWD upward in bundleless mode (today the runtime relies on the existing user-context discovery in `src/context/user.ts`, which already loads `AGENTS.md`/`CLAUDE.md` from the CWD).

## 2026-04-28 - Default Anthropic API Smoke Retry

- Scope: Quick live harness API smoke after reloading Anthropic credits, using
  the current default Anthropic model `claude-haiku-4-5-20251001`.
- Environment:
  - Repo: `/Users/julie/code/sovereign-ai-harness`
  - Runtime: Bun 1.3.13
  - `HARNESS_HOME`: `/tmp/sovereign-api-smoke-retry-20260428/home`
  - Session DB: `/tmp/sovereign-api-smoke-retry-20260428/sessions.db`
  - Transcript: `/tmp/sovereign-api-smoke-retry-20260428/trace.jsonl`
  - Session: `7e1a3117-04a1-4292-b4f1-388ec5525079`
- Commands:
  - `printf 'Reply exactly API_OK and do not use tools.\n/quit\n' | env HARNESS_HOME=/tmp/sovereign-api-smoke-retry-20260428/home bun src/main.ts chat --bundle /Users/julie/code/sovereign-ai-docs --db /tmp/sovereign-api-smoke-retry-20260428/sessions.db --permission-mode ask --no-cache --transcript /tmp/sovereign-api-smoke-retry-20260428/trace.jsonl`
  - `cat /tmp/sovereign-api-smoke-retry-20260428/trace.jsonl`
- Manual / REPL coverage:
  - Verified the CLI resolves the default provider/model and opens a live
    Anthropic-backed REPL session.
  - Sent a single no-tool sentinel prompt and queued `/quit` through stdin.
  - Verified the assistant returned exactly `API_OK`.
  - Verified transcript capture recorded `session_start`, `user_input`, and
    `session_end`.
- Result:
  - Passed. Startup provider preflight succeeded for
    `claude-haiku-4-5-20251001`.
  - Passed. The live provider turn returned `API_OK`.
  - Passed. Usage was reported as `input=17314`, `output=6`,
    `cache_write=0`, and `cache_read=0`.
- Regressions / follow-ups:
  - No regressions found.

## 2026-04-28 - Default Anthropic API Smoke

- Scope: Quick live harness API smoke using the current default Anthropic model
  `claude-haiku-4-5-20251001`.
- Environment:
  - Repo: `/Users/julie/code/sovereign-ai-harness`
  - Runtime: Bun 1.3.13
  - `HARNESS_HOME`: `/tmp/sovereign-api-smoke-20260428/home`
  - Session DB: `/tmp/sovereign-api-smoke-20260428/sessions.db`
  - Transcript: `/tmp/sovereign-api-smoke-20260428/trace.jsonl`
- Commands:
  - `printf 'Reply exactly API_OK and do not use tools.\n/quit\n' | env HARNESS_HOME=/tmp/sovereign-api-smoke-20260428/home bun src/main.ts chat --bundle /Users/julie/code/sovereign-ai-docs --db /tmp/sovereign-api-smoke-20260428/sessions.db --permission-mode ask --no-cache --transcript /tmp/sovereign-api-smoke-20260428/trace.jsonl`
- Manual / REPL coverage:
  - Verified the CLI resolves the default provider/model and reaches the
    Anthropic API preflight before opening a session.
- Result:
  - Failed due to provider account state, not harness startup. Anthropic
    returned a low-credit billing error during provider preflight for
    `claude-haiku-4-5-20251001`, so no chat session opened and the prompt was
    not sent.
  - Passed. The harness surfaced the billing failure through the startup
    preflight path instead of allowing a partial tool-enabled session.
- Regressions / follow-ups:
  - Add Anthropic credits or switch to another configured provider before
    expecting live default-provider chat to complete.

## 2026-04-28 - Anthropic Default Model Update

- Scope: Change the built-in Anthropic harness default model from
  `claude-sonnet-4-6` to `claude-haiku-4-5-20251001`, with docs and resolver
  test alignment.
- Environment:
  - Repo: `/Users/julie/code/sovereign-ai-harness`
  - Runtime: Bun 1.3.13
- Commands:
  - `bun test tests/providers/resolver.test.ts`
  - `bun run lint`
  - `bun run test`
  - `bun run typecheck`
- Manual / REPL coverage:
  - None. This was a registry default and documentation update.
- Result:
  - Passed. Focused resolver tests reported 5 passing tests and 0 failures.
  - Passed. `bun run lint` checked 119 files with no fixes applied.
  - Passed. `bun run test` reported 277 passing tests, 0 failures, and 748
    assertions across 48 files.
  - Passed. `bun run typecheck`.
- Regressions / follow-ups:
  - No regressions found.

## 2026-04-28 - Post Phase-10.5 REPL Backlog Final Validation

- Scope: Final validation after closing every item in
  `docs/post-phase-10-5-repl-backlog.md`.
- Environment:
  - Repo: `/Users/julie/code/sovereign-ai-harness`
  - Runtime: Bun 1.3.13
- Commands:
  - `rg -n "Status: open|Status: complete" docs/post-phase-10-5-repl-backlog.md`
  - `bun run lint`
  - `bun run test`
  - `bun run typecheck`
- Manual / REPL coverage:
  - None beyond the transcript smoke recorded in the item 7 entry. This was the
    final automated gate and backlog-status check.
- Result:
  - Passed. Backlog status scan found seven complete items and no open items.
  - Passed. `bun run lint` checked 119 files with no fixes applied.
  - Passed. `bun run test` reported 277 passing tests, 0 failures, and 748
    assertions across 48 files.
  - Passed. `bun run typecheck`.
- Regressions / follow-ups:
  - No regressions found.
  - No open items remain in the post Phase-10.5 REPL backlog.

## 2026-04-28 - Optional REPL Transcript Capture

- Scope: Post Phase-10.5 backlog item 7, adding an optional redacted JSONL
  transcript/event log for manual REPL tests.
- Environment:
  - Repo: `/Users/julie/code/sovereign-ai-harness`
  - Runtime: Bun 1.3.13
  - Smoke `HARNESS_HOME`: `/tmp/sovereign-transcript-smoke-20260428/home`
  - Smoke session DB: `/tmp/sovereign-transcript-smoke-20260428/sessions.db`
  - Smoke transcript: `/tmp/sovereign-transcript-smoke-20260428/trace.jsonl`
  - Smoke session: `8e03cdaa-091d-4272-aa5a-ddca15cf6005`
- Commands:
  - `bun test tests/ui/transcript.test.ts tests/ui/queuedQuestion.test.ts tests/permissions/prompt.test.ts`
  - `bun run lint`
  - `bun run test`
  - `bun run typecheck`
  - `mkdir -p /tmp/sovereign-transcript-smoke-20260428/home`
  - `printf '/cost\n/quit\n' | env HARNESS_HOME=/tmp/sovereign-transcript-smoke-20260428/home bun src/main.ts chat --bundle /Users/julie/code/sovereign-ai-docs --db /tmp/sovereign-transcript-smoke-20260428/sessions.db --permission-mode ask --no-cache --no-preflight --transcript /tmp/sovereign-transcript-smoke-20260428/trace.jsonl`
  - `cat /tmp/sovereign-transcript-smoke-20260428/trace.jsonl`
- Manual / REPL coverage:
  - Verified the CLI accepts `--transcript <path>` and writes a JSONL event log.
  - Verified a pasted `/cost\n/quit\n` sequence is processed as two inputs.
  - Verified the transcript includes `session_start`, both `user_input` events,
    the local `/cost` `slash_command` output, and `session_end`.
  - Unit tests cover redaction, transcript file creation, queued readline input,
    and permission prompt/answer hooks.
- Result:
  - Passed. Focused transcript/input/permission tests reported 15 passing tests
    and 0 failures.
  - Passed. `bun run lint` checked 119 files with no fixes applied after
    formatting.
  - Passed. `bun run test` reported 277 passing tests, 0 failures, and 748
    assertions across 48 files.
  - Passed. `bun run typecheck`.
  - Passed. The no-provider-call CLI smoke recorded the expected transcript
    events and exited cleanly.
- Regressions / follow-ups:
  - No regressions found.

## 2026-04-27 - Queued REPL Input For Multi-Line Paste

- Scope: Post Phase-10.5 backlog item 6, preserving pasted multi-line slash
  command input across REPL prompts.
- Environment:
  - Repo: `/Users/julie/code/sovereign-ai-harness`
  - Runtime: Bun 1.3.13
- Commands:
  - `bun test tests/ui/queuedQuestion.test.ts tests/permissions/prompt.test.ts`
  - `bun run lint`
  - `bun run test`
  - `bun run typecheck`
- Manual / REPL coverage:
  - None. Focused tests simulate `/cost\n/quit\n`-style pasted lines through
    readline streams and verify the second line is preserved for the next
    prompt.
- Result:
  - Passed. Focused input/permission tests reported 12 passing tests and 0
    failures.
  - Passed. `bun run lint` checked 117 files with no fixes applied after import
    ordering.
  - Passed. `bun run test` reported 274 passing tests, 0 failures, and 740
    assertions across 47 files.
  - Passed. `bun run typecheck`.
- Regressions / follow-ups:
  - No regressions found.

## 2026-04-27 - Max Tokens Documentation Default

- Scope: Post Phase-10.5 backlog item 5, aligning the documented
  `--max-tokens` default with the CLI default and adding a regression check.
- Environment:
  - Repo: `/Users/julie/code/sovereign-ai-harness`
  - Runtime: Bun 1.3.13
- Commands:
  - `bun test tests/docsDefaults.test.ts`
  - `bun run lint`
  - `bun run test`
  - `bun run typecheck`
- Manual / REPL coverage:
  - None. This is a documentation sync change with a focused docs-default test.
- Result:
  - Passed. Focused docs-default test reported 1 passing test and 0 failures.
  - Passed. `bun run lint` checked 115 files with no fixes applied.
  - Passed. `bun run test` reported 272 passing tests, 0 failures, and 736
    assertions across 46 files.
  - Passed. `bun run typecheck`.
- Regressions / follow-ups:
  - No regressions found.

## 2026-04-27 - Ollama Tool Support Preflight

- Scope: Post Phase-10.5 backlog item 4, failing unsupported Ollama tool models
  before opening a normal tool-enabled session.
- Environment:
  - Repo: `/Users/julie/code/sovereign-ai-harness`
  - Runtime: Bun 1.3.13
- Commands:
  - `bun test tests/providers/preflight.test.ts tests/providers/ollama.test.ts`
  - `bun run lint`
  - `bun run test`
  - `bun run typecheck`
- Manual / REPL coverage:
  - None. Focused tests use fake providers and provider HTTP errors rather than
    a live Ollama daemon.
- Result:
  - Passed. Focused provider tests reported 7 passing tests and 0 failures.
  - Passed. `bun run lint` checked 114 files with no fixes applied.
  - Passed. `bun run test` reported 271 passing tests, 0 failures, and 732
    assertions across 45 files.
  - Passed. `bun run typecheck`.
- Regressions / follow-ups:
  - No regressions found.

## 2026-04-27 - Static Site Validator Tool

- Scope: Post Phase-10.5 backlog item 3, adding a read-only static-site validation helper for website artifacts.
- Environment:
  - Repo: `/Users/julie/code/sovereign-ai-harness`
  - Runtime: Bun 1.3.13
- Commands:
  - `bun test tests/tools/staticSiteValidateTool.test.ts tests/context/systemPrompt.test.ts tests/tool/buildTool.test.ts`
  - `bun run lint`
  - `bun run test`
  - `bun run typecheck`
- Manual / REPL coverage:
  - None. Focused tests cover successful static-site validation, missing local references, JavaScript syntax failures, and read-only permission behavior.
- Result:
  - Passed. Focused static-site/system/tool tests reported 16 passing tests and 0 failures.
  - Passed. `bun run lint` checked 114 files with no fixes applied after formatting the new tool and tests.
  - Passed. `bun run test` reported 269 passing tests, 0 failures, and 727 assertions across 45 files.
  - Passed. `bun run typecheck`.
- Regressions / follow-ups:
  - No regressions found.

## 2026-04-27 - Partial Artifact Warning

- Scope: Post Phase-10.5 backlog item 2, warning when a provider error happens after successful mutating tool calls in the same turn.
- Environment:
  - Repo: `/Users/julie/code/sovereign-ai-harness`
  - Runtime: Bun 1.3.13
- Commands:
  - `bun test tests/ui/terminalMessages.test.ts tests/core/query.test.ts tests/core/orchestrator.test.ts`
  - `bun run lint`
  - `bun run test`
  - `bun run typecheck`
- Manual / REPL coverage:
  - None. Focused tests cover the warning formatter; existing query/orchestrator tests cover tool-result sequencing used by the tracker.
- Result:
  - Passed. Focused UI/core tests reported 42 passing tests and 0 failures.
  - Passed. `bun run lint` checked 112 files with no fixes applied.
  - Passed. `bun run test` reported 265 passing tests, 0 failures, and 713 assertions across 44 files.
  - Passed. `bun run typecheck`.
- Regressions / follow-ups:
  - No regressions found.

## 2026-04-27 - Provider Health Preflight

- Scope: Post Phase-10.5 backlog item 1, adding startup provider preflight and clearer billing/credential classification before real work begins.
- Environment:
  - Repo: `/Users/julie/code/sovereign-ai-harness`
  - Runtime: Bun 1.3.13
- Commands:
  - `bun test tests/providers/preflight.test.ts tests/providers/resolver.test.ts`
  - `bun run lint`
  - `bun run test`
  - `bun run typecheck`
- Manual / REPL coverage:
  - None. Focused tests use fake providers and provider HTTP errors rather than live API calls.
- Result:
  - Passed. Focused provider tests reported 8 passing tests and 0 failures.
  - Passed. `bun run lint` checked 112 files with no fixes applied after import ordering.
  - Passed. `bun run test` reported 264 passing tests, 0 failures, and 709 assertions across 44 files.
  - Passed. `bun run typecheck`.
- Regressions / follow-ups:
  - No regressions found.

## 2026-04-27 - Post-Fix Real-World Website REPL Retest

- Scope: Real-world REPL retest after closing the Phase-10.5 backlog. The test repeated the imperfect website-building workflow with a new static site under `~/code`, then validated the produced artifact externally and checked session transcript integrity.
- Environment:
  - Repo: `/Users/julie/code/sovereign-ai-harness`
  - Bundle: `/Users/julie/code/sovereign-ai-docs`
  - Website workspace: `/Users/julie/code/harness-website-retest-2026-04-27-183331`
  - `HARNESS_HOME`: `/tmp/sovereign-website-retest-home.xTzuDY`
  - Session DB: `/Users/julie/code/harness-website-retest-2026-04-27-183331/sessions.db`
  - Anthropic session: `765ac708-6a92-457c-a116-c4b131362bf2`
  - Ollama fallback session: `19077fe8-bbab-4410-a128-8a6421a7684b`
  - Screenshots: `/tmp/harness-retest-desktop.png`, `/tmp/harness-retest-mobile.png`
- Commands:
  - `script -q /Users/julie/code/harness-website-retest-2026-04-27-183331/repl-transcript.txt env HARNESS_HOME=/tmp/sovereign-website-retest-home.xTzuDY bun /Users/julie/code/sovereign-ai-harness/src/main.ts chat --bundle /Users/julie/code/sovereign-ai-docs --db /Users/julie/code/harness-website-retest-2026-04-27-183331/sessions.db --permission-mode ask --no-cache`
  - `ollama serve`
  - `ollama list`
  - `script -q /Users/julie/code/harness-website-retest-2026-04-27-183331/repl-transcript-ollama.txt env HARNESS_HOME=/tmp/sovereign-website-retest-home.xTzuDY bun /Users/julie/code/sovereign-ai-harness/src/main.ts chat --provider ollama --model dolphin-llama3:latest --bundle /Users/julie/code/sovereign-ai-docs --db /Users/julie/code/harness-website-retest-2026-04-27-183331/sessions.db --permission-mode ask --no-cache --max-tokens 4096`
  - `python3 -m http.server 4181`
  - `curl -fsS -D - http://127.0.0.1:4181/ -o /tmp/harness-retest-index.html`
  - `curl -fsS -I http://127.0.0.1:4181/style.css`
  - `curl -fsS -I http://127.0.0.1:4181/chooser.js`
  - `npx --yes playwright screenshot --full-page --viewport-size=1440,1000 http://127.0.0.1:4181/ /tmp/harness-retest-desktop.png`
  - `npx --yes playwright screenshot --full-page --viewport-size=390,844 http://127.0.0.1:4181/ /tmp/harness-retest-mobile.png`
  - `sqlite3 /Users/julie/code/harness-website-retest-2026-04-27-183331/sessions.db "pragma wal_checkpoint(full); select ..."`
  - Direct Bun/SQLite transcript scan for assistant `tool_use` blocks missing immediate next-message `tool_result` blocks.
  - `bun run lint`
  - `bun run test`
  - `bun run typecheck`
- Manual / REPL coverage:
  - Prompted the harness with imperfect user language: "make me a small tasteful website for a neighborhood plant shop called Moss & Main... put it in ~/code/... keep it simple but make it feel like a real local shop, not a startup landing page."
  - Followed with vague revision feedback: "it still sounds a little like brochure copy... add a small workshops/classes area, make sure it works well on phones, and add a tiny javascript plant-care chooser or estimator."
  - Approved write/edit prompts one at a time under `--permission-mode ask`.
  - Ran `/cost` and `/quit` after provider errors.
  - Tried an Ollama fallback session against `dolphin-llama3:latest` after the Anthropic account hit a billing error.
- Result:
  - Partially passed with provider limitation. The Anthropic session created a usable static site shell with `index.html` and `style.css`, successfully wrote to `~/code/...` paths, skipped prompts for read-only Bash/FileRead calls, and serialized write/edit permission prompts without overlap or stall.
  - Passed. The first turn completed under the new default token budget without `max_tokens`.
  - Passed. `/cost` after the Anthropic provider error reported 61,953 total tokens and `$0.19` estimated chat cost.
  - Passed. Transcript integrity scan reported `missing_tool_results=0` for both sessions, including after provider errors.
  - Passed. Local server returned HTTP 200 for `/` and `style.css`.
  - Passed. Desktop and mobile screenshots rendered nonblank; the mobile layout was usable and did not have obvious overlap.
  - Failed artifact validation. `index.html` references `chooser.js`, but `chooser.js` was never written because the provider failed before the planned JavaScript write. `curl -I /chooser.js` returned HTTP 404.
  - Failed provider continuation. Anthropic returned a low-credit error during the second turn after partial file edits.
  - Failed local fallback. Ollama started, but `dolphin-llama3:latest` rejected the first request because the model does not support tools.
  - Passed. `bun run lint` checked 110 files with no fixes applied.
  - Passed. `bun run test` reported 261 passing tests, 0 failures, and 700 assertions across 43 files.
  - Passed. `bun run typecheck`.
- Regressions / follow-ups:
  - No regression found in the Phase-10.5 fixes for home-path normalization, serialized permission prompts, read-only prompt skipping, max-token recovery, or transcript validity.
  - New candidate improvements are recorded in [`post-phase-10-5-repl-backlog.md`](post-phase-10-5-repl-backlog.md): provider/model preflight, clearer partial-artifact warnings after provider failures, a static-site validator helper, unsupported Ollama tool-model handling, stale max-token docs, pasted slash-command handling, and optional terminal transcript capture.

## 2026-04-27 - Phase-10.5 Backlog Final Validation

- Scope: Final validation after closing every Phase-10.5 backlog item in `docs/phase-10-5-backlog.md`.
- Environment:
  - Repo: `/Users/julie/code/sovereign-ai-harness`
  - Runtime: Bun 1.3.13
- Commands:
  - `bun run lint`
  - `bun run test`
  - `bun run typecheck`
- Manual / REPL coverage:
  - None. This was the final automated gate after all backlog fixes were committed.
- Result:
  - Passed. `bun run lint` checked 110 files with no fixes applied.
  - Passed. `bun run test` reported 261 passing tests, 0 failures, and 700 assertions across 43 files.
  - Passed. `bun run typecheck`.
- Regressions / follow-ups:
  - No regressions found.
  - No open items remain in the Phase-10.5 backlog.

## 2026-04-27 - Commit Command Cwd Guidance

- Scope: Phase-10.5 backlog item 10, tightening `/commit` prompt guidance while preserving narrow Bash scope enforcement.
- Environment:
  - Repo: `/Users/julie/code/sovereign-ai-harness`
  - Runtime: Bun 1.3.13
- Commands:
  - `bun test tests/commands/registry.test.ts tests/commands/toolScope.test.ts`
  - `bun run lint`
  - `bun run test`
  - `bun run typecheck`
- Manual / REPL coverage:
  - None. Focused tests cover prompt cwd/no-`cd` guidance, allowed direct git commands, and denial of `cd`-prefixed or unrelated chained Bash commands.
- Result:
  - Passed. Focused command tests reported 11 passing tests and 0 failures.
  - Passed. `bun run lint` checked 110 files with no fixes applied after formatting the new negative test.
  - Passed. `bun run test` reported 261 passing tests, 0 failures, and 700 assertions across 43 files.
  - Passed. `bun run typecheck`.
- Regressions / follow-ups:
  - No regressions found.

## 2026-04-27 - Context Reference Injection Screening

- Scope: Phase-10.5 backlog item 9, screening `@file` context-reference content through the same injection-defense path as local context files.
- Environment:
  - Repo: `/Users/julie/code/sovereign-ai-harness`
  - Runtime: Bun 1.3.13
- Commands:
  - `bun test tests/context/references.test.ts tests/context/injectionDefense.test.ts`
  - `bun run lint`
  - `bun run test`
  - `bun run typecheck`
- Manual / REPL coverage:
  - None. Focused tests cover suspicious referenced-file bodies, invisible Unicode blocking, oversized content truncation, and existing reference expansion behavior.
- Result:
  - Passed. Focused context-reference/injection tests reported 12 passing tests and 0 failures.
  - Passed. `bun run lint` checked 110 files with no fixes applied.
  - Passed. `bun run test` reported 260 passing tests, 0 failures, and 695 assertions across 43 files.
  - Passed. `bun run typecheck`.
- Regressions / follow-ups:
  - No regressions found.

## 2026-04-27 - Repeatable Website Build Eval

- Scope: Phase-10.5 backlog item 8, codifying the real-world website run into a repeatable fixture-backed eval and artifact validator.
- Environment:
  - Repo: `/Users/julie/code/sovereign-ai-harness`
  - Runtime: Bun 1.3.13
- Commands:
  - `bun test tests/evals/websiteBuildEval.test.ts`
  - `bun run eval:website`
  - `bun run lint`
  - `bun run test`
  - `bun run typecheck`
- Manual / REPL coverage:
  - None. The eval uses a deterministic fixture builder for repeatability rather than a live provider session.
- Result:
  - Passed. Focused eval tests reported 2 passing tests and 0 failures.
  - Passed. `bun run eval:website` created a temp website workspace and wrote `website-eval-result.json`.
  - Passed. `bun run lint` checked 110 files with no fixes applied.
  - Passed. `bun run test` reported 257 passing tests, 0 failures, and 686 assertions across 43 files.
  - Passed. `bun run typecheck`.
- Regressions / follow-ups:
  - No regressions found.
  - The eval currently uses a fixture builder; a future provider-fixture or local-model mode can replace the builder while keeping the same artifact checks.

## 2026-04-27 - Ask-Mode Read-Only Bash Friction

- Scope: Phase-10.5 backlog item 7, allowing provably read-only Bash commands to skip prompts in ask mode while preserving explicit ask/deny rules.
- Environment:
  - Repo: `/Users/julie/code/sovereign-ai-harness`
  - Runtime: Bun 1.3.13
- Commands:
  - `bun test tests/tools/bashTool.test.ts tests/permissions/canUseTool.test.ts`
  - `bun run lint`
  - `bun run test`
  - `bun run typecheck`
- Manual / REPL coverage:
  - None. Focused tests cover Bash self-check behavior, ask-mode prompt skipping, and explicit ask-rule override behavior.
- Result:
  - Passed. Focused Bash/permission tests reported 33 passing tests and 0 failures before the generic test cast; the targeted permission rerun reported 14 passing tests and 0 failures.
  - Passed. `bun run lint` checked 108 files with no fixes applied.
  - Passed. `bun run test` reported 255 passing tests, 0 failures, and 671 assertions across 42 files.
  - Passed. `bun run typecheck`.
- Regressions / follow-ups:
  - No regressions found.
  - The Bash read-only classifier remains conservative: path-prefixed binaries, command substitution, and off-allowlist commands still prompt.

## 2026-04-27 - Cheap Completion Validation Guidance

- Scope: Phase-10.5 backlog item 6, adding generic model guidance to run cheap validators before claiming code/web work is complete.
- Environment:
  - Repo: `/Users/julie/code/sovereign-ai-harness`
  - Runtime: Bun 1.3.13
- Commands:
  - `bun test tests/context/systemPrompt.test.ts`
  - `bun run lint`
  - `bun run test`
  - `bun run typecheck`
- Manual / REPL coverage:
  - None. This was a prompt-guidance change covered by system-prompt unit assertions.
- Result:
  - Passed. Focused system-prompt tests reported 4 passing tests and 0 failures.
  - Passed. `bun run lint` checked 108 files with no fixes applied.
  - Passed. `bun run test` reported 252 passing tests, 0 failures, and 665 assertions across 42 files.
  - Passed. `bun run typecheck`.
- Regressions / follow-ups:
  - No regressions found.
  - The website replay/eval assertion for `node --check` remains tracked under backlog item 8.

## 2026-04-27 - Filesystem Home Path Normalization

- Scope: Phase-10.5 backlog item 5, expanding leading `~` paths consistently across filesystem tools, permission matching, and path-overlap checks.
- Environment:
  - Repo: `/Users/julie/code/sovereign-ai-harness`
  - Runtime: Bun 1.3.13
- Commands:
  - `bun test tests/tools/pathUtils.test.ts tests/tools/permissionMatchers.test.ts tests/tools/fileReadTool.test.ts tests/tools/fileWriteTool.test.ts tests/tools/fileEditTool.test.ts tests/tools/globTool.test.ts tests/tools/grepTool.test.ts tests/core/orchestrator.test.ts`
  - `bun run lint`
  - `bun run test`
  - `bun run typecheck`
- Manual / REPL coverage:
  - None. Focused tests exercised real `~/` file reads, writes, edits, glob scans, ripgrep searches, permission matching, and path-overlap serialization.
- Result:
  - Passed. Focused tests reported 77 passing tests and 0 failures.
  - Passed. `bun run lint` checked 108 files with no fixes applied after formatting two long test calls.
  - Passed. `bun run test` reported 252 passing tests, 0 failures, and 662 assertions across 42 files.
  - Passed. `bun run typecheck`.
- Regressions / follow-ups:
  - No regressions found.
  - Non-leading `~` and `~other` remain literal by design.

## 2026-04-27 - Max-Token Recovery And Large-Edit Guidance

- Scope: Phase-10.5 backlog item 4, improving default output budget, provider `max_tokens` recovery, and large file-edit behavior guidance.
- Environment:
  - Repo: `/Users/julie/code/sovereign-ai-harness`
  - Runtime: Bun 1.3.13
- Commands:
  - `bun test tests/core/query.test.ts tests/ui/terminalMessages.test.ts tests/context/systemPrompt.test.ts`
  - `bun run lint`
  - `bun run test`
  - `bun run typecheck`
- Manual / REPL coverage:
  - None. This change is covered by focused query, terminal-message, and system-prompt unit tests.
- Result:
  - Passed. Focused tests reported 17 passing tests and 0 failures.
  - Passed. `bun run lint` checked 105 files with no fixes applied.
  - Passed. `bun run test` reported 242 passing tests, 0 failures, and 643 assertions across 40 files.
  - Passed. `bun run typecheck`.
- Regressions / follow-ups:
  - No regressions found.
  - No live website replay was run for this item; the repeatable eval is tracked separately in backlog item 8.

## 2026-04-27 - Durable Clear And Transcript Repair

- Scope: Phase-10.5 backlog item 3, making `/clear` a durable recovery path and adding resume/rollback repair for legacy orphaned `tool_use` transcripts.
- Environment:
  - Repo: `/Users/julie/code/sovereign-ai-harness`
  - Runtime: Bun 1.3.13
- Commands:
  - `bun test tests/core/transcriptRepair.test.ts tests/agent/sessionRecovery.test.ts tests/commands/registry.test.ts`
  - `bun run lint`
  - `bun run test`
  - `bun run typecheck`
- Manual / REPL coverage:
  - None. This change is covered by focused unit tests for transcript repair, cleared child-session creation, and `/clear` command dispatch.
- Result:
  - Passed. Focused tests reported 12 passing tests and 0 failures.
  - Passed. `bun run lint` checked 103 files with no fixes applied.
  - Passed. `bun run test` reported 238 passing tests, 0 failures, and 631 assertions across 39 files.
  - Passed. `bun run typecheck`.
- Regressions / follow-ups:
  - No regressions found.
  - The original malformed parent transcript remains raw in SQLite for debugging; the provider-safe repair is applied at load time.

## 2026-04-27 - Real-World Website Build Harness Test

- Scope: Real-world use-case REPL test where the harness built a simple static website from imperfect, iterative human-style prompts. The test exercised multi-turn file creation and revision, vague design feedback, responsive/mobile feedback, JavaScript feature addition, self-inspection, late rename/copy changes, external validation, recovery from harness errors, and final artifact verification.
- Environment:
  - Repo: `/Users/julie/code/sovereign-ai-harness`
  - Bundle: `/Users/julie/code/sovereign-ai-docs`
  - Website workspace: `/Users/julie/code/harness-website-test-2026-04-27`
  - `HARNESS_HOME`: `/tmp/sovereign-website-home.nbBFWB`
  - Session DB: `/Users/julie/code/harness-website-test-2026-04-27/sessions.db`
  - Provider/model: `anthropic / claude-sonnet-4-6`
  - Harness session: `594bea1a-3a7f-42e4-86bf-c10430d80573`
  - Screenshots: `/tmp/harness-website-desktop.png`, `/tmp/harness-website-mobile.png`
- Commands:
  - `HARNESS_HOME=/tmp/sovereign-website-home.nbBFWB bun /Users/julie/code/sovereign-ai-harness/src/main.ts chat --bundle /Users/julie/code/sovereign-ai-docs --db /Users/julie/code/harness-website-test-2026-04-27/sessions.db --permission-mode ask --no-cache`
  - `HARNESS_HOME=/tmp/sovereign-website-home.nbBFWB bun /Users/julie/code/sovereign-ai-harness/src/main.ts chat --bundle /Users/julie/code/sovereign-ai-docs --db /Users/julie/code/harness-website-test-2026-04-27/sessions.db --resume 594bea1a-3a7f-42e4-86bf-c10430d80573 --permission-mode ask --no-cache --max-tokens 12000`
  - `node --check estimator.js`
  - `python3 -m http.server 4177`
  - `curl -fsS http://127.0.0.1:4177/`
  - `curl -fsS -I http://127.0.0.1:4177/style.css`
  - `curl -fsS -I http://127.0.0.1:4177/estimator.js`
  - `playwright screenshot --full-page --viewport-size=1440,1000 http://127.0.0.1:4177/ /tmp/harness-website-desktop.png`
  - `playwright screenshot --full-page --viewport-size=390,844 http://127.0.0.1:4177/ /tmp/harness-website-mobile.png`
  - `sqlite3 sessions.db "select session_id,model,provider,input_tokens,output_tokens,round(estimated_cost_usd,4),schema_version from sessions; select count(*) from messages;"`
  - `bun run lint`
  - `bun run test`
  - `bun run typecheck`
- Manual / REPL coverage:
  - Prompted the harness with vague real-user input: "make me a simple website for a bike repair shop. keep it tasteful. put it in this folder".
  - Iterated with imperfect feedback: make it feel like a real local business, polish it without making it startup-y, improve phone behavior, add a small JavaScript quote/service estimator, inspect and fix obvious issues, then rename the shop to `Beacon Bike Works`.
  - The harness created `index.html`, `style.css`, and `estimator.js` under `/Users/julie/code/harness-website-test-2026-04-27`.
  - Verified the final site opens through a local static server and returns HTTP 200 for the page, CSS, and JS.
  - Captured desktop and mobile screenshots; both rendered nonblank and the mobile page was usable with the hero no longer taking over the viewport.
  - Verified final rename with no `Ironclad` remnants and prominent `Beacon Bike Works` title/footer/about copy.
  - Verified `node --check estimator.js` after the harness fixed JavaScript string-escaping errors.
  - Queried SQLite: session `594bea1a-3a7f-42e4-86bf-c10430d80573`, 101 persisted messages, estimated chat cost `$1.5981`.
- Result:
  - Passed with intervention. The harness produced a usable static website with responsive styling, realistic local-business copy, a vanilla JS estimator, and final requested rename.
  - Passed. External HTTP checks returned 200 for `/`, `style.css`, and `estimator.js`.
  - Passed. `node --check estimator.js` succeeded after the harness corrected apostrophe escaping defects.
  - Passed. Playwright desktop and mobile screenshots rendered the page correctly.
  - Passed. `bun run lint` checked 99 files with no fixes applied.
  - Passed. `bun run test` reported 232 passing tests, 0 failures, and 600 assertions across 37 files.
  - Passed. `bun run typecheck`.
- Regressions / follow-ups:
  - Default `maxTokens=4096` was too low for this realistic website-building flow. The model repeatedly started a large CSS rewrite but hit `max_tokens` before issuing the write. Resuming with `--max-tokens 12000` unblocked the workflow.
  - The harness initially attempted `FileWrite` with a `~` path and got a tool error, then recovered by writing relative paths. Path normalization for user-home-style paths would improve first-pass reliability.
  - An inspection turn launched three concurrent Bash reads, causing overlapping permission prompts. After answering, the REPL stopped making progress until Ctrl-C.
  - Interrupting that stuck concurrent tool-permission turn persisted assistant `tool_use` blocks without matching `tool_result` blocks. Subsequent provider calls, including resumed sessions, failed with Anthropic 400 until `/clear` was run in-memory. This is a serious recovery/persistence bug.
  - `/clear` recovers the live REPL enough to continue, but it does not repair the bad persisted transcript; resuming later reloads the malformed history and fails again until `/clear` is run after resume.
  - The harness did not run `node --check` before first claiming completion. External validation found a real `estimator.js` syntax error caused by unescaped apostrophes inside single-quoted strings. After being given the validator error, the harness fixed the issue through several `FileEdit` calls and repeated `node --check`.
  - The JavaScript fix turn hit `max_turns` before a final natural-language summary, even though the last `node --check` passed. Long repair loops may need a better turn budget or summarization behavior.
  - The simple anchor parser flagged `href="#"` on the logo and the external Google Fonts stylesheet as non-local references. These were not treated as broken site references for this test.

## 2026-04-27 - Date Testing Log Filename

- Scope: Documentation maintenance to rename `docs/testing-log.md` to `docs/testing-log-2026-04-27.md` and update all repo references.
- Environment:
  - Repo: `/Users/julie/code/sovereign-ai-harness`
  - Runtime: Bun 1.3.13
- Commands:
  - `bun run lint`
  - `bun run test`
- Manual / REPL coverage:
  - None. This was a filename/reference-only documentation change.
- Result:
  - Passed. `bun run lint` checked 99 files with no fixes applied.
  - Passed. `bun run test` reported 232 passing tests, 0 failures, and 600 assertions across 37 files.
- Regressions / follow-ups:
  - No regressions found.
  - No live REPL smoke was run because no runtime behavior changed.

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

## 2026-04-28 - debugMode config + auto-transcript

- Scope: Added `debugMode` settings bucket (`enabled`, `transcript`, `transcriptDir`); REPL now auto-resolves a timestamped transcript path under `<harnessHome>/debug` when debug mode is on and `--transcript` was not passed. Added new fields to the interactive config picker.
- Environment: Bun 1.3.13 / macOS Darwin 25.2.0, repo `sovereign-ai-harness@master`.
- Commands:
  - `bun run lint`
  - `bun run test`
  - `bun test tests/ui/transcript.test.ts`
- Manual coverage: none (config wiring + unit tests). Real REPL session smoke not run.
- Result:
  - `bun run lint` passes (2 pre-existing warnings unchanged).
  - `bun run test` passes: 379/379 tests across 54 files (5 new cases for `resolveDebugTranscriptPath`).
- Regressions / follow-ups:
  - No regressions.
  - Follow-up: exercise debug-mode-enabled REPL session end-to-end and confirm a transcript file lands at `<harnessHome>/debug/transcript-<ts>.jsonl`.

## 2026-04-28 - debugMode follow-up: simplify gate + capture assistant/tool events

- Scope: (1) Removed the `debugMode.enabled` umbrella gate so `debugMode.transcript: true` alone triggers the auto-transcript (matched user expectation). (2) Wired the streaming loop to record `assistant_message`, `tool_call`, `tool_result`, and `message_stop` events into the JSONL transcript. Image base64 payloads are stripped before write.
- Environment: Bun 1.3.13 / Darwin 25.2.0; `~/.harness/config.json` had `debugMode.transcript: true`.
- Commands:
  - `bun run lint`
  - `bun run test`
  - End-to-end: `printf '... ls -la ...\n/quit\n' | bun src/main.ts chat --bundle ~/code/sovereign-ai-docs --no-preflight --permission-mode bypass`
- Manual coverage:
  - Live REPL session against anthropic/claude-haiku-4-5-20251001 that exercised a Bash tool (`ls -la /tmp`) and a final text response.
  - Verified the resulting `~/.harness/debug/transcript-<ts>.jsonl` contains, in order: `session_start`, `user_input`, `message_stop(tool_use)`, `assistant_message(tool_use block)`, `tool_call`, `tool_result(isError=false, durationMs=28, full content)`, `message_stop(end_turn)`, `assistant_message(text "DONE")`, `session_end`.
- Result:
  - Lint clean (2 pre-existing warnings unchanged); 378/378 tests pass.
  - Transcript now captures the full session: user input, assistant output (text + thinking + tool_use), tool calls with input, tool results with success/error and duration, and per-turn stop reasons.
- Regressions / follow-ups:
  - No regressions.
  - Follow-up: tool_result `content` strings can be very large (full stdout in the example was ~10K chars on a single line). Consider an opt-in `debugMode.truncateContentBytes` cap if transcripts get unwieldy.

## 2026-04-28 - Fix permissionMode fallback from config.json

- Scope: Wired `~/.harness/config.json`'s `permissionMode` into the REPL's resolver as a fallback. Previously the schema accepted the field and the picker wrote it, but the runtime only consulted CLI flag and `.harness/settings.json` layers. New precedence: explicit CLI flag → settings.json layers → config.json → `'default'`.
- Environment: Bun 1.3.13 / Darwin 25.2.0; `~/.harness/config.json` had `permissionMode: bypass` and no `.harness/settings.json` override present.
- Commands:
  - `bun run lint`
  - `bun run test`
  - End-to-end (no CLI permission flag): `printf '... echo PERMISSION_TEST_OK ...\n/quit\n' | bun src/main.ts chat --bundle ~/code/sovereign-ai-docs --no-preflight`
- Manual coverage:
  - Verified the Bash tool ran without prompting using only the config.json setting.
  - Confirmed the splash bar reports `perms: bypass (from settings)`.
- Result:
  - Lint clean (2 pre-existing warnings unchanged); 378/378 tests pass.
  - Bug confirmed fixed: picker-set `permissionMode` now actually applies.
- Regressions / follow-ups:
  - None. Settings.json layer (with allow/deny rules) still wins over config.json, preserving prior behavior for users using that layer.

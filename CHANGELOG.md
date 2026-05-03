# Changelog

## Semantic test suite (LLM-judged behavior tests) - 2026-05-03

New opt-in test category that complements the existing unit/integration suite. Drives the real `sov` binary as a subprocess, captures the transcript, and asks an LLM judge whether each prompt was handled correctly against per-test must-satisfy / should-not criteria.

**Strict isolation.** Lives entirely under `tests/semantic/`. Zero edits to `src/`. No new production deps (`@anthropic-ai/sdk` and `chalk` already in `package.json`). Each test spawns the binary in an `mktemp -d` sandbox with its own `HARNESS_HOME`, `HARNESS_CONFIG`, sessions DB — cleaned up on completion or crash. File names are `*.cases.ts` and `run.ts`, neither matches Bun's `*.test.ts` discovery, so `bun test` is unaffected. New `test:semantic` script is purely additive.

**Pluggable judge backends.** `Judge` is a function type `(test, transcript) => Promise<JudgeVerdict>`. Two backends ship in v1:
- `claude-code` (default) — shells out to the local `claude` CLI in `--print` mode with `--json-schema` for structured output. Uses your authenticated session, costs zero API tokens. Spawned in `tmpdir()` with `--tools ""`, `--no-session-persistence`, `--disable-slash-commands` for full isolation.
- `anthropic-api` (opt-in) — direct `@anthropic-ai/sdk` call with tool-use; needs `ANTHROPIC_API_KEY`. Useful for CI runners.

`auto` mode picks `claude-code` if available, else falls back to `anthropic-api`. Adding a new backend (e.g., `codex`, `sov`-itself) is one new file under `framework/judges/` plus a `selectJudge` switch case — `runner.ts`, `run.ts`, and test cases are unchanged.

**Framework (~700 LOC).** `framework/types.ts` (SemanticTest, JudgeVerdict, Judge, RunSummary), `sandbox.ts` (per-test ephemeral env), `driver.ts` (subprocess spawn + ANSI strip + transcript), `judges/` (prompt builder + verdict parser + per-backend factories), `runner.ts` (load + orchestrate, judge-agnostic), `reporter.ts` (chalk progress + summary).

**Starter cases (8 tests).** Bash output capture, Read/Edit/Write tool dispatch, /help command rendering, two-step write-then-verify workflow, directory enumeration, and refusal-on-missing-file (anti-fabrication).

**Designed for portability.** Framework only assumes a stdin-driven REPL that exits on `/quit`. Lift `tests/semantic/` to any project, adjust `driver.ts` defaults, point at a different binary via `SEMANTIC_BINARY` or `--binary`. Documented in `tests/semantic/README.md`, including a sketch for an eventual `sov`-judges-itself backend.

**Cost.** Default judge (`claude-code`) uses your subscription — no API tokens. Binary under test still spends model credit during its own turns regardless of judge backend. Not part of `bun test` — opt-in only via `bun run test:semantic`.

## Phase 10.5e Wave 4 stabilization — Ctrl-R, soft-wrap, Esc flush - 2026-05-03

Closeout of the input-editor work. Vim mode (originally Wave 5) deferred indefinitely per the LOC-to-value tradeoff.

**Ctrl-R reverse-i-search.** Press Ctrl-R to enter reverse-i-search mode. Type to filter history newest-first. Ctrl-R cycles backward through matches. Enter accepts and submits (readline / bash convention). Esc / Ctrl-C / Ctrl-G cancel and restore the pre-search buffer. Other special keys (Right/Home/End/Tab/Ctrl-A/etc.) accept the match into the buffer and dispatch the key in normal mode for editing before submit.

**Soft-wrap for long input lines.** New `wrapForDisplay(rendered, width)` pure function in `textBuffer.ts`. Each long logical line wraps to multiple display chunks of ≤ width characters; the cursor is mapped from logical (row, col) to display (row, col). `inputEditor.draw()` calls this with `cols - prompt.length`, so a long input line no longer overflows past the terminal column. Width ≤ 0 short-circuits.

**Esc-key flush in keypress dispatcher.** Lone ESC bytes were held in the partial-sequence buffer indefinitely (no `escape` key event emitted). Added a 50ms flush timer matching vim `timeoutlen` and readline `esc-timeout`. Cancelled the moment more bytes arrive, so Alt+key encoding and CSI sequences still work. Cleared on `disable()`.

**Tests.** 13 new (7 wrapForDisplay, 6 Ctrl-R search). All 645 tests pass. Lint clean. Hard-pass 105/105.

## Phase 10.5e Wave 4 — input editor (multi-line, history, autocomplete) - 2026-05-03

The largest single felt UX upgrade. Replaces readline's line-oriented input with a from-scratch raw-mode editor.

**Five new modules (~1,400 LOC):**

- `src/ui/keypress.ts` — raw-mode dispatcher. Reference-counted enable/disable. Parses ANSI escapes (CSI, SS3) + bracketed paste + control chars + Alt-letter into typed `Key` events. Subscribes/unsubscribes via callbacks. `getKeypressDispatcher()` singleton; suppresses dispatch while a modal is up.
- `src/ui/textBuffer.ts` — multi-line buffer with row/col cursor. `insert` (with embedded-newline split), `deleteLeft/Right/WordLeft/ToLineStart/ToLineEnd`, `moveLeft/Right/Up/Down/LineStart/LineEnd/BufferStart/BufferEnd`, `cursorIsOnFirstLine/LastLine`.
- `src/ui/inputHistory.ts` — persistent history at `~/.harness/input-history`. 1000-entry cap, dedup against previous, embedded newlines escaped as `\n`. `at(offsetFromEnd)` walks the history for Up/Down navigation.
- `src/ui/autocomplete.ts` — pure completion. Slash commands (`/co<Tab>` → `/cost`/`/commit`/`/compact`) and `@file` paths (`@src/m<Tab>` → `@src/main.ts`). Directories sorted first, dotfiles hidden, capped at 50 results.
- `src/ui/inputEditor.ts` — drop-in replacement for `question() ⇒ Promise<string>`. Owns one TextBuffer + subscribes to keypress events. Re-renders the buffer on every keystroke with ANSI cursor positioning. Paste bursts insert literally without keybind dispatch.

**Keybinds:**

| Key | Action |
|---|---|
| Enter | Submit (or insert newline if last char of buffer is `\`) |
| Tab | Autocomplete; subsequent Tabs cycle through matches |
| Up / Down | History walk when on first/last line; cursor motion otherwise |
| Left / Right / Home / End | Cursor motion (across line boundaries) |
| Backspace / Delete | Delete left / right (joins lines at boundaries) |
| Ctrl-A / E / B / F | Line start / end / cursor left / right (readline) |
| Ctrl-P / N | History prev / next (readline) |
| Ctrl-U / K | Delete to line start / end |
| Ctrl-W | Delete word left |
| Ctrl-L | Clear screen |
| Ctrl-C | Clear buffer; second on empty = EOF |
| Ctrl-D | EOF when empty; deleteRight otherwise |

**Wiring.** New editor is the default when `process.stdin.isTTY === true`. Piped stdin falls through to the legacy readline + queuedQuestion path. New `--legacy-input` flag forces legacy regardless (safety hatch).

**Tests.** 84 new (19 keypress parsing, 21 textBuffer ops, 12 inputHistory I/O, 12 autocomplete shapes, 20 inputEditor integration via FakeDispatcher). All 632 tests pass.

## Phase 10.5d Wave 3 — theme system + /settings dialog - 2026-05-03

First-class user customization via semantic color tokens.

**Theme module (`src/ui/theme.ts`).** ~25 semantic roles: text/textMuted/textBold, accent/accentBold/accentMuted, status×4 (success/warning/error/info), diff×3 (added/removed/context), border×3 (default/accent/warning), code×2 (inline/fence), header×3 (h1/h2/h3). Three built-in themes:

- `dark` (default) — preserves the existing look exactly. Migration is invisible.
- `light` — darker primaries via `chalk.rgb` for light terminals (amber warning, dark blue accent).
- `no-color` — identity tokens for transcripts and pipes (separate from chalk's NO_COLOR env handling).

API: `getTheme()` / `setTheme(name)` / `listThemes()` / `isThemeName(name)` / `resolveThemeName({configured, env})`. The last honors `NO_COLOR` overriding the configured value. `theme.tokens` is a getter so swapping themes via `setTheme()` takes effect on the next renderer call without re-imports.

**Renderers migrated** to theme tokens: `footer.ts`, `diff.ts`, `modal.ts`, `thinking.ts`, `toolSlot.ts`, `box.ts`, `splash.ts`. Behavior is identical under the default dark theme — every existing test passes without assertion changes.

**Schema.** New `ui.theme` enum (`'dark'` / `'light'` / `'no-color'`) in `SettingsSchema`. `terminalRepl.ts` calls `setTheme(resolveThemeName(...))` immediately after `readConfig()`, before any rendering.

**New slash commands.** `/theme [<name>]` opens a picker over the three built-in themes (or applies inline). Persists to `~/.harness/config.json`. Rejects unknowns with the available list. `/settings` opens the existing `runConfigMenu` from `sov config` (no verb) inside a session.

**Tests.** 17 new (12 theme module, 5 `/theme` command). 548 tests pass.

## Phase 10.5c Wave 2 hotfix — piped-stdin queue drain - 2026-05-03

Latent bug since Phase 3.5: under piped stdin, `readline` emits all `'line'` events for buffered input, then fires `'close'` on EOF. The REPL loop's `while (!closed)` flag flipped the moment the close event fired — exiting before the queued lines for `/copy`, `/export`, `/quit` could be drained. Single-prompt scripts hid this because `question()` throwing was already the correct exit path.

**Fix.** `createQueuedQuestion` now returns a `QueuedQuestion` with a `pending()` accessor. `question()` shifts buffered lines BEFORE checking the `closed` flag, so callers still receive queued input after readline has closed. `terminalRepl.ts`'s main loop now iterates while `!closed || question.pending() > 0`. `rl.on('close')` no longer flips `closed` — `question()`'s throw path signals exhaustion naturally.

**Tests.** 1 new regression test pinning the pre-close-then-drain pattern. All 531 tests pass.

## Phase 10.5c Wave 2 — pickers & slash command coverage - 2026-05-03

Discoverability upgrade: reusable picker primitive + 11 new slash commands.

**`src/ui/picker.ts` — generic raw-mode picker.** Generalizes `configMenu.ts`'s pattern. ↑/↓/PgUp/PgDn/Home/End/Enter/Esc, optional initial selection, optional hint per item, returns `Promise<T | null>`. Restores raw mode + cursor + screen in `finally` so a thrown error can't leave the terminal in a bad state. Falls back to null on non-TTY (callers display a fallback message).

**SessionDb additions.** `listSessions(limit)` returns recent sessions newest-first by `last_updated`. Title falls back to first user message text (truncated to 60 chars). Includes `msgCount`, `totalTokens`, `totalCostUsd`. `updateSessionModel(sessionId, model)` persists `/model` picks so they survive `--resume`.

**11 new slash commands** (registered via the existing slash-command registry):

| Command | Behavior |
|---|---|
| `/about` | Boxed info card: version, provider, model, cwd, bundle, session id |
| `/tools` | List of registered tools with descriptions |
| `/skills` | List of visible skills with `[source]` tags |
| `/stats` | Mid-session metrics card (mirrors goodbye summary shape) |
| `/permissions` | Mode + session always-allow rules + persistent layered rules |
| `/quit` (`/exit`, `/q`) | Clean exit via `ctx.requestExit()`; replaces hard-coded EXIT_COMMANDS |
| `/copy` | Copy last assistant message via pbcopy / wl-copy / xclip / xsel / clip.exe |
| `/resume` | Picker over recent sessions; prints resume command (in-process swap deferred) |
| `/model` | Picker over provider models when no arg; persists via DB |
| `/export [md|jsonl|json]` | Picker over format when no arg; writes `session-<short-id>.<ext>` |
| `/init` | Prompt-command that scans the project and writes `CONTEXT.md` |

**`/help` refactored** into a categorized 2-column layout (session / info / config / files / git / skills / other) with ANSI-aware visible-width padding so chalk wrapping doesn't misalign columns.

**CommandContext extended** with: `bundlePath`, `listSessions`, `getMetrics`, `skills`, `getLastAssistantText`, `getMessages`, `getPermissions`, `requestExit`. Shared test helper at `tests/commands/_makeCtx.ts`.

**Tests.** 37 new (8 picker navigation, 7 sessionDb listSessions/updateSessionModel, 11 info commands, 8 export+init, 3 misc). All 530 tests pass.

## Phase 10.5b Wave 1 hotfix — FileEdit diff line-context - 2026-05-03

Subagent-driven verification of Wave 1 surfaced a UX gap: the FileEdit diff renderer printed the raw `old_string`/`new_string` substrings (`- hello world` / `+ hello sovereign`) instead of the full line containing the change.

**Fix.** New optional `opts.preContent` in `DiffRenderOpts`. When provided for FileEdit, the renderer scans the file content for `old_string`, computes the surrounding line(s), and renders those full lines as `-`/`+` blocks with a 1-based line number. Multi-occurrence edits (`replace_all: true`) annotate the head with `(applied N× across M occurrences)` and render only the first hunk. Falls back to substring rendering when the match is missing, `old_string` is empty, or `preContent` is omitted.

**Wiring.** `terminalRepl.ts` reads the file synchronously at `tool_use` time (before the orchestrator dispatches the tool) and threads the snapshot through to `renderToolDiff` at `tool_result` time. FileWrite is unchanged.

**Tests.** 7 new diff tests covering full-line render, line numbers, multi-line `old_string`, multi-occurrence note, and fallbacks. All 493 tests pass.

## Phase 10.5b Wave 1 — REPL polish foundations - 2026-05-03

Make the REPL trustworthy. Modal prompts that don't get buried, status line that always shows where you are, errors you can actually read.

**`src/ui/modal.ts` — overlay primitive.** `withModal({title, rows, choices, parse, question})` renders a framed prompt that survives concurrent decorator output. Raises a module-level `modalActive` flag that decorators (spinner, slot) consult before writing. Boxed body uses `box.ts` for visual consistency. Re-prompts on parse failure with configurable message. Used by `permissions/prompt.ts` for the framed permission prompt.

**`src/ui/footer.ts` — pre-prompt status line.** `provider · model · ctx % · cost · perms · tools · bundle`, dim grey by default. Context segment turns yellow at warn threshold, red at danger threshold. Honors `NO_TTY` and `ui.footer.enabled`.

**`src/ui/contextMeter.ts` — token-utilization tracker.** Computes used / contextLength as a percentage. Exposes `getZone()` returning `'ok' | 'warn' | 'danger'` based on configurable thresholds (default 60% / 80%). Emits a one-shot pre-compaction warning a turn ahead of the auto-trigger so the user isn't surprised by silent compaction.

**`src/ui/diff.ts` — inline diff renderer for FileEdit / FileWrite.** Renders `- old / + new` lines under the tool slot summary. Verbose: full block. Non-verbose: head + tail with `… N more lines …` truncation. Multi-line `old_string` and `replace_all` both handled. Returns null for non-diff-shaped tools.

**Schema.** New optional `ui.{footer,contextMeter,diffRender}` block in `SettingsSchema`. All flags default to enabled / sensible thresholds.

**Wiring (`terminalRepl.ts`).** ContextMeter constructed from provider's contextLength. Updates on `usage_delta`. Footer printed before each prompt frame. Pre-compaction warning fires once when crossing 5% below the proactive threshold. Diff renderer called after successful FileEdit/FileWrite. Splash banner shows count of loaded allow-rules. ToolSlot multi-line errors show first line + `+N more lines` hint.

**Tests.** 42 new (modal/contextMeter/footer/diff). All 486 tests pass.

## Binary rename: `sovereign` → `sov` - 2026-05-01

CLI invocation shortened. `package.json` `bin` mapping is now `"sov": "./src/main.ts"`; `bun link` produces `~/.bun/bin/sov`. Commander program name, error prefix, in-session resume hint, max-tokens warning, WebSearch missing-API-key error message, and active docs (README, usage.md, architecture.md) all updated. Historical changelog/testing-log entries are kept verbatim. Existing users running `bun link` from this checkout will need to remove `~/.bun/bin/sovereign` (the old name) and re-`bun link` to install `sov`.

## Bundleless / generic-agent mode - 2026-05-01

`sovereign` now runs in any directory without a harness bundle. Bundle resolution still tries `--bundle` → `HARNESS_BUNDLE` → walk-up-for-`index.yaml`, but the no-match path no longer errors — it launches a generic agent with no bundle context, the splash shows `no bundle`, and resume hints/max-token warnings drop the `--bundle` arg.

**Identity moved to the bundle.** `BASE_INSTRUCTIONS` in `src/context/systemPrompt.ts` is now generic — no Sovereign-specific "canonical AI entity of the business" framing. That language moved to the docs-repo bundle's `state/CONTEXT.md` under a new `## Identity and voice` section, where it belongs per CLAUDE.md rule #9 ("no product-specific hardcoding in `src/`"). The generic prompt still describes the segment layout and points the model at any loaded bundle context as the authoritative project/business prior.

**Bundle plumbing made optional.** `loadBundleIfPresent(path)` is the new tolerant entry point used by the CLI; `loadBundle` still throws for callers that require one. `ToolContext.bundleRoot` and `LoadSkillsOptions.bundleRoot` are optional; the skill loader skips the three bundle-relative roots when unset (project + user roots still load). Session metadata stores `bundleRoot: null` for bundleless sessions; resume validation tolerates either side being unset.

**Tests.** `tests/bundle/loader.test.ts` covers null-path / missing-index / valid-bundle behavior. `tests/skills/loader.test.ts` adds a no-bundleRoot case. `tests/ui/splash.test.ts` and `tests/ui/terminalMessages.test.ts` assert the bundleless display + resume-hint shape. `tests/context/systemPrompt.test.ts` asserts the generic prompt has no Sovereign framing and no bundle segments when bundleless. Smoke-tested both modes end-to-end (`/tmp/sovereign-no-bundle-test` shows `no bundle`; `~/code/sovereign-ai-docs` shows the bundle path).

## Phase 10.2 complete — web reach (WebFetch + WebSearch) - 2026-04-29

Two model-callable tools added for open-web reach. Closes the gap relative to Claude Code (built-in WebFetch/WebSearch) and matches the Cloudflare-stack reference pattern noted in `sovereign-ai-docs/harness/docs/reference/cloudflare-internal-stack-analysis.md`.

**`WebFetchTool` (`src/tools/WebFetchTool.ts`).** Model-callable URL fetcher. Reuses `globalThis.fetch` with: private-host/loopback blocking (`localhost`, `127.x`, `10.x`, `192.168.x`, `172.16-31.x`, IPv6 link/private), 10s timeout, 1MB response cap, 5 redirects (platform default), 50K-char output cap (overridable up to 200K via `max_chars`). HTML responses pass through `htmlToText` — strips `<script>`/`<style>`/`<noscript>`/comments, converts block-level tags to newlines, decodes common entities. Plaintext/JSON/Markdown pass through verbatim. Read-only, concurrency-safe.

**`WebSearchTool` (`src/tools/WebSearchTool.ts`).** Pluggable search. Tavily default (free 1K queries/month, designed for AI agents); Brave optional. API key resolves from `webSearch.apiKey` config first, then `TAVILY_API_KEY` / `BRAVE_SEARCH_API_KEY` env vars. Throws a structured error with setup commands when no key is configured. Returns up to 20 `{title, url, snippet}` results — model uses these to discover URLs to drill into via WebFetch.

**Schema additions:** `webSearch.provider` (enum `tavily | brave`), `webSearch.apiKey` (secret, redacted in display), `webSearch.maxResults` (int 1–20). Surfaced in the config picker.

**Tests (19 new):** htmlToText edge cases, validateInput URL/scheme/private-host rejection, fetch mocks for HTML/plain/truncation/non-2xx, Tavily/Brave parsing, env-var fallback, max-results cap, no-key error.

**Build plan:** Phase 10.2 marked complete in `harness/docs/runtime/harness-build-plan.md`. The earlier "web search via MCP" recommendation in the Cloudflare analysis remains relevant for higher-fidelity needs (JS-rendered SPAs, browser-only content) — that comes naturally with Phase 12 (MCP client).

## REPL UX overhaul + Phase 10.1 config command - 2026-04-29

A session of UX hardening on top of Phase 10. Bundle resolution, conversation framing, tool-output rendering, and config management all got first-class user-facing surfaces. No new architectural phases beyond Phase 10.1 (drafted in the docs build plan as the writeable-config phase).

**Bundle resolution chain.** `--bundle` flag → `HARNESS_BUNDLE` env → walk up from CWD looking for `index.yaml`. Bare `sovereign` from inside any bundle directory now Just Works; `chat` is no longer needed in any documented invocation (still works for backward compat). Phase 10.8 (default bundle / bundleless invocation) remains drafted in the docs repo as the eventual fix for "no bundle anywhere upstream".

**Phase 10.1 — config command + `/config` slash + interactive picker.** New `src/config/store.ts` shared by:
- `sovereign config show|path|get|set|unset` CLI subcommands
- `/config <verb>` in-session slash command
- `sovereign config` (no verb) opens a hand-rolled raw-mode picker with ↑/↓ navigation, choice sub-pickers for enum-shaped fields (defaultProvider, defaultModel scoped by provider, permissionMode, maxTurns, etc.), Enter to edit, `u` to unset, `s` to save and quit. Every write is zod-validated before touching disk; secret-bearing paths (`apiKey`, `apiKeys`, `credentials.apiKey`) are redacted in display. Phase 16.7 will replace the picker with an Ink-based TUI.

**Tunable proactive compaction.** New `compaction.proactiveThresholdPct` setting (1–99, default 75%). Default raised from 50% so small-context local models get headroom for the bundle's system prompt. Compactor self-guards: when the frozen system prompt alone exceeds the threshold (heavy bundle on a small-context model) `shouldCompactProactively` returns false instead of firing in a runaway loop.

**Ollama `num_ctx` auto-pinning.** Provider now sends `num_ctx` based on the model's registered context length (qwen2.5 family → 32K, llama3.1 → 128K). Override per-deployment via `providers.ollama.numCtx`. Stops the silent 2K-truncation that was causing constant compaction on local sessions. New models registered: `qwen2.5:7b/14b/32b`, `llama3.1:8b/70b`, `mistral-nemo`.

**Configurable maxTurns.** New `maxTurns` setting (positive int, default 100). Reframed in the schema as a runaway-loop circuit breaker rather than a task ceiling, mirroring Claude Code's "rely on permissions + Ctrl-C, not a numeric cap" pattern.

**REPL UX layer (`src/ui/`).** Six new modules + significant `terminalRepl.ts` work:
- `splash.ts` — startup splash with block-letter "S" logo (cyan→blue gradient) next to a boxed info card showing version, provider/auth, model, bundle path
- `sessionSummary.ts` — boxed goodbye summary with Interaction Summary (session ID, tool calls, success rate), Performance (wall time, agent active, API time, tool time), and Tokens (total, cache, est. cost)
- `box.ts` — shared unicode-box helper (`╭─╮ │ ╰─╯`) with ANSI-aware width
- `thinking.ts` — braille spinner (`Thinking 12s ↑ 1234 ↓ 56`) with 500ms grace, live token counts that tick from streamed chars and lock to the authoritative `usage_delta` value when it lands
- `markdownStream.ts` — line-buffered markdown renderer for streamed text deltas (headings, bold/italic/inline code, bullet/numbered lists, blockquotes, fenced code, hrules)
- `toolSlot.ts` — compact in-place tool display: sequential tool calls overwrite a single line via `\x1b[1A\x1b[2K`. With ANSI-clear-of-inter-tool-text logic in `terminalRepl.ts`, a 20-tool thinking run leaves one line of "what happened" between user input and final answer instead of 40
- `writeStatusLine` helper enforces leading + trailing newlines on every bracketed status (`[tool: ...]`, `[cleared ...]`, `[debug] ...`, `[error] ...`) so they never collide with adjacent assistant text
- Input frame: top + bottom dim-gray rules around the readline prompt (TTY-only, ANSI-positioned), so `> your message` always reads as a distinct visual block
- Final-answer prelude: every fresh agent text run gets one leading `\n` so prose never crams against a slot or status line

**Tool result visibility.** Default rendering is now a one-line summary (`└─ ok · 663 lines, 22.7K chars` or `└─ error · ...`). Pass `--verbose` (or set `verbose: true` in config) for the full 40-line / 4K-char preview block. Errors render in red.

**Debug mode umbrella.** `debugMode.enabled = true` auto-enables every child capability (currently `transcript`, with `transcriptDir` honored). When the umbrella is unset, children remain individually toggleable a la carte. When transcripts are auto-enabled by debug mode, the REPL prints `[debug] transcript → <path>` at startup so the user sees where their JSONL is going.

**Per-turn `[usage:]` gated behind debugMode.** Removed from default output (token usage still recorded to the DB and summarized in the goodbye box; the per-turn line was redundant noise).

**Bundle-side companion.** `~/code/sovereign-ai-docs/state/CONTEXT.md` got a "How tool results reach the user" section telling the agent that tool output isn't auto-shown to the user — to display content, paste it into the reply text inside a code fence. Pairs with the harness's tool-result preview surfacing.

**Hardening.**
- Fixed `exactOptionalPropertyTypes` typecheck failures that broke CI
- 21+ new tests across config store, slash command, picker, splash, summary, markdown rendering, thinking indicator, tool slot, and Ollama num_ctx wiring (382 tests passing as of session end, up from 337)

## Cross-Repo Sync Queue - 2026-04-28

Added `notify-docs.yml` GitHub Action (H-0009). On push to master, if CHANGELOG.md, DECISIONS.md, or README.md changed, the workflow appends a structured entry to the docs repo's `state/feed/harness-sync-queue.md`. Agent sessions on the docs repo process pending entries during boot. Requires `DOCS_REPO_TOKEN` PAT secret.

## Qwen Amendment Phases A+B Complete - 2026-04-28

Two production-hardening patterns from the Qwen Code analysis integrated as targeted deepenings of completed phases.

**Phase A — Microcompaction.** Per-part tool-result clearing as a first-line defense before full compaction. When compactable tool results (Bash, Read, Write, Edit, Grep, Glob) exceed 40% of estimated context tokens, all but the 5 most recent results are replaced with short placeholders. No model call, no latency hit. Integrated into the query loop after every tool-result round; emits a `microcompact` StreamEvent rendered by the REPL. Settings-configurable via `microcompaction: { enabled, keepRecent, triggerThresholdPct }` in `~/.harness/config.json`.

**Phase B — Shell command AST analysis.** Hand-written quote-aware tokenizer mapping 60+ shell commands to virtual Read/Write/Edit/Web operations. `Bash("cat src/main.ts")` resolves as a Read operation and matches Read permission rules without requiring an explicit `Bash(cat *)` allow rule. Transparent prefix stripping for sudo, timeout, env, nice, nohup. Command substitution ($(), backticks) conservatively returns unsafe. Redirects (>, >>) promote read commands to write. `virtualToolName` added to the `Tool<I,O>` interface; BashTool implements it via `analyzeShellCommand()`. The permission evaluator now checks rules for both the actual tool name and the virtual tool name.

## Phase 10 Complete - 2026-04-26

Context-window compaction. The REPL supports `/compact`, creates a child session with `parent_session_id`, writes a guarded handoff summary plus the preserved tail into the child, and leaves parent messages intact for `/rollback`. Schema version 3 records lineage, estimated message tokens, and separate compaction cost lanes. The REPL proactively compacts above 50% of the model context window and retries once after provider context-overflow errors.

## Phase 9.5 Complete - 2026-04-25

Skills production upgrade. The system prompt carries only a progressive-disclosure reminder; models discover skills through `skills_list` and inspect bodies/reference files through `skill_view`. Skills support visibility gates (`metadata.harness.requires_*` / `fallback_for_*`), trust-tier guard scanning for third-party content, `${HARNESS_SKILL_DIR}` / `${HARNESS_SESSION_ID}` substitutions, `!` inline-shell interpolation, and an agent-created skill writer via `skill_manage` under `$HARNESS_HOME/skills/agent-created/`.

## Phase 9 Complete - 2026-04-25

Skills MVP. Markdown files under `<cwd>/.harness/skills/`, `$HARNESS_HOME/skills/`, and `<bundle>/skills/` load as skills with YAML frontmatter (`name`, `description`, `allowedTools`, `whenToUse`). Skills register as prompt slash commands and can be activated by the model through `SkillTool`. Skill bodies support `{{args}}` substitution.

## Phase 8 Complete - 2026-04-25

Slash commands and session cost accounting. The REPL dispatches `/help`, `/clear`, `/cost`, `/model <name>`, and prompt-backed `/commit` through `src/commands/`. Prompt commands temporarily narrow the visible tool pool and permission surface; `/commit` can use only scoped git status/diff/add/commit Bash operations. The session DB migrated to schema version 2 with token and estimated-cost columns, and each provider turn records input/output/cache token usage plus a price-table estimate used by `/cost`.

## Phase 7 Complete - 2026-04-25

Rule-based permissions. The runtime loads layered permission settings from `$HARNESS_HOME/settings.json`, `<cwd>/.harness/settings.json`, and `<cwd>/.harness/settings.local.json` with local > project > user precedence. Rules support `allow`, `deny`, and `ask` entries such as `Bash(git *)`, `Read(*.ts)`, `Write(notes.md)`, `Edit`, or `mcp__server`, with matching delegated to each tool. Deny rules win within a layer, allow rules skip prompts, ask rules force a prompt, and mode fallthrough is `default`, `ask`, or `bypass`. "Always" approvals persist a specific allow rule into project-local settings instead of allowing a whole tool by name. Permission `updatedInput` is revalidated and honored before tool execution.

## Phase 6.7 Complete - 2026-04-25

Context references and subdirectory hint loading. User turns expand `@file:path`, `@file:"path with spaces"`, `@file:path:10-20`, `@folder:path`, `@diff`, `@staged`, and `@url:https://...` before the provider call, with sensitive-path blocks for SSH/AWS/GPG/Kube material, shell rc files, sudoers, and `/etc/passwd`/`/etc/shadow`. Tool results for newly touched directories append nearby safe `AGENTS.md`, `CONTEXT.md`, and `.cursorrules` hints instead of mutating the frozen system prompt.

## Phase 6.5 Complete - 2026-04-25

Bounded memory surfaces. `$HARNESS_HOME/memory/USER.md` and `$HARNESS_HOME/memory/MEMORY.md` are read once per user turn, fenced as recalled context in the user message, and never spliced into the system prompt. The `memory` tool supports explicit `view` and `replace`; over-cap writes fail with a consolidation error rather than truncating. A memory-provider abstraction is in place and rejects more than one external non-builtin provider.

## Phase 6 Complete - 2026-04-25

Context assembly, prompt-cache boundaries, and injection defense. New sessions freeze a static-to-dynamic system prompt: base instructions, available tools, bundle context/memory, runtime facts, and local user/project context. Runtime facts capture OS, shell, cwd, date, git status, recent commits, and recent branches once per session; `--resume` reuses the stored system prompt verbatim. Local context discovery merges `~/.harness/CONTEXT.md` first, then `AGENTS.md`, `CONTEXT.md`, and `.cursorrules` from filesystem root to cwd. Suspicious or oversized context files are blocked/truncated before inclusion. Anthropic applies cache markers to cacheable system segments plus the last three messages; `--no-cache` disables provider cache markers for testing.

## Phase 5.5 Complete - 2026-04-25

Provider hardening. `resolveProvider()` is the single entrypoint for Anthropic, OpenAI, OpenRouter, and Ollama. API-key providers use a persistent credential-pool metadata file at `~/.harness/credentials.json` for status, cooldown, and usage only. A cross-session rate guard writes `~/.harness/rate_limits/<provider>.json` after 429s so other sessions pause or fail fast instead of amplifying retries. Auxiliary clients (`compression`, `title`, `web-extract`) resolve through the cheap fallback chain OpenRouter to Anthropic Haiku to OpenAI mini to local Ollama.

## Phase 5 Complete - 2026-04-25

Multi-provider core. The CLI accepts `--provider anthropic|openai|openrouter|ollama`; `--model` overrides provider/config defaults. Anthropic keeps native prompt-cache markers, OpenAI/OpenRouter flatten system segments into a system message, and Ollama speaks `/api/chat`. All providers normalize back into the same internal `StreamEvent` and content-block message shape, so `query()`, the tool loop, permissions, and session persistence remain provider-agnostic.

## Phase 4 Complete - 2026-04-24

Tool ecosystem and concurrency-safe batching. Five tools landed alongside Bash: `FileRead`, `FileWrite`, `FileEdit`, `Grep`, and `Glob`. The orchestrator partitions per-turn `tool_use` blocks into contiguous concurrent and serial runs, splits concurrent runs into path-conflict-free sub-batches, caps batches at 10, and reinserts results in original tool-call order.

## Phase 3.5 Complete - 2026-04-24

Conversations persist across runs. SQLite via `bun:sqlite` plus WAL and FTS5 at `~/.harness/sessions.db` by default; schema-versioned migrations framework in place. Every user, assistant, and tool-result message is saved as it is produced. `--resume <uuid>` hydrates history and the frozen system prompt from the stored session. Bundle mismatch on resume is rejected with a clear error. Jittered retry plus periodic WAL checkpoints prepare for later multi-writer contention.

## Phase 3 Complete - 2026-04-24

Permission prompts around every tool dispatch. The orchestrator calls `canUseTool()` before `tool.call()`; denials flow back as `is_error` tool-result blocks. `query()` now propagates its `AbortSignal` into the tool context. Phase 7 later replaced the original coarse tool-name "always" cache with rule-based matching.

## Phase 2 Complete - 2026-04-24

Streaming REPL with the first tool wired through a full `buildTool()` to registry to orchestrator to `query()` loop. `BashTool` was the first capability. Tool results flow back as a user message with `tool_result` content blocks.

## Phase 1 Complete - 2026-04-24

Baseline streaming REPL against Anthropic, in-memory history, Ctrl-C aborts stream, `/quit` or Ctrl-D exits.

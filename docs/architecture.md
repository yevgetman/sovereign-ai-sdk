# Runtime Architecture

This repo is the TypeScript runtime for a Claude-Code-style agent harness. It reads a harness bundle as data, builds a cached conversation frame around that bundle, streams model events through a provider adapter, dispatches tools through a uniform tool contract, and persists the resulting session.

The authoritative product and business context lives in `~/code/sovereign-ai-docs/`. This repo owns runtime behavior only.

## Request Flow

The interactive path is:

1. `src/main.ts` parses CLI flags and starts `runRepl()` from `src/ui/terminalRepl.ts`.
2. The REPL resolves the bundle path, provider, model, settings, session DB, tools, skills, slash commands, permissions, memory provider, and system prompt.
3. User input is first checked for slash commands. Local commands return immediately; prompt commands become normal user turns with a narrowed tool scope.
4. Normal user turns expand context references such as `@file:`, `@folder:`, `@diff`, `@staged`, and `@url:`.
5. `query()` in `src/core/query.ts` calls the selected `LLMProvider.stream()` with internal content-block messages and segmented system prompt.
6. Provider adapters translate between internal messages and provider-specific wire formats under `src/providers/`.
7. Assistant stream events are yielded back to the REPL as they arrive.
8. If the assistant returns `tool_use` blocks, `runTools()` in `src/core/orchestrator.ts` executes them, yields a user `tool_result` message, appends it to history, and loops back to the provider.
9. The loop terminates when the assistant returns no tool calls, `maxTurns` is reached, the user interrupts, or a provider/tool error occurs.
10. Session messages, token usage, compaction lineage, and costs are stored through `src/agent/sessionDb.ts`.

## Core Contracts

`src/core/types.ts` defines the internal message shape. `Message` always carries an array of `ContentBlock`s: text, thinking, tool use, tool result, and image. Providers translate at the boundary; core runtime code never speaks provider-native message shapes directly.

`query()` is an async generator:

```ts
async function* query(params: QueryParams): AsyncGenerator<StreamEvent | Message, Terminal>
```

That shape is a load-bearing contract. It lets the REPL render partial model output, tool results, usage events, and terminal state without collapsing the turn loop into a single promise.

`src/tool/types.ts` defines the uniform capability contract. Native tools, future MCP tools, skills, and sub-agents all flow through `Tool<I, O, P>`. Every concrete tool is created with `buildTool()` so fail-closed defaults are applied consistently.

`src/providers/types.ts` defines `LLMProvider`. Core code calls only `provider.stream(req)`; SDK calls and provider-specific normalization stay under `src/providers/`.

## System Prompt And Context

System prompt assembly lives under `src/context/`. New sessions freeze a static-to-dynamic segmented prompt:

- base runtime instructions
- available tool summary
- bundle context and memory
- runtime facts such as cwd, OS, shell, date, and git status
- local user/project context from `AGENTS.md`, `CONTEXT.md`, `.cursorrules`, and user context files

Each segment has a `cacheable` marker. Providers that support prompt caching translate this into provider-specific cache controls; other providers concatenate the text and ignore the marker.

On resume, the session reuses the exact frozen system prompt from SQLite. Runtime facts and local context are not rebuilt for an existing session.

Current-turn context is injected through the user message, not by mutating the frozen system prompt. That includes bounded memory snapshots and explicit references such as `@file:src/main.ts`.

## Tool Execution

Tool calls are handled by `runTools()`:

- Unknown tools return an error `tool_result`.
- Inputs are validated with the tool schema and optional `validateInput()`.
- Permissions run before execution through `CanUseTool`.
- `PermissionResult.updatedInput` is revalidated before execution.
- Serial tools run in order.
- Concurrency-safe tools run in batches capped by `CONCURRENT_CAP`.
- Filesystem path overlaps serialize writer-vs-reader or writer-vs-writer conflicts.
- Results are emitted in the original tool-call order regardless of completion order.

The default tool posture is conservative. If a tool does not explicitly opt into read-only or concurrency-safe behavior for a particular input, it is treated as potentially stateful and runs serially.

After tool results are assembled and pushed to history, the query loop evaluates microcompaction (see below). If stale tool results are cleared, the compacted history replaces the in-memory history before the next provider call.

## Web Tools

Two model-callable tools handle open-web reach:

- `WebFetchTool` (`src/tools/WebFetchTool.ts`) — wraps `globalThis.fetch` with private-host blocking, timeout/size caps, redirect following, and an HTML→text reduction (strips `<script>`/`<style>`/comments, converts block tags to newlines, decodes basic entities). Sufficient for documentation pages, blog posts, news articles, raw markdown/JSON.
- `WebSearchTool` (`src/tools/WebSearchTool.ts`) — pluggable search via Tavily (default) or Brave. API key resolves from `webSearch.apiKey` config, then `TAVILY_API_KEY` / `BRAVE_SEARCH_API_KEY` env. Throws with a setup hint when no key is configured. Returns up to 20 `{title, url, snippet}` results.

The tools run with `isReadOnly: true, isConcurrencySafe: true`. The user-only `@url:` context reference (Phase 6.7) and these model-callable tools coexist: the reference inlines a URL into the user message at the start of a turn, while `WebFetch` lets the model decide to fetch a URL it discovered mid-conversation.

## Permissions

Permission settings are layered from local to global:

1. `<cwd>/.harness/settings.local.json`
2. `<cwd>/.harness/settings.json`
3. `$HARNESS_HOME/settings.json`

Rules are matched by tool name and tool-specific pattern semantics. Deny wins within a layer; otherwise allow and ask rules decide behavior. Fallthrough behavior comes from `permissionMode`.

The permission interface is intentionally transformable:

```ts
{ behavior: 'allow' | 'deny' | 'ask', updatedInput?: unknown, reason?: string }
```

That lets permission checks normalize or narrow inputs before the tool runs.

### Shell AST Analysis And Virtual Tool Mapping

Tools can declare a `virtualToolName(input)` method that maps their input to a different tool name for permission resolution. The permission evaluator checks rules for both the actual tool name and the virtual tool name.

`BashTool` uses this to map read-only shell commands to `Read`. When a user has `Read` in their allow rules, `Bash("cat src/main.ts")` resolves as a Read operation and runs without prompting. The mapping is provided by `src/permissions/shellSemantics.ts`, which parses shell commands into virtual operations:

- Read: `cat`, `head`, `grep`, `ls`, `find`, `git log`, `git status`, etc. (60+ commands)
- Write: `cp`, `mv`, `mkdir`, `touch`, `git commit`, `git push`, etc.
- Edit: `rm`, `chmod`, `sed -i`, etc.
- Web: `curl`, `wget`
- Unsafe: command substitution (`$(...)`, backticks), `eval`
- Exec: unrecognized commands (fall through to existing Bash rules)

Transparent prefix stripping handles `sudo`, `timeout`, `env`, `nice`, `nohup`. Redirects (`>`, `>>`) promote read commands to write. The analysis is fail-closed: unrecognized commands fall through to the existing Bash permission behavior, never to `allow`.

## Persistence

Session persistence lives in `src/agent/sessionDb.ts` and uses `bun:sqlite` with WAL, schema migrations, FTS5, and a jittered busy retry wrapper.

The DB stores:

- sessions and parent-child compaction lineage
- frozen system prompts
- user and assistant messages
- estimated message token counts
- input/output/cache token usage
- estimated provider and compaction costs

The default database is `$HARNESS_HOME/sessions.db`, normally `~/.harness/sessions.db`.

## Microcompaction

Microcompaction (`src/compact/microcompact.ts`) is a lightweight context-management layer that runs before full compaction. After every tool-result round, the query loop estimates what percentage of the conversation's tokens come from compactable tool results. When that exceeds `triggerThresholdPct` (default 40%), it clears all but the `keepRecent` (default 5) most recent tool results by replacing their content with a short placeholder like `[Tool result cleared — Read]`.

Microcompaction differs from full compaction:

- No model call — it replaces content directly, not via a summarization turn.
- Per-part granularity — individual `tool_result` blocks are cleared, not entire messages.
- Error preservation — `is_error` tool results are never cleared; the model needs error context to recover.
- Idempotent — already-cleared results are skipped on subsequent passes.
- Reversible via DB — the session DB retains the original content; `/rollback` restores the uncleared history.

The compactable tool set covers tools with large, transient output: Bash, Read, FileRead, Write, FileWrite, Edit, FileEdit, Grep, Glob. Skills and memory tools are excluded.

Configuration via `~/.harness/config.json`:

```json
{
  "microcompaction": {
    "enabled": true,
    "keepRecent": 5,
    "triggerThresholdPct": 40
  }
}
```

A `microcompact` StreamEvent is emitted when clearing occurs, rendered by the REPL as `[cleared N stale tool results, ~XK tokens]`.

## Runtime State

Runtime-local state belongs under `$HARNESS_HOME` by default:

- `sessions.db`
- `memory/USER.md`
- `memory/MEMORY.md`
- `settings.json`
- `credentials.json`
- provider rate-limit files
- agent-created skills

Bundle state is documented separately in `src/bundle/README.md`. The runtime must never write tier-1 business content or tier-2 schema/script content.

## REPL UX Layer

`src/ui/` contains the user-facing rendering for the streaming turn loop. The runtime stays UI-agnostic — REPL components consume `StreamEvent`s and `Message`s from `query()` without affecting tool/provider/permission semantics.

### Core surfaces

- `terminalRepl.ts` — input loop, slash-command dispatch, streaming-loop event handler, session-DB writes, goodbye/resume printing. Selects between the legacy readline path and the Wave-4 input editor based on `process.stdin.isTTY` and the `--legacy-input` flag.
- `splash.ts` — startup banner (block-letter logo + boxed info card). Splash footer shows `(N allow rules loaded)` when persistent rules are configured.
- `sessionSummary.ts` — boxed exit summary (interaction stats, performance, token totals).
- `box.ts` — shared unicode-box helper with ANSI-aware width. Consumes the active theme's `border` token by default.
- `markdownStream.ts` — line-buffered markdown renderer for streamed text deltas.
- `thinking.ts` — braille spinner + live token counts during quiet periods. Suppresses itself while a modal is up.
- `toolSlot.ts` — compact in-place tool-call display. Multi-line tool errors show the first line plus `· +N more lines`.
- `transcript.ts` — redacted JSONL session transcript writer.
- `terminalMessages.ts` — formatted warnings (max-tokens hit, partial mutation, etc.).

### Wave 1 — polish foundations (Phase 10.5b)

- `modal.ts` — `withModal({title, rows, choices, parse, question})` overlay primitive. Raises a module-level `modalActive` flag; decorators (`thinking.ts`, `toolSlot.ts`) consult `isModalActive()` and skip writes while a modal is up. The framed permission prompt routes through this.
- `footer.ts` — `printPrePromptFooter()` renders a single dim status line above each input frame: `provider · model · ctx N% · $cost · perms · tools · bundle`. Honors `process.stdout.isTTY` and `ui.footer.enabled`.
- `contextMeter.ts` — token-utilization tracker. Subscribes to `usage_delta` events and exposes `getZone()` returning `'ok' | 'warn' | 'danger'` based on configurable thresholds. Emits a one-shot pre-compaction warning when crossing 5% below the proactive threshold.
- `diff.ts` — inline `+ / -` renderer for FileEdit / FileWrite. Reads the file synchronously at `tool_use` time (before the orchestrator dispatches the tool) so it can show full-line context with a 1-based line number, not just the matched substring. Multi-occurrence edits (`replace_all: true`) annotate the head with `(applied N× across M occurrences)` and render only the first hunk.

### Wave 2 — pickers & commands (Phase 10.5c)

- `picker.ts` — generic raw-mode picker. ↑/↓/PgUp/PgDn/Home/End/Enter/Esc. Returns `Promise<T | null>`. Restores raw mode + cursor + screen in `finally`. Used by `/resume`, `/model`, `/export`, `/theme`.
- `configMenu.ts` — interactive picker for `sov config` (no verb) and `/settings` slash command. Pre-dates `picker.ts` but uses a similar pattern.
- New slash-command modules (`src/commands/info.ts`, `pickers.ts`, `sessionOps.ts`) implement `/about`, `/tools`, `/skills`, `/stats`, `/permissions`, `/quit` (+ aliases), `/copy`, `/resume`, `/model`, `/theme`, `/export`, `/init`, `/settings`. `/help` rewritten as a categorized 2-column layout in `registry.ts` with ANSI-aware visible-width padding.
- `agent/sessionDb.ts` gains `listSessions(limit)` and `updateSessionModel(id, model)` for `/resume` and persistent `/model` picks.

### Wave 3 — theme system (Phase 10.5d)

- `theme.ts` — semantic token registry (`text`, `accent`, `status×4`, `diff×3`, `border×3`, `code×2`, `header×3`, etc.) with three built-in themes: `dark` (default — preserves the existing look), `light` (darker primaries via `chalk.rgb`), `no-color` (identity tokens). Singleton mutated by `setTheme(name)`; `theme.tokens` is a getter so swapping themes takes effect on the next renderer call without re-imports. `resolveThemeName({configured, env})` honors `NO_COLOR` overriding the configured value.
- High-traffic renderers (`footer`, `diff`, `modal`, `thinking`, `toolSlot`, `box`, `splash`) consume `theme.tokens.<role>(...)` instead of literal `chalk.<color>(...)`. The migration is invisible under the dark theme — every existing test passes without assertion changes.

### Wave 4 — input editor (Phase 10.5e)

- `keypress.ts` — raw-mode dispatcher. Parses ANSI escapes (CSI, SS3) + bracketed paste + control chars + Alt-letter into typed `Key` events. Reference-counted enable/disable. Modal-aware (suppresses dispatch while a modal is up). 50ms Esc-flush timer: lone ESC bytes that aren't followed by more data within the window emit a plain `escape` key; subsequent bytes within the window cancel the timer and route the ESC into a CSI/Alt sequence.
- `textBuffer.ts` — multi-line buffer with row/col cursor. Standard editor ops (`insert`, `delete×4`, `move×8`). `wrapForDisplay(rendered, width)` is a pure helper that wraps each long logical line into multiple display chunks of ≤ width chars and maps the cursor from logical (row, col) to display (row, col).
- `inputHistory.ts` — persistent history at `$HARNESS_HOME/input-history`. 1000-entry cap, dedup against previous entry, embedded newlines escaped as `\n`.
- `autocomplete.ts` — pure completion. Slash commands and `@file` paths.
- `inputEditor.ts` — drop-in replacement for `question(prompt) ⇒ Promise<string>`. Owns one TextBuffer + subscribes to keypress events. Handles Enter (with `\` line-continuation), Tab autocomplete (cycle on repeat), Up/Down history, full readline-style keybinds, Ctrl-R reverse-i-search (with Esc/Ctrl-G cancel). Re-renders the buffer area on every keystroke with ANSI cursor positioning. Paste bursts insert literally without keybind dispatch. Soft-wrap via `wrapForDisplay()` when the line exceeds terminal columns.

The editor is the default when `process.stdin.isTTY === true`. Piped stdin falls through to the legacy `readline` + `queuedQuestion` path automatically (so CI / scripted sessions keep working). The `--legacy-input` flag forces the legacy path regardless.

Status-line writes (`[tool: ...]`, `[cleared ...]`, `[debug] ...`, `[error] ...`) all flow through a single `writeStatusLine` helper that enforces leading + trailing newlines so they never collide with adjacent assistant text. The compact tool slot tracks line count via ANSI cursor manipulation; when a new tool fires it clears any inter-tool preamble text and the previous slot line in one operation.

## Compaction

Full compaction (`/compact`) summarizes message history into a child session. Proactive compaction fires automatically when `system_prompt + history > contextLength * proactiveThresholdPct` (default 75%). The compactor self-guards: when the system prompt alone exceeds the threshold, proactive compaction returns false instead of firing — it can only reduce message history, not the system prompt, so otherwise it would loop indefinitely against an oversized bundle.

`compaction.proactiveThresholdPct` (1–99) is settings-configurable in `~/.harness/config.json`. Reactive compaction (post-error retry on context-overflow) is unconditional.

## Semantic Test Suite

A second test category lives under `tests/semantic/`, separate from the unit/integration suites. Where unit tests verify functions in isolation, semantic tests drive the real `sov` binary as a subprocess and have an LLM judge evaluate the resulting transcript against per-test criteria.

**Architecture (3 layers, each swappable):**

- `framework/sandbox.ts` builds the per-test ephemeral env (`HARNESS_HOME`, `HARNESS_CONFIG`, sessions DB, working dir) and guarantees cleanup.
- `framework/driver.ts` spawns the binary, pipes `<prompt>\n/quit\n`, captures stdout/stderr, ANSI-strips, applies a per-test timeout. Defaults the agent model to `claude-sonnet-4-6` unless the test specifies one via `binaryArgs`.
- `framework/judges/` is a pluggable backend dir. `Judge` is a function type `(test, transcript) => Promise<JudgeVerdict>`. Two backends ship: `claudeCode.ts` (default — shells out to local `claude` CLI in `--print` mode with `--tools ""` for isolation; uses the user's subscription) and `anthropicApi.ts` (opt-in — direct `@anthropic-ai/sdk` call with tool-use; needs `ANTHROPIC_API_KEY`). `index.ts` does auto-detection based on PATH. Adding a new backend (codex, `sov`-itself, etc.) is one new file plus a `selectJudge` switch case.
- `framework/runner.ts` is judge-agnostic: it accepts a `Judge` and never inspects which backend produced it.

**Isolation invariants:**

- Framework code never imports from `src/`. The binary under test is always a subprocess.
- File names match `*.cases.ts` and `run.ts` — neither matches Bun's `*.test.ts` / `*.spec.ts` discovery, so `bun test` ignores the suite.
- Suite runs are opt-in via `bun run test:semantic`; the script is purely additive in `package.json`.
- Per-test sandbox cleanup is idempotent and runs in a `finally` block.
- Judge subprocess (when using `claude-code`) runs in `os.tmpdir()` with `--no-session-persistence`, `--disable-slash-commands`, `--tools ""`.

**Verdict shape.** The judge returns `{pass, reasoning, satisfiedCriteria, failedCriteria, costUsd, tokens, backend}`. The reporter shows `subscription` for `claude-code` zero-cost results and a dollar figure (informational under subscription) when the envelope reports one.

**Coverage.** 30 tests spanning 8 tool-dispatch cases (Bash/Read/Edit/Write/Glob/Grep + error paths), 4 slash-command dispatch paths (/help local, /commit, /init, /<skill>), 6 permission cases (including the highest-stakes virtual-tool-name mapping and layer-precedence invariant), 4 refusal cases (anti-fabrication + prompt-injection resistance), 2 context-expansion cases, and 6 workflow cases including end-to-end `/compact` and `/rollback`. See [`docs/semantic-testing.md`](./semantic-testing.md) for the full inventory with bug-class breakdown per test, and [`tests/semantic/README.md`](../tests/semantic/README.md) for the developer-facing design and porting guide.

## Extension Surfaces

The primary extension surfaces are:

- `src/tools/` and `src/tool/` for native tools (including `virtualToolName` for cross-tool permission mapping)
- `src/providers/` for model providers
- `src/commands/` for slash commands
- `src/skills/` for markdown skills and skill discovery
- `src/compact/microcompact.ts` for microcompaction config and compactable tool sets
- `src/permissions/shellSemantics.ts` for shell command classification (add commands to the handler sets)
- `src/agent/sessionDb.ts` for schema migrations
- future `src/hooks/`, `src/mcp/`, `src/review/`, `src/router/`, and `src/trajectory/` phase landing zones

See `docs/extending.md` for concrete recipes.

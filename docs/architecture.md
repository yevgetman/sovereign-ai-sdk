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

Components:

- `terminalRepl.ts` — readline prompt loop, slash-command dispatch, streaming-loop event handler, session-DB writes, goodbye/resume printing
- `splash.ts` — startup banner (block-letter logo + boxed info card)
- `sessionSummary.ts` — boxed exit summary (interaction stats, performance, token totals)
- `box.ts` — shared unicode-box helper with ANSI-aware width
- `markdownStream.ts` — line-buffered markdown renderer for streamed text deltas
- `thinking.ts` — braille spinner + live token counts during quiet periods
- `toolSlot.ts` — compact in-place tool-call display
- `transcript.ts` — redacted JSONL session transcript writer
- `terminalMessages.ts` — formatted warnings (max-tokens hit, partial mutation, etc.)
- `configMenu.ts` — interactive picker for `sovereign config` (no verb)

Status-line writes (`[tool: ...]`, `[cleared ...]`, `[debug] ...`, `[error] ...`) all flow through a single `writeStatusLine` helper that enforces leading + trailing newlines so they never collide with adjacent assistant text. The compact tool slot tracks line count via ANSI cursor manipulation; when a new tool fires it clears any inter-tool preamble text and the previous slot line in one operation.

## Compaction

Full compaction (`/compact`) summarizes message history into a child session. Proactive compaction fires automatically when `system_prompt + history > contextLength * proactiveThresholdPct` (default 75%). The compactor self-guards: when the system prompt alone exceeds the threshold, proactive compaction returns false instead of firing — it can only reduce message history, not the system prompt, so otherwise it would loop indefinitely against an oversized bundle.

`compaction.proactiveThresholdPct` (1–99) is settings-configurable in `~/.harness/config.json`. Reactive compaction (post-error retry on context-overflow) is unconditional.

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

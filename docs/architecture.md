# Runtime Architecture

This repo is the TypeScript runtime for a Claude-Code-style agent harness. It reads a harness bundle as data, builds a cached conversation frame around that bundle, streams model events through a provider adapter, dispatches tools through a uniform tool contract, and persists the resulting session.

The authoritative product and business context lives in `~/code/sovereign-ai-docs/`. This repo owns runtime behavior only.

## Request Flow

Two processes — a TypeScript runtime/server (on Bun) and a Go Bubble Tea TUI client (`sov-tui`) — talk over HTTP+SSE on localhost. The same native HTTP+SSE protocol backs every interactive surface: the TUI, `sov drive` (headless line-driven), and `sov gateway`, a long-lived authenticated server that exposes that protocol off-loopback for remote clients (the run-anywhere roadmap A–F: secure gateway, multi-client transport, web UI, persistent supervisor, multi-user, channels — see "Native Gateway" below). The interactive path:

1. `src/main.ts` parses CLI flags and resolves the bundle, provider, model, settings, session DB, tools, skills, slash commands, permissions, memory provider, system prompt — then starts the Hono server (`src/server/index.ts`) on a dynamic port. `src/cli/tuiLauncher.ts` forks `sov-tui` as a subprocess, passing `--port`, `--session-id`, `--model`, `--provider` as CLI args.
2. `sov-tui` connects to `GET /sessions/:id/events` (SSE) for the live event stream and `GET /sessions/:id/messages` for backlog hydration on resume.
3. User input in the TUI is first checked for slash commands. Local commands route to dedicated endpoints (e.g. `POST /sessions/:id/compact`); other slashes dispatch through `POST /sessions/:id/commands`. Plain prose POSTs to `POST /sessions/:id/turns`.
4. Normal user turns expand context references such as `@file:`, `@folder:`, `@diff`, `@staged`, and `@url:` server-side before the model call.
5. `query()` in `src/core/query.ts` calls the selected `LLMProvider.stream()` with internal content-block messages and segmented system prompt.
6. Provider adapters translate between internal messages and provider-specific wire formats under `src/providers/`.
7. Stream events (`text_delta`, `thinking_delta`, `tool_use_start`, `tool_result`, `status_update`, `turn_complete`, etc.) are published onto the per-session `ServerEventBus` and forwarded over SSE to the TUI as they arrive. The bus is multi-subscriber with a bounded replay ring (Phase B) — multiple clients can watch one session and a dropped client can reconnect with `Last-Event-ID`; see "Native Gateway" below.
8. If the assistant returns `tool_use` blocks, `runTools()` in `src/core/orchestrator.ts` executes them, yields a user `tool_result` message, appends it to history, and loops back to the provider.
9. The loop terminates when the assistant returns no tool calls, `maxTurns` is reached, the user interrupts (ESC → `POST /sessions/:id/cancel`, see "Per-Turn Cancellation" below), or a provider/tool error occurs.
10. Session messages, token usage, compaction lineage, and costs are stored through `src/agent/sessionDb.ts`.

## Core Contracts

`src/core/types.ts` defines the internal message shape. `Message` always carries an array of `ContentBlock`s: text, thinking, tool use, tool result, and image. Providers translate at the boundary; core runtime code never speaks provider-native message shapes directly.

`query()` is an async generator:

```ts
async function* query(params: QueryParams): AsyncGenerator<StreamEvent | Message, Terminal>
```

That shape is a load-bearing contract. It lets the TUI render partial model output, tool results, usage events, and terminal state without collapsing the turn loop into a single promise.

`src/tool/types.ts` defines the uniform capability contract. Native tools, future MCP tools, skills, and sub-agents all flow through `Tool<I, O, P>`. Every concrete tool is created with `buildTool()` so fail-closed defaults are applied consistently.

`src/providers/types.ts` defines `LLMProvider`. Core code calls only `provider.stream(req)`; SDK calls and provider-specific normalization stay under `src/providers/`.

**Reasoning depth (`/effort`).** `ProviderRequest` carries a provider-neutral `effort?: ReasoningEffort` (`off | low | medium | high | max`), threaded from `QueryParams.effort` → `query()` → `provider.stream(req)`. The pure module `src/providers/effort.ts` owns the level→wire translation; each adapter forks it in `buildKwargs`: Anthropic → `thinking.budget_tokens` (+ raised `max_tokens`, dropped `temperature`, interleaved-thinking beta), OpenAI reasoning models → `reasoning_effort`, sov/ollama → `enable_thinking`. A `modelSupportsReasoning` gate means a non-reasoning model never gets a thinking parameter. The level is per-session mutable runtime state — `runtime.effort` (parallel to `runtime.model`), seeded from the `thinking.effort` config default and mutated live by the `/effort` command via `CommandContext.setEffort`. The default `off` leaves the request body byte-identical to a no-thinking turn. Spec: [`docs/specs/2026-06-09-effort-reasoning-depth-design.md`](./specs/2026-06-09-effort-reasoning-depth-design.md).

## System Prompt And Context

System prompt assembly lives under `src/context/`. New sessions freeze a static-to-dynamic segmented prompt:

- base runtime instructions
- `<harness-self-doc>` — vendor-neutral runtime contracts (settings file paths and precedence, `permissions` / `hooks` / `mcpServers` schemas, the permission rule grammar including the `mcp__server` server-prefix form, the inline-shell `!` prefix, the slash-command list, ToolSearch's role)
- available tool summary
- skills index reminder (one line; full skill discovery via the `skills_list` tool)
- bundle context and memory
- runtime facts such as cwd, OS, shell, date, and git status
- local user/project context from `AGENTS.md`, `CONTEXT.md`, `.cursorrules`, and user context files

Each segment has a `cacheable` marker. Providers that support prompt caching translate this into provider-specific cache controls; other providers concatenate the text and ignore the marker.

On resume, the session reuses the exact frozen system prompt from SQLite. Runtime facts and local context are not rebuilt for an existing session.

Current-turn context is injected through the user message, not by mutating the frozen system prompt. That includes bounded memory snapshots, recalled instinct lessons (when `learning.recall.enabled` — see "Learning Layer" below), and explicit references such as `@file:src/main.ts`.

The `<harness-self-doc>` segment is deliberately vendor-neutral (uses `<harness-home>` rather than `~/.harness/` and avoids the "Sovereign AI" identity) so white-label deployments inherit the same prompt unchanged.

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

### Tool Observation Envelope

`ToolResult<T>` carries an optional `observation` field shaped as `{status, summary, next_actions?, artifacts?}` (Phase 12.5). When present, the orchestrator's `formatToolResult` renders it as a plain-text header above the tool's `renderResult` output. `status: 'error'` forces `is_error: true` on the resulting `tool_result` block even when the tool's renderer didn't set it.

The envelope is opt-in — tools that don't set it render exactly as before. Native tools that have been retrofitted: `BashTool`, `FileEditTool`, `FileWriteTool`, `FileReadTool`, `GlobTool`, `GrepTool`, `MemoryTool`, `SkillTool`, `SkillsListTool`, `SkillsViewTool`, `WebFetchTool`, `WebSearchTool`, `HarnessInfoTool`, `ToolSearchTool`. The MCP wrapper maps `CallToolResult.isError` and common error keywords into the envelope shape.

The `next_actions` field is the highest-value piece on error paths — it gives the model a concrete recovery hint instead of a vague apology. `BashTool`'s envelope carries per-error-class hints (command-not-found, permission-denied, timeout, expect_token miss, privilege-escalation refusal); `FileEditTool` flips its missing-match and non-unique-match cases from throws to envelope-emitting returns specifically so the recovery hint reaches the model.

## Web Tools

Two model-callable tools handle open-web reach:

- `WebFetchTool` (`src/tools/WebFetchTool.ts`) — wraps `globalThis.fetch` with private-host blocking, timeout/size caps, redirect following, and an HTML→text reduction (strips `<script>`/`<style>`/comments, converts block tags to newlines, decodes basic entities). Sufficient for documentation pages, blog posts, news articles, raw markdown/JSON.
- `WebSearchTool` (`src/tools/WebSearchTool.ts`) — pluggable search via Tavily (default) or Brave. **Hidden when no API key is configured** (`isEnabled()` returns false), so the model never sees a tool it can't actually call. **Provider auto-detection from key shape:** an explicit `webSearch.provider` always wins, but when unset, the harness picks based on whichever signal carries a key — config-side `webSearch.apiKey` is classified by prefix (`tvly-` → Tavily, anything else → Brave); env-only setups dispatch by which env var is set (`TAVILY_API_KEY` / `BRAVE_SEARCH_API_KEY`). Returns up to 20 `{title, url, snippet}` results. The tool's `call()` retains the no-key error as defense in depth (tests, programmatic use, mid-session config drift).

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

### MCP Permission Rule Prefix

MCP tools register as `mcp__<server>__<tool>` so a single server-prefix rule scopes a whole server: `deny: ["mcp__github"]` blocks every GitHub tool in one line; `deny: ["mcp__github__create_issue"]` targets one tool. `ruleMatchesTool()` resolves a server-prefix rule by checking `tool.isMcp` and matching `rule.tool === \`mcp__${tool.mcpInfo.serverName}\`` — the match runs off tool metadata, not name-string parsing, so server names containing `__` would still resolve correctly.

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

A `microcompact` StreamEvent is emitted when clearing occurs, rendered by the TUI as `[cleared N stale tool results, ~XK tokens]`.

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

### Default bundle + bundleless invocation (Phase 10.8)

`sov` no longer requires a bundle on disk. `resolveBundlePath()` (in `src/main.ts`) is a four-step fallthrough: explicit `--bundle <path>` → `HARNESS_BUNDLE` env → upward `index.yaml` walk from CWD → default bundle. The default bundle resolver (`src/bundle/defaultBundle.ts`) checks `<harness-home>/default-bundle/` for a user override first, then falls back to the shipped `bundle-default/` directory next to the runtime source (resolved via `realpathSync` of the entry script — same trick `loadPackageEnv()` uses).

The shipped default bundle is vendor-neutral: a coding-assistant system prompt, two starter skills (`/review`, `/summarize`), no schemas, an empty state directory. Per `phase-10.8-default-bundle-design.md` in the docs repo, nothing Sovereign-AI-specific ships in the default — that identity lives only in real bundles. A user can fork the default by dropping a directory at `<harness-home>/default-bundle/` (the override location takes precedence over the shipped one).

`sov init` (`src/cli/init.ts`) graduates a directory into a real bundle. v1 contract: writes a minimal `index.yaml` + `business/README.md` (seeded from `<cwd>/README.md` when present, else a stub) + empty `harness/schemas/` + `state/` + `skills/`. Refuses to overwrite an existing `index.yaml` without `--force`. The corpus generator is intentionally minimal in v1; richer repo-aware seeding is queued as a separate design session.

### Replay primitives (Phase 10.5 part 2b-i)

`src/eval/replay/` provides the deterministic-replay half of the eval surface. A `ReplayFixture` (one JSON file per session) captures every StreamEvent the provider yielded plus every tool result the orchestrator received during a live run. `ReplayProvider` re-emits the captured events one turn per `stream()` call as a drop-in `LLMProvider`; `wrapToolsForReplay` returns wrapped tools whose `call()` returns the next captured result keyed by `(toolName, callIndex)`. The agent loop, orchestrator, permission gates, hooks, MCP wiring, and trace writer all run unchanged — the deterministic surface is achieved by stubbing only the provider + tool boundaries. Capture mode (the recorder that produces fixtures from live runs) is deferred to a follow-up slice.

### Eval suite (Phase 10.5 part 2a)

`sov eval run` is the declarative golden-task runner that builds on top of part 1's trace + summary infrastructure. Each golden lives at `evals/goldens/*.golden.ts` exporting a `GoldenSpec`: a sandbox seed map, a prompt (or array), and a list of code assertions. `src/eval/runner.ts` spawns `sov` in a per-golden tempdir with isolated `HARNESS_HOME` / `HARNESS_CONFIG` / `sessions.db`, pipes the prompt + `/quit` into stdin, captures stdout/stderr, parses `Tool Calls:` and `Est. Cost:` from the session-summary footer, evaluates assertions, and returns a `GoldenResult`.

`src/eval/assertions.ts` ships 12 pure assertion primitives (file state, transcript content, tool-call totals, exit code). `src/eval/budget.ts` enforces an opt-in `evals/budget.json` with four independent thresholds (`maxWallSeconds`, `maxCostUsd`, `maxToolErrors`, `minPassCount`). `src/cli/evalRun.ts` orchestrates: load goldens from a directory, filter by substring, run sequentially, print per-golden + summary report, exit non-zero on failure or budget violation.

The eval suite is deliberately parallel to `tests/semantic/` (which uses an LLM judge for fuzzy scoring) — same overall shape (sandbox + spawn + capture) but different judging mechanism + cost model. Live-LLM goldens are not part of `bun test`; they're opt-in via `sov eval run`.

### Local-model router (Phase 10.6 part 1)

`sov --provider router` activates `RouterProvider` (in `src/router/`), a meta-LLMProvider that wraps two child providers (one local, one frontier) and decides per-turn which to delegate to. The router lives at the LLMProvider boundary so the turn loop, orchestrator, hooks, and existing provider hardening (rate guards, credential pools) need no router-aware code paths — they see one provider with `name = 'router'`.

`src/router/classifier.ts` runs a deterministic rule set per turn: user override > hard frontier triggers (recent tool errors ≥ 3, schema failures ≥ 2, context overflow heuristic) > default-local. When the raw output is `local-with-escalation`, the configured `escalationMode` (`ask` | `auto` | `never`) decides whether to actually escalate. Today `ask` and `never` both stay on `defaultLane`; the interactive prompt UX is deferred. `src/router/auditLogger.ts` writes append-only JSONL to `<harness-home>/router/audit.jsonl` with the lane, resolved provider/model, reason, and a SHA-256 of the prompt — raw prompt text is never logged by default.

The router's `stream()` yields a `route_decision` StreamEvent before delegating, so any consumer (TUI banner, evals viewer, etc.) can observe lane changes per turn. `buildRuntime` in `src/server/runtime.ts` constructs the synthetic `ResolvedProvider` when `--provider router` is supplied: child providers resolved via the normal pipeline, contextLength conservatively the smaller of the two so the ContextMeter stays accurate on either lane, audit logger created and closed at session boundaries.

### Operational traces + loop detection (Phase 10.5 part 1)

Each session writes a JSONL trace at `<harness-home>/traces/<sessionId>.jsonl` covering session lifecycle (session_start, session_end), turn boundaries (turn_start), provider roundtrips (provider_request, provider_response with usage / latency / TTFT), tool dispatch (tool_start, tool_end, tool_error, permission_check), and stream-level signals (microcompact, interrupt, loop_detected). Records flow through the same allowlist redactor used by trajectories — Invariant #15.

`src/trace/types.ts` defines the discriminated `TraceEvent` union. `src/trace/writer.ts` is an append-only writer with a sequential write chain (concurrent `record()` calls land in order), best-effort error swallowing (Invariant #10), and a default path resolved through `getHarnessHome()`. The recorder is plumbed into `query()` via a `traceRecorder?: (event) => void` field on `QueryParams`; the orchestrator records permission and tool events, query records turn / provider / microcompact / interrupt events, and the server runtime records session_start / session_end. `sov trace show <sessionId>` (in `src/cli/traceShow.ts`) reads the JSONL and renders a human-readable per-turn summary.

`src/loop/detector.ts` ships a multi-heuristic loop detector instantiated per `query()` call. Three detectors run in priority order: consecutive-identical (SHA-256 of `<name>:<JSON.stringify(input)>`, threshold 4), action-stagnation (same tool name regardless of args, threshold 7), and content-loop (chunked-text repeats inside a `ceil(threshold * 1.5)` window, threshold 8). Each detector clears its own history after firing so a fresh run is required to refire. The orchestrator emits a `loop_detected` StreamEvent + records a `loop_detected` trace event on every detection; on the first detection it injects a guidance user message and continues, on the second it terminates with `reason: error`.

### Profile system (Phase 10.7)

`<harness-home>` is profile-aware. The default state root is `<harness-home>/` itself; named profiles live under `<harness-home>/profiles/<name>/` with the same internal layout (config, credentials, sessions, memory, etc.). The active profile is selected by:

1. **Top-level `-p/--profile <name>` flag**, parsed in `src/main.ts` BEFORE any module-load-time path capture (Invariant #11). The flag sets `process.env.HARNESS_HOME = join(<base>, 'profiles', <name>)` and is stripped from argv before commander parses it. The `default` name is reserved and maps to `<base>/` itself.
2. **Persisted active selection** at `<base>/active-profile`, written by `sov profile use <name>` and read on startup when no `-p` flag is supplied. An empty file or missing file means default.

`src/config/paths.ts` is the single source of truth for path resolution (`getHarnessHome`, `getBaseHome`, `getProfileHome`, `getActiveProfile`, `setActiveProfile`, `assertProfileName`). Every disk-access call site in `src/agent/sessionDb.ts`, `src/config/store.ts`, `src/config/loader.ts`, `src/providers/credentials/pool.ts`, and `src/providers/credentials/rateGuard.ts` resolves paths through these helpers at call time, never at module load.

`src/config/profileLock.ts` ships an atomic-mkdir-based PID lock with stale-process detection as a helper (`tryAcquireLock`, `readLockInfo`); interactive-session integration is deferred. `src/cli/profileCommands.ts` implements the `sov profile [list|create|use|show|import-default]` subcommand cluster — `import-default` copies the unscoped `config.json` + `credentials.json` into a target profile but leaves sessions/trajectories/memory empty (a profile is meant to scope history per project, not duplicate it).

## TUI Rendering (`sov-tui` Go client + `LiveRegion`)

The interactive UI is the Go Bubble Tea client at `packages/tui/`. It connects to the local Hono server via HTTP+SSE and renders the streaming turn loop. The runtime stays UI-agnostic — the TUI consumes `ServerEvent`s from the SSE bus without affecting tool/provider/permission semantics.

### Inline rendering mode (ux-fixes round 5)

The TUI runs **without** `tea.WithAltScreen()`. The terminal owns the scrollback buffer natively, which means:

- **Wheel + trackpad scroll** work like in any other terminal app — they page through the terminal's own scrollback, not a TUI viewport.
- **Click-drag text selection + copy** work natively — no mouse capture interferes with the terminal's selection layer.
- **No keyboard scroll bindings** in the TUI — keys not consumed by the prompt/autocomplete/picker pass through to the textarea unchanged.

Permanent content (user messages, finalized assistant cards, tool results, system messages, splash, boot notices, slash-command output, compaction markers, turn errors, `(interrupted by user)` markers) flows into the terminal's scrollback via `tea.Println`. The in-TUI `View()` shrinks to a small bottom region:

```
<terminal scrollback — owned by the terminal, contains all prior history>
       ↑
       │ (terminal handles wheel/trackpad scroll + selection through here)
       ↓
[m.live.View() — streaming assistant card + spinner + running-command]
[stallBadge / picker (when active)]
[prompt]
[autocomplete popup (when /)]
[hint line: "? for shortcuts"]
[statusLine: cwd · profile · model · cost · cache]
```

### Print queue + drain pattern

The model holds a `pendingPrintln []string` queue. Handlers push via `m.print(line)` or `m.printUser(text)` (the latter applies the "❯ " marker + wraps to terminal width + truncates >1500 chars). At the end of every Update branch, `m.respond(cmd)` batches the caller's Cmd with `m.drainPrintln()`, which consolidates the queue into a single newline-joined `tea.Println` Cmd (ordered emission). The drained snapshot is also retained in `m.emittedPrintln` so tests can inspect scrollback content via the `scrollbackContent(m)` helper.

### LiveRegion component

`packages/tui/internal/components/liveregion.go` owns the bottom-of-screen mutable region:

- **Streaming assistant card** — `AppendAssistantDelta(text)` accumulates a buffer rendered as markdown in `View()`. `EndAssistantCard()` returns the final rendered string for the caller to `m.print` into scrollback and clears the buffer (called on `tool_use_start`, `turn_complete`, `compaction_complete`, `turn_error`, ESC).
- **Spinner** — `SetSpinner(line)` installs the styled spinner frame (Braille glyph + Thinking… label); `ClearSpinner()` removes it. Replaces the round-3 `transcript.AppendLiveLine` / `UpdateLiveLine` pattern.
- **Running-command indicator** — `SetRunningCommand(line)` shows a dim "…running /name args" or "[compacting…]" placeholder while a slash command or compact request is in flight. The matching `commandDispatchedMsg` / `compactCompleteMsg` / `compactErrorMsg` handler clears it and prints the real result.

### Per-turn cancellation (ESC → POST /sessions/:id/cancel)

`ServerEventBus.setCurrentTurnAbort(c)` + `cancelCurrentTurn()` register a per-turn `AbortController` so the new `POST /sessions/:id/cancel` route can fire it without disposing the bus (the bus-level signal still kills everything on SSE disconnect). The runtime threads `AbortSignal.any([bus.signal, turnAbort.signal])` into the `query()` call + both `runtime.compact` call sites. The TUI's ESC handler emits `(interrupted by user)` to scrollback, fires the cancel Cmd, and suppresses the consequent `turn_error` once via `m.userCancelledTurn`. Ctrl+C still tears down the session.

### Paste abstraction

`Prompt.RegisterPaste(content)` replaces large pasted blocks (≥ 2 lines OR ≥ 200 chars) with `[Pasted text #N +M lines]` placeholders matching Claude Code's affordance. `Prompt.ExpandPastes(value)` reconstitutes the real content on Enter so the server sees the full text. `Prompt.Clear()` drops the paste buffers per composition session. Bubbletea's bracketed paste arrives as ONE KeyMsg with `Paste=true` and `Runes` holding the entire content (including newlines); the TUI flushes it immediately to `RegisterPaste` / `InsertString`.

### Prompt textarea

`Prompt` wraps `bubbles/textarea` (multi-line, auto-grow up to 8 rows). `SetPromptFunc(2, lineIdx => idx==0 ? "› " : "  ")` makes the bullet appear only on the first line; continuation rows indent two spaces. Alt+Enter / Ctrl+J insert real newlines; plain Enter submits (app.go's KeyMsg branch intercepts via `!msg.Alt`). `Prompt.Height()` is dynamic so the surrounding chrome resizes as the user types.

### What's been retired

- **Alt screen** — dropped in round 5.
- **Mouse capture** — gone entirely; `--mouse` and `--no-mouse` are no-op back-compat shims.
- **Tool card click-to-expand** — cards print fully expanded into scrollback (immutable). `/expand N` still re-renders the Nth-most-recent raw payload from a local ring buffer.
- **In-TUI scroll keybindings** (round-4 PgUp/PgDn/Shift+arrows) — terminal owns scroll.
- **`src/ui/terminalRepl.ts`** — deleted in M13.
- **`tea.WithMouseCellMotion()`** — never returns.

### Theme

`packages/tui/internal/theme/` ships built-in themes (Dark / Light / Tokyo Night / Sovereign / Catppuccin Mocha / Latte) plus TOML user themes loaded from `<harness-home>/themes/<name>.toml`. The `/theme` slash command flows through the M11.5 picker → `themeChanged` side-effect → `applyThemeByName` updates `m.theme` + `m.live.SetTheme(t)` + every themed sub-component. Mid-session theme changes affect only the live region; content already printed to scrollback retains the styling it was emitted with (the terminal owns it).

Pinned-hex accents survive: headings (`#e0f2fe` Tailwind sky-100), inline code (`#7dd3fc` sky-300), file refs use the inline-code style via the `wrapFileRefs` pre-processor. Body text intentionally has NO Foreground so it inherits the terminal default — see `docs/conventions/tui-color-rendering.md` for the rationale + the M11.5 → M11.10 iteration narrative.

## Runtime Introspection — `HarnessInfo`

`src/tools/HarnessInfoTool.ts` is a native, read-only tool the model calls to answer meta-questions about the harness it's running in. Closure-injected (mirrors `ToolSearchTool`'s pattern); the snapshot getter reads live state at tool-call time so the result reflects the current MCP pool and tool inventory, not a stale snapshot.

The snapshot covers:

- `permissionMode` and the loaded settings layers (with paths and present/absent flags)
- configured MCP servers with `status: 'connected' | 'failed' | 'not-attempted'`, tool counts, and the server's invocation command
- the live native + MCP tool inventory split by `tool.isMcp`
- the registered slash-command registry
- an optional `budget` field carrying the Phase 12.6 context-budget audit

A `section` input filters the response (`settings` / `mcp` / `tools` / `commands` / `budget`); the default `'all'` returns everything. The tool pairs with the `<harness-self-doc>` system-prompt segment — the prompt teaches the contracts, the tool exposes the live state.

## Context Budget Audit

`src/context/budget.ts` ships `auditContextBudget()` and `formatBudgetReport()` (Phase 12.6). The audit walks every component that occupies space in the model's context window — system-prompt segments, tool schemas (native + MCP), skills, bundle context, memory files — and emits per-component records:

```ts
type ComponentTokens = {
  kind: 'system-segment' | 'tool-schema' | 'skill' | 'bundle' | 'memory' | 'instinct'
  name: string
  path?: string
  tokens: number
  bloat: 'heavy' | 'extreme' | null
  classification: 'always' | 'sometimes' | 'rarely'
}
```

(The `'instinct'` kind covers recalled instinct lessons injected into the latest user message — see "Learning Layer" below.)

Token estimation reuses `src/core/tokenEstimate.ts`'s 4-chars-per-token heuristic; provider-exact tokenization would require shipping per-provider tokenizer libs and is overkill for triage. Bloat thresholds (skill 300/800, tool-schema 500/1500, system-segment 800/2000, memory 1000, bundle 1500/3000) match the build plan's table and are overridable via the `thresholds` opt and the prospective `~/.harness/config.json` `contextBudget.thresholds.*` block.

Triage classification is conservative:

- `always` — system-prompt boilerplate, `<available-tools>`, or skills whose `requires_*` matches the active toolset
- `sometimes` — deferred MCP tools; skills with `requires_*` or `fallback_for_*` gates that aren't currently active
- `rarely` — skills whose `fallback_for_*` intersects with active tools (the primary is winning); not in the visibility set

The audit drives three surfaces: the `/context-budget` slash command (sectioned report with bloat flags), the `'budget'` section on `HarnessInfo`, and a `CommandContext.getBudgetReport()` hook the TUI plumbs through. Auto-warning at 60%+ utilization is deferred — Invariant #4 freezes the system prompt per session, so the warning would only appear at session start; the audit currently surfaces utilization on demand.

## Hooks

`src/hooks/runner.ts` is a JSON-stdio shell-hook runner registered at four lifecycle points: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, and `Stop`. Each hook is a user-configured shell command that receives the event payload as JSON on stdin and returns a JSON decision on stdout. Exit code 2 from the hook process means "block." `PreToolUse` hooks can return `permissionDecision: 'allow' | 'deny' | 'ask'` and an optional `updatedInput` that transforms the tool input before execution; `PostToolUse` can return `additionalContext` that's appended to the tool result the model sees.

First-use TTY consent gates all hooks: when a configured hook fires for the first time on a given machine, the user is prompted to allow or deny it; the decision is persisted in `~/.harness/shell-hooks-allowlist.json`. Without consent the hook is inert. Hooks always run with `shell: false` + argv-split (Invariant #13) — never as a shell-string concatenation.

Settings shape (under any layer's `hooks` key):

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "/abs/path/audit-bash.sh" }] }
    ]
  }
}
```

## MCP Client

`src/mcp/client.ts` connects to configured MCP servers via `@modelcontextprotocol/sdk` at session start, discovers each server's tools, and wraps them into the harness's `Tool` interface. Servers that fail to connect are logged and skipped — one broken server doesn't prevent the rest of the session from running.

**Transports.** `buildTransport(name, cfg)` branches on the config's `type` (defaulting to `stdio` for legacy configs): `stdio` builds a `StdioClientTransport` (a spawned subprocess); `http` builds a `StreamableHTTPClientTransport` (the current MCP standard) against `cfg.url` with resolved auth headers on `requestInit`; `sse` builds the deprecated `SSEClientTransport` (headers are injected on both the POST channel via `requestInit` and the GET event stream via an `eventSourceInit.fetch` override — setting `eventSourceInit` otherwise suppresses the SDK's automatic `Authorization` header). All three satisfy the SDK's base `Transport` interface, so the pool drives them identically through `client.connect()` / `client.close()` — `connectOne`, the connect-timeout `Promise.race`, the wrapper, and the registry are transport-agnostic. The connect-error log path is sanitized (`sanitizeConnectError`) to a secret-free reason (an HTTP status or a short class like "connection refused") so a transport error can never leak a token-bearing URL.

**Remote auth** lives in `src/mcp/auth.ts` (`resolveMcpHeaders`, pure with an injectable `env`): env-first precedence (`SOV_MCP_<ALIAS>_TOKEN` → `Authorization: Bearer`, `SOV_MCP_<ALIAS>_API_KEY` → `X-API-Key`, falling back to `bearerToken`/`apiKey` in config), trimmed, empty→absent, never overwriting an explicit header, never logged. `redactUrlAuth` reduces a URL to its origin for every status/error surface; the HarnessInfo status serializer (`serializeMcpServerConfig`) projects remote servers to `{ transport, url }` (origin-only, never headers) and stdio to `{ transport, command, args }`. A remote URL that's plaintext `http://` or loopback/private warns but does not block (operator config, not end-user input); there is no insecure-TLS escape hatch, and OAuth is deferred.

Each wrapped tool registers as `mcp__<server>__<tool>` with `shouldDefer: true` so its full input schema isn't in the system prompt by default — the model retrieves the schema on demand via `ToolSearch`. This bounds prompt token cost as MCP servers add tens of tools.

Per Invariant #5, MCP tools flow through the same `Tool<I,O>` pipe as native tools — same orchestration, same permission gating, same hooks, regardless of transport. The permission rule prefix (`mcp__<server>` matches every tool from that server; `mcp__<server>__<tool>` matches one) lets MCP tools participate in the existing rule engine without a new code path.

Settings shape:

```json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/safe/dir"] },
    "hosted": { "type": "http", "url": "https://mcp.example.com/v1" }
  }
}
```

See [`usage.md`](usage.md#mcp-servers) for the full remote-config + `SOV_MCP_*` auth reference.

## Plugins

`src/plugins/` (Plugin System v1) is a **pure-aggregator** module: it discovers installed + consented + enabled plugins under `<harnessHome>/plugins/*`, validates each manifest, and composes their contributions into the loader seam shapes the runtime already consumes. It does **not** run hooks, connect MCP, or expand skills — a plugin in v1 contributes only **skills + slash-commands**. `loadPluginRuntime` (`src/plugins/runtime.ts`) is the single async entry point both boot surfaces call (`buildRuntime` in `src/server/runtime.ts`, and `dispatchCommand` in `src/cli/dispatchCommand.ts`) so the two can never drift; it's fail-soft (a bad plugin is skipped with a warn, an absent `plugins/` dir yields empty contributions).

A plugin installs under `<harnessHome>/plugins/<name>/` with a manifest at `<name>/.claude-plugin/plugin.json` (the Claude-Code-compatible location). `parsePluginManifest` (`src/plugins/manifest.ts`) validates a **strict known-subset** Zod schema — identity (`name` matching `^[a-z][a-z0-9-]*$`, `version`, `description`, `author?`), the convention-discovered `skills`/`commands` dir overrides, and the declared-but-inert `hooks`/`mcpServers` blocks (validated for disclosure, never executed). It uses `.passthrough()` so unknown / CC-only top-level keys survive and are partitioned into an explicit `ignored[]` rather than silently dropped or rejected.

**Consent + integrity model (S1 — the load-bearing control).** Directory presence may *discover* a plugin (so it can be listed) but never *enable* it. The loader (`src/plugins/loader.ts`) gates every plugin: it contributes only when (1) `readConsent` (`src/plugins/consent.ts`) returns a non-null `.consent.json` record, (2) the record's `pluginId` matches the manifest `name`, (3) `verifyConsent` holds (the recorded tree-hash equals a fresh `hashPluginTree`), (4) the tree carries real `skills/`/`commands/` content (the empty-tree guard), and (5) it's enabled by the opt-in allow-list. Anything short of (1)–(3) makes it discovered-but-inert and flagged `needsConsent` / `tampered`. `hashPluginTree` (`src/plugins/integrity.ts`) is a deterministic SHA-256 over every file in the tree except `.consent.json` (sorted by relative POSIX path, NUL-separated path+bytes, symlinks excluded), so a tree edited after consent (the TOCTOU case) fails the recompute and goes inert. The three install-time guarantees ride alongside, enforced in `installPlugin` (`src/plugins/install.ts`) **before** the consent prompt: **S1/integrity** (hash the *copied* tree, mint the record), plus a manifest secret-scan (`scanObjectForSecrets`, reject a baked credential), M1 path-containment of every declared path + `${CLAUDE_PLUGIN_ROOT}` result against the install root, symlink-escape rejection (`assertNoSymlinkEscape`), and a guard-scan of prompt content + bundled scripts (a `block` finding disables that component by policy; scripts are disclosed, never run). The capability-framed disclosure string is built purely by `buildDisclosure` (`src/plugins/disclosure.ts`).

**Composition seams + precedence.** `composePluginContributions` (`src/plugins/compose.ts`) turns the gated `LoadedPlugin[]` into `PluginContributions`. Plugin `skills/` dirs become `SkillRoot`s spliced into `loadSkills` via `extraRoots` **after user, before bundle** — so the search precedence is `project > user > plugin > bundle`: a plugin can override a bundle skill but can **never** shadow a user/project skill. Plugin `commands/` markdown is loaded through the same skill machinery (`loadSkillFromPath` → `buildSkillCommands`) but returned as slash-commands **only** (never added to `runtime.skills`, so they don't reach the system-prompt injection); built-in `COMMANDS` always win a name collision (the registry is first-wins), and inter-plugin order is deterministic (alphabetical by plugin id, first-wins dedupe). Every plugin-sourced skill/command is classified `source: 'plugin'`, `trustTier: 'community'`; the skill loader (`src/skills/loader.ts`) forces `allowShellInterpolation: false` for `source: 'plugin'` (with a `source !== 'plugin'` backstop in `expandSkillPrompt`), so a plugin skill's `` `!cmd` `` stays inert text — declarative-only. `${CLAUDE_PLUGIN_ROOT}` is threaded onto the `SkillRoot` (`pluginRoot`) and resolved to the install dir in skill/command bodies (a path-string substitution, not a shell arg). The disclosed-but-inert `hooks`/`mcpServers` + `ignored` keys are surfaced for the consent disclosure and `/plugins info`, producing no behavior.

**Disclosure surface.** `buildRuntime` returns every *discovered* plugin (active and inert) on `runtime.plugins` and the active plugins' commands on `runtime.pluginCommands`; `buildPluginSnapshots` (`src/plugins/snapshot.ts`) projects them into the rows `HarnessInfo` and `/plugins list` (`src/commands/pluginOps.ts`) render — one shared status precedence (`tampered` > `needs-consent` > `disabled` > `active`) so the two surfaces agree. Config is the opt-in `plugins: { enabled?, disabled? }` block (`.strict()`, `src/config/schema.ts`): `enabled` is an allow-list, `disabled` wins, an absent block activates every consented plugin. `/plugins install` is TTY-only (the consent prompt is injected via `ctx.confirm`; absent on server/TUI surfaces, which refuse). See [`usage.md`](usage.md#plugins) and [`extending.md`](extending.md#authoring-a-plugin).

## OpenAI HTTP Server

`src/openai/` carries an OpenAI-compatible HTTP API surface (Phase 18). It sits parallel to the TUI / drive / dispatch / cron surfaces — all five share the same `buildRuntime()` factory, but each owns its own entry point. The OpenAI server boots via `sov serve`, runs on its own `Bun.serve` binding (default port 8765, configurable via `--port` / `SOV_OPENAI_PORT` / `openaiServer.port`), and is fully stateless per request: `query()` drives directly (NOT `AgentRunner`) because the wire shape carries full message history natively. Bearer auth gates `/v1/*` (the API key is required at boot — no anonymous mode); `/health` is auth-exempt for container liveness probes.

```
sov serve  →  src/main.ts:282 (command('serve'))
           →  buildRuntime({ cwd, cronEnabled, ...overrides })
           →  createOpenAIServer({ runtime, apiKey, port, host })
           →  Bun.serve({ port, hostname, fetch: app.fetch, idleTimeout: 0 })
                ↓
              buildOpenAIApp({ runtime, apiKey })  ─┬─  /health         (no auth)
                                                    ├─  bearerAuth('/v1/*')
                                                    ├─  /v1/models      (auth)
                                                    └─  /v1/chat/completions  (auth)
                                                          ↓
                                              POST handler in chatCompletions.ts
                                                          ↓
                                              query() with messages[], abort signal
                                                          ↓
                                              (stream:true  → streamSSE + translator)
                                              (stream:false → drain → JSON envelope)
```

Per-request flow: parse + Zod-validate the body; resolve the model (`harness-default` → runtime bootstrap, explicit name → `resolveProvider(family, model, { harnessHome })`); map OpenAI messages → internal `Message[]` (lifting `system` → `extraSystemSegments`); mint/reuse a SessionDb row tagged `metadata.kind='openai-api'` with PK namespaced `openai:<id>` (client-supplied `X-Session-Id` namespaced to prevent cross-surface pollution); build a request-scoped `canUseTool` (`mode: 'default'` + auto-deny `ask` — matches cron headless policy); filter the tool pool against `SUBAGENT_EXCLUDED_TOOLS`; bridge the client's Web Fetch `Request.signal` to a request-scoped `AbortController`; drive `query()`. Streaming branch wraps the generator in Hono's `streamSSE`; the T4 translator emits OpenAI-shaped chunks (`buildRoleChunk` / `buildDeltaChunk` / `buildToolCallsChunk` / `buildFinalChunk`) and the T6 `hermes.tool.progress` SSE side-channel events for tool observability. Non-streaming branch drains the generator and projects the final assistant `ContentBlock[]` through `blocksToOpenAI()` into a `chat.completion` JSON envelope. Both branches share the same shutdown path: `runtime.disposeSession(sessionId)` in `finally`.

**Tool execution invariant (D9).** The harness runs tools internally inside a single `/v1/chat/completions` call. Clients see `tool_calls` chunks for observability, but `finish_reason` is always `'stop'` or `'length'`, never `'tool_calls'`. Standard OpenAI SDK clients (openai-python, openai-js, Open WebUI, LibreChat) never re-enter to satisfy a tool callback — the harness drives the tool loop end-to-end and returns the final assistant text. Tool invocations also emit `event: hermes.tool.progress\ndata: {tool_use_id, output?, is_error?}\n\n` on the SSE side-channel; standard clients ignore unknown event types per SSE spec, so harness-aware UIs get progressive disclosure without breaking SDK compatibility.

**Statelessness invariant (D10).** The route never hydrates prior history from the SessionDb. Each `/v1/chat/completions` call uses ONLY the request body's `messages[]`. The SessionDb row exists purely for trace + learning observability (trajectory + cost wiring + per-session subsystems all key off the row, but the conversation history is client-managed — every request is the full history).

**Abort propagation.** `c.req.raw.signal` (the Web Fetch `Request.signal` Hono exposes on Bun.serve) → request-scoped `AbortController` → `query()`'s `signal` param → `provider.stream({ signal })`. When the client closes its fetch context, every link in the chain flips to `aborted === true`; `query()` returns `{ reason: 'interrupted' }`; the route disposes the session. The explicit bridge insulates the inner pipeline from runtime-specific differences in when source signals dispatch their abort events (Bun, Node, Workers have diverged historically on TCP RST vs. graceful FIN).

**Session observability.** Every request mints a SessionDb row via `runtime.sessionDb.upsertSession({ sessionId: 'openai:<id>', metadata: { kind: 'openai-api', clientSessionId? } })`. The `openai:` prefix structurally disjoints this surface's keyspace from TUI / cron / drive (post-H1 audit fix) — a client cannot pollute another surface's transcript by sending `X-Session-Id` matching an existing UUID. The wire (`chatcmpl-<id>`) echoes the CLIENT's unprefixed view so the public contract is unchanged. Latest user message + final assistant message persist for observability; the model never sees the row.

**Cron co-deployment.** The cron tick loop runs INSIDE the runtime's lifecycle (Phase 17). When `sov serve` boots, `buildRuntime({ cronEnabled: opts.cron !== false })` attaches a `CronRunner` to the runtime by default; `--no-cron` opts out. Long-lived `sov serve` is the natural cron host: the operator runs ONE process that serves both the OpenAI API AND scheduled jobs.

## Native Gateway (`sov gateway`)

`sov gateway` (the home of the run-anywhere roadmap, A–F complete) is a long-lived, headless server that exposes the **native** HTTP+SSE protocol (`src/server/`) off-loopback, authenticated — the *rich interactive* protocol (turns, streaming, tool events, permission prompts, slash commands, skills), not the stateless OpenAI completion surface. It mirrors the `sov serve` lifecycle (build runtime once, `Bun.serve`, SIGINT/SIGTERM → `server.stop()` + `runtime.dispose()`, park) but serves `buildAppWithRuntime` instead of the OpenAI app, and adds nothing to the routes themselves — auth + CORS are middleware mounted in front. Phase A established the secure-bind + auth foundation below; Phases B–F layered the multi-client transport (`src/server/eventBus.ts`), the embedded web UI (`src/server/webui.*`), the persistent session supervisor (`src/server/sessionSupervisor.ts`), multi-user principals (`src/server/principals.ts`), and inbound channels (`src/channels/`) on top — all over the same protocol seam, all gateway-scoped (the TUI / `sov serve` / `sov drive` paths are byte-unchanged).

```
sov gateway  →  src/main.ts (command('gateway'))
             →  runGateway({ host?, port? })  in src/cli/gatewayCommand.ts
                  ↓  resolve host/port/token/corsOrigins (flag > env > config > default)
                  ↓  assertGatewaySafe({ host, token })   ← refuse-boot guard
             →  buildRuntime({ cwd, harnessHome })
             →  startServer({ runtime, hostname, port, auth?, corsOrigins? })
                  ↓
                buildAppWithRuntime(runtime, { auth?, corsOrigins? })
                  ├─  /health            (no auth)
                  ├─  cors(corsOrigins)  (when configured)
                  ├─  bearerAuth('/sessions/*')  (when a token is set)
                  └─  the existing native session routes (unchanged)
```

The **TUI launcher path is byte-unchanged**: `startServer` and `buildAppWithRuntime` gained backward-compatible optional `auth?` / `corsOrigins?` params; absent them (the TUI / `sov serve` / `sov drive` callers), the app is built and bound exactly as before, loopback-only with no auth.

- **Host-configurable bind (D2).** `src/server/index.ts` / `src/server/port.ts` thread an optional `hostname` (default `127.0.0.1`); the gateway resolves it via `--host` > `SOV_GATEWAY_HOST` > `gateway.host` > `127.0.0.1` (port: `--port` > `SOV_GATEWAY_PORT` > `gateway.port` > `8766`, distinct from `sov serve`'s 8765).
- **Bearer auth (D3).** `src/server/auth.ts` — constant-time token compare (mirrors `src/openai/auth.ts`), mounted on `/sessions/*` (incl. the SSE stream); `/health` stays open. Token: `SOV_GATEWAY_TOKEN` > `gateway.token`; never logged.
- **Refuse-to-boot when exposed without auth (D4).** `assertGatewaySafe` (`src/server/gatewaySafety.ts`) hard-exits (exit 1) when the bind host is non-loopback (`isLoopbackHost` accepts `127.0.0.1` / `::1` / `localhost` / the `127/8` block) AND no token is set. On loopback, auth is optional.
- **CORS (D5).** `src/server/cors.ts` — echoes `Access-Control-Allow-Origin` for an allow-listed `Origin` only + handles preflight `OPTIONS`; closed by default (`gateway.corsOrigins: []`). Needed for the reference web UI (Phase C).
- **Single-user / single-token (D7).** One token = one full-access principal; per-principal authz is Phase E.
- **Multi-client session transport (Phase B, v0.6.19).** The session event bus (`src/server/eventBus.ts`) is **multi-subscriber** (fan-out to a `Set`; a throwing subscriber is isolated, not propagated) with a **bounded replay ring** (last N events, N = `gateway.eventBufferSize`, default 512) keyed on the session-monotonic `seq`. `GET /sessions/:id/events` reads a reconnect cursor from `Last-Event-ID` (header) or `?lastEventId` (query) and replays ring events with `seq >` the cursor before going live (a fresh subscriber replays only the current turn via `markTurnStart()`); `?follow=true` keeps the stream open across turns (the default still ends per turn, so `sov drive` is byte-compatible). **Bus lifecycle moved per-turn → per-session:** the events route no longer disposes the bus in its `finally` (only unsubscribes); disposal is now `runtime.disposeSession → disposeBus`, and full shutdown reclaims all buses (`runtime.dispose → abortAllBuses → disposeSession walk → clearAllBuses`). Engine-agnostic — all above the protocol seam. See [`usage.md`](usage.md#multiple-clients-reconnect-and-persistent-streams).
- **Browser transport note.** Because the SSE stream (`GET /sessions/:id/events`) is bearer-gated and the browser `EventSource` API can't set an `Authorization` header, web clients must consume SSE with `fetch()` + a `ReadableStream` reader (frames are the standard `event:`/`id:`/`data:` triplet, `\n\n`-delimited; same encoder as `sov serve`, `src/server/sseStream.ts`). See [`usage.md`](usage.md#driving-the-gateway-from-a-browser) for the canonical client flow.
- **Hardening (2026-06-05, v0.6.18).** Body-reading routes return a structured **400** on malformed JSON (`turns`, `approvals` — matching `commands`/`skills`/`chatCompletions`); `resolveGatewayPort` (`src/cli/gatewayCommand.ts`) validates the resolved port to `[1,65535]` and fails fast; `runtime.dispose()` calls `abortAllBuses()` (`src/server/eventBus.ts`) to abort in-flight turns before `sessionDb.close()`. Validated by a live cross-origin browser E2E (real model streamed; tool-use + permission round-trip; CORS clean).
- **Bundled reference web client (Phase C, v0.6.20).** A single self-contained chat client — `src/server/webui.html` (inline CSS + vanilla JS, no framework, no build) — is embedded into the binary via a `with { type: 'text' }` import (`src/server/webui.ts` → `WEB_UI_HTML`) and served **OPEN** at `GET /` + `GET /ui` by `buildAppWithRuntime` (mounted before the `/sessions/*` bearer-auth, like `/health`), so any native server — the gateway especially — serves it. It's a *client*, driving the same HTTP+SSE protocol as the TUI: it prompts for the bearer token (stored client-side in `localStorage`, sent as `Authorization`, never embedded in the served HTML), opens a `?follow` fetch-stream (per the browser SSE pattern above), and reconnects with `Last-Event-ID`. Served same-origin → no CORS. It renders streaming text, collapsible thinking, tool cards, inline permission Approve/Deny, auto-reconnect, new-chat, and cancel. Validated by a real-browser Playwright e2e (real model; tool-use → permission → approve; reconnect) and reviewed XSS-clean + token-safe. See [`usage.md`](usage.md#open-the-web-ui).
- **Persistent session supervisor (Phase D, v0.6.21).** The gateway is the **persistent backbone**: a long-lived host owning many concurrent sessions across clients and restarts. `SessionSupervisor` (`src/server/sessionSupervisor.ts`) owns **idle eviction** — a periodic, `unref`'d sweep (cadence `gateway.idleSweepIntervalMs`, default 5 min; mirrors the `CronRunner` tick — in-flight guard + an awaitable `stop()` that drains the in-flight sweep before `sessionDb.close()`) that reclaims a session's in-memory state (`runtime.disposeSession` + `disposeBus`) when it is NOT turn-active, has NO SSE subscribers, and has been idle past `gateway.idleSessionTimeoutMs` (default 30 min). Eviction is **graceful** (the dispose path still flushes learning/trace/trajectory — the learning corpus is written) and **transparent**: the durable SQLite row stays, so the **next request lazily rebuilds** the session from disk (restart-resume; an evicted session is indistinguishable from a live one bar one cold rebuild). The supervisor is wired only into `runGateway` (constructed + `start()`ed there, `stop()`ped on SIGINT/SIGTERM before `runtime.dispose()`) — the TUI / `sov serve` / `sov drive` paths never build it, so they are byte-unchanged. Lifecycle routes: `GET /sessions` (list + `live`/`turnActive`/`subscribers` annotations) and `DELETE /sessions/:id` (FK-safe `SessionDb.deleteSession` → 204) in `src/server/routes/sessions.ts`; `POST /sessions` gains an opt-in **concurrency cap** (`gateway.maxConcurrentSessions`, default 0 = unlimited — sweep-then-429). The cap + annotations read the **bus liveness surface** (`subscriberCount`, `lastActivityAt`, `peekBus`, `liveBusSessionIds` in `eventBus.ts`). **Engine/protocol seam unchanged** — all of this sits above the HTTP+SSE protocol, so it survives a future agent-core swap. Closes Phase B's deferred idle-bus-eviction (D9) + the noted interactive-buses-accumulate carry-forward. See [`usage.md`](usage.md#persistent-gateway--session-lifecycle).
- **Multi-user identity + state scoping (Phase E, v0.6.22).** The gateway can serve **multiple named users** with isolated sessions, memory, and learning — the *within-org / single-trust-domain* model (trusted-but-separate users; hostile cross-tenant isolation is founder-reserved). It rests on **two independent isolation layers** above the protocol seam:
  1. **Identity (authz).** `gateway.principals: [{ id, token, name? }]` (XOR the single `gateway.token`; `id` validated as a safe path segment). `resolvePrincipal(token, principals)` (`src/server/principals.ts`) constant-time-compares the bearer token against *every* principal's token (no early-exit timing leak) and the auth middleware attaches the resolved principal to the request context. In principals mode a resolving token is **required on every request, including loopback** — there is no anonymous bypass; the implicit single principal (`ownerId = null`, legacy paths) applies only in single-`token`/no-auth mode.
  2. **Session ownership (the chokepoint).** A nullable `owner_id` column (SessionDb migration 4→5, indexed `(owner_id, last_updated DESC)`) records who created a session; `POST /sessions` stamps the caller. **Every `/sessions/:id/*` route returns 404 on owner mismatch** (existence-hiding, not 403 — covering messages/turns/events/approvals/cancel/compact/commands/skills/DELETE); `GET /sessions` is owner-filtered.
  3. **Owner-derived state scope.** `buildSessionContext` (`src/server/sessionContext.ts`) derives the per-user memory namespace (`$HARNESS_HOME/users/{id}/memory/…`) and learning corpus (`…/users/{id}/learning/{projectId}/…`) from the **session's `owner_id`** — never from caller input — re-validating the id as a safe segment at the path boundary. The implicit single principal keeps the existing top-level paths (byte-identical). Because the namespace is owner-derived, a turn physically can only read/write its owner's state even if an authz check were bypassed — but both layers hold.

  **Gateway-scoped + back-compatible.** No `principals` ⇒ behavior is byte-identical to today (implicit single principal, legacy paths, no ownership enforcement); the **TUI / `sov serve` / `sov drive`** paths configure no principals and are unchanged. Security-reviewed (adversarial gate; two cross-user leaks found + fixed before ship). Known v1 limits: operator-side traces + fine-tune trajectories aren't per-user-partitioned (operator-only, never API-served). See [`usage.md`](usage.md#multi-user-gateway).
- **Channel framework + Slack/Telegram/webhook adapters (Phase F, v0.6.23 — completes the run-anywhere roadmap A–F).** Activates the dormant `src/channels/` contract into a working **inbound → session → headless turn → outbound** pipeline hosted by the gateway. A channel message drives a real harness session and gets a reply, with each channel an isolated principal and a safe-by-default permission posture.
  1. **Channel-agnostic pipeline.** `runChannelTurn` (`src/channels/pipeline.ts`) is the shared core every adapter drives: `sessionId = buildSessionKey(msg)` (deterministic per `(channel, sender[, thread])`) → `runtime.sessionDb.upsertSession({ owner: principalId, platform, metadata.kind:'channel' })` (find-or-create, so a conversation is **continuous** — owned by the channel's Phase-E principal → isolated memory/learning) → persist the inbound message → hydrate prior history (`loadHistoryAsMessages` + `repairMissingToolResults`, mirroring the turns route, so multi-message conversations are coherent) → run one headless turn (`AgentRunner`, cron pattern) under the channel posture → `extractFinalText` → `disposeSession` in `finally` (reclaims the in-memory context; the DB row persists for the next message; the Phase-D supervisor evicts idle ones). Returns the reply text or a `silent` verdict (`[SILENT]`/empty).
  2. **Safe-by-default permission posture (X1 — the security crux).** `buildChannelCanUseTool` (`src/channels/permission.ts`) builds the decider **WITHOUT** `loadPermissionSettings` — a channel turn never inherits the local dev's `settings.local.json` allow-rules. The asker always denies (`ask = async () => 'deny'`), so any `ask` fallthrough resolves to deny; `Bash`/`Write`/`Edit` are denied by default while read-only tools still run. `assertChannelPermissionMode` rejects `'bypass'` outright (a remote bypass is RCE). The tool pool excludes `SUBAGENT_EXCLUDED_TOOLS` (same ceiling as cron). This is **stricter than cron**, which DOES load the local layers (cron is operator-scheduled/trusted; a channel message is remote/untrusted).
  3. **Thin adapters over injectable transports.** Each adapter only **verify**s + **parse**s inbound and **deliver**s outbound, and takes an injected transport so the whole pipeline is unit/integration-tested with no live credentials. **Webhook** (`adapters/webhook.ts`) — `POST /channels/webhook/:id`, HMAC-SHA256 constant-time-verified over the raw body, synchronous `{ reply }`; the keystone with no external deps. **Telegram** (`adapters/telegram.ts`) — `getUpdates` long-poll over an `unref`'d loop (no public endpoint), `sendMessage` reply, offset advances past every update so a poisonous one isn't reprocessed. **Slack** (`adapters/slack.ts`) — `POST /channels/slack/events`, `v0=` signing-secret HMAC over `v0:{ts}:{rawBody}` + 300 s replay window + `url_verification` challenge + **ack-fast-then-async** `chat.postMessage` + `event_id` retry dedupe. **SMS (Twilio)** (`adapters/sms.ts`) — `POST /channels/sms`: a Twilio-signature gate (HMAC-SHA1/base64 over the public URL + sorted params, constant-time → 403) **plus** an explicit **sender allow-list** gate (a number is publicly textable + spoofable, so `resolveSenderPrincipal` maps `From` → principal via `Object.hasOwn`; an unlisted `From` runs no turn) → a **safe-posture** turn on the shared pipeline → **async reply** via the Messages REST API; carrier-mandated `STOP`/`HELP`/`START` handled before any turn (opt-outs in a serialized + atomic durable store under `<harnessHome>/channels/sms/optouts.json`).
  4. **Gateway hosting (D4).** The webhook + Slack + SMS inbound routes (`src/server/routes/channels.ts` → `channelsRoute(runtime, channels, deps?)`) mount **OPEN** on `buildAppWithRuntime` (before the `/sessions/*` bearer/principal auth, like `/health`) — they authenticate via the channel's **own** credential (HMAC / signing secret / Twilio signature + sender allow-list), not the gateway token; an unconfigured/disabled channel is a 404 (existence-hiding). Telegram is a poll-loop worker (`src/channels/listeners.ts` → `buildChannelListeners`) started in `runGateway` after the supervisor and `stop()`ped **before** `runtime.dispose()` (mirrors the supervisor ordering). `resolveChannelsConfig` resolves secrets **env-first** over the raw config before the Zod parse and fails boot loudly if an enabled channel lacks its secret.
  5. **Config + isolation (D8).** `gateway.channels: { webhook?, telegram?, slack?, sms? }` in `src/config/schema.ts`; webhook/telegram/slack are each `{ enabled?, principalId, <secret(s)>?, permissionMode? }`, while **SMS binds per-sender** via a `senders` map (`From → principalId`) that is both the allow-list and the isolation boundary (`{ enabled?, provider:'twilio', accountSid?, authToken?, fromNumber?, senders, helpText?, permissionMode? }`). The `permissionMode` enum is `['default','ask']` (so `bypass` is a parse error, not a refine); a `superRefine` requires every enabled channel's secret(s) present (env merged in pre-parse) and its `principalId` ∈ `gateway.principals` (for SMS: a non-empty `senders` map with every value a declared principal).

  **The path-traversal fix (found + fixed in adversarial review).** A hard security review found a **CRITICAL** arbitrary-file-write: an attacker-controlled webhook `chatId` with `../` flowed into `buildSessionKey` → the trace **filename**, escaping the trace dir before the model ran. Fixed defense-in-depth at both boundaries: the **source** (`parseWebhook` validates `sender`/`chatId`/`threadId` against a safe-segment allowlist → 400) and the **sink** (`TraceWriter` in `src/trace/writer.ts` collapses `..` runs, replaces path separators/control chars, and containment-asserts the resolved path stays under the traces dir). Re-reviewed **SECURE-TO-SHIP** (no remaining Critical/High; the posture holds, auth is constant-time + replay-resistant, channel→principal isolation holds, secrets never logged). **Gateway-scoped + off by default** — no `gateway.channels` ⇒ no routes, no workers; the TUI / `sov serve` / `sov drive` paths are byte-unchanged. **v1 limits:** auto-deny / no in-channel approval / no rich UX; uncompacted long conversations (same as cron); channel sessions use colon-delimited ids (not `/sessions/:id*`-addressable — channel-managed). See [`usage.md`](usage.md#channels-sov-gateway).

## Cron / Scheduled Jobs

`src/cron/` (Phase 17) is the scheduled-jobs subsystem: a typed schedule parser (relative / interval / cron-expression / ISO timestamp), atomic `jobs.json` CRUD, and a `CronRunner` whose 60-second tick is embedded in the `buildRuntime` lifecycle (`.unref?.()` so tests don't hang; `cronEnabled: false` opts out). The tick is guarded by a cross-process file lock so a co-running `sov serve` + a manual `sov cron tick` can't double-fire a job. CLI surface: `sov cron add | list | show | pause | resume | delete | run | tick`.

Each due job runs in a fresh `metadata.kind='cron'` session via `AgentRunner` with auto-deny on permission asks (the same headless policy as `sov drive` and the OpenAI server). A job may chain a skill (`expandSkillPrompt` user-message injection) and/or run a pre-agent script via `spawnSync` with interpreter inference (`.py → python3`, `.ts`/`.js → bun`, `.sh → bash`; 120s default timeout, 16 KiB stdout cap). Output is delivered to `<harnessHome>/cron/outbox/<jobId>/<ts>.txt`; a `[SILENT]` first-line prefix (case-insensitive, post-trim) short-circuits the file write. The six cron CRUD tool names sit in `SUBAGENT_EXCLUDED_TOOLS` so a job's agent can't recursively schedule more jobs. Long-lived `sov serve` is the natural cron host (see the OpenAI HTTP Server § Cron co-deployment above).

## Sudo Guardrail And Inline Shell

`BashTool` refuses `sudo`, `pkexec`, `doas`, and `su` upfront with a structured error (exit code 126). These commands need a TTY for password / TouchID prompts which a piped subprocess can't supply — without the guardrail the spawn would hang for two minutes until BashTool's timeout fires, leaving the agent stuck. The refusal envelope's `next_actions` tell the model to ask the user to run the command themselves.

The `! <command>` prompt prefix is the explicit escape hatch for cases BashTool can't handle. The rest of the line runs as a bash command with the user's stdio inherited — sudo / TouchID / pagers / interactive editors all work as if typed at the user's regular shell. The harness does not capture inline-shell output; the user typed `! foo` to do something for themselves, not to feed state to the agent.

## Trajectory Capture

`src/trajectory/` ships three modules (Phase 13.1):

- **`redact.ts`** — pattern-based secret redaction. The `HARNESS_REDACT_SECRETS` env flag is snapshotted at module import (Invariant #15), so mid-session env mutations can't disable redaction. Patterns cover Anthropic / OpenAI / Tavily / Brave / OpenRouter API keys, GitHub PATs, AWS access keys, JWTs, bearer tokens, PEM private-key blocks, and credential file paths (`~/.aws/credentials`, `~/.ssh/id_*`). Conservative — false positives are cheap; false negatives leak secrets into archives that may be committed to a repo.

- **`shareGpt.ts`** — `Message → ShareGPTRecord[]` mapping. `user → human`, `assistant → gpt`, `tool_result → tool`. Thinking blocks render inline as `<think>…</think>` for cross-model compatibility (OpenAI o-series, Anthropic extended thinking, DeepSeek R1 all agree on the tag). Assistant messages with text + `tool_use` split into separate records.

- **`writer.ts`** — `buildTrajectoryRecord()` (pure) + `writeTrajectory()` (appending) + `tryWriteTrajectory()` (fire-and-forget wrapper, swallows errors per Invariant #10). Bucket split: `terminal.reason ∈ {completed, max_turns}` → `samples.jsonl`; everything else → `failed.jsonl`. JSON serialization passes through `redact()` before disk write.

Session-end wiring captures `lastTerminal` across all turns of the session and calls `tryWriteTrajectory` after the input loop closes, before DB shutdown. Empty sessions (zero in-memory messages) skip the write. Storage:

- Bundle loaded → `<bundle>/state/artifacts/trajectories/`
- Generic-agent → `<harnessHome>/trajectories/`

The trajectory directory is tier-3 per-installation state (Invariant #9). Phase 13.4's learning pipeline reads from this archive plus a parallel observation stream to synthesize an instinct corpus.

## Sub-Agent Runtime

Phase 13 introduces agent-as-tool delegation: the model invokes `AgentTool` with a `subagent_type` (one of the loaded agents from `<bundle>/agents/`, `<harness-home>/agents/`, or `<cwd>/.harness/agents/`) and a prompt; the harness spawns a child session with a filtered toolset, runs it to terminal, and returns a bounded summary plus the child session id. Seven reference agents ship in `bundle-default/agents/`: `explore` (read-only codebase mapping), `verify` (independent claim checking), and `plan` (implementation planning) from Phase 13; `review-memory`, `review-skill`, and `review-consolidate` (review-only, restricted toolsets) from Phase 13.3; and `instinct-synthesizer` (learning-only, restricted toolset) from Phase 13.4.

**Loader (`src/agents/loader.ts`).** Same pattern as `src/skills/loader.ts`: scans three roots in priority order (project `.harness/agents/` → user `<harness-home>/agents/` → bundle `<bundle>/agents/`), parses markdown + YAML frontmatter, dedupes by realpath (collapses symlinks) and by name (project beats user beats bundle on collisions). Returns `AgentRegistry` (`{ agents: AgentDefinition[]; byName: Map<string, AgentDefinition> }`) which lands in `ToolContext.agents`. v0 trust tiers are `'builtin'` (bundle) and `'trusted'` (project + user); a guard scanner is deferred until a `'community'` tier exists.

Frontmatter shape:

```yaml
---
name: explore                       # required, kebab-id
description: Fast codebase explorer # required
whenToUse: ...                      # optional; surfaces in AgentTool schema
allowedTools: [Read, Grep, Glob, Bash(git log *)]
model: anthropic/claude-haiku-4-5-20251001  # xor with role
role: explore                       # xor with model
maxTurns: 30                        # default 50
readOnly: true                      # default false
---

System prompt body goes here (when not in a frontmatter `systemPrompt:` field).
```

**Capability profile (`src/router/capabilities.ts`).** Per-model record carrying `contextLength`, coarse `costTier`, tool-call + JSON reliability, and `recommendedRoles[]`. Two consumers: (a) the router classifier reads `contextLength` (existing wiring); (b) the scheduler resolves `role: explore` to the cheapest model whose `recommendedRoles` includes that role. Cross-consistency test pins the table against `src/providers/models.ts::contextLengthFor()` so the two cannot drift on shared data.

**Scheduler (`src/runtime/scheduler.ts`).** Owns the entire sub-agent lifecycle:

1. **Per-parent child cap** (default 4) — prevents a misbehaving parent from spawning unbounded children.
2. **Per-lane concurrency caps** via `LaneSemaphores` — `maxConcurrentLocal` / `maxConcurrentFrontier` from the router config. Both the router (single-session escalations) and the scheduler (parent dispatching N children) acquire from the same instance so global limits apply.
3. **Global write-path lock** — a single `Semaphore(1)` that write-capable children must acquire. Read-only children skip it. v0 path-lock primitive; per-path locking lands later when there's a real consumer.
4. **Tool filtering** — parent pool ∩ `agent.allowedTools` (name-only) − `SUBAGENT_EXCLUDED_TOOLS` (`AgentTool` itself blocks recursive spawning; `cron_*` and `task_stop` / `send_message` are parent-side control plane).
5. **Cancellation chaining** — parent's `AbortSignal` composes with a per-child `AbortSignal.timeout()` via `AbortSignal.any()`. Both parent abort and timeout terminate the child cleanly.
6. **Provider/model resolution** — agent declares `model: <provider>/<id>` literally OR `role: <kind>` (the scheduler queries the capability table). Falls back to the parent's defaults when neither is set.
7. **Parent-child session lineage** — caller-provided `createChildSession` callback writes the child row with `parent_session_id` set (the existing schema-v3 column).
8. **`on_delegation` hook** — after successful child completion (terminal `completed` or `max_turns`), the scheduler calls `parent.memoryManager.onDelegation(prompt, summary)`. Errors and interrupts skip the hook. Hook errors route to `traceRecorder` rather than failing the scheduler return.

**AgentRunner (`src/runtime/agentRunner.ts`).** Focused wrapper around `query()` that owns the non-UI plumbing: building the user message from a string prompt, wiring query() params, tracking the final assistant message, iteration count, tool-call count, and parent-child lineage carry. `query()` itself stays unchanged (Invariant #1). The interactive server turn handler keeps its inline `query()` call because UI is woven into the per-event loop and isn't pure plumbing; AgentRunner exists for sub-agents and other surfaces (background review, scheduled missions, cron, the OpenAI server).

**AgentTool (`src/tools/AgentTool.ts`).** Thin `buildTool()` wrapper. The registry's `patchSchemasAgainstAvailable()` rewrites AgentTool's `subagent_type` field from open string to a closed enum derived from `ctx.agents`, and **drops the tool from the pool entirely when no agents are loaded** — exposing a tool whose enum is empty would let the model attempt calls that always fail. `renderResult` wraps the summary in `<subagent_result name="X" session="Y" lane="provider/model" turns="N" tool_calls="M" duration_ms="..." terminal="completed">…</subagent_result>` so the parent context shows lineage at a glance without the full transcript.

**Subscription executor (opt-in, off by default — spike).** A single scheduler branch (`src/runtime/subprocessExecutor.ts`, gated by `subscriptionExecutor.enabled` + `agent.role === 'subscription-executor'`) hands a delegated task to a **headless `claude -p` subprocess** instead of the native `AgentRunner` loop. The subprocess runs Claude Code's own agentic loop and returns a result in the **exact shape `drainRunner` produces**, so the whole scheduler tail (summary, trajectory, `on_delegation` hook, review-fork, SSE events) is byte-unchanged. Per-tool work from the subprocess `stream-json` is **replayed into the learning corpus + trace** — observations + `distinctToolNames` are **canonicalized to the native tool vocabulary** (`Read`→`FileRead`, `Write`→`FileWrite`, `Edit`→`FileEdit`, `file_path`→`path`, drop `Bash.description`; unmapped tools pass through) so delegated turns co-cluster with native ones, while `messages[]` + the trace stay verbatim. Permission posture is safe-by-default (`--permission-mode`, `bypassPermissions` rejected at config-parse). It is wired **only** to the interactive sub-agent delegation seam — **not** cron / channels / the gateway — because driving a Claude *subscription* credential as an automated / multi-tenant backend crosses the personal-use ToS boundary; only attended personal use of the local `claude` install is defensible. See [`docs/specs/2026-06-08-subscription-executor-spike.md`](specs/2026-06-08-subscription-executor-spike.md) and [`usage.md`](usage.md#subscription-executor-opt-in).

**v0 known gaps (with follow-up notes in `DECISIONS.md`):**

- Pattern constraints inside `allowedTools` entries (e.g. `Bash(git log *)`) are not enforced at the scheduler — only name-level filtering. The parent's `canUseTool` still applies. Tightening: layer agent-defined rules into the `canUseTool` stack.
- `subagent_progress` StreamEvents are not surfaced to the parent UI in v0 — children show as a single tool-result block. Live streaming requires orchestrator `onProgress` plumbing; trace + trajectory still capture full child detail for post-hoc analysis.
- Path lock is a single in-memory `Semaphore(1)`. Per-path locking and cross-process coordination wait for Phase 16 daemon.

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

**Coverage.** 58 tests spanning 10 tool-dispatch cases (including the Phase 12.5 envelope-recovery case, the Phase 13.3 A2 pool-separation guard, and the Phase 13.4 learning-tool pool-separation guard), 6 slash-command dispatch paths (including `/context-budget` and the Phase 13.3 `/review` verbs), 6 permission cases (including the highest-stakes virtual-tool-name mapping, layer-precedence invariant, and the `mcp__server` server-prefix denial), 4 refusal cases, 2 context-expansion cases, 2 MCP cases, 2 hook cases, 1 self-doc/HarnessInfo case, 1 router case, 1 secret-redaction case, 1 `/security-audit` skill case, 2 sub-agents cases (Phase 13 — registry discoverability + live end-to-end delegation), 4 task-system cases (Phase 13.2 — create/list/get/stop lifecycle), 6 review-system cases (Phase 13.3 — `/review` list/show/consolidate/activity/unknown-verb/bare-call), 4 learning-system cases (Phase 13.4), and 6 workflow cases including end-to-end `/compact` and `/rollback`. See [`docs/semantic-testing.md`](./semantic-testing.md) for the full inventory with bug-class breakdown per test, and [`tests/semantic/README.md`](../tests/semantic/README.md) for the developer-facing design and porting guide.

## Review Pipeline

Phase 13.3 ships the Hermes-pattern propose-then-promote learning loop as a background daemon:

**ReviewManager** (`src/review/manager.ts`) owns the counter-driven trigger logic. After each user turn it increments a turn counter; after each orchestrator tool-iteration round it increments a tool counter. When the turn counter reaches `userTurnsForMemoryReview` (default 10), a memory review fork is dispatched; when the tool counter reaches `toolIterationsForSkillReview` (default 50), a skill review fork is dispatched. The `on_delegation` hook fires a distillation review whenever a sub-agent completes (every `childReviewEveryN` completions, default 5). A temporal lockout (`minIntervalMs`, default 30s) prevents back-to-back dispatches.

**runReviewFork** (`src/review/fork.ts`) builds a review child session. It takes the parent's tool pool and augments it with `REVIEW_ONLY_TOOLS` (`memory_propose` and `skill_propose` — never in the main agent's pool) before passing the augmented pool to `SubagentScheduler.delegate()`. The scheduler's `filterToolsForChild` then intersects with the review agent's `allowedTools`, so only the correct propose tool reaches each agent.

**Review reference agents** (`bundle-default/agents/review-*.md`) — three agents with restricted toolsets: `review-memory` (reads trajectories + memory, calls `memory_propose`), `review-skill` (reads trajectories + skills, calls `skill_propose`), `review-consolidate` (reads pending proposals, calls `memory_propose` to write the merged entry). All three are excluded from recursive spawning; the scheduler's recursion guard skips `onChildCompletion` for review-* agents.

**Propose tools** — `memory_propose` and `skill_propose` write YAML-frontmatter proposal files to `$HARNESS_HOME/review/pending/{memory,skills}/` with full provenance: `sessionId`, `traceId`, `sourceHash`, `sourceExcerpt`, `message-range`. Proposals sit in `pending/` until the user approves (`/review approve <id>`), rejects (`/review reject <id>`), or the system auto-promotes them when `review.autoPromoteMemory` / `review.autoPromoteSkills` is set to `true` in settings.

**Pool separation (REVIEW_ONLY_TOOLS).** `memory_propose` and `skill_propose` are exported separately from `REGISTERED_TOOLS` in `src/tool/registry.ts` and are never added to `assembleToolPool()`'s output. They appear only in the augmented pool that `runReviewFork` builds for review children. This hard enforcement at the pool level (~530 tokens freed from the main agent's context) is stronger than description-based "review-only" hints. The `tools.main-agent-excludes-propose-tools` semantic test guards against regression.

**Stall detection** (`src/review/stall.ts`) runs a 3-turn sliding window over the child's output. If no decisions or tool calls appear in three consecutive turns, it emits a `stall_detected` trace event. The ReviewManager monitors for stalls and can abort the child early.

**`/review` slash command** (`src/commands/reviewOps.ts`) exposes the lifecycle: `list` (pending proposals), `show <id>` (full proposal body), `approve <id>` (move to approved/), `reject <id>` (move to rejected/), `consolidate` (dispatch a consolidation fork), `activity` (recent review forks from the sessions DB). Bare `/review` is equivalent to `/review list`.

**Trajectory routing (B2).** `isDefaultBundlePath()` (`src/bundle/defaultBundle.ts`) detects stock-bundle sessions and routes their trajectories to `<harnessHome>/trajectories/` instead of `<bundle>/state/artifacts/trajectories/`, keeping the shipped `bundle-default/state/` directory clean.

**Session-end cleanup (B4).** `ReviewManager.cancelAll()` is called on `session_end` to abort any in-flight review forks. This prevents orphaned child sessions after the session exits.

**Per-settings configuration.** Seven fields under `review` in `~/.harness/config.json` (or any settings layer):

| Field | Default | Purpose |
|---|---|---|
| `autoPromoteMemory` | `false` | Auto-approve memory proposals without human review |
| `autoPromoteSkills` | `false` | Auto-approve skill proposals without human review |
| `userTurnsForMemoryReview` | `10` | Trigger a memory review every N user turns |
| `toolIterationsForSkillReview` | `50` | Trigger a skill review every M tool iterations |
| `childReviewEveryN` | `5` | Trigger a distillation review every N child completions |
| `minIntervalMs` | `30000` | Minimum milliseconds between review dispatches |
| `disabled` | `false` | Disable all auto-review triggers |

## Learning Pipeline (Phase 13.4)

The harness captures every tool call into a per-project observation corpus and clusters those observations into atomic, confidence-weighted instincts. Instincts sit between raw observations and durable memory/skill changes — they never auto-promote; Phase 13.3's `/review approve` gate governs all promotions.

**Layers (top-down):**

1. **`LearningObserver`** (`src/learning/observer.ts`) — internal `PostToolUse` intercept fires after every tool call. Writes one record per call to `$HARNESS_HOME/learning/<projectId>/observations.jsonl`. Async fire-and-forget; bounded buffer drops on overflow rather than blocking. Invariant #10: never blocks the turn.

2. **Project identity** (`src/learning/project.ts`) — stable hash via `git remote get-url origin` → `realpath(cwd)` fallback chain. Cached for session lifetime.

3. **Observation corpus** — `<harnessHome>/learning/<projectId>/observations.jsonl` accumulates JSON lines, each conforming to the Zod-strict `ObservationSchema`.

4. **`runSynthesizer`** (`src/learning/synthesizer.ts`) — fire-and-forget dispatcher mirroring `runReviewFork`. Augments parent's tool pool with `LEARNING_ONLY_TOOLS` before delegating to the bundled `instinct-synthesizer` agent.

5. **`instinct-synthesizer`** (`bundle-default/agents/instinct-synthesizer.md`) — restricted-toolset sub-agent. Reads recent observations, clusters them via deterministic `(tool_name, action-pattern, status)` keying, proposes / reinforces / contradicts instincts. Cross-project promotion fires when the same trigger+action+domain appears in 2+ projects at confidence ≥ 0.7.

6. **Confidence math** (`src/learning/confidence.ts`) — pure `reinforce` (logarithmic, capped 0.9) + `contradict` (sharp drop, floor 0) + `shouldPrune` (sub-threshold AND past aging window). All instinct mutations route through these.

7. **`InstinctStore`** (`src/learning/instinctStore.ts`) — round-trips `Instinct` records to/from `<harnessHome>/learning/<projectId>/instincts/<id>.md` (YAML frontmatter + body). Strict Zod parsing on every read; malformed records skipped during `list()`.

8. **`LEARNING_ONLY_TOOLS` pool isolation** — `instinct_list / instinct_view / instinct_propose / instinct_update_confidence` are NOT in `REGISTERED_TOOLS`. Injected into the synthesizer's parentToolPool by `runSynthesizer` AND into the review fork's pool by `runReviewFork`. Agent-level `allowedTools` then filters: review forks see only the read-only pair (list/view); synthesizer sees all four.

9. **Review fork integration** — `review-memory` and `review-skill` agents (Phase 13.3) now declare `instinct_list` + `instinct_view` in their `allowedTools` and prefer the instinct corpus over raw trajectory slices when present.

10. **CLI surface** (`src/cli/learningStatus.ts`, `learningPrune.ts`, `learningExport.ts`) — `sov learning {status [--project <id>], prune [--project <id>] [--dry-run], export <project-id> [--output <dir>]}`.

**Settings** (`settings.learning.*`):
- `disabled: boolean` — when true, observer is a no-op AND synthesizer never fires
- `synthesizerEveryN: number` — default 20 user turns
- `observationBufferSize: number` — default 200
- `pruneBelowConfidence: number` — default 0.3
- `pruneAgeDays: number` — default 30

**Skip-list compliance (build plan §2106):**
- No auto-promote of instincts to memory/skills (Qwen "dream" anti-pattern); all promotions gated by `/review approve`.
- No embedding-based clustering (deterministic keys only).
- No realtime confidence updates (batched during synthesizer pass).
- No cross-user instinct sharing.
- No instinct UI/TUI viewer.

## Learning Layer — the four-port contract (Learning-loop spike Phase 1)

Before this phase the learning loop was **open**: the Phase 13.4 pipeline synthesized instincts to disk but nothing ever read them back into the main agent. The spike closes the loop and seats the whole learning concern behind a portable contract (ADR H-0010; spec at `docs/specs/2026-06-03-portable-learning-layer-adapter-1-design.md`; plan at `docs/plans/2026-06-03-learning-loop-spike-phase-1.md`).

**The sealed module (`src/learning-layer/`).** A new module that depends only on its own four-port contract:

- `ports.ts` — the four ports: **Observe** (capture sessions / tool events), **Recall** (surface lessons ahead of a turn), **Reason** (LLM completion), **Persist** (named-blob storage). Plus the shared `readonly` types (`RecallContext`, `RecalledLesson`, `RecallResult`, `CapturedSession`, …). This is the only file host code imports from the layer.
- `index.ts` — `createLearningLayer(deps)` wires Recall over the host-provided ports; returns a `LearningLayer`.
- `recall/` — pure machinery: `assemble.ts` (trigger-overlap match → confidence sort → token budget), `format.ts` (the fenced `<learned-context>` snapshot), `readInstincts.ts` (a Persist-backed instinct reader sharing a pure serde with the synchronous `InstinctStore`).
- `adapters/harness/` — the only host-specific code (adapter #1): `persistFs.ts` (FS `PersistPort` over `$HARNESS_HOME` using the existing `src/learning/paths.ts` layout) and `reasonProvider.ts` (a thin provider-backed `ReasonPort` — defined and unit-tested but not yet load-bearing; the production synthesizer migrates onto it in a later phase).
- `eval/` — the with-vs-without correctness-flip eval: `score.ts` (pure flip + efficiency scorer), `runner.ts` (paired-arm runner over the semantic driver), `scenarios/` + `trackB.ts` + `trackBCorpus.ts` (Track A curated scenarios; Track B full-loop synthesis→recall).

The layer is portable by construction — the adapter is the only host-coupled file. The mock-host isolation suite and the four portability acceptance gates are Phase 2.

**Recall injection point.** `query()` (`src/core/query.ts`) injects recall immediately **after** the MEMORY.md injection and before turn 0: it calls the optional `params.recall` thunk with the latest user text, then `injectRecallIntoLatestUserMessage()` (`src/core/recallInjection.ts`) prepends the snapshot to the latest user message (immutable; same pattern as `src/memory/injection.ts`). `query()` stays project-agnostic — recall is passed as a bound thunk (`RecallTurn` on `QueryParams`), built per session in `src/server/sessionContext.ts` and bound to the session's project id. As of v0.6.16 recall is **on by default**: the thunk is constructed unless recall is *explicitly* disabled (`learning.recall.enabled === false` → field undefined → the turns route omits `recall` → recall is inert). The gate is `recallCfg?.enabled !== false`, so the **runtime** carries the absent-config default — the Zod `.default(true)` only materializes when a `recall` block is present. Recall stays fail-open and is a no-op on an empty corpus, so enabling it by default is byte-identical for any session with nothing to recall.

**The D6 latent-bug fix.** The server turns route (`src/server/routes/turns.ts`) previously built its `query({...})` call **without** `memoryManager`, so MEMORY.md never injected on the default (server/TUI) surface — only the CLI paths passed it. The route now passes `memoryManager: sessionCtx.memoryManager` (and, conditionally, `recall`). Side-effect-safe: the builtin memory provider's `syncTurn` is a no-op, so only the read/injection path activates.

**Project-id alignment.** Recall reads the corpus under `getProjectId(cwd).id` — the same id the observer and synthesizer **write** under — rather than the memory subsystem's `resolveProjectScope` id (which diverges under a loaded bundle). This guarantees project-scoped synthesized instincts are recallable under any bundle; the same id also grants access to the `_global` corpus.

**Synthesis-yield repair.** The corpus that produced only 2 instincts from 185 trajectories is fixed across three axes:

- **Saturating confidence curve** — `confidenceFromEvidence(totalEvidenceCount)` (`src/learning/confidence.ts`) replaces the near-flat logarithmic accumulation for propose/update: `cap · (1 − e^(−n/τ))` with `τ` defaulting to 13. ~6 observations clear the 0.3 prune floor; ~20 clear the 0.7 promotion gate (the old log curve needed ~40M). Tunable via `learning.evidenceSaturation`.
- **Normalized cluster keys** — `src/learning/cluster.ts` collapses paths / numbers / quoted strings to placeholders before keying, so same-tool/different-arg observations co-cluster into one pattern instead of fragmenting.
- **End-of-session synthesis + visibility** — `ReviewManager` (`src/review/manager.ts`) dispatches the synthesizer at session end once ≥ `learning.synthesizeOnSessionEndAfter` (default 10) new observations have accrued; the synthesizer (`src/learning/synthesizer.ts`) now surfaces failures (assertable status) instead of swallowing them; the `instinct-synthesizer` agent's zero-bias framing is softened and its `maxTurns` raised 8 → 16.

**The proof (`bun run eval:learning`).** The eval scores correctness flips on two tracks — Track A (curated, non-derivable, seeded instincts; the gate) and Track B (the full loop end-to-end). **Q1 — does the loop work? — verdict: PASS (6 flips / 0 regressions), live, with no human in the loop.** The wiring is separately proven without LLM variance in `tests/server/turns.recall.test.ts`; a CI-visible behavior signal mirrors the scenarios in `tests/semantic/suites/24-learning-recall.cases.ts`.

**Product defaults.** As of v0.6.16, recall ships **on by default** (`learning.recall.enabled` defaults to true; opt out with `false`) — a founder decision (2026-06-04) taken after the spike's Q1 cleared its bar. It stays fail-open and a no-op on an empty corpus, and is wired on the turns route only. Auto-promotion-by-default, the Phase-2 rented-engine adapter, and the go/no-go remain founder-reserved decisions — see the close-out snapshot `docs/state/2026-06-04-learning-loop-spike-phase-1.md`.

## Extension Surfaces

The primary extension surfaces are:

- `src/tools/` and `src/tool/` for native tools (including `virtualToolName` for cross-tool permission mapping and the optional `ToolObservation` envelope on results)
- `src/tool/registry.ts` for the `REGISTERED_TOOLS` main pool and the `REVIEW_ONLY_TOOLS` separate set (tools injected only into review forks)
- `src/providers/` for model providers
- `src/commands/` for slash commands
- `src/skills/` for markdown skills and skill discovery
- `src/hooks/` for the shell-hook runner, consent allowlist, and orchestrator integration
- `src/mcp/` for the MCP client pool and tool wrapper
- `src/plugins/` for the consent-gated plugin aggregator (manifest, loader/integrity gate, compose seams, install/uninstall, disclosure) and `src/commands/pluginOps.ts` for the `/plugins` command
- `src/context/budget.ts` for the per-component context-window audit
- `src/trajectory/` for the ShareGPT writer + secret-redaction patterns
- `src/cli/upgrade.ts` for the `sov upgrade` subcommand
- `src/compact/microcompact.ts` for microcompaction config and compactable tool sets
- `src/permissions/shellSemantics.ts` for shell command classification (add commands to the handler sets)
- `src/agent/sessionDb.ts` for schema migrations
- `src/agents/` for agent definitions (loader + types + global exclusion set) and `src/runtime/` for the sub-agent runtime (AgentRunner, scheduler, semaphores)
- `src/router/capabilities.ts` for the per-model capability profile table (consumed by the router classifier and the sub-agent role resolver)
- `src/review/` for the background review pipeline (ReviewManager, runReviewFork, ProposalStore, consolidation, stall detection)
- `src/learning-layer/` for the portable learning layer (the four-port contract in `ports.ts`, the `adapters/harness/` bindings, the `recall/` assembly + format, and the `eval/` with-vs-without runner)

See `docs/extending.md` for concrete recipes.

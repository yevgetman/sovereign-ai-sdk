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

## Extension Surfaces

The primary extension surfaces are:

- `src/tools/` and `src/tool/` for native tools
- `src/providers/` for model providers
- `src/commands/` for slash commands
- `src/skills/` for markdown skills and skill discovery
- `src/agent/sessionDb.ts` for schema migrations
- future `src/hooks/`, `src/mcp/`, `src/review/`, `src/router/`, and `src/trajectory/` phase landing zones

See `docs/extending.md` for concrete recipes.

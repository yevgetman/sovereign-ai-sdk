# Extending The Runtime

This guide covers common code changes. Keep changes narrow, preserve the async-generator turn loop, and prefer existing contracts over one-off paths.

## Add A Native Tool

1. Create `src/tools/MyTool.ts` with a one-responsibility header comment.
2. Define input and output schemas with Zod.
3. Export a tool built with `buildTool()`.
4. Implement `call(input, ctx, onProgress?)`.
5. Add `renderResult()` when structured output needs a user-facing transcript shape.
6. **Optional but encouraged:** populate the `observation` field on `ToolResult` with `{status, summary, next_actions?, artifacts?}` (Phase 12.5). The orchestrator renders it as a header above `renderResult` content; `status: 'error'` forces `is_error: true`. `next_actions` is most valuable on error paths — it gives the model a concrete recovery hint instead of a vague apology. See `BashTool`'s per-error-class envelope, or `FileEditTool`'s missing-match envelope, for examples.
7. Add `preparePermissionMatcher()` if permission rules should support tool-specific patterns.
8. Add `virtualToolName(input)` if the tool's operations map to another tool's permission rules (e.g., a shell wrapper that does reads should return `'Read'`).
9. Add `affectedPaths()`, `isReadOnly(input)`, and `isConcurrencySafe(input)` only when they are true for the actual invocation.
10. Register the tool in `assembleToolPool()` in `src/tool/registry.ts`.
11. Add focused tests under `tests/tools/` and orchestration tests if concurrency or path behavior matters.

Skeleton:

```ts
// MyTool - one sentence naming the tool responsibility.

import { z } from 'zod';
import { buildTool } from '../tool/buildTool.js';

const Input = z.object({
  path: z.string(),
});

const Output = z.object({
  ok: z.boolean(),
});

export const MyTool = buildTool({
  name: 'MyTool',
  description: () => 'Short tool description for the model.',
  inputSchema: Input,
  outputSchema: Output,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  affectedPaths: (input) => [input.path],
  async call(input, ctx) {
    return { data: { ok: true } };
  },
  renderResult(output) {
    return { content: JSON.stringify(output) };
  },
});
```

Do not register ad hoc tool objects. Every tool goes through `buildTool()` so default permission, concurrency, and interruption behavior stay fail-closed.

## Add A Provider

1. Add the provider metadata to `src/providers/models.ts`.
2. Implement a provider adapter in `src/providers/<name>.ts`.
3. Implement `LLMProvider.stream(req)` and translate provider events into internal `StreamEvent`s.
4. Keep SDK calls inside `src/providers/`.
5. Normalize all assistant output into internal content blocks.
6. Add resolver support in `src/providers/resolver.ts`.
7. Add pricing data in `src/providers/pricing.ts` if `/cost` should estimate usage.
8. Add tests under `tests/providers/` using fixture chunks where practical.

The core runtime should not know provider-specific message shapes. If a change requires editing `src/core/query.ts` for a provider quirk, isolate the quirk in the provider adapter instead.

If the provider supports extended thinking, fork the provider-neutral `req.effort` (`ReasoningEffort`) in `buildKwargs` using the helpers in `src/providers/effort.ts` (`modelSupportsReasoning` to gate it, then the level → your wire shape) — see how `anthropic.ts` / `openai.ts` do it. Keep `effort: 'off'`/undefined byte-identical to a no-thinking request. The `enable_thinking` chat-template flag is wired for the `sov` engine only; ollama reasoning is gated off in v1 (`modelSupportsReasoning('…', 'ollama') === false`) because its native `think: true` switch differs and needs per-model capability data not yet wired, so `/effort` is a no-op on ollama (planned fast-follow).

## Add A Slash Command

1. Add a command object. New commands typically live in one of the topic-specific files: `src/commands/info.ts` for read-only info commands, `pickers.ts` for commands that need the raw-mode picker, `sessionOps.ts` for file/session-shaping commands. The aggregate registry in `src/commands/registry.ts` spreads these arrays.
2. Choose the command kind:
   - `local` for immediate local output.
   - `prompt` for commands that feed a model turn.
   - `local-jsx` for future rendered local UI.
3. Add `usage` when arguments are expected.
4. For prompt commands, set `allowedTools` to the narrowest useful tool scope.
5. If the command needs picker UI, import `pick` from `src/ui/picker.js`. The picker takes over the screen, runs ↑/↓/Enter/Esc, and returns `Promise<T | null>`. Always include a non-TTY fallback (returns null on non-TTY automatically; print a hint to the user).
6. Add the command name to `COMMAND_CATEGORIES` in `registry.ts` so it appears in the right `/help` section.
7. Add tests in `tests/commands/`. The shared `tests/commands/_makeCtx.ts` helper builds a `CommandContext` stub with sensible defaults — override only the fields your test cares about.

Prompt commands are still normal model turns. They should constrain tools through `allowedTools` rather than creating custom execution paths.

### Render output with theme tokens

Slash command output that uses color should consume `theme.tokens.<role>(...)` from `src/ui/theme.js` instead of literal `chalk.<color>(...)`. That way the user's chosen theme (`dark` / `light` / `no-color`) flows through. Available roles include `text`, `textMuted`, `textBold`, `accent`, `statusSuccess`, `statusWarning`, `statusError`, `diffAdded`, `diffRemoved`, `border`, `codeInline`. See `src/ui/theme.ts` for the full set.

## Add Or Change Permission Rules

Permission parsing and wildcard matching live in `src/config/rules.ts`; orchestration-level permission decisions live in `src/permissions/canUseTool.ts`.

When a rule needs tool-specific semantics, add or update the tool's `preparePermissionMatcher()` instead of teaching the global rule engine about that tool's input shape.

### Virtual Tool Mapping

Tools can implement `virtualToolName(input)` to map their input to a different tool name for permission resolution. The permission evaluator checks rules for both the actual tool name and the virtual name. This lets `Bash("cat src/main.ts")` resolve against `Read` rules.

To add a new command to the shell analyzer, add it to the appropriate set in `src/permissions/shellSemantics.ts`: `READ_COMMANDS`, `WRITE_COMMANDS`, `EDIT_COMMANDS`, or `WEB_COMMANDS`. For commands with flag-dependent behavior (like `sed -i`), add a handler in `analyzeSegment()`.

### Permission Invariants

Preserve these invariants:

- deny wins within a settings layer
- local project settings outrank user settings
- `ask` can force a prompt even when fallthrough would allow
- `updatedInput` must be validated again before execution
- permission prompts deny by default on empty input
- virtual tool name resolution is fail-closed: if `virtualToolName()` throws, no virtual rules apply

## Add A Skill Capability

Skills are markdown files loaded by `src/skills/loader.ts`. Runtime-visible skill behavior is split across:

- `src/skills/types.ts` for the registry shape
- `src/skills/whenToUse.ts` for the trigger-rigor heuristic (Phase 9.6)
- `src/skills/visibility.ts` for active-tool and active-toolset gates
- `src/skills/guard.ts` for trust-tier scanning
- `src/tools/SkillsListTool.ts` and `src/tools/SkillsViewTool.ts` for progressive disclosure
- `src/tools/SkillTool.ts` and `src/skills/commands.ts` for invocation
- `src/skills/install.ts` for the `install` (byte-faithful) and `import` (normalize-on-write) verbs

New skill features should preserve progressive disclosure: the system prompt should carry a reminder, not the full skill body.

### `allowedTools` is enforced on the `/skill` path

A skill's `allowedTools` is a **real boundary** when the skill is invoked as a slash command. At the `/skill` seam (`src/server/routes/turns.ts`), the resolved skill's `allowedTools` is threaded into `runTurnInBackground` and run through `buildToolScope` (`src/commands/toolScope.ts`): the live tool pool is narrowed to the allow-list and `canUseTool` denies any out-of-scope call (`tool is outside slash-command scope`) — turn-scoped, so the restriction evaporates at turn end. The scope feeds both the `query()` call and `buildSessionToolContext` (whose `effectivePool` param defaults to `runtime.toolPool`), so sub-agents forked mid-turn inherit the narrowed pool (child ⊆ skill scope ⊆ runtime pool). `runtime.toolPool` is **read, never mutated** (it is a shared array mutated in place on reload — `buildToolScope` returns a fresh filtered copy). An empty/absent `allowedTools` is the identity (no narrowing).

The model-invoked `SkillTool` path is **advisory**: it surfaces the `allowedTools` as guidance to the model but does not hard-narrow the pool mid-loop (`query()` reads `tools` once at turn start). A clean future upgrade is for `SkillTool` to write a "pending scope" onto `SessionContext` honored at the next turn (same `/skill` seam) — flagged, not built.

### Importing Claude Code skills

`importSkill()` (`src/skills/install.ts`) ports a Claude Code `SKILL.md` onto the harness-native canonical shape, distinct from `installSkill()` (which copies byte-faithfully). It parses with the real YAML parser, normalizes the frontmatter — aliases `allowed-tools` → `allowedTools` (splitting a comma-string into a list), synthesizes `whenToUse` from `description` when absent, drops Claude-Code-only keys (`model`/`license`/`argument-hint`) — validates the result against the exported `SkillFrontmatterSchema` (fail loud), copies the source tree, then overwrites the target `SKILL.md` with canonical content. The loader also accepts the hyphenated `allowed-tools` key directly (via a `z.preprocess` in front of the schema), so a Claude Code skill loads natively even without import. Claude Code `:`-globs (`Bash(git status:*)`) are **not** auto-translated (lossy) — the importer warns and leaves them verbatim.

### Trigger-rigor convention for `whenToUse`

The skill loader runs `validateWhenToUse()` against every skill's `whenToUse` value at load time and emits a one-line warning per low-rigor entry (Phase 9.6, non-blocking). The rubric:

- States a user-observable trigger condition (what the user did or said), not the skill's purpose.
- Concrete enough to be matched as a predicate ("when the user mentions a commit, branch, or remote") rather than a description ("general git operations").
- One sentence per condition; multiple conditions allowed but each independent. Use `;` to separate — `SkillsListTool` splits on `;` into a `string[]` array so the model sees discrete triggers.
- Avoids meta-language ("call this skill when…") in favor of predicate language ("when the user X").

Skills that fail the heuristic still load — the warning is a nudge, not a block.

## Add An Agent Definition

Sub-agents (Phase 13) are markdown files loaded by `src/agents/loader.ts`. Same shape as skills (frontmatter + body) but consumed differently — an agent definition is loaded into `ToolContext.agents` and surfaces in `AgentTool`'s `subagent_type` enum. The model invokes `AgentTool({ subagent_type: '<name>', prompt: '...' })`; the scheduler in `src/runtime/scheduler.ts` spawns a child session with the agent's filtered toolset, runs it to terminal, and returns a bounded summary.

Drop a markdown file into one of the three search paths (project `.harness/agents/` → user `<harness-home>/agents/` → bundle `<bundle>/agents/`):

```yaml
---
name: explore                       # required; kebab-id, used as subagent_type
description: Fast codebase explorer # required; surfaces in AgentTool's tool description
whenToUse: |                        # optional; helps the model pick the right agent
  Use when the parent task needs file search, symbol lookup, or surface mapping.
allowedTools:                       # required; child's tool pool = parent pool ∩ this list
  - Read
  - Grep
  - Glob
  - Bash(git log *)                 # name-level filter only in v0; pattern not enforced at scheduler
role: explore                       # OR `model: <provider>/<id>` — mutually exclusive
maxTurns: 30                        # default 50
readOnly: true                      # default false; write-capable children acquire the global write lock
---

You are an Explore agent. Your job is to answer specific lookup or mapping questions
from a parent agent that delegated to you. Stay narrow — don't refactor or redesign.
Search before reading. Cite paths and line numbers. Stop early.

End with: Finding (1-2 sentences), Evidence (3-6 bullet points each `path:line`), Gaps (optional).
```

**Resolution.** When `model:` is set, the scheduler uses it literally (split on first `/` → provider + model). When `role:` is set, `findCapableModel(role, availableProviders)` queries `src/router/capabilities.ts` and picks the cheapest model whose `recommendedRoles` includes that role. When neither is set, the scheduler falls back to the parent's defaults.

**Filtering.** The scheduler intersects the parent's tool pool with the agent's `allowedTools` (name-only — `Bash(git log *)` matches the `Bash` tool with the pattern left to the parent's `canUseTool` to enforce), then subtracts `SUBAGENT_EXCLUDED_TOOLS` (`src/agents/exclusions.ts`: `AgentTool` blocks recursive spawning; `cron_*` and `task_stop` / `send_message` are parent-side control plane).

**Trust tiers.** Bundle agents → `'builtin'`. Project + user agents → `'trusted'`. v0 has no `'community'` tier and no guard scanner; if a `'community'` tier is added later, mirror the skills guard pattern (`src/skills/guard.ts`).

**`bundle-default/agents/`** ships seven reference agents: `explore`, `verify`, and `plan` (general sub-agents — these are the authoring template), `review-memory`, `review-skill`, and `review-consolidate` (Phase 13.3 review agents — restricted toolsets, specialized system prompts), plus `instinct-synthesizer` (Phase 13.4 learning agent — restricted to learning-only tools). Copy the general agents when building a new sub-agent; copy the review or learning agents only when building a pipeline variant.

**Review agents have a special role.** The three `review-*` agents are invoked exclusively by `runReviewFork()` in `src/review/fork.ts`, never by the main agent directly. They receive an augmented tool pool that includes `REVIEW_ONLY_TOOLS` (`memory_propose` and `skill_propose`) — tools that are deliberately excluded from the main agent's pool via `src/tool/registry.ts`'s `REVIEW_ONLY_TOOLS` export. If you add a tool that should only be callable from review forks (not from main agent turns), add it to `REVIEW_ONLY_TOOLS` rather than `REGISTERED_TOOLS`, and declare it in the review agents' `allowedTools` frontmatter.

## Authoring A Plugin

A **plugin** (Plugin System v1, `src/plugins/`) bundles **skills + slash-commands** into one installable, consentable unit. You don't author plugins under `src/` — a plugin is a self-contained directory with a manifest plus `skills/` and `commands/` dirs, installed by the operator via `/plugins install <dir>`. v1 contributes skills + commands only; a manifest may *declare* `hooks` / `mcpServers` (and CC-only keys like `agents`), but those are disclosed-and-inert — validated, listed at install time, never run.

**Layout** (the manifest path is the Claude-Code-compatible location):

```text
my-pack/
  .claude-plugin/
    plugin.json          # the manifest
  skills/                # markdown skills → spliced into the skill registry (prompt-injected + dispatchable)
    greet.md
  commands/              # markdown → slash-commands ONLY (not prompt-injected)
    deploy.md
```

**Manifest** (`.claude-plugin/plugin.json`) — `parsePluginManifest` (`src/plugins/manifest.ts`) validates a strict known subset; unknown / CC-only top-level keys are collected into `ignored[]` and disclosed, not dropped:

```json
{
  "name": "my-pack",
  "version": "1.0.0",
  "description": "A tiny greeting pack.",
  "author": "you"
}
```

`name` must be a lowercase hyphen-separated slug (`^[a-z][a-z0-9-]*$`) — it's the install-dir segment and the inter-plugin sort key. `skills` / `commands` default to those dir names; override them with a relative path (it must stay **under** the plugin root — an absolute or `../`-escaping value is rejected at install). `hooks` / `mcpServers` are optional and inert in v1.

**A skill** (`skills/greet.md`) is an ordinary harness skill (frontmatter + body). The only difference: a plugin skill is **declarative-only** — inline shell (`` `!cmd` ``) is disabled and never executes at expansion, so the body emits prompts/templates, not shell. Reference bundled files via `${CLAUDE_PLUGIN_ROOT}`, which resolves to the plugin's install dir (in both skill *and* command bodies); `{{args}}`, `${HARNESS_SKILL_DIR}`, and `${HARNESS_SESSION_ID}` work as usual:

```md
---
name: greet
description: Greet someone by name.
whenToUse: When the user asks to greet a person.
---
Greet {{args}} warmly. Use the template at ${CLAUDE_PLUGIN_ROOT}/skills/template.txt.
```

**Install + consent.** `/plugins install <dir>` is **terminal-only** and the only path that mints consent. It runs every safety gate first (`installPlugin`, `src/plugins/install.ts`) — manifest secret-scan, path-containment, symlink-escape rejection, guard-scan of content + bundled scripts — then shows a capability disclosure (`buildDisclosure`, `src/plugins/disclosure.ts`) and asks for `y/N`. On accept it copies the tree, hashes the **copied** tree, and writes `.consent.json` (`src/plugins/consent.ts`). At every boot the loader (`src/plugins/loader.ts`) re-verifies that record against a fresh tree-hash: no record, an identity mismatch, or a post-consent edit makes the plugin inert (`needsConsent` / `tampered`). Plugins are opt-in via the `plugins: { enabled?, disabled? }` config block and load at boot, so install/enable/disable are restart-to-apply. See [`usage.md`](usage.md#plugins) for the operator-facing reference and [`architecture.md`](architecture.md#plugins) for the composition + consent internals.

## Add A Shell Hook

Hooks live in any settings layer's `hooks` key (`<cwd>/.harness/settings.local.json`, `<cwd>/.harness/settings.json`, or `$HARNESS_HOME/settings.json`). They're not authored under `src/`; they're external shell commands or scripts the user owns. The harness runtime is in `src/hooks/` (`runner.ts`, `consent.ts`, `types.ts`); changes there should preserve:

- JSON-stdio interface (event payload in, decision out)
- Exit code 2 = block
- First-use TTY consent persisted to `~/.harness/shell-hooks-allowlist.json`
- `shell: false` + argv-split (Invariant #13 — never shell-string concatenation)
- `PreToolUse` can return `permissionDecision` and `updatedInput`; the orchestrator re-validates `updatedInput` before execution
- `PostToolUse` can return `additionalContext` appended to the tool result the model sees

## Add An MCP Server Integration

`src/mcp/client.ts` connects to configured stdio MCP servers via `@modelcontextprotocol/sdk` at session start, discovers tools, and wraps each one through `buildTool()`. Per Invariant #5, MCP tools flow through the same `Tool<I,O>` pipe as native tools — same orchestration, same permissions, same hooks.

Adding new transport support (HTTP/SSE/WebSocket — currently stdio-only) means extending `src/mcp/client.ts` to instantiate the SDK's transport variants. The wrapper layer (`src/mcp/toolWrapper.ts`) is transport-agnostic; nothing changes there.

The wrapper translates an MCP `CallToolResult` into a `ToolResult<T>` with the Phase 12.5 observation envelope: `isError` → `status: 'error'`; first text line → `summary`; URL-shaped output lines → `artifacts`; common error keywords (`not found`, `unauthorized`, `rate limit`) → `next_actions` inferences. The MCP server doesn't supply `next_actions` directly, so the inference is best-effort.

Permission rules participate via two prefix shapes: `mcp__<server>` matches every tool from one server; `mcp__<server>__<tool>` matches one specific tool. The matching is in `ruleMatchesTool()` (`src/config/rules.ts`) and uses `tool.isMcp` + `tool.mcpInfo.serverName` rather than name-string parsing.

## Add An OpenAI Route

`src/openai/` carries the OpenAI-compatible HTTP API server (Phase 18 — drop-in OpenAI backend for Open WebUI / LibreChat / `openai` SDK clients with a custom `base_url`). The surface is mounted by `buildOpenAIApp()` in `src/openai/app.ts` and bound via `createOpenAIServer()` in `src/openai/server.ts`; `sov serve` is the CLI entry point. Adding a new OpenAI route follows a small fixed shape.

1. **Define a route module under `src/openai/routes/<route>.ts`** returning a `Hono` instance:

```typescript
// src/openai/routes/embeddings.ts (hypothetical)
import { Hono } from 'hono';
import type { Runtime } from '../../server/runtime.js';

export function embeddingsRoute(runtime: Runtime): Hono {
  const r = new Hono();
  r.post('/v1/embeddings', async (c) => {
    // ... validate body, call runtime, return JSON
    return c.json({ object: 'list', data: [...] });
  });
  return r;
}
```

2. **Mount it in `src/openai/app.ts`'s `/v1` auth group** by adding a `r.route('/', ...)` call after `bearerAuth('/v1/*', ...)`:

```typescript
app.use('/v1/*', bearerAuth(opts.apiKey));
app.route('/', chatCompletionsRoute(opts.runtime));
app.route('/', modelsRoute(opts.runtime));
app.route('/', embeddingsRoute(opts.runtime));  // new
```

3. **Write Zod schemas in `src/openai/mapping/`** for any new request/response shapes. Reuse the pattern from `src/openai/mapping/schema.ts` — `.passthrough()` on the request envelope so SDK-specific fields don't reject (clients sometimes send extra params like `user`, `metadata`).

4. **Test in two layers:**
   - **Pure unit tests** for the schema mapping (parse / serialize / edge cases) under `tests/openai/mapping/<route>.test.ts`.
   - **Integration tests** against `buildOpenAIApp({ runtime, apiKey }).request('/v1/<path>', ...)` under `tests/openai/<route>.test.ts`. Use Hono's in-memory `app.request()` for fast tests; reach for `createOpenAIServer` + a real `fetch()` only when you need the actual socket (e.g., testing `c.req.raw.signal` propagation for client-disconnect).

Reference implementations: `src/openai/routes/health.ts` (no auth, trivial JSON), `src/openai/routes/models.ts` (auth-gated, projects a catalog), `src/openai/routes/chatCompletions.ts` (the streaming + tool-execution + abort-bridge anchor — the most representative shape for any route that drives `query()`).

**Tool execution invariant.** Routes that drive `query()` MUST honor D9: tools run INSIDE the request, `finish_reason` is always `'stop'` / `'length'`, never `'tool_calls'`. If a route needs client-side tool callbacks, it's a different surface — don't bend the existing OpenAI route.

**Auth scope.** Anything under `/v1/*` auto-inherits `bearerAuth(opts.apiKey)`. Routes that need to be auth-exempt (liveness / readiness probes) mount outside the `/v1/` namespace — see `routes/health.ts` as the reference.

**SessionDb conventions.** When a route persists trace state, tag the row `metadata.kind='<surface>-api'` and namespace the PK to prevent cross-surface pollution (post-H1 fix pattern from `chatCompletions.ts`: prefix client-supplied ids with `<surface>:` before passing to `upsertSession`). The wire response should echo the CLIENT's view of the id unprefixed.

## Add A Channel Adapter

`src/channels/` is the inbound-channel framework for `sov gateway` (Phase F) — a Slack / Telegram / webhook message drives one headless harness turn and the reply goes back out over the channel. Adapters are deliberately thin: they **authenticate + parse** an inbound request and **deliver** a reply, and drive the shared turn pipeline for everything in between. Adding a channel follows a fixed shape; the existing `webhook` adapter (`src/channels/adapters/webhook.ts`) is the smallest reference, `slack.ts` the richest.

1. **Implement the adapter contract** (`src/channels/adapter.ts` — `ChannelAdapter<T>`). Three responsibilities, each pure of turn logic:
   - **`verify`** — authenticate the raw request **constant-time** over the **raw bytes** (the HMAC/signature is computed over exactly what was signed; never re-serialize parsed JSON, the bytes change). Return a verdict, not an exception, on a bad signature so the route maps it to a 401/403. The webhook uses `verifyWebhook` (HMAC-SHA256 of the raw body); Slack uses `verifySlackSignature` (`v0=` HMAC over `v0:{timestamp}:{rawBody}` with a 300 s replay window).
   - **parse → a normalized `InboundMessage`** (`src/channels/types.ts`: `{ channel, sender, chatId, chatType, text, threadId?, raw }`). **CRITICAL — validate inbound ids at the source.** `sender` / `chatId` / `threadId` become path-segment-shaped parts of the deterministic session key, which becomes a trace **filename** — so each MUST pass `isSafeSegmentId` (exported from `webhook.ts`: an `^[A-Za-z0-9_.-]+$` allowlist, length-capped, explicit `..` reject). A violation returns `null` → the route 400s with no turn. (This is the source boundary of a defense-in-depth pair; `TraceWriter`'s path sanitizer is the sink-boundary belt-and-suspenders — but validate at the source anyway; the trace-sink sanitizer is not a license to skip it.) `text` is free-form (never a path segment).
   - **`deliver(reply, msg, transport)`** — send the reply back over an **injected transport** (a bot-API client). Keep the transport an injectable seam (`TelegramTransport` / `SlackTransport`) so the adapter is testable with no live credentials.

2. **Drive the shared pipeline — don't reimplement the turn.** `runChannelTurn({ runtime, msg, principalId, permissionMode? })` (`src/channels/pipeline.ts`) owns find-or-create-session → persist inbound → run one headless turn → persist reply → dispose, and returns `{ text }` or `{ silent }`. It already handles: per-`sessionId` **serialization** (concurrent messages from one sender don't race the shared context), **empty/whitespace short-circuit**, a **bounded recent-history window** (`capSeededHistory`, ~40 messages), the **learning loop** (memory + recall scoped to the channel principal), and an **error fallback** reply on a non-completed terminal. Your adapter just maps inbound → `InboundMessage`, calls this, and delivers a non-silent reply.

3. **Do not weaken the safe-by-default permission posture.** A channel message is untrusted remote input. The pipeline builds the decider with `buildChannelCanUseTool` (`src/channels/permission.ts`), which **never calls `loadPermissionSettings`** (no local-allow inheritance — a remote sender can't ride your `allow: Bash(*)`), **auto-denies** any `ask` fallthrough (no human at the boundary), and **rejects `bypass`** (`assertChannelPermissionMode` throws — a remotely-reachable bypass is RCE). The tool pool is filtered against `SUBAGENT_EXCLUDED_TOOLS`. Don't route around any of this; channel-scoped allow-rules are the only intended escape hatch (passed as `ruleLayers`, never the dev's settings layers).

4. **Wire it in.** Inbound HTTP channels (webhook, Slack) add a route to `channelsRoute` (`src/server/routes/channels.ts`) — mounted **open** (before the `/sessions/*` bearer/principal auth, like `/health`), since the per-channel `verify` is the gate, not the gateway token. Poll-based channels with no public endpoint (Telegram) are **background workers** built in `buildChannelListeners` (`src/channels/listeners.ts`) and `start()`/`stop()`ed in the gateway lifecycle. The `/channels/*` routes carry a shared **1 MiB inbound body cap** (`bodyLimit`).

5. **Add the config + env-first secrets.** Extend `gateway.channels` in `src/config/schema.ts`: `{ enabled?, principalId, <secret(s)>?, permissionMode? }`, `.strict()`, with `permissionMode` enum `['default','ask']` (so `bypass` is a **parse error**, not a refine). The `superRefine` requires, for each *enabled* channel, its secret(s) present AND a `principalId` resolving to a declared `gateway.principals` id. Keep the schema **env-free** — secrets resolve env-first in `resolveChannelsConfig` (`listeners.ts`), which injects env into the raw config *before* the parse (config wins over env). Register the env-var name in `CHANNEL_SECRET_ENV`. Secrets are **never logged** — boot prints only the enabled-channel names.

6. **Test against injected transports.** Per-area suites live in `tests/channels/` (`permission`, `pipeline`, `webhook`, `telegram`, `slack`, `listeners`, `channelIsolation`). Cover: a bad/missing/stale signature is rejected with no turn; the safe posture holds **even with a local `allow Bash(*)` seeded on disk** (prove no local-allow inheritance); `bypass` config is rejected; a source-validated bad id 400s; two channels on different principals stay isolated (sessions/memory/learning). No live credentials needed — inject the transport.

### Add A Principal

A principal (a named gateway user) is **config-only** — no code. Add an entry to `gateway.principals` in `config.json`: `{ id, token, name? }`. The `id` must be a safe path segment (`^[A-Za-z0-9_-]+$` — it becomes a per-user state directory component) and the `token` non-empty + unique. `gateway.principals` is **XOR with the single `gateway.token`** (a gateway runs one auth model at a time). Channels bind to a principal by `principalId`. See [usage › Multi-user gateway](usage.md#multi-user-gateway).

## Add A Trajectory Redaction Pattern

`src/trajectory/redact.ts` ships a `PATTERNS` array — every match is replaced with `[REDACTED]` (or `[REDACTED:<name>]` when `tagged: true`) before the trajectory record is written to disk. Adding a new secret-shape:

1. Append a `{name, regex}` entry to `PATTERNS`. Use a **named** regex so the `tagged` mode shows which pattern fired — useful for diagnosing false positives.
2. Anchor the pattern with word boundaries (`\b`) where the secret has a stable prefix/suffix; otherwise the regex will match arbitrary substrings.
3. Add a positive case (the secret should redact) AND a negative case (similar-shaped but legitimate text shouldn't) to `tests/trajectory/redact.test.ts`.

Use `redactForce()` in tests rather than `redact()` — `redactForce` runs the patterns regardless of the import-time `HARNESS_REDACT_SECRETS` snapshot, so tests are independent of env state.

The redactor is **conservative on purpose** — false positives are cheap (a stray `[REDACTED]` in a trajectory archive), false negatives leak secrets into archives that may be committed to a repo. Bias toward over-matching when a secret pattern is ambiguous.

## Add A Session Migration

1. Increment `CURRENT_SCHEMA_VERSION` in `src/agent/sessionDb.ts`.
2. Add a `Migration` entry from the previous version to the new version.
3. Keep migrations forward-only.
4. Update types such as `Session` and `SessionCost`.
5. Update create/read/write SQL.
6. Add migration tests in `tests/agent/sessionDb.test.ts`.

Use additive schema changes where possible. Existing local databases are part of the developer experience, so migrations should be boring and deterministic.

## Add A Context Surface

Context that should remain stable for a session belongs in system prompt assembly under `src/context/`. Context that depends on the current user turn belongs in user-message expansion or injection.

Do not mutate the frozen system prompt after session creation. On resume, the stored system prompt wins.

Injection-prone external text should be fenced, labeled, bounded, and screened before it reaches the model.

## Add A Golden (Eval Test)

Goldens are deterministic-ish end-to-end tests run by `sov eval run`. Unlike semantic tests (which use an LLM judge for fuzzy scoring), goldens use code assertions for strict scoring. Lives at `evals/goldens/*.golden.ts`.

1. Create `evals/goldens/NN-my-test.golden.ts`.
2. Export a `GoldenSpec` const (any export name — the loader picks up everything matching the spec shape):

```ts
import type { GoldenSpec } from '../../src/eval/types.js';

export const myGolden: GoldenSpec = {
  id: 'my-golden',                 // stable; also the filter substring
  name: 'Short human-readable name',
  description: 'What this exercises and why.',
  category: 'tools',                // optional grouping tag
  seed: {                           // optional sandbox files (relative paths)
    'README.md': '# fixture\n',
  },
  prompt: 'Single-turn user prompt.',  // or string[] for multi-turn
  assertions: [
    { type: 'agentResponseContains', text: 'fixture' },
    { type: 'fileExists', path: 'README.md' },
    { type: 'noToolErrors' },
  ],
  // optional:
  timeoutMs: 60_000,
  extraArgs: ['--permission-mode', 'bypass'],
  slow: false,
};
```

3. Validate with `bun src/main.ts eval run --filter <your-id>` (live LLM, ~$0.05).
4. Once green, optionally capture a fixture for CI: `sov eval run --filter <your-id> --capture <dir>`. Subsequent CI runs can replay from the fixture without spending tokens.

Assertion catalog: `fileExists`, `fileNotExists`, `fileContains`, `fileMatches` (regex + flags), `fileEquals`, `agentResponseContains`, `agentResponseMatches` (regex + flags), `agentResponseLacks`, `noToolErrors`, `minToolCalls`, `maxToolCalls`, `exitCode`. Each is pure: `(sandboxCwd, transcript, exitCode, toolCalls?) → {pass, detail?}`.

When to add a golden vs a semantic test vs a unit test:

- **Unit (`tests/`):** pure-logic regressions. Runs on every `bun test`. No LLM.
- **Semantic (`tests/semantic/`):** fuzzy meaning checks ("the agent didn't fabricate"). LLM-judged. Opt-in.
- **Golden (`evals/goldens/`):** deterministic-ish file-state and transcript checks ("the agent created the file with the right contents"). Code-judged. Opt-in. Capturable.

See [`evals/README.md`](../evals/README.md) for the full format documentation, the assertion catalog with examples, and the seed-golden inventory.

## Add A Semantic Test

Semantic tests live under `tests/semantic/suites/*.cases.ts`. Each one is a single prompt (or array of prompts for multi-turn cases) + judge criteria designed to weed out a specific bug class. See [`docs/semantic-testing.md`](./semantic-testing.md) for the full inventory of existing tests, what each guards against, and the policy for when to add a new one (new tool / slash command / permission rule path / context surface, or a bug that should never regress).

1. Open or create `tests/semantic/suites/NN-topic.cases.ts`.
2. Append an entry to its exported `tests: SemanticTest[]`:

```ts
{
  id: 'kebab-case-id',           // unique across the whole suite
  name: 'Short human title',
  description: 'Which bug class does this test guard against?',
  category: 'tools' | 'commands' | 'permissions' | 'context' | 'workflow' | 'refusal' | 'hooks' | 'router',
  setup: {
    files: [{ path: 'foo.txt', content: 'bar' }],          // optional — sandbox cwd
    homeFiles: [{ path: 'config.json', content: '{}' }],   // optional — under HARNESS_HOME
    userConfig: { router: { localProvider: 'anthropic' } }, // optional — overrides HARNESS_CONFIG (Phase 10.6)
    env: { MY_VAR: 'value' },                              // optional — merged on top of sandbox defaults
  },
  // Single string for one turn, or string[] for multi-turn (one prompt per turn).
  prompt: 'The single user prompt sent to the agent.',
  judgeCriteria: {
    mustSatisfy: [
      'A behavior the transcript MUST demonstrate.',
    ],
    shouldNot: [
      'A behavior that, if observed, forces fail.',
    ],
  },
  timeoutMs: 45_000,             // optional; default 60_000; bump for multi-turn (90-180s)
  binaryArgs: ['--permission-mode', 'default'],  // optional; overrides driver defaults
}
```

3. Validate with `bun run test:semantic -- --filter <your-id>`.

Design rules:

- One target bug class per test. Don't try to verify five things at once — multiple weakly-related criteria make the verdict harder to interpret.
- Criteria must be observable in the ANSI-stripped transcript. "The agent invoked the Read tool" is observable; "the agent understood the intent" is not.
- Embed unique tokens (`sovereign-test-token-9f3e1c`) in echo-style prompts so the judge can tell genuine tool output from fabrication.
- Always include a `shouldNot` to catch hallucination bugs that a presence-only check would miss.
- Setups must be deterministic: declare every input file in `setup.files`, never depend on ambient state.
- Pick prompts the agent has no independent reason to refuse. Modern models refuse risky commands like `rm` on their own safety judgment, masking the system you're actually trying to test (e.g., the permission deny rule). Use innocuous targets like `echo` and rely on the test setup to gate them.
- For multi-turn cases, criteria can refer to specific turns ("In Turn 2, the agent..."). The judge prompt builder formats multi-turn prompts as numbered turns automatically.

### Add A Judge Backend

`Judge` is a function type. Adding `codex`, an OpenAI judge, or eventually `sov`-judges-itself is mechanical:

1. Create `tests/semantic/framework/judges/<name>.ts`. Export `create<Name>Judge(opts)` returning `Judge`. Use `buildJudgePrompt()` from `prompt.ts` for the prompt and either `parseVerdictFromText()` or `makeVerdict()` for the verdict shape.
2. Wire it into `framework/judges/index.ts`: add to the `JudgeBackendName` union and a case to `selectJudge()`.
3. Document the backend in the table in `tests/semantic/README.md` and add coverage notes to [`docs/semantic-testing.md`](./semantic-testing.md) if relevant.

The runner, the entry point, and every test case stay unchanged.

## Update Documentation

When a change introduces a non-trivial design choice, add an entry to `DECISIONS.md`. When user-facing behavior changes, update the README or the relevant file under `docs/`. Phase-completion notes belong in `CHANGELOG.md`.

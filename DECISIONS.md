# Decisions

This file records runtime-local design choices. Larger product and architecture ADRs still live in `~/code/sovereign-ai-docs/`.

## 2026-05-04 - Phase 12 MCP Client: Eleven Design Decisions

Phase 12 ships the MCP client + deferred tool loading per `harness-build-plan.md` §"Phase 12" and `claude-code-reverse-engineering.md` §11. Eleven choices were locked during implementation; recording here so a future pass that revisits any of them sees the rationale.

1. **stdio transport only this phase.** HTTP/SSE/WebSocket explicitly skipped. The build plan calls this out: "stdio covers most published servers." Adding more transports is additive — the SDK's `Transport` abstraction means new transports plug into `client.ts` without changing the wrapper or anything downstream.

2. **Use `@modelcontextprotocol/sdk` (the official TS client).** Pinned at `^1.29.0`. The SDK owns JSON-RPC framing, schema discovery, and tool invocation; reinventing any of that would be wasted code and a future bug source.

3. **`mcpServers` lives in `RuntimeSettingsSchema` (`src/config/settings.ts`)**, alongside `permissions` and `hooks`. Same layered local→project→user precedence. Servers are concatenated by alias across layers; duplicate aliases throw with both source paths so the user can pick one. Putting MCP in `SettingsSchema` (provider config) instead would make project-level MCP impossible.

4. **All MCP tools default to `shouldDefer: true`.** Otherwise a single MCP server can blow out the prompt — many servers expose 10-30 tools. Native tools stay non-deferred; their schemas are small and stable enough to ship every turn.

5. **Auto-deferral threshold (the build plan's "10% of context" line) is skipped.** Token-count heuristics for "should this tool defer" are easy to get wrong. Deferral is a per-tool boolean; native tools opt in explicitly if needed. The MCP-default behavior already covers the common prompt-bloat case.

6. **Lazy-loading factory pattern (Qwen §3.1) is deferred.** ~14 native + N MCP tools is small enough that eager registration costs little. The wrapper is a thin closure (no expensive imports). Revisit when MCP tool counts cross ~50, or when startup latency from MCP discovery becomes user-visible.

7. **First-use TTY consent for MCP servers is deferred.** The settings.json edit IS the consent — registering an MCP server requires the user to type a command + args, which is a deliberate scoped action. Hooks needed first-use TTY consent because they could be silently invoked by any tool call; MCP servers are explicit external resources. If a real-world abuse pattern surfaces, add consent in a follow-up.

8. **MCP tools use existing `mcp__<server>__<tool>` rule patterns — no new permission code.** The rule matcher's prefix matching already supports `mcp__github` (deny whole server) and `mcp__github__create_issue` (specific tool). Re-using the canUseTool path means the same hooks, prompts, and bypass-mode semantics apply uniformly.

9. **Add `inputJSONSchema?: object` to `ToolDef`/`Tool` for MCP.** When present, the schema serializer uses it verbatim and the orchestrator skips Zod validation on the input (the MCP server validates inputs itself). For native tools, Zod stays the single source of truth. This keeps native tools strict while letting external schemas flow through unchanged.

10. **MCP server lifecycle is session-scoped.** Connect at session start (after settings load), disconnect on session end via `mcpPool.shutdown()`. Connection failures log and skip — one bad server doesn't take down the whole session, the affected tools just don't appear. Restart the harness to retry connections.

11. **`ToolSearchTool` is a native tool, always non-deferred, with a closure over the live deferred-tool list.** It must be in every tools array so the model can find it. Its closure reads from the assembled pool at call time, so newly-discovered tools become searchable without a rebuild. Input is `query: string` (keyword OR `select:n1,n2`); output is the full schemas of matched deferred tools, formatted so the model can read the result and emit a correct subsequent tool_use.

Skipped this phase per the build plan's explicit list: HTTP/SSE/WebSocket transports, MCP resources, MCP OAuth, harness-as-MCP-server (Phase 19).

## 2026-05-04 - Phase 11 Hook System: Eight Design Decisions

Phase 11 ships shell hooks per `harness-build-plan.md` §"Phase 11" and `claude-code-reverse-engineering.md` §10. Eight choices were locked during implementation; recording here so a future pass that revisits any of them sees the rationale.

1. **PreToolUse fires after `canUseTool`, before `tool.call()`.** Permissions deny first — no wasted subprocess spawn for known-bad calls. Hooks observe an already-authorised invocation and can still upgrade to deny or rewrite the input. The orchestrator's flow is: schema-validate → canUseTool → PreToolUse hook → tool.call → PostToolUse hook → render result. Reversing canUseTool ↔ PreToolUse would let a deny-rule-blocked invocation still spend a hook subprocess; not worth it.

2. **`permissionDecision: 'ask'` from PreToolUse is treated as deny with reason.** Wiring the hook back through the same `AskUser` callback would couple the orchestrator to the permission UI for one rare path. Until a real-world hook returns 'ask', the deny-with-reason is the lowest-risk default. Trivial to upgrade later — the hook output is already parsed; only the response handler in `executeOne()` needs a branch.

3. **Overlap-lock util (`src/util/overlapLock.ts` per Fry §A3) is deferred.** No real-world hook hits concurrent reentrancy in the current flows. Add when a smoke test surfaces a problem; the Fry pattern (`os.Mkdir` is atomic; EEXIST → skip) is portable and zero-dep.

4. **Hooks live in `RuntimeSettingsSchema` (`src/config/settings.ts`)**, not `SettingsSchema` (`src/config/schema.ts`). Hooks are runtime policy, layered local → project → user, same lifecycle as permission rules. `loadHookSettings()` parallels `loadPermissionSettings()` and walks the same `getPermissionSettingsPaths()`. `SettingsSchema` (the user-level provider config in `~/.harness/config.json`) is a different concern.

5. **Allowlist keyed by literal command string + event name.** Moving a hook from PreToolUse to PostToolUse re-prompts (cheap defence-in-depth — a hook approved as one event surface should not silently start running on another). Hashing the command body would protect against script substitution but adds complexity; trusting the literal command string mirrors how the rest of settings.json is trusted.

6. **`argvSplit()` is a small purpose-built util, not an npm dep.** ~40 LOC handling whitespace, single/double quotes, `\` escapes, and leading `~/` expansion. No piping, redirection, variable substitution, or globbing — those are shell features that belong inside the user's hook script. Adding `shell-quote` for these few semantics would weigh more than the implementation.

7. **`PostToolUseFailure` (a separate event in Claude Code) is folded into `PostToolUse` with `is_error: boolean`.** The build plan's type signature combined them deliberately — splitting later is a non-breaking change if the matcher schema stays forward-compatible.

8. **Stop hook fires unconditionally on every Terminal — including `error`.** Claude Code skips Stop hooks on API errors to avoid an infinite loop where a Stop hook requests continuation. We don't expose a continuation channel from Stop hooks (they're observers only), so the guard isn't needed. Stop hooks are also fire-and-forget; failures are swallowed.

Skipped this phase by build-plan instruction: `Notification` and `SubagentStop` events; glob matchers like `mcp__*` (waits for Phase 12 MCP); transcript_path / permission_mode in the stdin payload (the build plan's payload spec didn't include them).

## 2026-05-03 - Vim Mode Deferred Indefinitely

The Wave-5 vim-mode plan (~500 LOC: NORMAL/INSERT/VISUAL state machine over the Wave-4 TextBuffer) is deferred. ~70-80% of users don't use Vim, and the LOC-to-felt-value ratio is worse than even Phase-11 hooks. The Wave-4 input editor's TextBuffer already supports every operation a vim layer would need, so adding vim later is a small additive change rather than a refactor.

Reasoning: the polish wave was at diminishing returns. The next 500 LOC spent on capability (hooks, MCP, trajectory capture) beats the next 500 LOC spent on more polish. Vim mode comes back to the table only if a real user asks for it.

## 2026-05-03 - Wave-4 Input Editor With `--legacy-input` Safety Hatch

The Wave-4 raw-mode input editor replaces readline as the default when `process.stdin.isTTY === true`. Bugs that only surface in real terminals (cursor positioning under reflow, modifier-key reporting on uncommon terminals, paste-burst edge cases) won't be caught by unit tests. The `--legacy-input` flag forces the legacy `readline` + `queuedQuestion` path so users can fall back without losing functionality.

Piped stdin always uses the legacy path automatically — the new editor's terminal assumptions don't fit non-TTY input, and CI / scripted sessions need the proven readline behavior.

`queuedQuestion.ts` stays in the codebase indefinitely. Removing it would require replacing the legacy fallback with something else; the cost-to-benefit ratio doesn't favor that.

## 2026-05-03 - Theme Tokens Instead Of Direct `chalk.<color>(...)`

Wave-3 introduced a semantic token registry (`src/ui/theme.ts`) that replaces literal `chalk.<color>(...)` calls in high-traffic renderers. Renderers ask for roles (`accent`, `statusError`, `diffAdded`) instead of concrete colors. Three built-in themes (`dark` / `light` / `no-color`) swap the role-to-color mapping; custom themes from `~/.harness/themes/*.json` are deferred but the registry is structured to absorb them.

Reasoning: theme support was already a felt need (light-terminal users get bad contrast under cyan-on-default; CI / transcript users want stripped output). The token system also makes future contrast / accessibility tweaks (high-contrast theme, colorblind-friendly palette) a config change rather than a code-wide sweep.

The migration is invisible under the dark theme — every existing test passes without assertion changes. Lower-traffic renderers (markdownStream, sessionSummary, info, registry) keep direct chalk calls; sweeping them is mechanical but low-value until a theme actually needs to override their styling.

## 2026-05-03 - Modal Frame For Permission Prompts (Wave 1)

Permission prompts are rendered as a yellow-bordered box (`withModal()` in `src/ui/modal.ts`) instead of an inline `[permission] ...` text line. The framed shape can't be visually buried by concurrent decorator output: the modal raises a module-level `modalActive` flag that decorators (`thinking`, `toolSlot`) consult before writing.

The actual answer is still read through the readline `question()` the REPL owns — we don't open a second readline. The modal is a richer-looking prompt, not a parallel input system.

Reasoning: the prior inline format (`[permission] Bash ls src/`) was a known pain point — under streaming text, the spinner's `\r + clear-line` could clobber the prompt mid-read. The framed box plus the modal-active flag fix both sides of that bug.

## 2026-04-28 - Context-Percentage Trigger For Microcompaction

Microcompaction uses a context-percentage trigger (tool results > 40% of estimated context) rather than Qwen Code's idle-timeout trigger (clear after N minutes of inactivity). The idle-timeout design assumes a user walks away and returns; our harness is continuously model-operated, so idle time is rare but context bloat is constant. The percentage trigger fires when it matters (tool results are crowding out conversational context) regardless of wall-clock time.

## 2026-04-28 - Virtual Tool Name For Cross-Tool Permission Resolution

Shell AST analysis maps read-only Bash commands to `Read` via a `virtualToolName` method on the Tool interface. The alternative was teaching the rule engine to understand shell commands directly, which would have violated the principle that domain semantics stay delegated to tools (Invariant #6). The `virtualToolName` approach lets any tool declare a mapping without the permission system knowing about specific tool input shapes.

## 2026-04-28 - Qwen Code Patterns As Targeted Deepenings

The Qwen Code analysis identified six patterns worth lifting. Two (microcompaction, shell AST) deepened completed phases and landed as immediate implementation. Four (loop detection, tool lazy loading, subagent exclusion set, memory consolidation) are integrated into upcoming phases in `harness-build-plan@6`. Patterns explicitly skipped: MCP OAuth, modifiable tools, SDKs, aggressive auto-memory. See `sovereign-ai-docs/harness/docs/reference/qwen-code-analysis.md`.

## 2026-04-27 - Follow The Maturity-First Build Order

`sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md@6` is the canonical remaining build order. The runtime repo should treat Phase 10.5 soak/evals/traceability, Phase 10.6 local-router hardening, and Phase 10.7 profiles as the next maturity work before hooks, MCP, sub-agents, task parallelism, and reviewed self-learning. Broad channel/API surfaces are optional reach work, not core private-harness maturity.

Reasoning: the harness is for private use with a local or hybrid LLM, not for launching a competing agent product. The capability gap that matters most is robustness: traceable behavior, profile isolation, reliable local-model routing, recursive sub-agents, bounded parallelism, and Hermes-style propose-then-promote learning.

## 2026-04-26 - Keep Business Context Outside The Runtime Repo

The harness repo documents runtime behavior, extension points, and operational usage. Product strategy, business context, and ADR H-0003 remain in the sibling docs repo.

Reasoning: this repo is intended to be deployable as runtime code against different client bundles. Pulling client-zero business context into `src/` or repo-local runtime docs would make the runtime less portable.

## 2026-04-26 - Treat README As Orientation, Not Phase Ledger

Detailed phase completion notes moved to `CHANGELOG.md`. The README keeps current status, setup, usage, and links to deeper docs.

Reasoning: the phase log was useful but made the README harder to scan for new developers. Keeping the log preserves history while making the first-read path shorter.

## 2026-04-26 - Document Extension Surfaces Before Future Phases

The repo now has `docs/architecture.md` and `docs/extending.md` before Phase 11 starts.

Reasoning: phases 0-10 established the core contracts. Hooks, MCP, sub-agents, review, and routing will be easier to implement consistently if the existing extension surfaces are explicit first.

## 2026-04-26 - Split Operator Usage From README

The repo now has `docs/usage.md` for day-to-day runtime operation. The README keeps quick-start commands and links to the full guide.

Reasoning: install, architecture, development, and operator behavior were competing for space in the README. A dedicated usage guide makes common workflows easier to find without losing detail.

# Decisions

This file records runtime-local design choices. Larger product and architecture ADRs still live in `~/code/sovereign-ai-docs/`.

## 2026-05-04 - Phase 10.7 profile system: env-var-before-imports, with `default` reserved

The profile system scopes `<harness-home>` to `<base>/profiles/<name>/` so the same machine can host disjoint setups (work / personal / lab) without aliasing config, credentials, sessions, rate-limit ledgers, memory, or skills. Several design choices worth recording:

1. **Profile selection is `process.env.HARNESS_HOME`, set BEFORE any module that captures the path at load time.** Per Invariant #11. The pre-import argv scan in `src/main.ts` translates `-p <name>` into `process.env.HARNESS_HOME = join(<base>, 'profiles', <name>)` before the static-import tree resolves. This means modules never need to plumb a "profile" argument; they just call `getHarnessHome()` and land under the right root.

2. **`-p` short flag is reassigned from `--provider` (chat) to `--profile` (top-level).** The top-level concept (which state root to use) takes precedence over the chat-subcommand-specific concept (which provider to target). No tests or docs used the old short form, so the breakage is theoretical. Long-form `--provider` is unchanged.

3. **The `'default'` profile name is reserved.** It maps to `<base>/` itself — the unscoped state root, which is also the pre-Phase-10.7 default. Reserving the name lets `sov profile use default` semantically mean "pin back to the unscoped root" without introducing a separate "no profile" concept. `assertProfileName('default')` deliberately throws so the reservation is enforced at every entry point.

4. **`<base>/active-profile` persists the pinned selection.** A plain text file with the profile name (or empty for default). Read on startup when `-p` is absent. Chosen over a flag in `config.json` because a profile selection can't live inside the per-profile config file (chicken-and-egg: which config do we read first?).

5. **The atomic-mkdir PID lock (`<profile>/.sov.lock/`) is shipped as a helper but NOT integrated into REPL startup.** The lock would prevent concurrent `sov` sessions on the same profile, but that's a behavioral change with no clear forcing function — SQLite's WAL mode and the atomic temp+rename pattern for credentials.json already cover the dominant write-collision cases. The helper exists for a future "guard mode" or advisory banner; turning it into a hard guard is a separate decision.

6. **Profile-aware paths use functions, not module-load-time constants.** The first iteration kept eagerly-evaluated `DEFAULT_DB_PATH = join(homedir(), '.harness', 'sessions.db')`-style consts. Those locked in the wrong path when `-p` set HARNESS_HOME after the module was imported. Now every call site uses `getDefaultDbPath()` / `getDefaultCredentialStatePath()` / `defaultRateRoot()` and re-resolves at call time. The deprecated consts remain as back-compat shims (with `@deprecated` JSDoc) so external callers don't break, but in-tree code uses the function form.

7. **`profile import-default` copies `config.json` + `credentials.json` only.** Sessions/trajectories/memory stay clean — a profile is meant to scope history per project, not duplicate it. Refuses to overwrite existing files in the target so re-running it is safe.

## 2026-05-04 - `sov upgrade` Bun-cache workaround: pre-uninstall + optional --purge-cache

`bun install -g <git-url>` doesn't reliably re-resolve against the remote. Two layers of cache fight us:

1. **Lockfile pin** at `~/.bun/install/global/bun.lock`. Bun records the resolved SHA per URL and re-uses it. Symptom: `bun install -g <url>` reinstalls the pinned commit. Workaround: `bun uninstall -g @yevgetman/sov` evicts the lockfile entry. (Without this, requesting a different ref also triggers `DependencyLoop` because the existing install and the new request have the same package name.)

2. **Binary `.npm` manifest cache** at `~/.bun/install/cache/*.npm`. Even after the lockfile is clean, Bun stores a `URL → SHA` mapping in opaque per-package binary files. `bun install --no-cache --force <url>#master` still serves the cached SHA. Symptom verified empirically while verifying Phase 13.1: `sov upgrade` (post-pre-uninstall fix) kept installing `0eee03c` while `git ls-remote` showed master at `797222d`.

Two-step fix:

- **Pre-uninstall is always-on.** `runUpgrade` spawns `bun uninstall -g @yevgetman/sov` before `bun install -g <url>`. Uninstall failures are silently ignored (first-install case). API contract bumped: `UpgradeResult.command: string[]` → `UpgradeResult.commands: string[][]`. `--skip-uninstall` flag for the rare "I want the cached SHA" case.

- **`--purge-cache` is opt-in.** When present, `runUpgrade` `rm -rf`'s `~/.bun/install/cache/` before install. The cache wipe takes out other Bun-installed packages' manifest entries too — regenerable on next install, low cost. `cacheDir` opt is a test seam so unit tests exercise dry-run without touching the real cache.

Rejected alternatives:

- **Always purge the cache.** Defaulting to a destructive cache wipe punishes users who have other globally-installed Bun packages. Make it explicit.
- **Append a unique URL fragment per upgrade** (`#?t=<timestamp>`). Git rejects query parameters in refs, breaks the URL.
- **Clone-and-link instead of `bun install -g`.** Bypasses Bun's caches entirely but loses the upgrade-via-package-manager UX. Worth revisiting if Bun's caching changes shape again.

This is a Bun-side bug surface. If `bun install` ever gains a real "force re-resolve" semantic for git URLs, drop `--purge-cache` and the lockfile-eviction step.

## 2026-05-04 - Distribution: git+ssh, not npm

The harness package and the repo it lives in are private. Distribution uses `bun install -g git+ssh://git@github.com/yevgetman/sovereign-ai-harness.git` directly against the private repo; SSH access is the access-control gate (same as cloning). `package.json` is marked `"private": true` so `npm publish` is impossible by mistake.

Rejected alternatives:

- **npm Pro / Teams ($7/mo).** Pays for hidden registry packages. Unnecessary when SSH-gated git installs achieve the same access control free.
- **Public npm publish.** The harness binary is harmless to leak (it requires an Anthropic key to do anything; source posture stays "all rights reserved" via the `license` field), but the user explicitly asked for non-public access. Falling back to git+ssh respects that.
- **GitHub Packages.** Adds `.npmrc` PAT-auth setup per machine. More friction than git+ssh for single-user / small-team distribution. Worth revisiting if a team distribution emerges.

`sov upgrade` shells out to `bun install -g git+ssh://...` so users don't have to remember the URL. `--ref <ref>` pins to a tag, branch, or commit; `--dry-run` prints the command; `SOV_UPGRADE_URL` env var overrides for forks. The pure argv-builder is split from the spawning runner so unit tests don't actually re-install bin during test runs.

## 2026-05-04 - Phase 12.6 Context Budget: Six Design Decisions

`auditContextBudget()` (`src/context/budget.ts`) walks the live context inventory and reports per-component token estimates with bloat tier and triage classification. Choices:

1. **Token estimation is the existing 4-chars-per-token heuristic from `src/core/tokenEstimate.ts`.** Provider-exact tokenization (CL100K, tiktoken, etc.) would require shipping per-provider tokenizer libs and is overkill for triage. The estimator is good enough to identify "this skill is heavy" without claiming exact token counts.

2. **Bloat tiers (`heavy` / `extreme` / null) and per-kind thresholds.** Defaults from ECC's experience: skill 300/800, tool-schema 500/1500, system-segment 800/2000, memory 1000, bundle 1500/3000. Overridable via the `thresholds` opt and the prospective `~/.harness/config.json` `contextBudget.thresholds.*` block. Two tiers because the action differs — a heavy skill might be acceptable; an extreme one is almost certainly bloat.

3. **Classification (`always` / `sometimes` / `rarely`)** uses skill `requires_tools` / `fallback_for_tools` against the active toolset, not just static analysis. "Recent invocation" as a classification signal is deferred until Phase 13.1 (trajectory) lands; until then classification is visibility-only.

4. **HarnessInfo gains a `'budget'` section.** The model can call HarnessInfo to ask its own context-budget question — useful for meta-questions ("why is this session slow?", "what should I drop?"). Wraps the same `auditContextBudget()` so there's one source of truth.

5. **Slash command surface is `/context-budget` (Info category).** Mirrors the per-section `/tools`, `/skills`, `/permissions` commands. The CommandContext gets a `getBudgetReport()` hook so the command and HarnessInfo share the same builder.

6. **Auto-warning at 60%+ utilization deferred.** Invariant #4 freezes the system prompt per session — a `<runtime-context>` warning would only appear at session start, never mid-session as utilization climbs. The audit currently surfaces utilization on demand via `/context-budget`. A pre-prompt warning footer (similar to the existing pre-compaction warning) is the right shape if usage shows it's needed.

## 2026-05-04 - Phase 12.5 Observation Envelope: Three Design Decisions

`ToolResult<T>` gains an optional `observation: ToolObservation` field shaped as `{status, summary, next_actions?, artifacts?}`. The orchestrator renders it as a plain-text header above each tool's existing `renderResult` content. Choices:

1. **Optional in v1, not required.** Tools opt in by populating the field; tools that don't render exactly as before. Once every native tool has been retrofitted (currently true for all 14 native tools + the MCP wrapper), a follow-up phase can flip the field to required. Keeping it optional means the retrofit lands incrementally without breaking changes.

2. **Plain-text rendering, not JSON.** The envelope shows up in tool_result content as labeled lines (`status: error`, `summary: …`, `next_actions:` + bulleted list). Provider-agnostic — works identically across Anthropic, OpenAI, Ollama. Embedding structured JSON in tool_result content would be more parseable for the model but provider-specific work, and the model already parses labeled-line tool output reliably.

3. **`FileEditTool`'s missing-match and non-unique-match cases flip from throws to envelope-emitting returns.** The throws path bypasses the envelope (the orchestrator's catch wraps the message into a generic is_error tool_result), so the model wouldn't see the recovery hint. Returning a structured `{data: {path, replacements: 0, error}, observation: {status: 'error', next_actions: ['Re-read…']}}` lets the existing `renderResult` show the error message and lets the orchestrator surface `is_error: true` from the envelope. Other FileEdit errors (file doesn't exist, identical strings, empty old_string) still throw — those represent invariant violations or input-shape errors where there's no actionable recovery hint, so the standard catch path is fine.

## 2026-05-04 - Phase 9.6 Skill Trigger Rigor: Heuristic-Only

`validateWhenToUse(value)` runs at skill-load time and emits a one-line warning per low-rigor `whenToUse` entry. Three checks: empty/too-short, low-rigor preamble (`use this skill`, `activate this skill`, `call this when`, …), and absence of any trigger verb from a 22-word allowlist (`asks`, `mentions`, `runs`, `edits`, …).

Decisions:

- **Heuristic, not schema.** No regex DSL or structured predicate AST — `whenToUse` stays a free-form string. The model matches naturally; we only nudge skill authors toward predicate-shaped phrasings via the warning.
- **Warning, not block.** A low-rigor `whenToUse` still loads the skill. The user controls their bundle's quality bar; we surface the nudge but don't gate.
- **Multi-trigger via `;`-separated values.** `SkillsListTool` splits on `;` into a `whenToUse: string[]` array so the model sees discrete predicates instead of one buried sentence. Single-trigger skills keep the original `string` shape — back-compat is the schema, the convention is the splitter.

## 2026-05-04 - HarnessInfo + Self-Doc: Two Complementary Surfaces

Two seams instead of one because they answer different questions. The `<harness-self-doc>` system-prompt segment teaches the *contracts* (settings paths, schemas, slash-command names) — stable, cacheable, vendor-neutral. `HarnessInfo` exposes the *live state* (which settings layers are present, which MCP servers connected, what tools are in the pool) — runtime-evaluated at call time. Either alone is incomplete: the prompt without the tool can't answer "what's connected right now"; the tool without the prompt requires the model to ask "what's the schema for adding an MCP server" without knowing what the answer should look like.

The self-doc segment is deliberately vendor-neutral (`<harness-home>` not `~/.harness/`; no "Sovereign AI" identity) so white-label deployments inherit the same prompt unchanged — product identity comes from the bundle layer.

## 2026-05-04 - WebSearch Hide-When-Disabled + Provider Auto-Detection

`WebSearchTool.isEnabled()` returns false when no Tavily/Brave key is configured. Filtered out at `assembleToolPool` time so the model never sees a tool it can't actually call. The previous behavior surfaced WebSearch regardless and let the call fail with "needs an API key" on every search-shaped prompt — a worse UX than a missing tool because the model picks it up to ten times before giving up.

The error path is preserved as defense-in-depth (test paths, programmatic use, mid-session config drift) but should never fire in normal operation.

Provider auto-detection from key shape: Tavily keys begin with `tvly-` by Tavily's own convention; anything else routes to Brave. An explicit `webSearch.provider` always wins. Solves the user-pasted-Brave-key-into-Tavily-default failure mode without requiring two config commands.

## 2026-05-04 - MCP Server-Prefix Permission Rule

`ruleMatchesTool()` recognizes a server-scoped MCP rule when the tool is MCP and `rule.tool === \`mcp__${tool.mcpInfo.serverName}\``. The match runs off `tool.isMcp` + `tool.mcpInfo.serverName`, not name-string parsing — so server names containing `__` would still resolve correctly. Tool-level rules (`mcp__server__tool`) still hit the exact-match path.

Phase 12's plan claimed "the rule matcher already does prefix matching" — it didn't. This decision corrects that and pins the contract: `mcp__<server>` is a server-scoped rule that matches every tool from that server.

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

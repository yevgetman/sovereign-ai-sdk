# Changelog

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

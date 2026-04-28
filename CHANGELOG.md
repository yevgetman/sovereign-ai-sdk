# Changelog

## Cross-Repo Sync Queue - 2026-04-28

Added `notify-docs.yml` GitHub Action (H-0009). On push to master, if CHANGELOG.md, DECISIONS.md, or README.md changed, the workflow appends a structured entry to the docs repo's `state/feed/harness-sync-queue.md`. Agent sessions on the docs repo process pending entries during boot.

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

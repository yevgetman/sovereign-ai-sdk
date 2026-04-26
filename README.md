# Sovereign AI — Agent Runtime

The agent runtime for Sovereign AI. A Claude-Code-style harness (TypeScript on Bun, async-generator turn loop, `Tool<I,O>` factory with fail-closed defaults, content-block messages) with a Hermes-pattern learning layer on top (persistent memory, trajectory capture, background review).

This is **runtime code**. The business data it operates against lives in a separate repo: `~/code/sovereign-ai-docs/`. This repo reads that one as a *harness bundle* and never writes to business-scope files; runtime state lives under `$HARNESS_HOME` (default `~/.harness`) unless a later phase introduces explicit bundle-state writers.

## Status

**Phase 10 complete (2026-04-26)** — context-window compaction. The REPL now supports `/compact`, creates a child session with `parent_session_id`, writes a guarded handoff summary plus the preserved tail into the child, and leaves parent messages intact for `/rollback`. Schema version 3 records lineage, estimated message tokens, and separate compaction cost lanes. The REPL proactively compacts above 50% of the model context window and retries once after provider context-overflow errors.

**Phase 9.5 complete (2026-04-25)** — skills production upgrade. The system prompt now carries only a progressive-disclosure reminder; models discover skills through `skills_list` and inspect bodies/reference files through `skill_view`. Skills support visibility gates (`metadata.harness.requires_*` / `fallback_for_*`), trust-tier guard scanning for third-party content, `${HARNESS_SKILL_DIR}` / `${HARNESS_SESSION_ID}` substitutions, `!` inline-shell interpolation, and an agent-created skill writer via `skill_manage` under `$HARNESS_HOME/skills/agent-created/`.

**Phase 9 complete (2026-04-25)** — skills MVP. Markdown files under `<cwd>/.harness/skills/`, `$HARNESS_HOME/skills/`, and `<bundle>/skills/` load as skills with YAML frontmatter (`name`, `description`, `allowedTools`, `whenToUse`). Skills register as prompt slash commands and can be activated by the model through `SkillTool`. Skill bodies support `{{args}}` substitution.

**Phase 8 complete (2026-04-25)** — slash commands and session cost accounting. The REPL now dispatches `/help`, `/clear`, `/cost`, `/model <name>`, and prompt-backed `/commit` through `src/commands/`. Prompt commands temporarily narrow the visible tool pool and permission surface; `/commit` can use only scoped git status/diff/add/commit Bash operations. The session DB migrated to schema version 2 with token and estimated-cost columns, and each provider turn records input/output/cache token usage plus a price-table estimate used by `/cost`.

**Phase 7 complete (2026-04-25)** — rule-based permissions. The runtime now loads layered permission settings from `$HARNESS_HOME/settings.json`, `<cwd>/.harness/settings.json`, and `<cwd>/.harness/settings.local.json` with local > project > user precedence. Rules support `allow` / `deny` / `ask` entries such as `Bash(git *)`, `Read(*.ts)`, `Write(notes.md)`, `Edit`, or `mcp__server`, with matching delegated to each tool. Deny rules win within a layer, allow rules skip prompts, ask rules force a prompt, and mode fallthrough is `default` / `ask` / `bypass`. "Always" approvals now persist a specific allow rule into project-local settings instead of allowing a whole tool by name. Permission `updatedInput` is revalidated and honored before tool execution.

**Phase 6.7 complete (2026-04-25)** — context references and subdirectory hint loading. User turns now expand `@file:path`, `@file:"path with spaces"`, `@file:path:10-20`, `@folder:path`, `@diff`, `@staged`, and `@url:https://...` before the provider call, with sensitive-path blocks for SSH/AWS/GPG/Kube material, shell rc files, sudoers, and `/etc/passwd`/`/etc/shadow`. Tool results for newly touched directories append nearby safe `AGENTS.md`, `CONTEXT.md`, and `.cursorrules` hints instead of mutating the frozen system prompt.

**Phase 6.5 complete (2026-04-25)** — bounded memory surfaces. `$HARNESS_HOME/memory/USER.md` (1,375 chars) and `$HARNESS_HOME/memory/MEMORY.md` (2,200 chars) are read once per user turn, fenced as recalled context in the user message, and never spliced into the system prompt. The `memory` tool supports explicit `view` and `replace`; over-cap writes fail with a consolidation error rather than truncating. A memory-provider abstraction is in place and rejects more than one external non-builtin provider.

**Phase 6 complete (2026-04-25)** — context assembly, prompt-cache boundaries, and injection defense. New sessions freeze a static-to-dynamic system prompt: base instructions, available tools, bundle context/memory, runtime facts, and local user/project context. Runtime facts capture OS, shell, cwd, date, git status, recent commits, and recent branches once per session; `--resume` reuses the stored system prompt verbatim. Local context discovery merges `~/.harness/CONTEXT.md` first, then `AGENTS.md`, `CONTEXT.md`, and `.cursorrules` from filesystem root to cwd. Suspicious or oversized context files are blocked/truncated before inclusion. Anthropic now applies `system_and_3` cache markers to cacheable system segments plus the last three messages; `--no-cache` disables provider cache markers for testing.

**Phase 5.5 complete (2026-04-25)** — provider hardening. `resolveProvider()` is now the single entrypoint for Anthropic, OpenAI, OpenRouter, and Ollama. API-key providers use a persistent credential-pool metadata file at `~/.harness/credentials.json` (status/cooldown/usage only — no raw keys). A cross-session rate guard writes `~/.harness/rate_limits/<provider>.json` after 429s so other sessions pause or fail fast instead of amplifying retries. Auxiliary clients (`compression`, `title`, `web-extract`) resolve through the cheap fallback chain OpenRouter → Anthropic Haiku → OpenAI mini → local Ollama.

**Phase 5 complete (2026-04-25)** — multi-provider core. The CLI accepts `--provider anthropic|openai|openrouter|ollama`; `--model` overrides provider/config defaults. Anthropic keeps native prompt-cache markers, OpenAI/OpenRouter flatten system segments into a system message, and Ollama speaks `/api/chat`. All providers normalize back into the same internal `StreamEvent` + content-block message shape, so `query()`, the tool loop, permissions, and session persistence remain provider-agnostic.

**Phase 4 complete (2026-04-24)** — the tool ecosystem and concurrency-safe batching. Five new tools land alongside Bash: `FileRead` (line-numbered output, offset/limit paging), `FileWrite` (overwrite, parent-dir-must-exist), `FileEdit` (unique-match string replace + `replace_all`), `Grep` (ripgrep shell-out with content/files-with-matches/count modes), `Glob` (`Bun.Glob` file pattern match). The orchestrator partitions per-turn `tool_use` blocks into contiguous concurrent / serial runs, splits concurrent runs into path-conflict-free sub-batches, caps batches at 10, and re-inserts results in original tool-call order.

**Phase 3.5 complete (2026-04-24)** — conversations persist across runs. SQLite (via `bun:sqlite`) + WAL + FTS5 at `~/.harness/sessions.db` by default; schema-versioned migrations framework in place. Every user / assistant / tool_result message is saved as it's produced. `--resume <uuid>` hydrates history and the *frozen system prompt* from the stored session (storage-side of Invariant #4 — Phase 6 enforces actually-reuse-it). Bundle-mismatch on resume is rejected with a clear error. Jittered retry wrapper (20–150ms × up to 15) + `wal_checkpoint(TRUNCATE)` every 50 writes — prepared for Phase 16/17 multi-writer contention. Zero new npm dependencies.

**Phase 3 (complete 2026-04-24)** — permission prompts around every tool dispatch. The orchestrator calls `canUseTool()` before `tool.call()`; denials flow back as `is_error` tool_result blocks. Latent Phase 2 bug fixed in passing: `query()` now propagates its `AbortSignal` into the tool context. Phase 7 replaced the original coarse tool-name "always" cache with rule-based matching.

**Phase 2 (complete 2026-04-24)** — streaming REPL with the first tool wired through a full `buildTool()` → registry → orchestrator → `query()` loop. `BashTool` is the first capability. Tool results flow back as a user message with `tool_result` content blocks (Anthropic-native shape).

**Phase 1 (complete 2026-04-24)** — baseline streaming REPL against Anthropic, in-memory history, Ctrl-C-aborts-stream, `/quit` or Ctrl-D to exit.

See [`sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md`](../sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md) for the full 28-phase plan, and [`sovereign-ai-docs/harness/decisions/0003-claude-code-core-hermes-learning-layer.md`](../sovereign-ai-docs/harness/decisions/0003-claude-code-core-hermes-learning-layer.md) for the architectural ADR.

## Install on a new machine

Full setup from zero — no prior Bun install, no repos cloned, no key.

### Prerequisites

| Tool | Needed for |
|---|---|
| **Bun 1.2+** | The runtime itself. Ships `bun:sqlite` with FTS5 compiled in — no native-compile step. |
| **Git + SSH to GitHub** | Cloning the private repos. |
| **Provider API key** | Anthropic/OpenAI/OpenRouter access, depending on provider. Ollama can run local without a key. |
| **Node 18+** *(optional)* | Only for the **docs-repo** lint / cascade / sync scripts. Not needed to run the harness. |

Install Bun with `curl -fsSL https://bun.sh/install | bash`, then reopen your shell (or `source` your rc) so `~/.bun/bin` ends up on PATH. The repos are private, so the owner has to grant collaborator access on `sovereign-ai-harness` (and on `sovereign-ai-docs` if you want the docs bundle — which is the default bundle). Get an API key at `console.anthropic.com`.

### Steps

```bash
# 1. Clone both repos
git clone git@github.com:yevgetman/sovereign-ai-harness.git ~/code/sovereign-ai-harness
git clone git@github.com:yevgetman/sovereign-ai-docs.git   ~/code/sovereign-ai-docs

# 2. Install deps + register the global `sovereign` binary
cd ~/code/sovereign-ai-harness
bun install
bun link     # creates ~/.bun/bin/sovereign → this repo's src/main.ts

# 3. Drop your provider key into .env (gitignored; auto-loaded from repo root)
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

# 4. Run from anywhere
sovereign chat --bundle ~/code/sovereign-ai-docs
```

That's the whole setup — three commands, a key, a bundle path.

### What ports vs. what doesn't

**Comes with the repos:** runtime code, tests, ADRs, business docs, CLAUDE.md rules, decisions digest, status pages — every committed file.

**Does not port:**
- `~/.harness/sessions.db` — your conversation history lives under `$HOME`, not the repo. A new machine starts with an empty DB. `scp` the file across if you want a snapshot; usually not worth it.
- `~/.harness/memory/` — bounded `USER.md` / `MEMORY.md` files are local runtime memory. Copy them intentionally if you want the same remembered preferences or notes on another machine.
- `.env` — gitignored by design. Every user brings their own API key.
- The `sovereign-ai-ops` repo (macOS launchd cron for feed / CHANGELOG / audit) — **not required to run the harness.** Clone it only if nightly summaries matter.

### Optional extras

- **Contributing docs changes** — `cd ~/code/sovereign-ai-docs && npm install && npm run install-hooks` turns on the pre-commit cascade + linter.
- **Skip `--bundle` every call** — `export HARNESS_BUNDLE=~/code/sovereign-ai-docs` in your shell rc.
- **Different model** — `sovereign chat -m claude-opus-4-7` (default is Sonnet 4.6 — see `state/memory/decisions-made.md` in the docs repo for the v0.x cost calculus).
- **Different provider** — `sovereign chat --provider openai -m gpt-4o-mini`, `sovereign chat --provider ollama -m qwen2.5:3b`, or `sovereign chat --provider openrouter -m anthropic/claude-haiku-4.5`.

### Gotchas

1. **`~/.bun/bin` must be on PATH.** The Bun installer edits your shell rc; a running shell won't see the change until it's reopened or `source`'d.
2. **No `.bun-version` pin yet.** Any Bun 1.2+ has worked in practice; very old Bun versions may have different `bun:sqlite` APIs.
3. **`bun link` is dev-mode, not a production binary.** The symlink points at the live `src/main.ts` — code edits take effect on the next invocation, no rebuild. Production client installs use `bun build --compile` to produce a standalone binary per [ADR H-0003](../sovereign-ai-docs/harness/decisions/0003-claude-code-core-hermes-learning-layer.md) + [agent-harness § deployment-topology](../sovereign-ai-docs/business/architecture/agent-harness.md#deployment-topology).
4. **Node is a soft dep.** Pure runtime users don't need Node at all. It's only for the docs-repo toolchain (lint, cascade, Notion sync).

## Usage

```bash
bun install
export ANTHROPIC_API_KEY=sk-ant-...   # or drop it in .env at the repo root
bun run chat --bundle ~/code/sovereign-ai-docs
# or: HARNESS_BUNDLE=~/code/sovereign-ai-docs bun run chat
```

Flags: `--provider <name>` (default `anthropic`), `--model <name>` (provider/config default if omitted), `--max-tokens <n>` (default `4096`), `--bundle <path>` (or `HARNESS_BUNDLE` env), `--permission-mode <default|ask|bypass>` (default `default`), `--resume <uuid>` (resume a prior session), `--db <path>` (override the default `~/.harness/sessions.db`), `--no-cache` (disable provider prompt-cache markers for testing).

Provider defaults can also live in `~/.harness/config.json`:

```json
{
  "defaultProvider": "anthropic",
  "providers": {
    "anthropic": { "model": "claude-sonnet-4-6" },
    "openai": { "apiKey": "sk-...", "model": "gpt-4o-mini" },
    "ollama": { "baseUrl": "http://localhost:11434", "model": "qwen2.5:3b" }
  }
}
```

### Session persistence (Phase 3.5)

Every turn is saved to `~/.harness/sessions.db` as it happens. When the REPL exits (cleanly or otherwise), the last line of output shows you the resume command:

```
to resume: sovereign chat --resume <uuid> --bundle <bundle-path>
```

Resuming rehydrates the in-memory history from the DB and reuses the *exact* system prompt segments that were frozen at session creation. Anthropic prompt-cache markers are applied to cacheable system segments and the last three messages unless `--no-cache` is set. Bundle path is validated on resume; using a different `--bundle` than the session was created against is rejected with a clear message rather than silently re-framing the conversation.

Under the hood: SQLite (via `bun:sqlite`, no npm deps) + WAL journaling + FTS5 virtual table for search + ai/ad/au triggers for index maintenance. Schema-versioned migrations (`state_meta` singleton) upgraded sessions to schema version 3 for token/cost accounting plus compaction lineage. A jittered-retry wrapper (20–150ms × 15 attempts) plus WAL checkpoint every 50 writes are in place for Phase 16/17 multi-writer contention.

### Bounded memory (Phase 6.5)

Memory lives under `$HARNESS_HOME/memory/` (`~/.harness/memory/` by default):

- `USER.md` stores durable user preferences and profile facts, capped at 1,375 characters.
- `MEMORY.md` stores agent/project notes, capped at 2,200 characters.

The model sees these files as fenced recalled context prepended to the current user message. The frozen system prompt and stored session system prompt are not changed. Use the `memory` tool to `view` current files or `replace` one whole file with a consolidated version; writes over the cap return an error instead of truncating.

### Context references (Phase 6.7)

Prompt text can include inline references:

```text
Review @file:src/main.ts and @diff
Summarize @file:"docs/file with spaces.md"
Inspect lines @file:src/core/query.ts:40-90
Map @folder:src/context
Quote @url:https://example.com/doc
```

References expand before the provider call into bounded fenced blocks. Sensitive paths such as `~/.ssh/*`, `~/.aws/*`, `~/.gnupg/*`, `~/.kube/*`, shell rc files, sudoers, and `/etc/passwd`/`/etc/shadow` are blocked. When a tool touches a new directory, nearby safe `AGENTS.md`, `CONTEXT.md`, and `.cursorrules` files are appended to that tool result once per session.

### Permission rules (Phase 7)

Permission settings are read from three locations, highest precedence first:

1. `<cwd>/.harness/settings.local.json` — project-local and usually gitignored; "always" approvals are appended here.
2. `<cwd>/.harness/settings.json` — project-shared settings.
3. `$HARNESS_HOME/settings.json` — user-wide settings.

Example:

```json
{
  "permissionMode": "default",
  "permissions": {
    "allow": ["Bash(git *)", "Read(*.ts)", "Write(notes.md)"],
    "deny": ["Bash(rm *)"],
    "ask": ["Edit"]
  }
}
```

Rules are shaped as `Tool(pattern)` or just `Tool`. Aliases `Read`, `Write`, and `Edit` map to `FileRead`, `FileWrite`, and `FileEdit`; native tool names also work. Deny rules are checked first within a layer, then allow, then ask. Layers are strict-precedence: a local allow can override a user-wide deny for the same operation.

When permission fallthrough reaches a prompt, the REPL asks:

```
[permission] Bash ls src/
  allow? [y]es / [N]o / [a]lways:
```

- **`y`** — allow this one invocation, tool runs.
- **`n`** (or Enter) — deny; the tool_result flows back to the model with `is_error: true` and reason `"user denied"`, so the model sees the refusal and can adapt.
- **`a`** — allow this specific command/path pattern for the current project by appending a rule to `.harness/settings.local.json`.

Run with `--permission-mode bypass` to allow permission fallthrough without prompts (explicit deny and ask rules still apply). The banner shows the active mode and how many settings files were loaded.

### Slash commands (Phase 8)

Lines beginning with `/` are handled locally before normal model turns:

| Command | Behavior |
|---|---|
| `/help` | Lists registered slash commands and aliases. |
| `/clear` | Clears in-memory conversation history for the current session. |
| `/cost` | Shows session token totals and estimated USD cost recorded in SQLite. |
| `/compact` | Compresses older history into a guarded handoff summary, creates a child session, and switches to it. |
| `/rollback` | Switches back to the parent session after compaction. |
| `/model <name>` | Switches the active model for subsequent turns. |
| `/commit` | Runs a prompt command asking the model to stage, message, and commit changes. Its tool scope is narrowed to git status/diff/add/commit Bash operations for that turn. |

### Context compaction (Phase 10)

`/compact` runs a four-stage compression pipeline: old oversized tool results are pruned to one-line summaries, the split point is aligned so assistant `tool_use` / user `tool_result` pairs stay together, the recent tail is protected by a token budget, and an auxiliary compression model merges any prior handoff summary with older transcript state.

The new child session keeps the same provider/model/platform/system prompt and points at the parent through `sessions.parent_session_id`. The first child message is a guarded assistant handoff summary that explicitly says it is not active instructions; preserved tail messages follow verbatim. `/rollback` switches the active REPL back to the parent session.

### Skills (Phase 9 / 9.5)

Drop markdown skill files in any of these locations:

- `<cwd>/.harness/skills/` — project-local skills, highest precedence.
- `$HARNESS_HOME/skills/` — user-wide skills.
- `$HARNESS_HOME/skills/agent-created/<name>/SKILL.md` — skills written by `skill_manage`.
- `<bundle>/skills/` — bundled skills.
- `<bundle>/harness/skills-trusted/` — trusted bundled skills.
- `<bundle>/skills-community/` — guarded community skills.

Skill file format:

```md
---
name: simplify
description: Review changed code for reuse and quality
allowedTools: [Bash(git status **), Read, Edit]
whenToUse: User asks to simplify or clean up code
metadata:
  harness:
    requires_toolsets: [filesystem]
    fallback_for_tools: []
---
Review {{args}} for reuse and quality.
```

Each visible skill registers as a slash command (`/simplify src/main.ts`). The system prompt no longer inlines the full skill index; the model uses `skills_list({query})` to discover visible skills and `skill_view({name, path?})` to inspect the full body or a reference file under that skill directory. Prompt-command invocation scopes the turn to the skill's `allowedTools`; model-invoked `SkillTool` returns the expanded skill body as a tool result.

Visibility gates are optional and live under `metadata.harness`: `requires_toolsets`, `requires_tools`, `fallback_for_toolsets`, and `fallback_for_tools`. Trust tiers apply guard scanning before a skill loads: builtin skills allow all findings, trusted skills block critical findings, community skills block medium/critical findings, and agent-created critical content is rejected by `skill_manage`.

Skill bodies and reference files support `{{args}}`, `${HARNESS_SKILL_DIR}`, `${HARNESS_SESSION_ID}`, and inline shell interpolation with the `!`-prefixed backtick syntax. Inline shell runs in the skill directory; failures become `[inline-shell error: ...]` text instead of crashing the loader.

### Global `sovereign` command (dev-mode)

Install once, invoke from anywhere — mirrors how `claude` is invoked for Claude Code:

```bash
cd ~/code/sovereign-ai-harness
bun link         # registers the package AND installs the `sovereign` binary on PATH
```

Then from any directory:

```bash
sovereign chat --bundle ~/code/sovereign-ai-docs
# or set HARNESS_BUNDLE once in your shell rc:
#   export HARNESS_BUNDLE=~/code/sovereign-ai-docs
# and just:
sovereign chat
```

The symlink points at `./src/main.ts` so edits under `src/` take effect on the next invocation — no rebuild step. For production (client installs) use `bun build --compile` to produce a standalone binary instead; see [`agent-harness.md § deployment-topology`](../sovereign-ai-docs/business/architecture/agent-harness.md#deployment-topology).

To uninstall: `bun unlink` from the repo root, or `rm ~/.bun/bin/sovereign`.

## Development

```bash
bun install
bun run test       # fixture tests
bun run lint       # biome
bun run chat --version
```

See `CLAUDE.md` for Claude Code session rules when developing this repo.

## What this repo contains

| Directory | Purpose | Phase |
|---|---|---|
| `src/context/` | System/user context assembly, prompt-cache boundaries, injection defense, context references, subdirectory hints | 6, 6.7 |
| `src/core/` | Async-generator turn loop, content-block types, partition-and-batch orchestrator | 0 scaffold, 1 functional, 4 batched |
| `src/tool/` | `Tool<I,O>` factory with fail-closed defaults; `affectedPaths` + `renderResult` | 0, 4 extensions |
| `src/tools/` | Bash + FileRead/Write/Edit + Grep/Glob + bounded memory tool + skill tools | 2 Bash, 4 file & search, 6.5 memory, 9/9.5 skills |
| `src/providers/` | LLM provider adapters, resolver, credential pool, rate guard, auxiliary fallback | 1 Anthropic, 5/5.5 hardened |
| `src/permissions/` | Permission middleware (layered rules, ask/default/bypass modes, project-local always rules) | 3, 7 |
| `src/agent/` | Session DB — SQLite + WAL + FTS5, migrations, retry wrapper, compaction lineage | 3.5, 10 |
| `src/commands/` | Slash commands (local / local-jsx / prompt) | 8, 10 |
| `src/skills/` | Markdown-plus-frontmatter skill loader, prompt expansion, visibility gates, guard scanner, slash-command adapter | 9/9.5 |
| `src/compact/` | Context-window compaction | 10 |
| `src/hooks/` | Shell-out lifecycle hooks | 11 |
| `src/mcp/` | MCP client | 12 |
| `src/bundle/` | Harness-bundle loader (Sovereign AI specific) | 0 skeleton |
| `src/memory/` | Bounded MEMORY.md / USER.md store, provider ABC, user-message memory injection | 6.5 |
| `src/trajectory/` | JSONL trajectory writer (Hermes pattern) | 13.2 |
| `src/review/` | Background review loop (Hermes pattern) | 13 |
| `src/router/` | Hybrid router — local / local-with-escalation / frontier | 5 |
| `src/config/` | Provider config, permission-rule settings loader, and `$HARNESS_HOME` path helpers | 5, 6.5, 7 |
| `src/ui/` | Terminal REPL (plain readline Phase 1, Ink Phase 14) | 0 stub |

Empty directories are deliberate — they mark future phase landing zones.

## License

Private. All rights reserved.

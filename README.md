# Sovereign AI — Agent Runtime

The agent runtime for Sovereign AI. A Claude-Code-style harness (TypeScript on Bun, async-generator turn loop, `Tool<I,O>` factory with fail-closed defaults, content-block messages) with a Hermes-pattern learning layer on top (persistent memory, trajectory capture, background review).

This is **runtime code**. The business data it operates against lives in a separate repo: `~/code/sovereign-ai-docs/`. This repo reads that one as a *harness bundle* and never writes to business-scope files; runtime state lives under `$HARNESS_HOME` (default `~/.harness`) unless a later phase introduces explicit bundle-state writers.

## Status

**Phase 10.2 complete (2026-04-29)** — model-callable web reach. `WebFetch` (URL → readable text with HTML stripping, private-host blocking, size caps) and `WebSearch` (pluggable search via Tavily default or Brave, with API key from config or env). Closes the gap relative to Claude Code's built-in web tools.

**REPL UX overhaul + Phase 10.1 config command (2026-04-29)** — bundle resolution from CWD, splash screen, boxed session-end summary with token totals, thinking spinner with live token counts, line-buffered markdown rendering of streamed output, in-place compact tool slot, framed input prompt. New `sovereign config` CLI + `/config` slash + interactive picker for writeable user-level config. Tunable proactive compaction threshold (default raised 50→75%) with a self-guard against runaway loops when the system prompt itself exceeds the threshold. Ollama `num_ctx` auto-pinning so chats aren't silently truncated to 2K. `--verbose` flag collapses tool-result previews behind a one-line summary by default.

**Qwen amendment complete (2026-04-28)** — microcompaction (per-part tool-result clearing) and shell command AST analysis (virtual tool mapping for permissions) landed on top of Phase 10. The runtime now clears stale tool results before full compaction triggers, and read-only Bash commands resolve against Read permission rules.

**Phase 10 complete (2026-04-26)** — context-window compaction. The REPL supports `/compact` and `/rollback`, stores parent-child session lineage, records separate compaction usage/cost lanes, proactively compacts above 75% of the model context window, and retries once after provider context-overflow errors.

Next phase: **Phase 10.5 — soak, evals, and traceability**. The canonical v6 build plan prioritizes private-harness maturity: loop detection, local-model routing hardening, profile isolation, sub-agent/task parallelism, trajectory capture, and reviewed self-learning before optional external channel/API surfaces.

Phase 11 hooks remains later in that plan. Do not start any future implementation phase unless explicitly requested.

See [`docs/usage.md`](docs/usage.md) for day-to-day operation, [`CHANGELOG.md`](CHANGELOG.md) for phase history, [`docs/architecture.md`](docs/architecture.md) for the current runtime flow, [`docs/extending.md`](docs/extending.md) for development recipes, [`docs/testing-log-2026-04-27.md`](docs/testing-log-2026-04-27.md) for test and regression history, [`sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md`](../sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md) for the full maturity-first phase plan, and [`sovereign-ai-docs/harness/decisions/0003-claude-code-core-hermes-learning-layer.md`](../sovereign-ai-docs/harness/decisions/0003-claude-code-core-hermes-learning-layer.md) for the architectural ADR.

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

# 4. Run from anywhere — bare `sovereign` defaults to `chat` and resolves
#    the bundle from CWD (walks up looking for index.yaml), or pass --bundle
sovereign --bundle ~/code/sovereign-ai-docs
# or, from inside the bundle:
#   cd ~/code/sovereign-ai-docs && sovereign
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
- **Different model** — `sovereign -m claude-opus-4-7` (default is `claude-haiku-4-5-20251001`).
- **Different provider** — `sovereign --provider openai -m gpt-4o-mini`, `sovereign --provider ollama -m qwen2.5:3b`, or `sovereign --provider openrouter -m anthropic/claude-haiku-4.5`.

### Gotchas

1. **`~/.bun/bin` must be on PATH.** The Bun installer edits your shell rc; a running shell won't see the change until it's reopened or `source`'d.
2. **No `.bun-version` pin yet.** Any Bun 1.2+ has worked in practice; very old Bun versions may have different `bun:sqlite` APIs.
3. **`bun link` is dev-mode, not a production binary.** The symlink points at the live `src/main.ts` — code edits take effect on the next invocation, no rebuild. Production client installs use `bun build --compile` to produce a standalone binary per [ADR H-0003](../sovereign-ai-docs/harness/decisions/0003-claude-code-core-hermes-learning-layer.md) + [agent-harness § deployment-topology](../sovereign-ai-docs/business/architecture/agent-harness.md#deployment-topology).
4. **Node is a soft dep.** Pure runtime users don't need Node at all. It's only for the docs-repo toolchain (lint, cascade, Notion sync).

## Quick usage

```bash
bun install
export ANTHROPIC_API_KEY=sk-ant-...   # or drop it in .env at the repo root
bun run chat --bundle ~/code/sovereign-ai-docs
# or: HARNESS_BUNDLE=~/code/sovereign-ai-docs bun run chat
```

Flags: `--provider <name>` (default `anthropic`), `--model <name>` (provider/config default if omitted), `--max-tokens <n>` (default `12000`), `--bundle <path>` (or `HARNESS_BUNDLE` env, or auto-resolved from CWD), `--permission-mode <default|ask|bypass>` (default `default`), `--resume <uuid>` (resume a prior session), `--db <path>` (override the default `~/.harness/sessions.db`), `--no-cache` (disable provider prompt-cache markers for testing), `--no-preflight` (skip startup provider health checks), `--transcript <path>` (write a redacted JSONL terminal/event transcript), `-v, --verbose` (show full tool-result preview blocks instead of one-line summaries).

`sovereign config` — open the interactive picker for user-level config (or `sovereign config get|set|unset|show|path <args>` to script it).

See [`docs/usage.md`](docs/usage.md) for provider configuration, resume, context references, permissions, slash commands, memory, skills, compaction, common workflows, and troubleshooting.

### Global `sovereign` command (dev-mode)

Install once, invoke from anywhere — mirrors how `claude` is invoked for Claude Code:

```bash
cd ~/code/sovereign-ai-harness
bun link         # registers the package AND installs the `sovereign` binary on PATH
```

Then from any directory:

```bash
sovereign --bundle ~/code/sovereign-ai-docs
# or set HARNESS_BUNDLE once in your shell rc:
#   export HARNESS_BUNDLE=~/code/sovereign-ai-docs
# and just:
sovereign
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
| `src/tools/` | Bash + FileRead/Write/Edit + Grep/Glob + bounded memory tool + skill tools + WebFetch/WebSearch | 2 Bash, 4 file & search, 6.5 memory, 9/9.5 skills, 10.2 web |
| `src/providers/` | LLM provider adapters, resolver, credential pool, rate guard, auxiliary fallback | 1 Anthropic, 5/5.5 hardened |
| `src/permissions/` | Permission middleware (layered rules, ask/default/bypass modes, project-local always rules, shell AST analysis for virtual tool mapping) | 3, 7, Qwen-B |
| `src/agent/` | Session DB — SQLite + WAL + FTS5, migrations, retry wrapper, compaction lineage | 3.5, 10 |
| `src/commands/` | Slash commands (local / local-jsx / prompt) | 8, 10 |
| `src/skills/` | Markdown-plus-frontmatter skill loader, prompt expansion, visibility gates, guard scanner, slash-command adapter | 9/9.5 |
| `src/compact/` | Context-window compaction + microcompaction (per-part tool-result clearing) | 10, Qwen-A |
| `src/hooks/` | Shell-out lifecycle hooks | 11 |
| `src/mcp/` | MCP client | 12 |
| `src/bundle/` | Harness-bundle loader (Sovereign AI specific) | 0 skeleton |
| `src/memory/` | Bounded MEMORY.md / USER.md store, provider ABC, user-message memory injection | 6.5 |
| `src/trajectory/` | JSONL trajectory writer (Hermes pattern) | 13.1 |
| `src/review/` | Background review loop (Hermes pattern) | 13.3 |
| `src/router/` | Hybrid router — local / local-with-escalation / frontier | 5, 10.6 |
| `src/config/` | Provider config, permission-rule settings loader, and `$HARNESS_HOME` path helpers | 5, 6.5, 7 |
| `src/ui/` | Terminal REPL and future local daemon/TUI surfaces | 0 stub, 1, 16.0/16.7 |

Empty directories are deliberate — they mark future phase landing zones.

## License

Private. All rights reserved.

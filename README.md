# Sovereign AI — Agent Runtime

The agent runtime for Sovereign AI. A Claude-Code-style harness (TypeScript on Bun, async-generator turn loop, `Tool<I,O>` factory with fail-closed defaults, content-block messages) with a Hermes-pattern learning layer on top (persistent memory, trajectory capture, background review).

This is **runtime code**. The business data it operates against lives in a separate repo: `~/code/sovereign-ai-docs/`. This repo reads that one as a *harness bundle* — it never writes to business-scope files, only to the tier-3 `state/` content (memory, trajectories, session log, artefacts).

## Status

**Phase 3.5 complete (2026-04-24)** — conversations persist across runs. SQLite (via `bun:sqlite`) + WAL + FTS5 at `~/.harness/sessions.db` by default; schema-versioned migrations framework in place. Every user / assistant / tool_result message is saved as it's produced. `--resume <uuid>` hydrates history and the *frozen system prompt* from the stored session (storage-side of Invariant #4 — Phase 6 enforces actually-reuse-it). Bundle-mismatch on resume is rejected with a clear error. Jittered retry wrapper (20–150ms × up to 15) + `wal_checkpoint(TRUNCATE)` every 50 writes — prepared for Phase 16/17 multi-writer contention. Zero new npm dependencies.

**Phase 3 (complete 2026-04-24)** — permission prompts around every tool dispatch. The orchestrator calls `canUseTool()` before `tool.call()`; denials flow back as `is_error` tool_result blocks. CLI flag `--permission-mode ask | bypass` (default `ask`); "always" approvals cache for the session, keyed by tool name (Phase 7 replaces with rule-based matching). Latent Phase 2 bug fixed in passing: `query()` now propagates its `AbortSignal` into the tool context.

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
| **Anthropic API key** | Model access. One per user — don't share. |
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

# 3. Drop your API key into .env (gitignored; auto-loaded from repo root)
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

# 4. Run from anywhere
sovereign chat --bundle ~/code/sovereign-ai-docs
```

That's the whole setup — three commands, a key, a bundle path.

### What ports vs. what doesn't

**Comes with the repos:** runtime code, tests, ADRs, business docs, CLAUDE.md rules, decisions digest, status pages — every committed file.

**Does not port:**
- `~/.harness/sessions.db` — your conversation history lives under `$HOME`, not the repo. A new machine starts with an empty DB. `scp` the file across if you want a snapshot; usually not worth it.
- `.env` — gitignored by design. Every user brings their own API key.
- The `sovereign-ai-ops` repo (macOS launchd cron for feed / CHANGELOG / audit) — **not required to run the harness.** Clone it only if nightly summaries matter.

### Optional extras

- **Contributing docs changes** — `cd ~/code/sovereign-ai-docs && npm install && npm run install-hooks` turns on the pre-commit cascade + linter.
- **Skip `--bundle` every call** — `export HARNESS_BUNDLE=~/code/sovereign-ai-docs` in your shell rc.
- **Different model** — `sovereign chat -m claude-opus-4-7` (default is Sonnet 4.6 — see `state/memory/decisions-made.md` in the docs repo for the v0.x cost calculus).

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

Flags: `--model <name>` (default `claude-sonnet-4-6`), `--max-tokens <n>` (default `4096`), `--bundle <path>` (or `HARNESS_BUNDLE` env), `--permission-mode <ask|bypass>` (default `ask`), `--resume <uuid>` (resume a prior session), `--db <path>` (override the default `~/.harness/sessions.db`).

### Session persistence (Phase 3.5)

Every turn is saved to `~/.harness/sessions.db` as it happens. When the REPL exits (cleanly or otherwise), the last line of output shows you the resume command:

```
to resume: sovereign chat --resume <uuid> --bundle <bundle-path>
```

Resuming rehydrates the in-memory history from the DB and reuses the *exact* system prompt segments that were frozen at session creation — later phases (6) hook warm-cache behaviour on top. Bundle path is validated on resume; using a different `--bundle` than the session was created against is rejected with a clear message rather than silently re-framing the conversation.

Under the hood: SQLite (via `bun:sqlite`, no npm deps) + WAL journaling + FTS5 virtual table for search + ai/ad/au triggers for index maintenance. Schema-versioned migrations (`state_meta` singleton) keep the upgrade path cheap when Phase 8 adds cost columns. A jittered-retry wrapper (20–150ms × 15 attempts) plus WAL checkpoint every 50 writes are in place for Phase 16/17 multi-writer contention.

### Permission prompts (Phase 3)

In the default `ask` mode, every tool invocation asks:

```
[permission] Bash ls src/
  allow? [y]es / [N]o / [a]lways:
```

- **`y`** — allow this one invocation, tool runs.
- **`n`** (or Enter) — deny; the tool_result flows back to the model with `is_error: true` and reason `"user denied"`, so the model sees the refusal and can adapt.
- **`a`** — allow this and every subsequent call to the same tool in the current session (crude first-pass; Phase 7 will replace with input-aware rule matching).

Run with `--permission-mode bypass` to skip all prompts (useful for scripted smoke tests or when you trust the model fully). The banner shows the active mode at startup; `bypass` renders in red as a visible warning.

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
| `src/core/` | Async-generator turn loop, content-block types | 0 scaffold, 1 functional |
| `src/tool/` | `Tool<I,O>` factory with fail-closed defaults | 0 |
| `src/tools/` | Individual tool implementations | 2+ |
| `src/providers/` | LLM provider adapters (Anthropic, later OpenAI / Ollama) | 1 Anthropic, 5 others |
| `src/permissions/` | Permission middleware (ask/bypass modes, always-cache) | 3 |
| `src/agent/` | Session DB — SQLite + WAL + FTS5, migrations, retry wrapper | 3.5 |
| `src/context/` | System context, CLAUDE.md hierarchy, memoization | 6 |
| `src/commands/` | Slash commands (local / local-jsx / prompt) | 8 |
| `src/skills/` | Markdown-plus-frontmatter skill loader | 9 |
| `src/compact/` | Context-window compaction | 10 |
| `src/hooks/` | Shell-out lifecycle hooks | 11 |
| `src/mcp/` | MCP client | 12 |
| `src/bundle/` | Harness-bundle loader (Sovereign AI specific) | 0 skeleton |
| `src/memory/` | MEMORY.md / USER.md injection (Hermes pattern) | 6 |
| `src/trajectory/` | JSONL trajectory writer (Hermes pattern) | 13.2 |
| `src/review/` | Background review loop (Hermes pattern) | 13 |
| `src/router/` | Hybrid router — local / local-with-escalation / frontier | 5 |
| `src/config/` | Settings loader (user / project / local precedence) | 0 |
| `src/ui/` | Terminal REPL (plain readline Phase 1, Ink Phase 14) | 0 stub |

Empty directories are deliberate — they mark future phase landing zones.

## License

Private. All rights reserved.

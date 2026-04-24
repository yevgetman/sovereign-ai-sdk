# Sovereign AI — Agent Runtime

The agent runtime for Sovereign AI. A Claude-Code-style harness (TypeScript on Bun, async-generator turn loop, `Tool<I,O>` factory with fail-closed defaults, content-block messages) with a Hermes-pattern learning layer on top (persistent memory, trajectory capture, background review).

This is **runtime code**. The business data it operates against lives in a separate repo: `~/code/sovereign-ai-docs/`. This repo reads that one as a *harness bundle* — it never writes to business-scope files, only to the tier-3 `state/` content (memory, trajectories, session log, artefacts).

## Status

**Phase 3 complete (2026-04-24)** — permission prompts around every tool dispatch. The orchestrator calls `canUseTool()` before `tool.call()`; denials flow back as `is_error` tool_result blocks. CLI flag `--permission-mode ask | bypass` (default `ask`); in `ask` mode, every `tool_use` block hits an interactive y/N/always prompt backed by the REPL's readline. "Always" approvals cache for the session (keyed by tool name — Phase 7 replaces with rule-based matching). BashTool now returns `ask` for every invocation. Latent Phase 2 bug fixed in passing: `query()` now propagates its `AbortSignal` into the tool context so Ctrl-C reaches long-running subprocesses and in-flight permission prompts, not just the model stream.

**Phase 2 (complete 2026-04-24)** — streaming REPL with the first tool wired through a full `buildTool()` → registry → orchestrator → `query()` loop. `BashTool` is the first capability: the model can run arbitrary bash commands and see combined stdout/stderr + exit code in its context. Tool results flow back as a user message with `tool_result` content blocks (Anthropic-native shape).

**Phase 1 (complete 2026-04-24)** — baseline streaming REPL against Anthropic, in-memory history, Ctrl-C-aborts-stream, `/quit` or Ctrl-D to exit.

See [`sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md`](../sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md) for the full 28-phase plan, and [`sovereign-ai-docs/harness/decisions/0003-claude-code-core-hermes-learning-layer.md`](../sovereign-ai-docs/harness/decisions/0003-claude-code-core-hermes-learning-layer.md) for the architectural ADR.

## Usage

```bash
bun install
export ANTHROPIC_API_KEY=sk-ant-...   # or drop it in .env at the repo root
bun run chat --bundle ~/code/sovereign-ai-docs
# or: HARNESS_BUNDLE=~/code/sovereign-ai-docs bun run chat
```

Flags: `--model <name>` (default `claude-sonnet-4-6`), `--max-tokens <n>` (default `4096`), `--bundle <path>` (or `HARNESS_BUNDLE` env), `--permission-mode <ask|bypass>` (default `ask`).

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

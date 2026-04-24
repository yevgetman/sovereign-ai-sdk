# Sovereign AI — Agent Runtime

The agent runtime for Sovereign AI. A Claude-Code-style harness (TypeScript on Bun, async-generator turn loop, `Tool<I,O>` factory with fail-closed defaults, content-block messages) with a Hermes-pattern learning layer on top (persistent memory, trajectory capture, background review).

This is **runtime code**. The business data it operates against lives in a separate repo: `~/code/sovereign-ai-docs/`. This repo reads that one as a *harness bundle* — it never writes to business-scope files, only to the tier-3 `state/` content (memory, trajectories, session log, artefacts).

## Status

**Phase 2 complete (2026-04-24)** — streaming REPL with the first tool wired through a full `buildTool()` → registry → orchestrator → `query()` loop. `BashTool` is the first capability: the model can run arbitrary bash commands and see combined stdout/stderr + exit code in its context. Tool results flow back as a user message with `tool_result` content blocks (Anthropic-native shape). No permission prompts yet — Phase 3 adds those. Sequential execution only — Phase 4 adds path-scoped concurrency. The `toolContext` plumbing (`cwd`, `bundleRoot`, `sessionId`, optional `signal`) is in place for every future tool.

**Phase 1 (complete 2026-04-24)** remains the baseline: streaming-only REPL against Anthropic, in-memory history, Ctrl-C-aborts-stream, `/quit` or Ctrl-D to exit.

See [`sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md`](../sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md) for the full 28-phase plan, and [`sovereign-ai-docs/harness/decisions/0003-claude-code-core-hermes-learning-layer.md`](../sovereign-ai-docs/harness/decisions/0003-claude-code-core-hermes-learning-layer.md) for the architectural ADR.

## Usage

```bash
bun install
export ANTHROPIC_API_KEY=sk-ant-...
bun run chat --bundle ~/code/sovereign-ai-docs
# or: HARNESS_BUNDLE=~/code/sovereign-ai-docs bun run chat
```

Flags: `--model <name>` (default `claude-opus-4-7`), `--max-tokens <n>` (default `4096`), `--bundle <path>` (or `HARNESS_BUNDLE` env).

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
| `src/permissions/` | Permission middleware | 3 |
| `src/context/` | System context, CLAUDE.md hierarchy, memoization | 6 |
| `src/commands/` | Slash commands (local / local-jsx / prompt) | 8 |
| `src/skills/` | Markdown-plus-frontmatter skill loader | 9 |
| `src/compact/` | Context-window compaction | 10 |
| `src/hooks/` | Shell-out lifecycle hooks | 11 |
| `src/mcp/` | MCP client | 12 |
| `src/bundle/` | Harness-bundle loader (Sovereign AI specific) | 0 skeleton |
| `src/memory/` | MEMORY.md / USER.md injection (Hermes pattern) | 6 |
| `src/trajectory/` | JSONL trajectory writer (Hermes pattern) | 2 |
| `src/review/` | Background review loop (Hermes pattern) | 13 |
| `src/router/` | Hybrid router — local / local-with-escalation / frontier | 5 |
| `src/config/` | Settings loader (user / project / local precedence) | 0 |
| `src/ui/` | Terminal REPL (plain readline Phase 1, Ink Phase 14) | 0 stub |

Empty directories are deliberate — they mark future phase landing zones.

## License

Private. All rights reserved.

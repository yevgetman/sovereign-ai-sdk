# Sovereign AI — Agent Runtime

The agent runtime for Sovereign AI. A Claude-Code-style harness (TypeScript on Bun, async-generator turn loop, `Tool<I,O>` factory with fail-closed defaults, content-block messages) with a Hermes-pattern learning layer on top (persistent memory, trajectory capture, background review).

This is **runtime code**. The business data it operates against lives in a separate repo: `~/code/sovereign-ai-docs/`. This repo reads that one as a *harness bundle* and never writes to business-scope files; runtime state lives under `$HARNESS_HOME` (default `~/.harness`) unless a later phase introduces explicit bundle-state writers.

## Status

**Semantic test suite (2026-05-03)** — opt-in LLM-judged behavior tests under `tests/semantic/`. Each test spawns the real `sov` binary in an isolated sandbox, captures the transcript, and asks an LLM judge whether per-test must-satisfy / should-not criteria were met. Default judge is the local `claude` CLI (subscription, no API tokens); `--judge anthropic-api` falls back to the SDK. Pluggable backend design — adding a new backend (codex, `sov`-itself, OpenAI judge) is one new file. Supports both single-turn and multi-turn cases (`prompt: string | string[]`). Strictly additive: zero edits to `src/`, never imports from `src/`, file names don't match `*.test.ts` so `bun test` is unaffected. Run with `bun run test:semantic`. Coverage spans 30 tests across 8 tool-dispatch cases, 4 slash-command pipeline paths, 6 permission cases, 4 refusal/honesty cases, 2 context-expansion cases, and 6 workflow/multi-turn cases (including end-to-end `/compact` and `/rollback`). See [`docs/semantic-testing.md`](docs/semantic-testing.md) for the canonical reference and full test-by-test inventory; [`tests/semantic/README.md`](tests/semantic/README.md) for design and porting details.

**Phase 10.5b–e (REPL polish, 2026-05-03)** — four-wave UX upgrade. Modal-framed permission prompts, persistent pre-prompt footer (provider · model · ctx % · cost · perms · tools), inline FileEdit/FileWrite diffs with line context, context meter with one-shot pre-compaction warning, theme system (`dark` / `light` / `no-color` + `NO_COLOR` env override), 12 new slash commands (`/about`, `/tools`, `/skills`, `/stats`, `/permissions`, `/quit`, `/copy`, `/resume`, `/export`, `/init`, `/theme`, `/settings`), `/help` refactored into a categorized 2-column layout, raw-mode picker primitive, and a from-scratch input editor (multi-line via `\` continuation, persistent history at `~/.harness/input-history`, Ctrl-R reverse search, Tab autocomplete for `/command` and `@file`, soft-wrap for long lines, full readline-style keybinds). The new editor is default under TTY; `--legacy-input` flag forces the readline path. 645 tests, 105 hard-pass assertions, lint clean.

**Phase 10.2 (2026-04-29)** — model-callable web reach. `WebFetch` (URL → readable text with HTML stripping, private-host blocking, size caps) and `WebSearch` (pluggable search via Tavily default or Brave, with API key from config or env).

**Phase 10.1 (2026-04-29)** — writeable config. `sov config` CLI + `/config` slash + interactive picker for `~/.harness/config.json`. Every write is zod-validated. Tunable proactive compaction threshold (default 75%); Ollama `num_ctx` auto-pinning.

**Phase 10 (2026-04-26)** — context-window compaction. `/compact` and `/rollback`, parent-child session lineage, separate compaction cost lanes, proactive compaction above 75% of context, reactive retry after context-overflow errors. Microcompaction (per-part tool-result clearing) and shell-AST virtual tool mapping landed as Qwen-amendment deepenings on 2026-04-28.

**Next phase pivot.** Polish wave is at diminishing returns. The build plan's remaining high-leverage targets are **Phase 11** (hooks), **Phase 12** (MCP client), and **Phase 13.1** (trajectory capture — the actual Sovereign moat). See `~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md` for the full maturity-first plan.

See [`docs/usage.md`](docs/usage.md) for day-to-day operation, [`CHANGELOG.md`](CHANGELOG.md) for phase history, [`docs/architecture.md`](docs/architecture.md) for the current runtime flow, [`docs/extending.md`](docs/extending.md) for development recipes, [`docs/testing-log-2026-04-27.md`](docs/testing-log-2026-04-27.md) for test and regression history, [`sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md`](../sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md) for the full maturity-first phase plan, and [`sovereign-ai-docs/harness/decisions/0003-claude-code-core-hermes-learning-layer.md`](../sovereign-ai-docs/harness/decisions/0003-claude-code-core-hermes-learning-layer.md) for the architectural ADR.

## Install on a new machine

The repo is **private** — access is controlled by GitHub SSH permissions. There is no public package registry entry. Two paths:

- **(A) Direct git+SSH install** — fastest, no clone needed. Recommended for users who just want to run `sov`.
- **(B) Source clone + `bun link`** — for contributing or tracking `master` between version bumps.

Both paths register the binary at `~/.bun/bin/sov`. Run only one of them; the latest install wins.

### Prerequisites

| Tool | Needed for |
|---|---|
| **Bun 1.2+** | The runtime itself. Ships `bun:sqlite` with FTS5 compiled in — no native-compile step. |
| **Provider API key** | Anthropic/OpenAI/OpenRouter access, depending on provider. Ollama can run local without a key. |
| **Git + SSH to GitHub** | The repo is private — your SSH key must be authorized on the `yevgetman/sovereign-ai-harness` repo. Same for the docs bundle (`yevgetman/sovereign-ai-docs`) if you want it. |
| **Node 18+** *(optional)* | Only for the **docs-repo** lint / cascade / sync scripts. Not needed to run the harness. |

Install Bun with `curl -fsSL https://bun.sh/install | bash`, then reopen your shell (or `source` your rc) so `~/.bun/bin` ends up on PATH. Get a provider API key at `console.anthropic.com`. Confirm SSH access works with `ssh -T git@github.com`.

### Path A — install directly from the private repo

```bash
# 1. Install or upgrade `sov` from the private repo over SSH.
#    Bun clones into its global cache, runs `bun install`, and links
#    ~/.bun/bin/sov → the cached repo's src/main.ts.
bun install -g git+ssh://git@github.com/yevgetman/sovereign-ai-harness.git

# 2. Drop your provider key somewhere `sov` will see it
export ANTHROPIC_API_KEY=sk-ant-...           # any login shell
# or persist it in ~/.harness/credentials.json — see docs/usage.md

# 3. Run from anywhere
sov                                           # generic-agent mode, no bundle
sov --bundle ~/code/sovereign-ai-docs         # with the docs bundle (also private)
```

**Upgrade once installed:** `sov upgrade` (or `sov upgrade --ref v0.2.0` to pin to a tag). The subcommand shells out to `bun install -g git+ssh://…sovereign-ai-harness.git` so you don't have to remember the URL. `--dry-run` prints the command without running it. The first install still uses the explicit `bun install -g git+ssh://…` form above (you can't run `sov upgrade` until `sov` exists).

Access control is the GitHub SSH key on the user's machine — exactly the same model the source clone uses. Nothing reaches a public registry.

### Path B — clone + `bun link` (development / contributing)

Path A is sufficient for using the harness. Use this path only if you're modifying runtime code or want a working tree with live symlink semantics.

```bash
# 1. Clone both repos
git clone git@github.com:yevgetman/sovereign-ai-harness.git ~/code/sovereign-ai-harness
git clone git@github.com:yevgetman/sovereign-ai-docs.git   ~/code/sovereign-ai-docs

# 2. Install deps + register the global `sov` binary as a live symlink
cd ~/code/sovereign-ai-harness
bun install
bun link     # creates ~/.bun/bin/sov → this repo's src/main.ts

# 3. Drop your provider key into .env (gitignored; auto-loaded from repo root)
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

# 4. Run from anywhere — code edits take effect on the next invocation
sov --bundle ~/code/sovereign-ai-docs
```

`bun link` produces a live symlink to your working tree (edits take effect immediately, no rebuild). Path A's symlink points at the global cache and is replaced on every upgrade.

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
- **Different model** — `sov -m claude-opus-4-7` (default is `claude-haiku-4-5-20251001`).
- **Different provider** — `sov --provider openai -m gpt-4o-mini`, `sov --provider ollama -m qwen2.5:3b`, or `sov --provider openrouter -m anthropic/claude-haiku-4.5`.

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

Flags: `--provider <name>` (default `anthropic`), `--model <name>` (provider/config default if omitted), `--max-tokens <n>` (default `12000`), `--bundle <path>` (or `HARNESS_BUNDLE` env, or auto-resolved from CWD), `--permission-mode <default|ask|bypass>` (default `default`), `--resume <uuid>` (resume a prior session), `--db <path>` (override the default `~/.harness/sessions.db`), `--no-cache` (disable provider prompt-cache markers for testing), `--no-preflight` (skip startup provider health checks), `--transcript <path>` (write a redacted JSONL terminal/event transcript), `-v, --verbose` (show full tool-result preview blocks instead of one-line summaries), `--legacy-input` (force the readline-based input loop instead of the Wave-4 raw-mode editor; safety hatch for terminal-compat issues).

`sov config` — open the interactive picker for user-level config (or `sov config get|set|unset|show|path <args>` to script it).

See [`docs/usage.md`](docs/usage.md) for provider configuration, resume, context references, permissions, slash commands, memory, skills, compaction, common workflows, and troubleshooting.

### Global `sov` command (dev-mode)

Install once, invoke from anywhere — mirrors how `claude` is invoked for Claude Code:

```bash
cd ~/code/sovereign-ai-harness
bun link         # registers the package AND installs the `sov` binary on PATH
```

Then from any directory:

```bash
sov --bundle ~/code/sovereign-ai-docs
# or set HARNESS_BUNDLE once in your shell rc:
#   export HARNESS_BUNDLE=~/code/sovereign-ai-docs
# and just:
sov
```

The symlink points at `./src/main.ts` so edits under `src/` take effect on the next invocation — no rebuild step. For production (client installs) use `bun build --compile` to produce a standalone binary instead; see [`agent-harness.md § deployment-topology`](../sovereign-ai-docs/business/architecture/agent-harness.md#deployment-topology).

To uninstall: `bun unlink` from the repo root, or `rm ~/.bun/bin/sov`.

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
| `src/ui/` | Terminal REPL — splash, footer, modal, picker, diff renderer, theme system, input editor (keypress dispatcher + textBuffer + autocomplete + persistent history) | 0 stub, 1, 10.5b–e |

Empty directories are deliberate — they mark future phase landing zones.

## License

Private. All rights reserved.

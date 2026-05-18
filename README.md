# Sovereign AI — Agent Runtime

The agent runtime for Sovereign AI. A Claude-Code-style harness (TypeScript on Bun, async-generator turn loop, `Tool<I,O>` factory with fail-closed defaults, content-block messages) with a Hermes-pattern learning layer on top (persistent memory, trajectory capture, background review).

This is **runtime code**. The business data it operates against lives in a separate repo: `~/code/sovereign-ai-docs/`. This repo reads that one as a *harness bundle* and never writes to business-scope files; runtime state lives under `$HARNESS_HOME` (default `~/.harness`) unless a later phase introduces explicit bundle-state writers.

## Status

Current state lives in [`docs/state/`](docs/state/) — newest dated file is canonical.

- **Latest snapshot:** [`docs/state/2026-05-16.md`](docs/state/2026-05-16.md) — Phase 16.1 M8 shipped (polish-surfaces group: router-mode RouterProvider, capture/replay, @file + subdirectory hints, skills loading + GET /skills + skill-as-slash, TUI ring buffer + /expand, stall detection, rich session_summary) + autonomous M8 real-Anthropic smoke (38/38). **24/24 prereq boxes complete**; backlog #30 closed. Unit suite **1991/1991**, Go tests green. M9 (visual polish) is next.
- **Phase history:** [`CHANGELOG.md`](CHANGELOG.md) covers Phases 0–13.3. Phases 13.4 onward + revert history are in [`docs/state/archive/`](docs/state/archive/).
- **Phase plan:** [`~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md`](../sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md) is the canonical phased plan.
- **Architectural ADR:** [`H-0003`](../sovereign-ai-docs/harness/decisions/0003-claude-code-core-hermes-learning-layer.md).

For day-to-day operation see [`docs/usage.md`](docs/usage.md). For developing this repo see [`CLAUDE.md`](CLAUDE.md).

## Install on a new machine

The repo is **private** — access is controlled by GitHub SSH permissions. There is no public package registry entry. Two paths:

- **(A) Direct git+SSH install** — fastest, no clone needed. Recommended for users who just want to run `sov`.
- **(B) Source clone + `bun link`** — for contributing or tracking `master` between version bumps.

Both paths register the binary at `~/.bun/bin/sov`. Run only one of them; the latest install wins.

### Prerequisites

| Tool | Needed for |
|---|---|
| **Bun 1.2+** | The runtime itself. Ships `bun:sqlite` with FTS5 compiled in — no native-compile step. |
| **Go ≥ 1.24** | Building `sov-tui` (the Bubble Tea TUI client). Required to use bare `sov` (which defaults to `--ui tui` as of M11). If `sov-tui` is missing, `sov` auto-falls back to the readline REPL with a one-line stderr warning; `sov --ui repl` is also always available as an explicit opt-out. |
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

**First-install postinstall trust.** Bun's global installer blocks postinstall scripts by default — the script that builds `bin/sov-tui` from `packages/tui/`. If `bin/sov-tui` is missing after install, run:

```bash
bun pm -g trust @yevgetman/sov
```

Then re-run the install. Subsequent upgrades pick up the trusted entry automatically.

**Upgrade once installed:** `sov upgrade` (or `sov upgrade --ref v0.2.0` to pin to a tag). The subcommand pre-uninstalls, **wipes Bun's install cache** (`~/.bun/install/cache/`), then reinstalls. The cache wipe is the default since 2026-05-05 because Bun's binary manifest cache otherwise pins a stale `URL → SHA` mapping for the harness git URL — `sov upgrade` would silently re-install the same SHA you already had. `--dry-run` prints the bun commands without running them.

The cache wipe also evicts other Bun-installed packages' manifests as a side-effect — those regenerate (small one-time slowdown on each package's next install, never broken). If you specifically want to preserve those manifests and accept the risk of a stale upgrade, `sov upgrade --keep-cache` opts out.

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

Flags: `-p, --profile <name>` (top-level — pin the run to `<harness-home>/profiles/<name>/`; use `default` for the unscoped root), `--ui <tui|repl>` (default `tui` as of M11; `tui` launches the Go Bubble Tea client via the local Hono server, `repl` runs the readline terminal REPL — also persist via `sov config set ui.surface repl` or `SOV_UI=repl`), `--provider <name>` (default `anthropic`), `--model <name>` (provider/config default if omitted), `--max-tokens <n>` (default `12000`), `--bundle <path>` (or `HARNESS_BUNDLE` env, or auto-resolved from CWD), `--permission-mode <default|ask|bypass>` (default `default`), `--resume <uuid>` (resume a prior session), `--db <path>` (override the default `~/.harness/sessions.db`), `--no-cache` (disable provider prompt-cache markers for testing), `--no-preflight` (skip startup provider health checks), `--transcript <path>` (write a redacted JSONL terminal/event transcript), `-v, --verbose` (show full tool-result preview blocks instead of one-line summaries), `--legacy-input` (force the readline-based input loop instead of the Wave-4 raw-mode editor; safety hatch for terminal-compat issues).

`sov config` — open the interactive picker for user-level config (or `sov config get|set|unset|show|path <args>` to script it).

`sov profile [list|create|use|show|import-default]` — manage profile-scoped state roots. `sov profile create work` makes `<harness-home>/profiles/work/`; `sov profile use work` pins it as the persisted active profile; `sov -p work chat …` is one-shot per-invocation. `sov profile import-default work` copies `<harness-home>/config.json` + `credentials.json` from the default root into the named profile (sessions/trajectories/memory stay clean). The active profile is persisted at `<harness-home>/active-profile`; remove or empty that file (or `sov profile use default`) to fall back to the unscoped root.

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
bun run typecheck  # tsc --noEmit
bun run chat --version
```

See [`CLAUDE.md`](CLAUDE.md) for the session boot sequence, doc index, and standing rules when developing this repo.

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
| `src/review/` | Background review loop — ReviewManager, runReviewFork, ProposalStore, consolidation, stall detection (Hermes pattern) | 13.3 |
| `src/router/` | Hybrid router — local / local-with-escalation / frontier | 5, 10.6 |
| `src/config/` | Provider config, permission-rule settings loader, and `$HARNESS_HOME` path helpers | 5, 6.5, 7 |
| `src/ui/` | Terminal REPL — splash, footer, modal, picker, diff renderer, theme system, input editor (keypress dispatcher + textBuffer + autocomplete + persistent history) | 0 stub, 1, 10.5b–e |
| `src/server/` | Hono HTTP+SSE server backing the Phase 16.1 split-process TUI; routes for sessions, turns, approvals; event bus; on-disk SessionDb; preflight; CLI flag forwarding | 16.1 |
| `src/cli/` | `sov dispatch` (headless slash surface) + `sov-tui` launcher (Phase 16.1 spawn-and-supervise) | 16.0c, 16.1 |
| `packages/tui/` | Go + Bubble Tea TUI client (`sov-tui`); communicates with `sov` via localhost HTTP+SSE | 16.1 |

Empty directories are deliberate — they mark future phase landing zones.

## License

Private. All rights reserved.

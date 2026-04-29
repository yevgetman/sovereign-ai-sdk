# Usage Guide

This guide covers day-to-day operation of the Sovereign AI runtime. It assumes the repo is installed and `sovereign` is on your `PATH` via `bun link`.

## Quick Start

The bare `sovereign` command starts a chat (`chat` is the default subcommand). Bundle resolution order:

1. `--bundle <path>` if passed
2. `HARNESS_BUNDLE` env var if set
3. **Walk up from the current directory** looking for an `index.yaml` (the bundle marker)
4. Otherwise, error

So the simplest invocation is:

```bash
cd ~/code/sovereign-ai-docs    # or any subdirectory inside a bundle
sovereign
```

Or set it once and run from anywhere:

```bash
export HARNESS_BUNDLE=~/code/sovereign-ai-docs
sovereign
```

Or pass it explicitly:

```bash
sovereign --bundle ~/code/sovereign-ai-docs
```

From the repo checkout, the equivalent development command is:

```bash
bun run chat --bundle ~/code/sovereign-ai-docs
```

## CLI Flags

| Flag | Meaning |
|---|---|
| `--bundle <path>` | Harness bundle directory. Can also be set with `HARNESS_BUNDLE`. |
| `--provider <name>` | Provider: `anthropic`, `openai`, `openrouter`, or `ollama`. |
| `--model <name>` | Model override for the selected provider. |
| `--max-tokens <n>` | Max output tokens per provider turn. Default: `12000`. |
| `--permission-mode <mode>` | Tool permission mode: `default`, `ask`, or `bypass`. |
| `--resume <uuid>` | Resume a stored session. |
| `--db <path>` | Override the session DB path. Default: `~/.harness/sessions.db`. |
| `--no-cache` | Disable provider prompt-cache markers for testing. |
| `--no-preflight` | Skip startup provider/model health checks. |
| `--transcript <path>` | Write a redacted JSONL terminal/event transcript for manual tests. |

Examples:

```bash
sovereign --provider openai --model gpt-4o-mini
sovereign --provider ollama --model qwen2.5:3b
sovereign --permission-mode ask
sovereign --no-cache
```

## Config Command

User-level config lives at `~/.harness/config.json` (override with `HARNESS_CONFIG`). Read or write it without hand-editing JSON:

```bash
sovereign config                                 # interactive picker (TTY only)
sovereign config show                            # full config, secrets redacted
sovereign config path                            # resolved file path
sovereign config get defaultProvider
sovereign config set defaultProvider ollama
sovereign config set providers.ollama.model qwen2.5:7b
sovereign config set microcompaction.enabled false
sovereign config unset microcompaction.enabled
```

Bare `sovereign config` opens a single-screen picker: ↑/↓ to navigate, Enter to edit, `u` to unset, `q` or Esc to quit. Edits are validated through the settings schema before writing. (This is an interim raw-mode UI; Phase 16.7 will replace it with the Ink-based TUI.)

The same verbs work in-session via `/config`:

```text
/config show
/config get defaultProvider
/config set providers.ollama.model qwen2.5:7b
/config unset microcompaction.enabled
```

Every write is validated against the settings schema before touching disk; rejected changes leave the file untouched. `apiKey`, `apiKeys`, and credential entries are redacted in `show` and `get` output.

## Ollama Notes

Ollama defaults `num_ctx` to **2,048 tokens** for chat requests unless overridden. The harness now sends `num_ctx` automatically based on the model's registered context length (32K for the qwen2.5 family, 128K for llama3.1, etc.) — so chats no longer get silently truncated to 2K and trigger constant compaction. Override with:

```bash
sovereign config set providers.ollama.numCtx 16384
```

If your Ollama install is RAM-constrained, lowering `numCtx` is the right knob. Unsetting it returns to the registered default.

### Frequent compaction with small-context local models

Proactive compaction fires by default at **50% of the model's context window**. For Anthropic at 200K that's 100K — fine. For qwen2.5:7b at 32K that's only 16K, which a typical bundle's system prompt + a few turns will exceed. Raise the threshold:

```bash
sovereign config set compaction.proactiveThresholdPct 85
```

Anything between 1 and 99 is accepted. 80–90 is a sane range for keeping more history with local models; the trade-off is a higher chance of hitting the model's hard ceiling and triggering reactive (post-error) compaction instead.

## Provider Configuration

Provider defaults can live in `~/.harness/config.json`:

```json
{
  "defaultProvider": "anthropic",
  "providers": {
    "anthropic": { "model": "claude-haiku-4-5-20251001" },
    "openai": { "apiKey": "sk-...", "model": "gpt-4o-mini" },
    "ollama": { "baseUrl": "http://localhost:11434", "model": "qwen2.5:3b" }
  }
}
```

Environment variables still work. For local development, a repo-root `.env` is auto-loaded when the globally linked `sovereign` binary runs:

```bash
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
OPENROUTER_API_KEY=sk-or-...
```

## Sessions And Resume

Every turn is saved to `~/.harness/sessions.db` by default. When the REPL exits, it prints a resume command:

```text
to resume: sovereign --resume <uuid> --bundle <bundle-path>
```

Resume with that command:

```bash
sovereign --resume <uuid> --bundle ~/code/sovereign-ai-docs
```

Resume reuses the exact system prompt that was frozen when the session began. The bundle path is validated; resuming a session against a different bundle is rejected.

Use `--db <path>` when you want an isolated session database for testing:

```bash
sovereign --db /tmp/harness-test.db --bundle ~/code/sovereign-ai-docs
```

## Context References

Prompt text can include inline references. They expand before the provider call into bounded fenced blocks.

```text
Review @file:src/main.ts and @diff
Summarize @file:"docs/file with spaces.md"
Inspect lines @file:src/core/query.ts:40-90
Map @folder:src/context
Quote @url:https://example.com/doc
```

Supported references:

| Reference | Behavior |
|---|---|
| `@file:path` | Include file content. |
| `@file:path:10-20` | Include a line range. |
| `@file:"path with spaces.md"` | Include a quoted path. |
| `@folder:path` | Include a bounded folder listing. |
| `@diff` | Include current git diff. |
| `@staged` | Include staged git diff. |
| `@url:https://...` | Fetch and include URL text. |

Sensitive paths such as SSH, AWS, GPG, Kube config, shell rc files, sudoers, and `/etc/passwd` or `/etc/shadow` are blocked.

## Slash Commands

Lines beginning with `/` are handled locally before normal model turns.

| Command | Behavior |
|---|---|
| `/help` | List slash commands and aliases. |
| `/clear` | Clear in-memory conversation history for the current session. |
| `/cost` | Show session token totals and estimated USD cost. |
| `/compact` | Compress older history into a guarded handoff summary and switch to a child session. |
| `/rollback` | Switch back to the parent session after compaction. |
| `/model <name>` | Switch the active model for later turns. |
| `/config [...]` | View or change durable config (`show`, `path`, `get <p>`, `set <p> <v>`, `unset <p>`). |
| `/commit` | Ask the model to stage and commit changes with git-only Bash scope. |

Examples:

```text
/cost
/model claude-opus-4-7
/compact
/rollback
/commit
```

## Tool Permissions

Permission settings are read from three locations, highest precedence first:

1. `<cwd>/.harness/settings.local.json`
2. `<cwd>/.harness/settings.json`
3. `$HARNESS_HOME/settings.json`

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

Rules are shaped as `Tool(pattern)` or just `Tool`. Aliases `Read`, `Write`, and `Edit` map to `FileRead`, `FileWrite`, and `FileEdit`.

### Shell Command Virtual Tool Mapping

Read-only Bash commands automatically resolve against `Read` permission rules. If your allow rules include `Read` or `Read(*.ts)`, then `Bash("cat src/main.ts")` runs without prompting because the shell AST analyzer classifies `cat` as a read operation. Write and edit commands (`cp`, `rm`, `chmod`, etc.) do not benefit from this — they still follow Bash-specific rules. Command substitution (`$(...)`, backticks) is always treated as unsafe and requires explicit Bash rules.

When a prompt is required, the REPL asks:

```text
[permission] Bash ls src/
  allow? [y]es / [N]o / [a]lways:
```

Responses:

| Response | Behavior |
|---|---|
| `y` | Allow this invocation. |
| `n` or Enter | Deny this invocation and return an error tool result to the model. |
| `a` | Persist a specific project-local allow rule in `.harness/settings.local.json`. |

Modes:

| Mode | Behavior |
|---|---|
| `default` | Honor explicit rules, then tool self-checks, then prompt if needed. |
| `ask` | Prompt on fallthrough. |
| `bypass` | Allow fallthrough without prompts; explicit deny and ask rules still apply. |

## Memory

Memory lives under `$HARNESS_HOME/memory/`, normally `~/.harness/memory/`.

| File | Purpose | Cap |
|---|---|---|
| `USER.md` | Durable user preferences and profile facts. | 1,375 characters |
| `MEMORY.md` | Agent/project notes. | 2,200 characters |

The model sees these files as fenced recalled context prepended to the current user message. They are not spliced into the frozen system prompt.

Use the `memory` tool in chat to view or replace memory. Over-cap writes return an error instead of truncating.

Example prompt:

```text
Use the memory tool to show current USER.md and MEMORY.md.
```

## Skills

Skills are markdown files. They can live in:

- `<cwd>/.harness/skills/`
- `$HARNESS_HOME/skills/`
- `$HARNESS_HOME/skills/agent-created/<name>/SKILL.md`
- `<bundle>/skills/`
- `<bundle>/harness/skills-trusted/`
- `<bundle>/skills-community/`

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

Visible skills register as slash commands:

```text
/simplify src/main.ts
```

The model can also discover skills with `skills_list`, inspect them with `skill_view`, and invoke them through `SkillTool`.

Skill bodies and reference files support:

- `{{args}}`
- `${HARNESS_SKILL_DIR}`
- `${HARNESS_SESSION_ID}`
- inline shell interpolation with the `!`-prefixed backtick syntax

Community and agent-created skills are scanned before loading.

## Microcompaction

The runtime automatically clears stale tool results when they consume more than 40% of the estimated conversation context. This happens transparently after each tool-result round — no model call, no latency hit. The 5 most recent tool results are always preserved; older ones are replaced with short placeholders.

Configure in `~/.harness/config.json`:

```json
{
  "microcompaction": {
    "enabled": true,
    "keepRecent": 5,
    "triggerThresholdPct": 40
  }
}
```

When microcompaction fires, the REPL prints `[cleared N stale tool results, ~XK tokens]`. Set `"enabled": false` to disable.

## Compaction And Rollback

Use `/compact` when a session is long or when you want to carry only the useful state forward:

```text
/compact
```

Compaction creates a child session with:

- the same provider, model, platform, and frozen system prompt
- a guarded handoff summary
- a preserved recent tail
- parent-child lineage in SQLite

Use `/rollback` to switch the active REPL back to the parent:

```text
/rollback
```

The runtime also compacts proactively above 50% of the model context window and retries once after provider context-overflow errors.

## Common Workflows

Review current changes:

```text
Review @diff for correctness and missing tests.
```

Ask about a specific file:

```text
Explain @file:src/core/query.ts.
```

Change model mid-session:

```text
/model claude-opus-4-7
```

Commit a finished change:

```text
/commit
```

Run with stricter permission prompts:

```bash
sovereign --permission-mode ask --bundle ~/code/sovereign-ai-docs
```

Run locally through Ollama:

```bash
sovereign --provider ollama --model qwen2.5:3b --bundle ~/code/sovereign-ai-docs
```

## Troubleshooting

`No bundle found`
: Run from inside a bundle directory (one containing `index.yaml`), pass `--bundle <path>`, or set `HARNESS_BUNDLE`.

`~/.bun/bin` command not found
: Reopen your shell after installing Bun, or add `~/.bun/bin` to `PATH`.

Missing API key
: Export the provider key, add it to repo-root `.env`, or put it in `~/.harness/config.json`.

Resume rejected for bundle mismatch
: Use the same bundle path shown in the original resume command.

Permission prompts appear too often
: Add specific allow rules to `.harness/settings.local.json` or answer `a` at the prompt for safe repeated operations.

Need a clean test session
: Run with `--db /tmp/some-session.db`.

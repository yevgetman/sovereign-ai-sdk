# Usage Guide

This guide covers day-to-day operation of the Sovereign AI runtime. It assumes `sov` is on your `PATH` (either `bun install -g git+ssh://git@github.com/yevgetman/sovereign-ai-harness.git` for users, or `bun link` from a source clone for development — see the README install section).

> **Phase 16.0b note (2026-05-11):** the legacy terminal REPL was retired and the Ink-based TUI is now the default. Bare `sov` opens the Ink TUI; the standalone `sov chat` subcommand was removed. Several CLI flags that lived on `sov chat` (`--provider`, `--model`, `--max-tokens`, `--permission-mode`, `--resume`, `--db`, `--no-cache`, `--no-preflight`, `--transcript`, `-v/--verbose`, `--legacy-input`, `--capture-fixture`, `--replay-fixture`) are not yet plumbed through `startInkTUI`; they'll come back in Phase 16.0c. The slash command surface (`/help`, `/cost`, `/tasks`, `/compact`, etc.) was orphaned by the same change and is being rebuilt on top of the Ink TUI in 16.0c — until then those `/`-prefixed commands are not dispatched. Sections that still document those flags / verbs describe the intended steady state; current behavior is the bare Ink TUI plus the dedicated subcommands documented under "CLI Subcommands" below.
>
> Non-interactive mission wakes that previously rode on `sov chat --agent ... --state-dir ...` now live on `sov mission run --state-dir <path>`. See "CLI Subcommands."

## Quick Start

The bare `sov` command opens the Ink TUI. Bundle resolution order:

1. `--bundle <path>` if passed
2. `HARNESS_BUNDLE` env var if set
3. **Walk up from the current directory** looking for an `index.yaml` (the bundle marker)
4. Otherwise, run as a generic agent — no bundle context, generic system prompt, tools and skills load normally

Bundled invocation:

```bash
cd ~/code/sovereign-ai-docs    # or any subdirectory inside a bundle
sov
```

Or set it once and run from anywhere:

```bash
export HARNESS_BUNDLE=~/code/sovereign-ai-docs
sov
```

Or pass it explicitly:

```bash
sov --bundle ~/code/sovereign-ai-docs
```

Generic-agent invocation — `sov` works in any directory without a bundle. The splash shows `no bundle`, the bundle-derived prompt segments are omitted, and project-level skills (`./.harness/skills`) plus user-level skills (`~/.harness/skills`) still load:

```bash
cd ~/some-project   # any directory, no bundle required
sov
```

From the repo checkout, the equivalent development command is:

```bash
bun run dev    # bare `sov` against the in-tree source
```

## CLI Flags

The bare `sov` command currently accepts only the two flags below. The richer flag set (provider / model / max-tokens / permission-mode / resume / db / cache / preflight / transcript / verbose / capture-fixture / replay-fixture) was tied to the retired `sov chat` command and is pending re-plumbing through `startInkTUI` in Phase 16.0c.

| Flag | Meaning |
|---|---|
| `-p, --profile <name>` | (Top-level — must precede any subcommand.) Pin the run to `<harness-home>/profiles/<name>/` for config / credentials / sessions / rate-limits / memory / skills. Use `default` for the unscoped base root. See [Profiles](#profiles). |
| `-b, --bundle <path>` | Harness bundle directory. Can also be set with `HARNESS_BUNDLE`. Optional — `sov` falls through to the default bundle (`<harness-home>/default-bundle/` or the shipped `bundle-default/`) when no bundle is found via upward `index.yaml` walk. |

For configuration knobs you previously set on the command line (`--provider`, `--model`, `--permission-mode`, `--no-cache`, etc.), use `sov config set <path> <value>` until those flags return. Examples:

```bash
sov config set defaultProvider anthropic
sov config set defaultModel claude-opus-4-7
sov config set permissionMode ask
```

## CLI Subcommands

`sov` exposes the following subcommands. The default action — bare `sov` — opens the Ink TUI; no subcommand is required to start a session.

| Subcommand | Behavior |
|---|---|
| (bare `sov`) | Open the Ink TUI against the resolved bundle. Multi-turn conversation, status line, abort via Ctrl-C. Slash command dispatch is pending Phase 16.0c. |
| `daemon` | Start the harness daemon for the active profile in the foreground (Phase 16.0a). Keeps the per-profile PID lock + event bus alive until SIGTERM/SIGINT. Phase 16.0b's TUI auto-starts an in-process daemon and shuts it down on exit, so this command is for headless deployments (cron, systemd, mission scheduler). |
| `mission init <dir>` | (Phase 13.5.) Scaffold a new mission directory with `mission.md`, `plan.md`, `notes.md`, `state.json`. `--goal <text>` (required) seeds the goal section; `--per-wake-turns <n>` sets the per-wake tool-call budget; `--force` overwrites an existing `state.json`. |
| `mission run --state-dir <path>` | (Phase 13.5.) Execute one non-interactive scheduled-mission wake against a mission directory. Replaces the old `sov chat --agent <name> --state-dir <path>` form. Acquires the per-mission lock, runs the FSM tick, writes notes/wake-log/state back atomically. Exits with `lock held` when another wake is in flight. |
| `config [verb]` | View or change durable user-level config. Verbs: `show`, `path`, `get <p>`, `set <p> <v>`, `unset <p>`. No verb opens an interactive raw-mode picker. |
| `upgrade` | Pull the latest sov from the private repo and re-link the global binary. Pre-uninstalls + reinstalls so Bun's lockfile evicts the stale SHA. Options: `--ref <ref>` (pin to tag/branch/commit), `--dry-run` (preview commands), `--skip-uninstall` (faster but Bun's git-cache may serve a stale SHA), `--purge-cache` (wipe `~/.bun/install/cache/` first — now the default). `SOV_UPGRADE_URL` env var overrides the install URL for forks. |
| `profile [verb]` | Manage profile-scoped state roots under `<harness-home>/profiles/`. Verbs: `list` (table with `*` beside the active one), `show` (just the active name), `create <name>` (mkdir the profile dir), `use <name>` (pin the persisted active selection — use `default` to clear), `import-default <name>` (copy `config.json` + `credentials.json` from the unscoped root into the profile; sessions/trajectories/memory stay clean; refuses to overwrite). |
| `trace show <session-id>` | Render the operational trace at `<harness-home>/traces/<session-id>.jsonl` as a high-signal summary: header (provider/model/cwd/bundle), per-turn breakdown (provider request/response with usage + latency + TTFT, permission decisions, tool durations + output sizes), microcompact + loop_detected events, and the terminal session_end reason. |
| `eval run [--filter] [--budget] [--include-slow] [--compare] [--capture] [--replay]` | (Currently broken — the runner spawned `sov chat` which no longer exists. Pending re-wire to a non-interactive entry point in Phase 16.0c.) Run declarative goldens from `evals/goldens/*.golden.ts`. Each golden seeds a sandbox, pipes a prompt, and evaluates code assertions. `--compare provider1,provider2,...` runs each golden once per provider and prints a grid. `--capture <dir>` writes a deterministic-replay fixture per golden; `--replay <dir>` re-runs goldens against captured fixtures with no LLM calls. See [Eval Suite](#eval-suite). |
| `init [--force]` | (Phase 10.8.) Bootstrap the current directory into a real harness bundle. Writes a minimal `index.yaml` + `business/README.md` (seeded from `<cwd>/README.md` when present, else a stub) + empty `harness/schemas/` + `state/` + `skills/`. Refuses to overwrite an existing `index.yaml` unless `--force` is passed. After `sov init`, running `sov` from the same directory auto-discovers the new bundle via the upward `index.yaml` walk. |
| `learning status [--project <id>]` | (Phase 13.4.) Show per-project instinct counts + confidence histogram for the current (or specified) project. |
| `learning prune [--project <id>] [--dry-run]` | (Phase 13.4.) Drop sub-threshold instincts that have exceeded their aging window. `--dry-run` lists candidates without deleting. |
| `learning export <project-id> [--output <dir>]` | (Phase 13.4.) Emit each instinct as a `.md` file into `<dir>` (defaults to `./instincts-export`). Useful for external review or archiving. |

## Eval Suite

`sov eval run` is the declarative golden-test runner. Each golden lives at `evals/goldens/*.golden.ts` and exports a `GoldenSpec` describing a sandbox to spin up, a prompt (or array for multi-turn), and a list of code assertions. The runner spawns a fresh `sov chat` subprocess per golden in an isolated tempdir (separate `HARNESS_HOME` / `HARNESS_CONFIG` / `sessions.db`), pipes the prompt + `/quit` into stdin, captures stdout/stderr, parses tool-call totals + cost from the session-summary footer, and evaluates the assertions.

```bash
# Run every golden, default budget at evals/budget.json:
sov eval run

# Filter by id/name/category:
sov eval run --filter edit

# Custom binary, longer timeout per golden:
sov eval run --binary ./build/sov --timeout 120000

# Keep sandboxes for debugging:
sov eval run --keep-sandbox

# Compare two providers across the same goldens (grid output):
sov eval run --compare anthropic,ollama

# Capture once with a live LLM, then replay forever in CI without an API key:
sov eval run --capture /tmp/golden-fixtures            # ~one fixture per golden
sov eval run --replay  /tmp/golden-fixtures            # no LLM calls
```

**Assertion catalog.** `fileExists`, `fileNotExists`, `fileContains`, `fileMatches` (regex + flags), `fileEquals`, `agentResponseContains`, `agentResponseMatches` (regex + flags), `agentResponseLacks`, `noToolErrors`, `minToolCalls`, `maxToolCalls`, `exitCode`. Each is pure — takes `{sandboxCwd, transcript, exitCode, toolCalls?}` → `{pass, detail?}`.

**Compare mode.** `--compare provider1,provider2,...` runs each golden once per provider in sequence and reports a grid (rows = goldens, cols = providers, cells = `✓ 1.2s` or `✗ 4.5s`). Per-provider model selection falls through to each provider's configured default. The aggregate budget applies across the cross-product totals.

**Capture / replay.** `--capture <dir>` records a `ReplayFixture` per golden at `<dir>/<id>.fixture.json` while running live. `--replay <dir>` skips `resolveProvider` entirely and replays each golden against its captured fixture using `ReplayProvider` + `wrapToolsForReplay` — the agent loop, orchestrator, permission gates, hooks, and tool dispatch all run unchanged; only the provider + tool call boundaries are stubbed. The replay path makes no LLM calls and needs no API keys, so it's CI-safe. Goldens whose fixture is missing during replay are reported as aborted. The two flags are mutually exclusive.

The same primitives are exposed on the chat command directly: `sov chat --capture-fixture <path>` writes a single-session fixture; `sov chat --replay-fixture <path>` runs a single session against one. Useful for hand-crafted reproduction scenarios outside the eval suite.

**Budget JSON.** `evals/budget.json` is opt-in. Four thresholds, all independent — omit any to skip:
```json
{
  "maxWallSeconds": 300,
  "maxCostUsd": 1.5,
  "maxToolErrors": 2,
  "minPassCount": 3
}
```
The runner exits non-zero on any assertion fail, run abort (timeout/spawn error), or budget violation.

**When to add a golden.** When shipping a new tool, a bug fix that should never regress (write the golden first, ship it failing alongside the fix), a new permission rule, hook, or skill that has a behavioral check.

**Eval vs. semantic vs. unit.** Three suites with different roles:
- `tests/` (unit) — pure logic, offline, runs on every `bun test`.
- `tests/semantic/` (LLM-judged) — fuzzy meaning checks, opt-in via `bun run test:semantic`.
- `evals/goldens/` (code-judged) — deterministic-ish file-state and transcript checks, opt-in via `sov eval run`.

See `evals/README.md` for the full format documentation and seed-golden examples.

## Local-Model Router

`sov chat --provider router` activates a meta-provider that picks per turn between a configured **local** lane and a **frontier** lane. Every decision lands in `<harness-home>/router/audit.jsonl` so you can prove after the fact that data only left the box on turns where you expected it to.

**Configure it once** (`sov config set router.localProvider ollama` etc., or edit `<harness-home>/config.json`):

```json
{
  "router": {
    "localProvider": "ollama",
    "localModel": "qwen2.5:14b",
    "frontierProvider": "anthropic",
    "frontierModel": "claude-sonnet-4-6",
    "escalationMode": "ask",
    "defaultLane": "local"
  }
}
```

**Run it:**

```bash
sov chat --provider router
```

**How it routes.** The classifier is deterministic and conservative:

1. **Explicit user override** wins (e.g. `getNextOverride` set by a slash command — interactive override pending).
2. **Hard frontier triggers** flip to `local-with-escalation` automatically: recent tool errors ≥ 3, recent schema-validation failures ≥ 2, or a context-byte estimate that exceeds the local model's cap.
3. **Default** is `local`.

When the classifier output is `local-with-escalation`, the configured `escalationMode` decides:

| Mode | Behavior |
|---|---|
| `auto` | Escalate to frontier without asking. |
| `ask` (default) | Stay on `defaultLane` (today this matches `'never'` — interactive prompting lands in a later phase). |
| `never` | Stay on `defaultLane`. |

**What gets logged.** Each per-turn record in `audit.jsonl`:

```json
{
  "iso": "2026-05-04T20:00:00.000Z",
  "sessionId": "...",
  "lane": "local",
  "classifierLane": "local",
  "reason": "default lane: local",
  "provider": "ollama",
  "model": "qwen2.5:14b",
  "promptHash": "<sha256 of prompt>",
  "contextByteCount": 4096
}
```

Raw prompt text is **never** recorded by default — only its SHA-256 hash. (Opt-in raw logging is deferred to a follow-up.) The same allowlist redactor that protects trajectories also protects the audit log against accidental secret-spillage.

**Landed in Phase 13 (2026-05-05):** capability-profile lookup (per-model context length / role hints / tool-call + JSON reliability — see `src/router/capabilities.ts`) and per-lane concurrency caps via `LaneSemaphores` (`src/runtime/laneSemaphores.ts`). Both the router (single-session escalations) and the sub-agent scheduler (parent dispatching N children) acquire from the same per-lane semaphore set so global limits apply regardless of who issues the request. Capability profiles drive role-based agent definitions: an agent that declares `role: explore` resolves to the cheapest available model whose `recommendedRoles` includes that role.

## Bundleless Invocation + Default Bundle

`sov` runs without requiring a bundle on disk. Bundle resolution is a four-step fallthrough:

1. Explicit `--bundle <path>` flag.
2. `HARNESS_BUNDLE` env var.
3. Upward `index.yaml` walk from the current directory.
4. **Default bundle:**
   1. `<harness-home>/default-bundle/` if it exists (user override — takes precedence).
   2. The shipped `bundle-default/` directory next to the runtime source (always present in a healthy install).

"No bundle found" stops being a possible outcome in normal operation.

**The shipped default bundle is vendor-neutral.** It carries a generic coding-assistant system prompt, two starter skills (`/review`, `/summarize`), no schemas, an empty state directory. Nothing project-specific or product-specific. Anything Sovereign-AI-flavored ships only via real bundles authored by users.

**Customizing the default.** Two paths:

- **Drop an override at `<harness-home>/default-bundle/`.** Same shape as `bundle-default/` (an `index.yaml`, a `business/`, a `harness/`, a `state/`, optionally `skills/`). Lives outside the runtime install, so it survives upgrades. Useful for tweaking the system prompt or adding skills you want available everywhere.

- **Graduate a directory into a real bundle with `sov init`.** Run from the project root; writes a minimal skeleton (`index.yaml` + `business/README.md` seeded from your repo's `README.md` if present + empty `harness/`, `state/`, `skills/`). After `sov init`, running `sov chat` from inside that directory discovers the bundle via the upward walk — no `--bundle` flag needed.

`sov init` refuses to overwrite an existing `index.yaml` unless `--force` is passed.

```bash
# Run sov anywhere; the default bundle backs you up:
cd /tmp
sov

# Graduate the current directory into a real bundle:
cd ~/code/my-project
sov init
sov        # picks up the new bundle automatically
```

The corpus generator inside `sov init` is intentionally minimal in v1 — it seeds `business/README.md` from the cwd's `README.md` and that's it. Richer repo-aware seeding (file-tree summary, language/framework detection, dependency inference) is queued as a separate design session.

## Profiles

A profile is a named state-root scope. `sov -p work chat …` (or `sov --profile=work chat …`) pins the run to `<harness-home>/profiles/work/` instead of `<harness-home>/`, giving it a separate `config.json`, `credentials.json`, `sessions.db`, `rate_limits/`, memory, and skills. The same machine can host disjoint setups — work, personal, lab, per-client — without aliasing.

**Activating a profile.** Two shapes:
- **Per-invocation:** `sov -p work chat …` — affects this run only.
- **Persisted:** `sov profile use work` writes `<harness-home>/active-profile`; subsequent `sov` calls (without `-p`) inherit it. `sov profile use default` clears it.

The `default` name is reserved — it maps to `<harness-home>/` itself (the pre-Phase-10.7 unscoped root). `sov profile create default` is rejected.

**Bootstrapping.** A fresh profile starts empty. To seed it with your existing config + credentials: `sov profile create work && sov profile import-default work`. Sessions, trajectories, and memory stay empty by design — the profile is meant to scope history per project, not duplicate it.

**Listing.** `sov profile list` prints every profile (including the implicit `default`) with the active one marked:
```text
  default
* work
  personal
```

**Where things live.** With `HARNESS_HOME=$HOME/.harness` (the default):
- Default root: `~/.harness/{config.json,credentials.json,sessions.db,…}`
- `work` profile: `~/.harness/profiles/work/{config.json,credentials.json,sessions.db,…}`
- Active profile pin: `~/.harness/active-profile` (single line, profile name, empty for default)

**Locking.** Each profile has its own `<profile>/.sov.lock/` directory available as a helper for callers that want exclusivity (atomic mkdir + PID file with stale-process detection). The REPL itself does not currently acquire it — concurrent `sov` sessions on the same profile keep working.

### Scoping `HARNESS_HOME` for tests

`HARNESS_HOME` controls where the harness reads and writes all state (config, sessions, traces, trajectories, learning corpus). When driving `sov` non-interactively — for testing, eval scripts, or CI — take care that the env var actually reaches the `sov` process.

**Footgun pattern (override silently ignored):**
```bash
HARNESS_HOME=/tmp/test-home printf 'prompt\n/quit\n' | sov chat ...
```
Here `HARNESS_HOME` binds only to `printf`. The downstream `sov chat` process runs with the default `HARNESS_HOME` (typically `~/.harness/`) and silently ignores the override. Symptoms: state writes land in `~/.harness/` instead of your sandbox; expected per-test config (e.g. `learning.synthesizerEveryN: 2`) is not applied; tests that depend on isolated state appear to pass while polluting the live harness home.

**Correct patterns:**
```bash
# (a) export in the current shell — preferred
export HARNESS_HOME=/tmp/test-home
printf 'prompt\n/quit\n' | sov chat ...

# (b) pipe stdin from a file or heredoc, assign env only to sov
HARNESS_HOME=/tmp/test-home sov chat ... < input.txt

# (c) repeat the var on each command in the pipeline
HARNESS_HOME=/tmp/test-home printf 'prompt\n/quit\n' | HARNESS_HOME=/tmp/test-home sov chat ...
```

Pattern (a) is preferred — single assignment, unambiguous scope, works correctly in subshells. Pattern (b) avoids the pipeline entirely by redirecting stdin from a file, so the env var only needs to appear once on `sov`. Pattern (c) works but requires duplicating the var on every pipeline stage.

**Why this happens:** the `VAR=value cmd` prefix syntax binds `VAR` only to `cmd`, not to the rest of a pipeline. Each command in a pipeline runs in its own subshell with its own environment. `printf` gets the override; `sov chat` does not.

## REPL UX

Visual surfaces you'll see in a normal session:

- **Splash** at startup — block-letter "SOV" logo (cyan→blue gradient) next to a boxed info card with version, provider/auth, model, and bundle path. The dim footer line collapses operational details (perms mode + count of loaded allow-rules, tools, cache, session id).
- **Pre-prompt footer** — a single dim status line above each input frame: `provider · model · ctx N% · $cost · perms:mode · tools:N · bundle:label`. The `ctx` segment turns yellow above 60% utilization and red above 80%. Disable with `sov config set ui.footer.enabled false`.
- **Input editor** (Wave 4) — multi-line raw-mode editor with persistent history at `~/.harness/input-history`. Type `\` at end of a line + Enter to insert a newline; Enter on a line not ending in `\` submits. Up/Down walk history (or move cursor when on multi-line buffer); Ctrl-R opens reverse-i-search; Tab autocompletes `/commands` and `@file:` paths. Long lines soft-wrap to terminal width. Full readline-style keybinds: Ctrl-A/E/B/F/U/K/W/L/P/N. Ctrl-C clears the buffer (second press exits); Ctrl-D exits when buffer is empty. Escape cancels reverse-search. Falls back to the legacy readline path under piped stdin or when `--legacy-input` is set.
- **Modal permission prompts** — when a tool needs approval, a yellow-bordered box appears: title, tool name, input, optional reason, and `[y] allow   [N] deny   [a] always` choices. The thinking spinner suppresses itself while the modal is up so the prompt can't be visually buried.
- **Thinking indicator** — `⠋ Thinking 12s ↑ 1234 ↓ 56` (cyan spinner + dim status) appears during silent waits (provider work, slow local model prompt processing, tool execution). 500ms grace, so it never flashes during normal fast streaming.
- **Compact tool slot** — sequential tool calls share a single line that updates in place (`→ FileRead path=...` while running, `✓ N lines, M chars` after). With `--verbose`, the full 40-line preview block is shown instead.
- **Inline diffs** — successful FileEdit and FileWrite calls render below the slot summary as `- ` (red) / `+ ` (green) lines with the file path and 1-based line number. FileEdit shows the full surrounding line, not just the matched substring. Long diffs truncate to head + `… N more lines …` + tail in non-verbose mode. Disable with `sov config set ui.diffRender.enabled false`.
- **Multi-line tool errors** — failures surface the first line of the error followed by `· +N more lines` when the underlying tool produced a multi-line trace.
- **Pre-compaction warning** — when context utilization crosses 5% below the proactive-compaction threshold, the REPL prints a one-shot `[compact] approaching threshold (ctx N% / trigger M%)` so you know auto-compaction may fire on the next turn.
- **Markdown rendering** of streamed text — headings, bold, italic, inline code, list bullets, blockquotes, fenced code blocks, horizontal rules.
- **Goodbye box** at session end — Interaction Summary (session ID, tool calls ✓/✗, success rate), Performance (wall time, agent active, API time, tool time), Tokens (total, cache, est. cost). Followed by the resume command.

## Themes

Three built-in themes are bundled. The default is `dark`; `light` retunes primaries for light terminals (amber warning, dark blue accent); `no-color` returns identity tokens for transcripts and pipes.

```bash
/theme            # opens picker (TTY only)
/theme light      # switches inline + persists to ~/.harness/config.json
/theme no-color
/theme dark       # back to default
```

The `NO_COLOR` environment variable is honored at startup and overrides the configured value (useful for CI / piped output without changing your config). Custom themes loaded from `~/.harness/themes/*.json` are deferred to a future wave; the registry is structured to absorb them.

## Config Command

User-level config lives at `~/.harness/config.json` (override with `HARNESS_CONFIG`). Read or write it without hand-editing JSON:

```bash
sov config                                 # interactive picker (TTY only)
sov config show                            # full config, secrets redacted
sov config path                            # resolved file path
sov config get defaultProvider
sov config set defaultProvider ollama
sov config set providers.ollama.model qwen2.5:7b
sov config set microcompaction.enabled false
sov config unset microcompaction.enabled
```

Bare `sov config` opens a single-screen picker: ↑/↓ to navigate, Enter to edit, `u` to unset, `s` (or Esc) to save and quit. The same picker is reachable in-session via `/settings`. Fields with curated values (`defaultProvider`, `defaultModel` scoped by provider, `permissionMode`, `maxTurns`, `compaction.proactiveThresholdPct`, etc.) open a sub-picker on Enter; otherwise readline takes a free-text value. Edits are validated through the settings schema before writing. (This is an interim raw-mode UI; a multi-page settings dialog is Wave 5+ work.)

The same verbs work in-session via `/config`:

```text
/config show
/config get defaultProvider
/config set providers.ollama.model qwen2.5:7b
/config unset microcompaction.enabled
```

Every write is validated against the settings schema before touching disk; rejected changes leave the file untouched. `apiKey`, `apiKeys`, and credential entries are redacted in `show` and `get` output.

Available config fields (top-level unless noted):

| Path | Type | Default | Notes |
|---|---|---|---|
| `defaultProvider` | string | `anthropic` | `anthropic` \| `openai` \| `openrouter` \| `ollama` |
| `defaultModel` | string | provider default | scoped by `defaultProvider` in the picker |
| `permissionMode` | enum | `default` | `default` \| `ask` \| `bypass` |
| `maxTurns` | int | `100` | runaway-loop circuit breaker, not a task ceiling |
| `verbose` | bool | `false` | show full tool-result preview blocks |
| `providers.<name>.model` | string | — | provider-specific model override |
| `providers.<name>.baseUrl` | url | provider default | e.g. `http://localhost:11434` for ollama |
| `providers.<name>.apiKey` | string (secret) | — | redacted in `show` |
| `providers.ollama.numCtx` | int | model contextLength | sent as `num_ctx` per request |
| `webSearch.provider` | enum | `tavily` | `tavily` \| `brave` |
| `webSearch.apiKey` | string (secret) | — | redacted in `show` |
| `webSearch.maxResults` | int 1–20 | `5` | default result cap for WebSearch |
| `compaction.proactiveThresholdPct` | int 1–99 | `75` | full-compaction trigger pct of context window |
| `microcompaction.enabled` | bool | `true` | per-part tool-result clearing |
| `microcompaction.keepRecent` | int | `5` | number of recent tool results preserved |
| `microcompaction.triggerThresholdPct` | int 0–100 | `40` | trigger pct of context for microcompaction |
| `debugMode.enabled` | bool | `false` | umbrella switch — auto-enables every child |
| `debugMode.transcript` | bool | `false` | write per-session JSONL transcript |
| `debugMode.transcriptDir` | path | `<harnessHome>/debug` | directory for auto-generated transcripts |
| `ui.theme` | enum | `dark` | `dark` \| `light` \| `no-color`. `NO_COLOR` env overrides. |
| `ui.footer.enabled` | bool | `true` | pre-prompt status line above each input frame |
| `ui.contextMeter.warnAtPercent` | int 0–100 | `60` | yellow zone threshold for the ctx % footer segment |
| `ui.contextMeter.dangerAtPercent` | int 0–100 | `80` | red zone threshold for the ctx % footer segment |
| `ui.diffRender.enabled` | bool | `true` | inline diff renderer for FileEdit / FileWrite |
| `review.autoPromoteMemory` | bool | `false` | auto-approve memory proposals without human review |
| `review.autoPromoteSkills` | bool | `false` | auto-approve skill proposals without human review |
| `review.userTurnsForMemoryReview` | int | `10` | trigger a memory review fork every N user turns |
| `review.toolIterationsForSkillReview` | int | `50` | trigger a skill review fork every M tool iterations |
| `review.childReviewEveryN` | int | `5` | trigger a distillation review every N child completions |
| `review.minIntervalMs` | int | `30000` | minimum ms between auto-dispatched review forks |
| `review.disabled` | bool | `false` | disable all auto-review triggers for this session |
| `learning.disabled` | bool | `false` | when true, observer is a no-op + synthesizer never fires |
| `learning.synthesizerEveryN` | int > 0 | `20` | synthesizer dispatches every Nth user turn |
| `learning.observationBufferSize` | int > 0 | `200` | in-memory buffer cap before backpressure drops the oldest |
| `learning.pruneBelowConfidence` | 0..1 | `0.3` | threshold below which instincts age out via `sov learning prune` |
| `learning.pruneAgeDays` | int > 0 | `30` | days without reinforcement before sub-threshold instincts are pruned |

## Ollama Notes

Ollama defaults `num_ctx` to **2,048 tokens** for chat requests unless overridden. The harness now sends `num_ctx` automatically based on the model's registered context length (32K for the qwen2.5 family, 128K for llama3.1, etc.) — so chats no longer get silently truncated to 2K and trigger constant compaction. Override with:

```bash
sov config set providers.ollama.numCtx 16384
```

If your Ollama install is RAM-constrained, lowering `numCtx` is the right knob. Unsetting it returns to the registered default.

### Frequent compaction with small-context local models

Proactive compaction fires by default at **75% of the model's context window**. For Anthropic at 200K that's 150K. For qwen2.5:7b at 32K that's ~24K — leaves ~8K for the bundle's system prompt and conversation. Tune with:

```bash
sov config set compaction.proactiveThresholdPct 90    # keep more history before triggering
sov config set compaction.proactiveThresholdPct 50    # earlier compaction
```

Anything between 1 and 99 is accepted. The trade-off going higher is a higher chance of hitting the model's hard ceiling and triggering reactive (post-error) compaction instead.

The compactor also self-guards: if the frozen system prompt alone exceeds the threshold (a heavy bundle on a small-context model), compaction stops firing — it can't make progress because it only summarizes message history. The fix in that case is either a lighter bundle, a model with a larger context window, or raising the threshold.

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

Environment variables still work. For local development, a repo-root `.env` is auto-loaded when the globally linked `sov` binary runs:

```bash
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
OPENROUTER_API_KEY=sk-or-...
```

## Sessions And Resume

Every turn is saved to `~/.harness/sessions.db` by default. When the REPL exits, it prints a resume command:

```text
to resume: sov --resume <uuid> --bundle <bundle-path>
```

Resume with that command:

```bash
sov --resume <uuid> --bundle ~/code/sovereign-ai-docs
```

Resume reuses the exact system prompt that was frozen when the session began. The bundle path is validated; resuming a session against a different bundle is rejected.

Use `--db <path>` when you want an isolated session database for testing:

```bash
sov --db /tmp/harness-test.db --bundle ~/code/sovereign-ai-docs
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

## Tool Result Visibility

When the model runs a tool, the REPL prints a one-line summary under the `[tool: name input]` header by default — `└─ ok · 663 lines, 22.7K chars` for success, `└─ error · ...` (red) for failure. The full tool output stays available to the model but doesn't dominate your conversation view.

Pass `--verbose` (or set `verbose: true` in config) to see the full preview block (capped at 40 lines / 4,000 chars; longer results show a count summary):

```bash
sov --verbose                      # full previews this session
sov config set verbose true        # full previews always
```

Caveats:
- Even in verbose mode, the preview is for human visibility only. It is not part of the model's reply text — model-generated explanations still appear separately.
- Tool inputs (commands, file paths) always appear in the `[tool: name input]` header line.

## Web Tools

Two model-callable tools cover open-web reach:

- **`WebFetch`** — fetch a URL and return decoded text. HTML pages have `<script>`/`<style>` blocks stripped, tags removed, and entities decoded. Plaintext/JSON/Markdown pass through unchanged. Caps: 10s timeout, 1MB response body, 50K chars returned (override per call with `max_chars`). Refuses non-http(s) schemes and private IPs / localhost. **Works out of the box with no API key.**
- **`WebSearch`** — query the open web through a configurable provider. Returns a small list of `{title, url, snippet}` results the model drills into via WebFetch.

**WebSearch is hidden until you configure a key.** `isEnabled()` returns false when no Tavily/Brave key is set, so the model never sees a tool that would only fail. To turn it on, set a key — both Tavily and Brave have free tiers:

```bash
# Tavily (free tier: 1K queries/month, AI-friendly snippets — keys start with tvly-)
sov config set webSearch.apiKey tvly-...

# Or Brave Search (free tier: 2K queries/month — keys are bare hex strings)
sov config set webSearch.apiKey BSA...
```

The provider auto-detects from the key shape — Tavily keys begin with `tvly-` by Tavily's own convention; anything else is treated as Brave. You can override explicitly with `sov config set webSearch.provider tavily` (or `brave`). You can also export `TAVILY_API_KEY` or `BRAVE_SEARCH_API_KEY` instead of putting the key in config; the harness dispatches by which env var is set.

For higher-fidelity reach (JS-rendered SPAs, browser-only content, GitHub / Slack / etc.) configure an MCP server — see "MCP Servers" below.

## Slash Commands

Lines beginning with `/` are handled locally before normal model turns. `/help` renders a categorized 2-column layout of the full command set.

### Session

| Command | Behavior |
|---|---|
| `/help` (`/h`, `/?`) | List slash commands grouped by category. |
| `/clear` | Clear in-memory conversation history by starting a fresh child session. |
| `/cost` | Token totals and estimated USD cost for this session. |
| `/compact` | Compress older history into a guarded handoff summary; switch to a child session. |
| `/rollback` | Switch back to the parent session after `/compact` or `/clear`. |
| `/resume` | Picker over recent sessions; prints the resume command for a fresh REPL. (TTY only.) |
| `/stats` | Mid-session metrics card (mirrors the goodbye summary shape). |
| `/quit` (`/exit`, `/q`) | Exit the REPL after printing the session summary. |

### Info

| Command | Behavior |
|---|---|
| `/about` | Boxed info card: version, provider, model, cwd, bundle, session id. |
| `/permissions` | Active mode + session always-allow rules + persistent rule layers. |
| `/skills` | Visible skills with `[source]` tags. |
| `/tools` | Registered tools with descriptions. |
| `/context-budget` | Per-component context-window audit: system prompt, tool schemas, skills, bundle, memory. Flags components above bloat thresholds and classifies as always/sometimes/rarely needed. |

### Config

| Command | Behavior |
|---|---|
| `/config [...]` | View or change durable config (`show`, `path`, `get <p>`, `set <p> <v>`, `unset <p>`). |
| `/model [<name>]` | Picker over provider models when no arg; persists to the session DB so it survives `--resume`. |
| `/settings` | Open the interactive settings editor (TTY only; equivalent to `sov config` with no verb). |
| `/theme [<name>]` | Picker over built-in themes (`dark`, `light`, `no-color`); inline arg skips picker. Persists to config. |

### Files

| Command | Behavior |
|---|---|
| `/copy` | Copy the last assistant message to the system clipboard (pbcopy / wl-copy / xclip / xsel / clip.exe). |
| `/export [md|jsonl|json]` | Picker over format when no arg; writes `session-<short-id>.<ext>` to cwd. |
| `/init` | Prompt-command that scans the project (Glob / FileRead) and writes a `CONTEXT.md` briefing. |

### Git

| Command | Behavior |
|---|---|
| `/commit` | Ask the model to stage and commit changes with git-only Bash scope. |

### Review

| Command | Behavior |
|---|---|
| `/review` | List pending proposals (equivalent to `/review list`). |
| `/review list` | List all pending memory and skill proposals waiting for review. |
| `/review show <id>` | Show the full body of a pending proposal by ID. |
| `/review approve <id>` | Promote the proposal from `pending/` to `approved/`. |
| `/review reject <id>` | Move the proposal to `rejected/`. |
| `/review consolidate` | Dispatch a consolidation fork that merges redundant memory proposals into a single entry. |
| `/review activity` | Show recent review forks from the sessions database. |

Proposals are created automatically by background review forks (triggered by the ReviewManager on configured intervals) or manually requested via sub-agent delegation. The propose-then-promote lifecycle keeps human approval in the loop by default; set `review.autoPromoteMemory` / `review.autoPromoteSkills` in settings to bypass.

Skill files registered as slash commands appear under their own category in `/help` output.

Examples:

```text
/cost
/model claude-opus-4-7
/theme light
/export md
/resume
/quit
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
    "deny": ["Bash(rm *)", "mcp__github"],
    "ask": ["Edit"]
  }
}
```

Rules are shaped as `Tool(pattern)` or just `Tool`. Aliases `Read`, `Write`, and `Edit` map to `FileRead`, `FileWrite`, and `FileEdit`. For MCP tools (`mcp__<server>__<tool>`), the rule shape `mcp__<server>` matches every tool from one server in one line — useful for blanket-deny of an entire MCP server. Tool-level rules use the full `mcp__<server>__<tool>` form.

### Secret Redaction (Defense in Depth)

The harness applies an `InputTransformer` after permission resolution that scans Write / Edit / NotebookEdit inputs for well-known secret patterns and rewrites matches to `<REDACTED:kind>` before the orchestrator dispatches the tool. The on-disk artifact never contains the live secret.

| Kind | Pattern (prefix + length) |
|---|---|
| `github-oauth` | `gh[oprsu]_` + 36+ alphanumeric |
| `github-fine-grained` | `github_pat_` + 82 chars (incl. `_`) |
| `aws-access-key-id` | `AKIA` + 16 base32 |
| `stripe-secret-live` / `stripe-secret-test` | `[sr]k_live_` / `[sr]k_test_` + 16+ alphanumeric |
| `stripe-publishable` | `pk_(live\|test)_` + 16+ alphanumeric |
| `slack-token` | `xox[abprs]-` + tokens |
| `google-api-key` | `AIza` + 35 chars |
| `jwt` | `eyJ…eyJ…<sig>` (header + payload + signature) |
| `private-key-block` | PEM `-----BEGIN […] PRIVATE KEY-----` blocks |

What this does NOT cover:
- Bash commands (would require shell parsing). Use shell hooks or careful prompts.
- Edit's `old_string` field — intentionally NOT redacted, since the legitimate workflow for *removing* a secret from a file passes the live value as `old_string` so Edit can match.
- Chat narration / final response — the redactor only acts on tool inputs, not on the model's reply text. Skill prompts (e.g., `/security-audit`) discipline the model not to inline secrets there.
- High-entropy strings without a known prefix. Generic detection is too noisy on real code.

To disable for testing or debugging:
```bash
HARNESS_REDACTION=off sov chat
```

Source: `src/permissions/secretRedactor.ts` (detector), `src/permissions/inputTransformer.ts` (wrapper), `src/permissions/redactSecretsTransformer.ts` (Write/Edit/NotebookEdit field bridge).

### Shell Command Virtual Tool Mapping

Read-only Bash commands automatically resolve against `Read` permission rules. If your allow rules include `Read` or `Read(*.ts)`, then `Bash("cat src/main.ts")` runs without prompting because the shell AST analyzer classifies `cat` as a read operation. Write and edit commands (`cp`, `rm`, `chmod`, etc.) do not benefit from this — they still follow Bash-specific rules. Command substitution (`$(...)`, backticks) is always treated as unsafe and requires explicit Bash rules.

When a prompt is required, the REPL renders a yellow-bordered modal:

```text
╭─────────────────────────────────────────────╮
│  permission required                        │
│                                             │
│  tool    Bash                               │
│  input   ls src/                            │
│  reason  needs approval                     │
│                                             │
│  [y] allow   [N] deny   [a] always          │
╰─────────────────────────────────────────────╯
  >
```

The thinking spinner suppresses itself while the modal is up so the prompt can't be visually buried by streamed tool output.

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

## Inline Shell — `! <command>`

Type `! <command>` at the REPL prompt to run the rest as a bash command with your TTY inherited. This is the explicit escape hatch for cases `BashTool` can't handle: `sudo`, TouchID, pagers, interactive editors. The harness does not capture inline-shell output for the model — you typed `!` to do something for yourself, not to feed state to the agent.

```text
> ! sudo launchctl list | grep com.example
> ! git rebase -i HEAD~3
> ! less /var/log/system.log
```

The `!` prefix runs *before* slash-command parsing so a hostile filename or skill name can never shadow it.

## MCP Servers

Configure stdio MCP servers in any settings layer (`mcpServers` is concatenated across layers; duplicate names across layers is an error):

```json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/safe/dir"] }
  }
}
```

Discovered tools register as `mcp__<server>__<tool>` and flow through the same `Tool` interface as native tools — same permission gating, same hooks. They default to deferred (their full schema is fetched on demand via the model's `ToolSearch` tool) so the system prompt token cost stays bounded as servers add tools.

Connection failures log a one-line banner at session start and the affected tools simply don't appear; the rest of the session keeps running. Use `/context-budget` or `HarnessInfo`'s `mcp` section to inspect connection status, tool counts, and the configured invocation commands.

## Hooks

Configure `PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `Stop` hooks under any settings layer's `hooks` key:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "/abs/path/audit-bash.sh" }] }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "/abs/path/lint-after-edit.sh", "timeout": 30 }] }
    ]
  }
}
```

Each hook is a shell command that receives the event payload as JSON on stdin and returns a JSON decision on stdout. Exit code 2 means "block." `PreToolUse` hooks can return `permissionDecision: 'allow' | 'deny' | 'ask'` plus an optional `updatedInput` that transforms the tool input; `PostToolUse` can return `additionalContext` appended to the tool result the model sees.

**First-use TTY consent.** When a configured hook fires for the first time on this machine, the user is prompted to allow or deny it; the decision is persisted in `~/.harness/shell-hooks-allowlist.json`. Without consent the hook is inert. Hooks always run with `shell: false` + argv-split — never as a shell-string concatenation.

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

### Default-bundle skills

The shipped `bundle-default/` provides three starter skills, all auto-discovered:

| Skill | Purpose |
|---|---|
| `/review` | Walk a codebase and surface the highest-priority issues (correctness, security, design, tests) |
| `/summarize` | Produce a tight, accurate summary of a file/directory/repo |
| `/security-audit` | Run a security audit with explicit threat-model scaffolding (actors → assets → exposure paths), per-finding verification gate ("what command did I run, what was the output, why does it mean exposure"), and hard rules: no fan-fiction, no platform mismatch, no live secrets in artifacts. Pairs with the secret-redaction transformer above as defense in depth. |

Override any of these in your own bundle by placing a same-named skill file in `<bundle>/skills/` — bundle skills shadow defaults. Override globally for all bundleless sessions by placing it under `<harness-home>/default-bundle/skills/`.

## Trajectory Capture

Every completed session writes a ShareGPT-shaped JSONL record (Phase 13.1). Storage location:

| Mode | Path |
|---|---|
| Bundle loaded | `<bundle>/state/artifacts/trajectories/{samples,failed}.jsonl` |
| Generic-agent | `<harnessHome>/trajectories/{samples,failed}.jsonl` |

Sessions terminating cleanly (`reason: completed` or `max_turns` — the run loop hit its iteration cap with no error) land in `samples.jsonl`; sessions ending via interrupt / error / `max_tokens` go to `failed.jsonl`. Each line is a single record:

```json
{
  "conversations": [
    { "from": "human", "value": "what is 2+2?" },
    { "from": "gpt", "value": "2 + 2 = 4" }
  ],
  "timestamp": "2026-05-04T22:49:49.755Z",
  "sessionId": "0b576155-e83b-43ba-b432-12b99f5d5e57",
  "provider": "anthropic",
  "model": "claude-haiku-4-5-20251001",
  "completed": true,
  "terminalReason": "completed",
  "toolCallCount": 0,
  "iterationsUsed": 0,
  "estimatedCostUsd": 0.00107145
}
```

Mapping conventions: `user → human`, `assistant → gpt`, `tool_result → tool`. Thinking blocks render inline as `<think>…</think>` (cross-model compatible — OpenAI o-series, Anthropic extended thinking, DeepSeek R1 all agree on the tag). Assistant messages with text + `tool_use` split into separate records: text first, then `<tool_call name="X" id="Y">{…}</tool_call>`.

**Redaction at write.** Every record passes through `redact()` before disk write — secrets in conversation text get replaced with `[REDACTED]`. Patterns cover Anthropic / OpenAI / Tavily / Brave / OpenRouter API keys, GitHub PATs, AWS access keys, JWTs, bearer tokens, PEM private-key blocks, and credential file paths (`~/.aws/credentials`, `~/.ssh/id_*`).

**Disable redaction** (test-only — not recommended): `HARNESS_REDACT_SECRETS=0`. The flag is **snapshotted at process import** per Invariant #15, so an agent tool call that mutates `process.env` mid-session can't disable redaction.

**Privacy posture.** The trajectory directory is tier-3 per-installation state. Treat it like `sessions.db` — fine to commit to a private repo as a durable archive, don't push to a public one without scrubbing. `failed.jsonl` is especially worth checking before sharing because session interrupts often capture mid-thought text.

Empty sessions (you opened `sov` and quit without prompting) skip the write entirely — no record gets created.

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

The runtime also compacts proactively above 75% of the model context window (tunable via `compaction.proactiveThresholdPct`) and retries once after provider context-overflow errors. The compactor self-guards: if the frozen system prompt alone exceeds the threshold, proactive compaction stops firing — it can't reduce the system prompt and would otherwise loop. Lighter bundle, larger-context model, or a higher threshold are the resolutions.

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

Audit context-window usage when a session feels sluggish or the agent's output quality drops:

```text
/context-budget
```

The output is sectioned by component kind (system prompt, tool schemas, skills, bundle context, memory files) with token counts, bloat flags (`heavy`, `extreme`), and triage classes (`sometimes`, `rarely`). Lets you see whether a particular skill or MCP server's schema is dominating the window before deciding what to drop or move behind a `requires_*` gate.

Run with stricter permission prompts (Phase 16.0c will bring the `--permission-mode` flag back — for now, set it persistently in config):

```bash
sov config set permissionMode ask
sov --bundle ~/code/sovereign-ai-docs
```

Run locally through Ollama (Phase 16.0c will bring the `--provider` / `--model` flags back — for now, set them persistently in config):

```bash
sov config set defaultProvider ollama
sov config set providers.ollama.model qwen2.5:3b
sov --bundle ~/code/sovereign-ai-docs
```

## Semantic Test Suite

LLM-judged behavior tests that drive the real `sov` binary in an isolated sandbox and have an LLM judge decide whether each prompt was handled correctly. Catches bugs that unit tests can't reach: tool dispatch surfacing, fabrication on tool errors, slash command pipelines, permission system end-to-end, multi-turn coherence, /compact and /rollback.

```bash
bun run test:semantic                              # full suite (~5 min, $0.87 informational)
bun run test:semantic -- --filter bash             # single test
bun run test:semantic -- --list                    # show discovered tests
bun run test:semantic -- --verbose                 # print transcripts on failure
bun run test:semantic -- --judge anthropic-api     # API mode (needs ANTHROPIC_API_KEY)
```

**Default judge:** the local `claude` CLI in `--print` mode — uses your authenticated subscription, no API tokens. Falls back to the Anthropic SDK when `claude` isn't on `PATH` (or you pass `--judge anthropic-api`). Both judge and agent default to `claude-sonnet-4-6`.

**Strictly opt-in.** Not part of `bun test` because every case spawns a real model turn (the judge is subscription-absorbed but the agent-under-test still spends model credit). `tests/semantic/*.cases.ts` doesn't match Bun's `*.test.ts` discovery.

**Fully isolated.** Each test runs in a fresh `mktemp -d` with its own `HARNESS_HOME`, `HARNESS_CONFIG`, sessions DB. Cleaned up on success, failure, or crash. The judge subprocess is spawned in `tmpdir()` with `--tools ""`, `--no-session-persistence`, `--disable-slash-commands`.

**Coverage at a glance (58/58 pass):** 10 tool-dispatch cases (including Phase 12.5 envelope-recovery, Phase 13.3 propose-tool pool separation, and Phase 13.4 instinct-tool pool separation), 6 slash-command pipeline paths, 6 permission cases, 4 refusal cases, 2 context-expansion cases, 2 MCP cases, 2 hook cases, 1 self-doc/HarnessInfo case, 1 router case, 1 secret-redaction case, 1 `/security-audit` skill case, 2 sub-agent cases, 4 task-system cases (Phase 13.2), 6 review-system cases (Phase 13.3 `/review` verbs), 4 learning-system cases (Phase 13.4), and 6 workflow cases including end-to-end /compact and /rollback. Full test-by-test inventory and bug-class breakdown: [`docs/semantic-testing.md`](./semantic-testing.md). Design, isolation, porting guide, how to add tests / judge backends: [`tests/semantic/README.md`](../tests/semantic/README.md).

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

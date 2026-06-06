# Usage Guide

This guide covers day-to-day operation of the Sovereign AI runtime. It assumes `sov` is on your `PATH` (either `bun install -g git+ssh://git@github.com/yevgetman/sovereign-ai-harness.git` for users, or `bun link` from a source clone for development — see the README install section).

## Quick Start

The bare `sov` command starts a chat (`chat` is the default subcommand). Bundle resolution order:

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
bun run chat --bundle ~/code/sovereign-ai-docs
```

## CLI Flags

| Flag | Meaning |
|---|---|
| `-p, --profile <name>` | (Top-level — must precede the subcommand.) Pin the run to `<harness-home>/profiles/<name>/` for config / credentials / sessions / rate-limits / memory / skills. Use `default` for the unscoped base root. See [Profiles](#profiles). |
| `--bundle <path>` | Harness bundle directory. Can also be set with `HARNESS_BUNDLE`. Optional — `sov` runs as a generic agent when no bundle is found. |
| `--provider <name>` | Provider: `anthropic`, `openai`, `openrouter`, or `ollama`. |
| `--model <name>` | Model override for the selected provider. |
| `--max-tokens <n>` | Max output tokens per provider turn. Default: `12000`. |
| `--permission-mode <mode>` | Tool permission mode: `default`, `ask`, or `bypass`. |
| `--resume <uuid>` | Resume a stored session. |
| `--db <path>` | Override the session DB path. Default: `~/.harness/sessions.db`. |
| `--no-cache` | Disable provider prompt-cache markers for testing. |
| `--no-preflight` | Skip startup provider/model health checks. |
| `--transcript <path>` | Write a redacted JSONL terminal/event transcript for manual tests. |
| `-v, --verbose` | Show full tool-result preview blocks instead of one-line summaries. |
| `--capture-fixture <path>` | (Phase 10.5 part 2.) Wrap the resolved provider + tools to write a deterministic-replay fixture at this path on session end. See [Eval Suite](#eval-suite). Verified working post-Phase-16-revert. |
| `--replay-fixture <path>` | (Phase 10.5 part 2.) Replay a previously-captured fixture instead of resolving a real provider. No LLM calls. Mutually exclusive with `--capture-fixture`. Verified working post-Phase-16-revert. |
| `--agent <name>` | (Phase 13.) Run as a named agent — uses the agent definition's system prompt and allowed tools instead of the default harness chat persona. Required when invoking a scheduled-mission agent. |
| `--state-dir <path>` | (Phase 13.5.) Scheduled-mission mode: path to a mission directory containing `mission.md` + `state.json`. Requires `--agent` with `supportsMissionState: true`. The directory's `.lock/` subdir guards against overlapping launchd-triggered wakes. |

Examples:

```bash
sov --provider openai --model gpt-4o-mini
sov --provider ollama --model qwen2.5:3b
sov --permission-mode ask
sov --no-cache
```

### TUI flag coverage

Bare `sov` launches the Go Bubble Tea TUI via the local Hono server. The TUI accepts the following `sov` flags:

| Flag | Status | Notes |
|---|---|---|
| `--bundle <path>` | Wired (M3) | |
| `--provider <name>` | Wired (M3) | |
| `-m, --model <name>` | Wired (M3) | |
| `--permission-mode <mode>` | Wired (M4) | |
| `--max-tokens <n>` | Wired (M4) | Default 12000 |
| `--db <path>` | Wired (M4) | Default `<harnessHome>/sessions.db` |
| `--resume <id>` | Wired (M4) | Hydrates prior transcript via `GET /sessions/:id/messages` |
| `--no-cache` | Wired (M4) | |
| `--no-preflight` | Wired (M4) | Skips provider preflight |
| `--capture-fixture <path>` | Wired (M8) | Threads through `buildRuntime` as `captureFixturePath`; mutex-checked against `--replay-fixture` (exits 2 if both set) |
| `--replay-fixture <path>` | Wired (M8) | Threads through `buildRuntime` as `replayFixturePath` |
| `--transcript <path>` | **Warn** | Wires in M7 (trajectory capture) |
| `--agent <name>` | **Warn** | Wires in M7 (sub-agent scheduler + scheduled-mission) |
| `--state-dir <path>` | **Warn** | Wires in M7 |
| `-v, --verbose` | Wired | Forwarded to the TUI as `--verbose-raw` (raw tool-output escape hatch) |

## CLI Subcommands

`sov` has top-level subcommands beyond the default interactive session:

| Subcommand | Behavior |
|---|---|
| (bare `sov`) | Start the interactive session using the Bubble Tea TUI (`sov-tui`) backed by the local Hono server. If `sov-tui` is missing the launcher prints an install hint and exits. |
| `chat` *(deprecated keyword)* | Same as bare `sov`. Typing `sov chat` explicitly prints a deprecation warning on stderr recommending bare `sov` (interactive) or `sov dispatch` (headless). The keyword still works for now. |
| `dispatch [-b/--bundle <path>]` | (2026-05-12.) Headless slash-command surface. Boots a minimum context (no session DB, no compactor, no task manager, no review manager, no agent loop), reads slash commands from stdin (one per line), prints output framed by `--- ready ---` (boot complete) and `--- end-of-turn ---` (per-command separator), exits on EOF or `/quit`. Read-only commands work identically to the interactive session; state-dependent commands like `/compact`, `/rollback`, `/resume`, `/tasks`, `/review`, `/stats`, `/export` error informatively ("dispatch mode does not maintain a session DB — /X requires an interactive session"). Use case: mechanical regression testing of dispatch logic at $0 cost in ~1s. Example: `echo "/help" \| sov dispatch`. |
| `mission init <dir> --goal "..."` | (Phase 13.5.) Bootstrap a scheduled-mission directory at `<dir>` with `mission.md` (goal + plan template), `state.json` (FSM initial state), `notes.md`, and the `.lock/` subdir. Refuses to overwrite an existing mission dir. |
| `mission run --state-dir <dir>` | (Phase 13.5.) Non-interactive scheduled-mission wake. Runs one mission cycle (load state → check FSM gate → inject mission segments → invoke `scheduled-mission` agent → parse `MISSION_TRANSITION=<state>` sentinel → append wake-log → atomic state write-back → release lock). Exits with `[mission] state is 'complete' (terminal) — nothing to do` if the FSM is in a terminal state. Designed for launchd / cron invocation. The interactive equivalent `sov --agent scheduled-mission --state-dir <dir>` still works. |
| `daemon` | (Phase 16.0a — dormant.) Acquire a per-profile PID lock, init the daemon event bus + session cache + approval queue, emit `daemon_started`, wait for SIGTERM/SIGINT. Currently has no foreground subscriber; the intended subscriber (Phase 16.0b Ink TUI) was reverted on 2026-05-12. Functional but unused; Phase 16.1 shipped as the Bubble Tea TUI rebuild (not a daemon subscriber), so the daemon stays dormant pending a future daemon-subscriber design. Use `harness daemon` interchangeably. |
| `config [verb]` | View or change durable user-level config. Verbs: `show`, `path`, `get <p>`, `set <p> <v>`, `unset <p>`. No verb opens an interactive picker. |
| `upgrade` | Pull the latest sov from the private repo and re-link the global binary. Pre-uninstalls + reinstalls so Bun's lockfile evicts the stale SHA. Options: `--ref <ref>` (pin to tag/branch/commit), `--dry-run` (preview commands), `--skip-uninstall` (faster but Bun's git-cache may serve a stale SHA), `--purge-cache` (wipe `~/.bun/install/cache/` first — escape hatch when Bun keeps installing an older SHA than master HEAD). `SOV_UPGRADE_URL` env var overrides the install URL for forks. |
| `profile [verb]` | Manage profile-scoped state roots under `<harness-home>/profiles/`. Verbs: `list` (table with `*` beside the active one), `show` (just the active name), `create <name>` (mkdir the profile dir), `use <name>` (pin the persisted active selection — use `default` to clear), `import-default <name>` (copy `config.json` + `credentials.json` from the unscoped root into the profile; sessions/trajectories/memory stay clean; refuses to overwrite). |
| `trace show <session-id>` | Render the operational trace at `<harness-home>/traces/<session-id>.jsonl` as a high-signal summary: header (provider/model/cwd/bundle), per-turn breakdown (provider request/response with usage + latency + TTFT, permission decisions, tool durations + output sizes), microcompact + loop_detected events, and the terminal session_end reason. |
| `eval run [--filter] [--budget] [--include-slow] [--compare] [--capture] [--replay]` | Run declarative goldens from `evals/goldens/*.golden.ts` against a live `sov` subprocess. Each golden seeds a sandbox, pipes a prompt, and evaluates code assertions (`fileExists`, `agentResponseContains`, `noToolErrors`, etc.). `evals/budget.json` is opt-in and enforces total wall-time / cost / pass-count thresholds. `--compare provider1,provider2,...` runs each golden once per provider and prints a grid. `--capture <dir>` writes a deterministic-replay fixture per golden; `--replay <dir>` re-runs goldens against captured fixtures with no LLM calls. Exit code 1 on any failure. See [Eval Suite](#eval-suite). |
| `init [--force]` | (Phase 10.8.) Bootstrap the current directory into a real harness bundle. Writes a minimal `index.yaml` + `business/README.md` (seeded from `<cwd>/README.md` when present, else a stub) + empty `harness/schemas/` + `state/` + `skills/`. Refuses to overwrite an existing `index.yaml` unless `--force` is passed. After `sov init`, running `sov` from the same directory auto-discovers the new bundle via the upward `index.yaml` walk. |
| `learning status [--project <id>]` | (Phase 13.4.) Show per-project instinct counts + confidence histogram for the current (or specified) project. |
| `learning prune [--project <id>] [--dry-run]` | (Phase 13.4.) Drop sub-threshold instincts that have exceeded their aging window. `--dry-run` lists candidates without deleting. |
| `learning export <project-id> [--output <dir>]` | (Phase 13.4.) Emit each instinct as a `.md` file into `<dir>` (defaults to `./instincts-export`). Useful for external review or archiving. |
| `cron <add\|list\|show\|pause\|resume\|delete\|run\|tick>` | (Phase 17.) Schedule fresh-session agent runs (cron / relative / interval / ISO timestamps). Per-job optional pre-agent script + chained skills + delivery target. The 60-second tick loop runs as long as a `sov` process (TUI / drive / dispatch / `sov serve`) is alive. See `docs/state/2026-05-22-phase-17-cron.md` for the design lock + `cron add --help` for flag detail. |
| `serve [--port <n>] [--host <addr>] [--provider <name>] [--model <name>] [--max-tokens <n>] [--permission-mode <mode>] [--no-cron] [--no-preflight] [-b/--bundle <path>]` | (Phase 18.) Run the OpenAI-compatible HTTP API server. Long-lived; SIGINT/SIGTERM trigger graceful shutdown. Any tool speaking OpenAI's HTTP API (Open WebUI, LibreChat, AnythingLLM, official `openai` Python/JS SDKs with a custom `base_url`) can drive the harness without code changes. API key required at boot (`SOV_OPENAI_API_KEY` env > `openaiServer.apiKey` config). See [OpenAI-compatible HTTP API (`sov serve`)](#openai-compatible-http-api-sov-serve) below for the full surface. |

## Eval Suite

`sov eval run` is the declarative golden-test runner. Each golden lives at `evals/goldens/*.golden.ts` and exports a `GoldenSpec` describing a sandbox to spin up, a prompt (or array for multi-turn), and a list of code assertions. The runner spawns a fresh `sov` subprocess per golden in an isolated tempdir (separate `HARNESS_HOME` / `HARNESS_CONFIG` / `sessions.db`), pipes the prompt + `/quit` into stdin, captures stdout/stderr, parses tool-call totals + cost from the session-summary footer, and evaluates the assertions.

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

The same primitives are exposed at the top level: `sov --capture-fixture <path>` writes a single-session fixture; `sov --replay-fixture <path>` runs a single session against one. Useful for hand-crafted reproduction scenarios outside the eval suite.

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

`sov --provider router` activates a meta-provider that picks per turn between a configured **local** lane and a **frontier** lane. Every decision lands in `<harness-home>/router/audit.jsonl` so you can prove after the fact that data only left the box on turns where you expected it to.

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
sov --provider router
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

## Multi-provider task routing (Phase 1)

A second routing layer sits above the local-model router: instead of choosing one model per turn, the **smart router** decomposes the turn into atoms and dispatches each to the cheapest sufficient cost-lane sub-agent. The bundled `delegator` agent becomes the parent's first action on every user turn when `taskRouting.enabled: true`. The delegator dispatches one or more atoms via `AgentTool` to three cost-tier sub-agents — `cheap-task`, `moderate-task`, `frontier-task` — each backed by a configured provider/model pair.

**Config schema** (`~/.harness/config.json`):

```json
{
  "taskRouting": {
    "enabled": false,
    "delegator": {
      "model": "claude-sonnet-4-6"
    },
    "lanes": {
      "cheap-task": {
        "provider": "anthropic",
        "model": "claude-haiku-4-5-20251001",
        "allowedTools": null,
        "maxTokens": null,
        "timeoutMs": 120000
      },
      "moderate-task": {
        "provider": "anthropic",
        "model": "claude-sonnet-4-6"
      },
      "frontier-task": {
        "provider": "anthropic",
        "model": "claude-opus-4-7"
      }
    }
  }
}
```

All fields are optional. Per-lane overrides are **partial** — any field omitted inherits the defaults from `src/router/lanes.ts` (`LANE_DEFAULTS`). `allowedTools: null` means inherit the parent's tool pool (minus the global exclusion set); `maxTokens: null` defers to the provider default; `timeoutMs` is positive milliseconds (default `120_000`).

**Disabled vs enabled:**

- **Disabled (default).** The B-via-D bridge baseline: the four cost-lane sub-agents (`cheap-task` / `moderate-task` / `frontier-task` / `delegator`) are still loaded into the agent registry, and the lane registry still resolves their provider/model. The parent's system prompt mentions the three cost-tier sub-agents (see `bundle-default/business/system-prompt.md` § "Cost-lane sub-agents") so the parent can opt to delegate via `AgentTool` when it sees a clean fit. No automatic decomposition — the parent stays in control.
- **Enabled (`taskRouting.enabled: true`).** The smart-router system-prompt segment from `bundle-default/prompts/smart-router.md` is injected into the parent's frozen prompt. On every user turn the parent's first action MUST be `AgentTool(subagent_type: "delegator", ...)`; the delegator decides single-shot vs. decompose-and-synthesize and returns the final response. The parent relays the delegator's `summary` field verbatim.

**The three modes the delegator picks per turn:**

| Mode | When it fires | Atoms dispatched |
|---|---|---|
| Trivial single-shot | Single claim, single lookup, conversational reply | 1 atom on `cheap-task` or `moderate-task`. **No** synthesis step. |
| Compound multi-atom | N independent sub-questions | N atoms (lanes chosen per sub-question complexity), then a final synthesis atom (lane chosen per synthesis difficulty — usually `frontier-task`). |
| Synthesis-only hard reasoning | Single hard-reasoning question ("design a permission model", "audit for security") | 1 atom on `frontier-task`. **No** synthesis step (the atom IS the synthesis). |

**Per-lane provider overrides** — mix providers freely. Example: keep delegator + synthesis on Anthropic, push cheap atoms to local Ollama:

```json
{
  "taskRouting": {
    "enabled": true,
    "delegator": { "model": "claude-sonnet-4-6" },
    "lanes": {
      "cheap-task": { "provider": "ollama", "model": "qwen2.5:7b" },
      "moderate-task": { "provider": "anthropic", "model": "claude-sonnet-4-6" },
      "frontier-task": { "provider": "anthropic", "model": "claude-opus-4-7" }
    }
  }
}
```

**Boot-time preflight.** When `taskRouting.enabled: true`, the runtime aggregates a preflight pass across every configured cost lane before binding the agent loop. The `delegator` lane is skipped (its provider/model rides the parent's existing preflight when providers align). Failures are collected into a single error so credentials can be fixed in one pass:

```text
sov: cannot start with taskRouting enabled — preflight failures:
  cheap-task     ollama/qwen2.5:7b     — connection refused: http://localhost:11434
  frontier-task  anthropic/claude-opus-4-7  — no API key (set ANTHROPIC_API_KEY or providers.anthropic.apiKey)

Set credentials or override lanes in ~/.harness/config.json.
```

Pass `--no-preflight` to skip the check (e.g. CI runs that never actually contact the lane provider).

**Phase 2 / Phase 3 pointers.** Atom-level progress events shipped in Phase 2 (see [Routing observability](#routing-observability) below). Quality escalation (the delegator promoting an atom from cheap-task to moderate-task when the cheap-lane output looks off), parent-model auto-downgrade, trivial-chat fast-path, and profile presets (`anthropic+local`, `frugal`, etc.) are Phase 2.5 work, gated on real-world soak data from Phase 2. Spend management (per-lane budget caps, monthly ceiling, escalation gates) is Phase 3, gated on Phase 2 + Phase 2.5 soak. Full design at [`docs/specs/2026-05-23-multi-provider-task-routing-design.md`](specs/2026-05-23-multi-provider-task-routing-design.md).

## Routing observability (Phase 2)

Phase 2 wraps full atom-level observability around the Phase 1 smart router. The runtime synthesizes four new SSE event types from the scheduler's delegation lifecycle — no delegator-prompt changes required — and routes them through every harness surface (TUI / `sov drive` / `sov serve`). A new `/routing-stats` slash command aggregates per-lane usage from SessionDb. Lane `timeoutMs` enforcement is now wired end-to-end. An `SOV_TASK_ROUTING_ENABLED` env override gives operators a one-shot CI toggle without editing config.

### Four new SSE event types

The runtime publishes these on the per-session event bus whenever `taskRouting.enabled: true` AND the parent's turn dispatches a delegator atom:

| Event | When it fires | Payload |
|---|---|---|
| `delegator_plan` | The delegator session starts. | `{ scheduledAtomCount?: number }` (v0 always emits `null`/`undefined`; reserved for a future delegator variant that pre-plans). |
| `delegator_atom_started` | Each atom dispatch starts. | `{ atomIndex, laneName, promptPreview }`. `atomIndex` is the synthesis closure's running counter (0-indexed). |
| `delegator_atom_complete` | Each atom completes. | `{ atomIndex, laneName, success, durationMs }`. `success: true` iff terminal === 'completed'. |
| `delegator_complete` | The delegator session completes. | `{ totalAtomCount, laneDistribution: Record<string, number> }`. |

Non-delegator child dispatches (e.g., the parent calling `explore` directly) are NOT published — the synthesis closure detects "active delegator" by `agentName === 'delegator'` and ignores everything else.

### TUI rendering

The TUI renders the events inline as compact one-liners (matching the M22 tool-call compact-line aesthetic). Glyphs: `◇` plan, `→` atom start, `✓` atom success, `✗` atom failure, `◆` delegator done. Example compound turn:

```text
◇ Delegating …
→ atom 0 on cheap-task: List the files in src/router/
✓ atom 0 on cheap-task (1234ms)
→ atom 1 on moderate-task: Summarize the test coverage matrix
✓ atom 1 on moderate-task (3142ms)
→ atom 2 on frontier-task: Synthesize a coverage-gap report
✓ atom 2 on frontier-task (4812ms)
◆ Done. 3 atoms: cheap-task=1, frontier-task=1, moderate-task=1
```

A failure path swaps the success glyph for the error glyph (`✗ atom 0 on cheap-task failed (89ms)`).

### `sov drive` rendering

The `sov drive` renderer prints plain-text bracketed lines suitable for piping into the semantic-test framework or downstream scripts:

```text
[delegator_plan] dispatching
[delegator_atom 0] starting on cheap-task: List the files in src/router/
[delegator_atom 0] complete on cheap-task (1234ms) ok
[delegator_atom 1] starting on moderate-task: Summarize the test coverage matrix
[delegator_atom 1] complete on moderate-task (3142ms) ok
[delegator_atom 2] starting on frontier-task: Synthesize a coverage-gap report
[delegator_atom 2] complete on frontier-task (4812ms) ok
[delegator_complete] 3 atoms: cheap-task=1, frontier-task=1, moderate-task=1
```

### `sov serve` side-channel SSE

The OpenAI HTTP server (`sov serve`) emits the events as `event: hermes.delegator.progress` side-channel SSE frames interleaved with the main OpenAI-shaped stream. This follows the same `hermes.*` event-name convention Phase 18 introduced for `hermes.tool.progress`. Harness-aware clients can subscribe to the side-channel name; OpenAI-spec-only clients ignore it (the unknown event name is dropped at the SSE parser layer).

Example raw SSE bytes:

```text
event: hermes.delegator.progress
data: {"type":"delegator_plan","seq":1,"sessionId":"openai:abc","scheduledAtomCount":null}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk", ... ,"choices":[{"index":0,"delta":{"role":"assistant"}}]}

event: hermes.delegator.progress
data: {"type":"delegator_atom_started","seq":2,"sessionId":"openai:abc","atomIndex":0,"laneName":"cheap-task","promptPreview":"List the files ..."}

...

event: hermes.delegator.progress
data: {"type":"delegator_complete","seq":7,"sessionId":"openai:abc","totalAtomCount":3,"laneDistribution":{"cheap-task":1,"moderate-task":1,"frontier-task":1}}
```

### `/routing-stats` slash command

`/routing-stats` aggregates per-lane usage for the current session; pass `--all` for cross-session stats. Available in any surface that wires `getRoutingStats` into the CommandContext (TUI / `sov drive` / `sov serve` slash command surface). From headless `sov dispatch` it reports `routing-stats is not wired in this surface`.

```text
> /routing-stats
routing stats — current session

total atoms:         5
overall success:     100.0%
overall avg duration: 2.3s

per-lane breakdown
  cheap-task     3 atoms (60.0%)  — 100.0% success  — 1.2s avg
  frontier-task  1 atom (20.0%)   — 100.0% success  — 4.8s avg
  moderate-task  1 atom (20.0%)   — 100.0% success  — 3.1s avg

> /routing-stats --all
routing stats — all sessions

total atoms:         42
overall success:     95.2%
overall avg duration: 2.1s

per-lane breakdown
  cheap-task     28 atoms (66.7%)  — 96.4% success  — 1.4s avg
  moderate-task  9 atoms (21.4%)   — 100.0% success  — 2.8s avg
  frontier-task  5 atoms (11.9%)   — 80.0% success  — 5.2s avg
```

The success heuristic in v0 is `outputTokens > 0` (proxy for "atom produced an assistant message"). This is documented as a Phase 2.5 refinement candidate — a future revision will persist `terminal.reason` on the session row for a more reliable signal.

### `SOV_TASK_ROUTING_ENABLED` env override

A one-shot env-var override that bypasses the config flag. Three-way semantics:

| `SOV_TASK_ROUTING_ENABLED` | Behavior |
|---|---|
| `'1'` | Enables `taskRouting` regardless of `~/.harness/config.json`. |
| `'0'` | Disables `taskRouting` regardless of config. |
| unset / `''` / `'true'` / `'false'` / anything else | Falls through to `taskRouting.enabled` from config (default `false`). |

Useful for CI runs that want to flip routing on/off per-job without editing config:

```bash
# CI run with routing forced on:
SOV_TASK_ROUTING_ENABLED=1 sov dispatch "summarize this changelog"

# CI run with routing forced off (e.g., for byte-for-byte parity checks):
SOV_TASK_ROUTING_ENABLED=0 sov dispatch "summarize this changelog"
```

### Lane `timeoutMs` enforcement

Phase 2 wired through the R-D plumbing Phase 1 deferred. Each lane's `timeoutMs` (default `120_000` milliseconds) is now enforced end-to-end: atoms dispatched to a lane that takes longer than its configured `timeoutMs` are interrupted, the atom records `success: false` in the `delegator_atom_complete` event, and the delegator continues to synthesis with `Atom N (failed: timeout)` labeling. Configure per-lane:

```json
{
  "taskRouting": {
    "enabled": true,
    "lanes": {
      "cheap-task":    { "timeoutMs": 30000 },
      "moderate-task": { "timeoutMs": 90000 },
      "frontier-task": { "timeoutMs": 300000 }
    }
  }
}
```

The configured value is consulted in three-step precedence: lane override (via `ctx.laneRegistry.lookup(role)?.timeoutMs`) → `SubagentSchedulerOpts.perChildTimeoutMs` → `agent.maxTurns * DEFAULT_PER_TURN_TIMEOUT_MS`.

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

- **Graduate a directory into a real bundle with `sov init`.** Run from the project root; writes a minimal skeleton (`index.yaml` + `business/README.md` seeded from your repo's `README.md` if present + empty `harness/`, `state/`, `skills/`). After `sov init`, running `sov` from inside that directory discovers the bundle via the upward walk — no `--bundle` flag needed.

`sov init` refuses to overwrite an existing `index.yaml` unless `--force` is passed.

```bash
# Run sov anywhere; the default bundle backs you up:
cd /tmp
sov

# Graduate the current directory into a real bundle:
cd ~/code/my-project
sov init
sov   # picks up the new bundle automatically
```

The corpus generator inside `sov init` is intentionally minimal in v1 — it seeds `business/README.md` from the cwd's `README.md` and that's it. Richer repo-aware seeding (file-tree summary, language/framework detection, dependency inference) is queued as a separate design session.

## Profiles

A profile is a named state-root scope. `sov -p work …` (or `sov --profile=work …`) pins the run to `<harness-home>/profiles/work/` instead of `<harness-home>/`, giving it a separate `config.json`, `credentials.json`, `sessions.db`, `rate_limits/`, memory, and skills. The same machine can host disjoint setups — work, personal, lab, per-client — without aliasing.

**Activating a profile.** Two shapes:
- **Per-invocation:** `sov -p work …` — affects this run only.
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

**Locking.** Each profile has its own `<profile>/.sov.lock/` directory available as a helper for callers that want exclusivity (atomic mkdir + PID file with stale-process detection). The TUI itself does not currently acquire it — concurrent `sov` sessions on the same profile keep working.

### Scoping `HARNESS_HOME` for tests

`HARNESS_HOME` controls where the harness reads and writes all state (config, sessions, traces, trajectories, learning corpus). When driving `sov` non-interactively — for testing, eval scripts, or CI — take care that the env var actually reaches the `sov` process.

**Footgun pattern (override silently ignored):**
```bash
HARNESS_HOME=/tmp/test-home printf 'prompt\n/quit\n' | sov ...
```
Here `HARNESS_HOME` binds only to `printf`. The downstream `sov` process runs with the default `HARNESS_HOME` (typically `~/.harness/`) and silently ignores the override. Symptoms: state writes land in `~/.harness/` instead of your sandbox; expected per-test config (e.g. `learning.synthesizerEveryN: 2`) is not applied; tests that depend on isolated state appear to pass while polluting the live harness home.

**Correct patterns:**
```bash
# (a) export in the current shell — preferred
export HARNESS_HOME=/tmp/test-home
printf 'prompt\n/quit\n' | sov ...

# (b) pipe stdin from a file or heredoc, assign env only to sov
HARNESS_HOME=/tmp/test-home sov ... < input.txt

# (c) repeat the var on each command in the pipeline
HARNESS_HOME=/tmp/test-home printf 'prompt\n/quit\n' | HARNESS_HOME=/tmp/test-home sov ...
```

Pattern (a) is preferred — single assignment, unambiguous scope, works correctly in subshells. Pattern (b) avoids the pipeline entirely by redirecting stdin from a file, so the env var only needs to appear once on `sov`. Pattern (c) works but requires duplicating the var on every pipeline stage.

**Why this happens:** the `VAR=value cmd` prefix syntax binds `VAR` only to `cmd`, not to the rest of a pipeline. Each command in a pipeline runs in its own subshell with its own environment. `printf` gets the override; `sov` does not.

## Session UX

The TUI runs in **inline mode** (no alt screen) — your terminal owns the scrollback buffer, so wheel scroll, trackpad scroll, click-drag text selection, and copy/paste all work exactly like in any other terminal app. There are no in-TUI scroll keybindings; just scroll your terminal up to see prior conversation.

Visual surfaces you'll see in a normal session:

- **Splash** at startup — block-letter "SOV" logo (blue→teal→purple→pink gradient) next to a boxed info card showing version, provider/auth, model, and cwd. Printed once into terminal scrollback so it sits at the top of your history.
- **Status line** at the bottom — `<cwd>  <profile>  <model>` on the left; `$<cost>  cache <pct>%` on the right, with a cyan spinner glyph when streaming. Dim foreground (ambient metadata, not primary content).
- **Hint line** above the status — `? for shortcuts` (dim italic). Press `?` for the shortcut overlay.
- **Prompt** above the hint — rounded-border box with `▸` on the first line. Auto-grows up to 8 rows as you type or paste. Alt+Enter / Ctrl+J insert a newline; plain Enter submits.
- **Modal permission prompts** — when a tool needs approval, a yellow-bordered box overlays the screen: title, tool name, input, optional reason, and `[y] allow   [n] deny   [a] always` choices. The thinking spinner suppresses itself while the modal is up.
- **Thinking spinner** — bottom-weighted Braille glyph (`⢀⣀⡀⡄⠄⠤⠠⢠`) + animated "Thinking…" label, appears immediately above the prompt during silent waits (provider work, tool execution, post-content idle gaps).
- **User message echo** — your submission appears in scrollback as `❯ <text>`, wrapped to terminal width with hanging-indent continuation rows. Submissions above 1500 chars are truncated in the echo with a dim ` …[+N chars]` marker (the full text still ships to the model).
- **Paste abstraction** — pastes ≥ 2 lines OR ≥ 200 chars are replaced in the prompt with `[Pasted text #N +M lines]`; the real content ships on Enter. Short pastes insert verbatim.
- **Tool cards** — each `tool_result` prints a fully-expanded card into scrollback with the tool name, summary, and output. Diff renders inline for FileEdit/FileWrite. Use `/expand N` to re-render the Nth-most-recent tool's raw payload below the prompt.
- **Pre-compaction warning** — when context utilization crosses 5% below the proactive-compaction threshold, the TUI prints a one-shot `[compact] approaching threshold (ctx N% / trigger M%)`.
- **Markdown rendering** of streamed text — headings, bold, italic, inline code (light-blue file-refs auto-styled), list bullets with hang-indent continuation, blockquotes, fenced code blocks, horizontal rules. Tables print verbatim per round-3 fix (no inline-code styling inside cells — avoids ANSI cruft).
- **ESC** during a streaming turn — cancels the turn (POST `/sessions/:id/cancel`), shows `(interrupted by user)` in scrollback, returns to idle prompt. Ctrl+C still tears down the session.
- **Compaction marker** — when proactive or explicit `/compact` runs, the session pivots to a child id; a dim `─ compacted — new session <id>` line lands in scrollback.
- **Turn separator** — a dim horizontal rule between completed turns; when the model finishes with a non-`end_turn` reason, the reason follows on the next line (`⚠ max_tokens`).
- **Goodbye card** at session end — Interaction Summary (session ID, tool calls ✓/✗, success rate), Performance (wall time, agent active, API time, tool time), Tokens (total, cache, est. cost), followed by the resume command. Replaces the View instead of being in scrollback (it's the last frame the user sees).

## OpenAI-compatible HTTP API (`sov serve`)

Run the harness as a **drop-in OpenAI backend** on a stable port. Any tool that speaks OpenAI's HTTP API (Open WebUI, LibreChat, AnythingLLM, the official `openai` Python/JS SDKs with a custom `base_url`) can drive the harness without code changes. Phase 18 (shipped 2026-05-23).

### Quick start

1. Set the API key (one-shot per machine):

```bash
export SOV_OPENAI_API_KEY=$(openssl rand -hex 32)
# OR persist via config: sov config set openaiServer.apiKey <key>
```

2. Start the server:

```bash
sov serve
# listening on http://127.0.0.1:8765
#   provider=anthropic  model=claude-haiku-4-5-20251001
#   cron=on  harnessHome=/Users/you/.harness
```

3. Drive it with anything OpenAI-shaped. Bash + curl:

```bash
curl -s -H "Authorization: Bearer $SOV_OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -X POST http://localhost:8765/v1/chat/completions \
  -d '{
    "model": "harness-default",
    "messages": [{"role": "user", "content": "what files are in src/?"}]
  }'
```

Python `openai` SDK:

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8765/v1",
    api_key=os.environ["SOV_OPENAI_API_KEY"],
)
resp = client.chat.completions.create(
    model="harness-default",
    messages=[{"role": "user", "content": "what files are in src/?"}],
    stream=True,
)
for chunk in resp:
    print(chunk.choices[0].delta.content or "", end="")
```

Open WebUI quickstart: Settings → Connections → OpenAI API → add `http://localhost:8765/v1` as the base URL and the value of `SOV_OPENAI_API_KEY` as the key. The model picker auto-populates from `GET /v1/models`.

### CLI flags

| Flag | Default | Description |
|---|---|---|
| `--port <n>` | `8765` | Listening port. Env: `SOV_OPENAI_PORT`. Config: `openaiServer.port`. |
| `--host <addr>` | `127.0.0.1` | Bind host. Env: `SOV_OPENAI_HOST`. Config: `openaiServer.host`. |
| `--provider <name>` | runtime default | Provider override for the runtime: `anthropic`, `openai`, `ollama`, `openrouter`, or `router`. |
| `-m, --model <name>` | runtime default | Model override (the runtime's bootstrap model). Per-request `req.model` can override on a call-by-call basis (T9). |
| `--max-tokens <n>` | runtime default | Per-request max_tokens cap fed into `query()`. Clients may also send `max_tokens` on each request. |
| `--permission-mode <mode>` | `default` | `default` / `ask` / `bypass`. `ask` fall-throughs always auto-deny on this surface (D11). |
| `--no-cron` | (cron on) | Disable the cron tick loop. By default cron is on — long-lived `sov serve` is the natural cron host. |
| `-b, --bundle <path>` | bundled | Harness bundle root. Single bundle per server in v0 (D6/OQ3); fork multiple `sov serve` processes on different ports for multi-bundle. |
| `--no-preflight` | preflight on | Skip the provider health-check on boot. |

### Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | none | Liveness probe. Returns `{ ok: true, version }`. Exempt from auth so container orchestrators can ping it. |
| GET | `/v1/models` | Bearer | List routable models in OpenAI's standard `{ object: 'list', data: [...] }` shape. Catalog sourced from `SUPPORTED_MODELS` in `src/openai/modelResolution.ts`. |
| POST | `/v1/chat/completions` | Bearer | Chat completion. Supports both non-streaming (`stream: false` or absent) and streaming (`stream: true` → SSE) shapes. |

### Model selection (`req.model`)

- **`harness-default`** (or empty) — uses the runtime's bootstrapped provider + model. Cheap and fast (no extra resolver call).
- **Explicit name** (e.g., `claude-haiku-4-5-20251001`, `gpt-4o`, `gpt-4o-mini`) — calls `resolveProvider(family, model, { harnessHome })` per request. Each call yields fresh credentials and rate-guard state. Routing logic: `claude-*` → `anthropic` family; `gpt-*` → `openai` family.
- **Unknown name** — returns 400 with `error.type: 'invalid_request_error'` and the full supported model list in the message. No silent aliasing (D6/OQ2).

The full catalog: `harness-default`, `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`, `gpt-4o`, `gpt-4o-mini`. `GET /v1/models` surfaces this catalog directly.

### Session continuity

The OpenAI surface is **fully stateless** (D10). Each request carries its own `messages[]`; the harness does NOT re-hydrate prior history from its SessionDb. The client owns conversation continuity (which matches the OpenAI API contract — clients always send the full history on every turn).

For observability, every request creates a SessionDb row tagged `metadata.kind='openai-api'`. Send `X-Session-Id: <your-id>` to control the trace's id (otherwise a UUID is minted server-side). Server-side the row is namespaced `openai:<id>` to prevent cross-surface pollution (clients cannot inject into TUI / cron / drive session keyspace by sending an existing UUID). The response's `chatcmpl-<id>` field echoes the client-supplied id unprefixed; the `openai:` namespace is a server-side detail.

Repeat invocations against the same `X-Session-Id` APPEND new messages to the existing row (a fresh row is NOT created), but the model still sees only what the current request body carries — the row is observability, not state.

### Tools

The harness owns tool execution end-to-end. Tool invocations happen **inside** the single `/v1/chat/completions` request — the client never re-enters to satisfy a `tool_calls` callback. Clients see `tool_calls` in the assistant chunks for observability, but the response always terminates with `finish_reason: "stop"` (D9 — never `"tool_calls"`).

Tool-execution side-channel: when a tool runs mid-request, the SSE stream emits

```
event: hermes.tool.progress
data: {"tool_use_id":"<id>","output":"<text>","is_error":false}

```

alongside the standard OpenAI `data: {...}` chunks. Standard OpenAI clients ignore unknown event types per SSE spec — the side-channel is harness-aware UIs' progressive-disclosure hook without breaking SDK compatibility. The payload omits `output` when undefined and `is_error` when false (absence signals success).

Permission policy mirrors `sov drive` / cron headless: `mode: 'default'` with auto-deny `ask` fall-through. The runtime's layered allow/deny rules fire normally; only when a tool's self-check returns `ask` does the auto-deny kick in. The tool pool is filtered against `SUBAGENT_EXCLUDED_TOOLS` so `AgentTool` / cron CRUD / `task_stop` / `send_message` never appear on the OpenAI surface. Configure explicit allow rules in `<harnessHome>/settings.local.json` for tools you want the OpenAI surface to invoke.

### Abort on client disconnect

The route bridges the Web Fetch `Request.signal` (Hono's `c.req.raw.signal` on Bun.serve) to a request-scoped `AbortController`, then threads `abortController.signal` into `query()`. When the client closes its fetch context (Ctrl-C, browser tab close, `openai-python`'s `with ... as response:` exiting on exception), the controller fires; `query()` sees the signal and returns `{ reason: 'interrupted' }`; the route disposes the session in `finally`. No wasted provider tokens after the client gives up. Fast-fail path: if `c.req.raw.signal.aborted === true` at handler entry, the request short-circuits before any provider call.

### Error handling

Errors surface as OpenAI-shaped envelopes so SDK clients raise the right exception classes:

- 401 + `invalid_api_key` — bearer auth failure (missing/wrong key); `CredentialUnavailableError` from `resolveProvider`; `ProviderHttpError` 401/403; credential-related message heuristic. SDK clients raise `AuthenticationError`.
- 400 + `invalid_request_error` — malformed JSON, Zod schema validation failure, unknown model (`code: 'model_not_found'`). SDK clients raise `BadRequestError`.
- Mirror upstream HTTP status + `upstream_error` — `ProviderHttpError` / SDK-shaped errors with a `.status` field. A real provider 429 stays 429 (not 500).
- 500 + `api_error` — generic fallback for unclassified provider errors.

**Streaming caveat:** errors thrown AFTER the SSE wire has opened surface as a best-effort final-stop chunk + `data: [DONE]\n\n` rather than a JSON envelope (the wire shape doesn't allow mid-stream status changes), but the `finally` block always disposes the session.

### Configuration

Persistent config block in `~/.harness/config.json`:

```json
{
  "openaiServer": {
    "apiKey": "<your-key>",
    "port": 8765,
    "host": "127.0.0.1"
  }
}
```

Env vars: `SOV_OPENAI_API_KEY`, `SOV_OPENAI_PORT`, `SOV_OPENAI_HOST`. Precedence: env > flag > config > default (for port/host; the API key has no default — refuses to boot without one).

### Deployment

v0 expectation: keep `sov serve` running in a long-lived terminal pane, a launchd plist, or a systemd service. If the process exits, both the OpenAI surface and any cron jobs go silent. Localhost-only by default (`127.0.0.1`); set `--host 0.0.0.0` to expose on a LAN — but put a reverse proxy with TLS in front since the API key travels in cleartext on the wire.

## Remote gateway (`sov gateway`)

Run the harness's **native HTTP+SSE protocol** as a long-lived, remote-reachable, authenticated server. This is the *rich, interactive* protocol the Go TUI / `sov drive` already speak — turns, streaming output, tool events, **permission prompts**, slash commands, and skills — not the stateless OpenAI completion surface (`sov serve`, above). It's the first piece of the run-anywhere roadmap (`docs/specs/2026-06-05-run-anywhere-harness-roadmap-design.md`, Phase A); it lets any remote UI (a web app, an iOS app, a custom client) drive a full session over the network.

`sov gateway` is distinct from the default `sov` launch: the default forks `sov-tui` next to a per-invocation loopback server, whereas `sov gateway` is a headless, standalone, always-on server with no TUI. The TUI / `sov serve` / `sov drive` surfaces are unchanged.

### Quick start

```bash
# Local (loopback) — no token needed:
sov gateway
# sov gateway: listening on http://127.0.0.1:8766
#   provider=anthropic  model=claude-haiku-4-5-20251001
#   auth=off  cors=off  harnessHome=/Users/you/.harness

# Exposed — a token is REQUIRED off-loopback (refuses to boot otherwise):
export SOV_GATEWAY_TOKEN=$(openssl rand -hex 32)
sov gateway --host 0.0.0.0 --port 8766
```

Drive it from a remote client. All `/sessions/*` calls (including the SSE event stream) carry `Authorization: Bearer <token>`:

```bash
# Probe liveness (no auth):
curl -s http://HOST:8766/health

# Open a session, then stream its events + post a turn:
curl -s -H "Authorization: Bearer $SOV_GATEWAY_TOKEN" \
  -X POST http://HOST:8766/sessions
# → { "sessionId": "<id>", ... }

curl -s -N -H "Authorization: Bearer $SOV_GATEWAY_TOKEN" \
  http://HOST:8766/sessions/<id>/events          # SSE: text_delta, tool_use_start, permission_request, turn_complete, ...

curl -s -H "Authorization: Bearer $SOV_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST http://HOST:8766/sessions/<id>/turns \
  -d '{"text":"what files are in src/?"}'
```

A `permission_request` event over the SSE stream is answered by `POST /sessions/<id>/approvals/<approvalId>` (the same protocol the TUI uses) — the rich interactive round-trip works end-to-end over the network.

### CLI flags

| Flag | Default | Description |
|---|---|---|
| `--host <addr>` | `127.0.0.1` | Bind host. Env: `SOV_GATEWAY_HOST`. Config: `gateway.host`. Off-loopback requires a token (see Security model). |
| `--port <n>` | `8766` | Listening port (distinct from `sov serve`'s 8765). Env: `SOV_GATEWAY_PORT`. Config: `gateway.port`. Validated to `[1, 65535]` — the gateway fails fast (stderr + exit 1) on `0`, `70000`, `-1`, or garbage like `8080x` rather than silently binding a random/clamped port. |

There is no `--cors-origins` flag yet — set the CORS allow-list in `config.json` (`gateway.corsOrigins`); see Configuration and "Driving the gateway from a browser" below.

### Endpoints

The gateway serves the existing native session routes. Auth (when a token is configured) gates everything under `/sessions/*`, including the SSE event stream; `/health` is always open. The `Status` column is the success code — use `res.ok` in clients, not `res.status === 200`, since the surface uses `201`/`202`/`200` deliberately.

| Method | Path | Auth | Status | Description |
|---|---|---|---|---|
| GET | `/health` | none | 200 | Liveness probe (`{ ok, version }`). Exempt from auth so orchestrators can ping it. |
| POST | `/sessions` | Bearer | **201** | Open a session → `{ sessionId, createdAt }`. |
| GET | `/sessions/:id/messages` | Bearer | 200 | Stored message backlog → `{ messages: [{ role, content }] }`. Hydrate UI on resume. |
| GET | `/sessions/:id/events` | Bearer | 200 | SSE event stream (`text_delta`, `tool_use_start`, `permission_request`, `turn_complete`/`turn_error`, …). Ends per turn — see "re-subscribe per turn" below. |
| POST | `/sessions/:id/turns` | Bearer | **202** | Submit a turn → `{ accepted: true }`. Body `{ text }` (prose) or `{ text: "/name args", kind: "skill" }` (server-side skill expansion). Fire-and-forget: events arrive on the SSE stream. |
| POST | `/sessions/:id/approvals/:requestId` | Bearer | 200 | Answer a permission prompt → `{ ok: true }`. Body `{ approved: boolean, always?: boolean }`. `:requestId` is the `requestId` from the `permission_request` event. |
| POST | `/sessions/:id/cancel` | Bearer | 200 | Cancel the in-flight turn → `{ cancelled }`. |
| POST | `/sessions/:id/compact` | Bearer | 200 | Compact the session's history (manual microcompaction). |
| GET | `/sessions/:id/commands` | Bearer | 200 | List available slash commands. |
| POST | `/sessions/:id/commands` | Bearer | 200 | Dispatch a slash command. |
| GET | `/sessions/:id/skills` | Bearer | 200 | List installed skills. |
| POST | `/sessions/:id/skills/install` | Bearer | 200 | Install a skill into the session. |

Errors are structured JSON (`{ error: "…" }`): a malformed/empty JSON body on `/turns` or `/approvals` returns **400** (not 500), an unknown session id returns 404, and a missing/invalid bearer token returns 401. (The full route set is the native protocol in `src/server/routes/`; the gateway adds auth + CORS middleware in front of it without changing the routes themselves.)

### Configuration

Persistent config block in `~/.harness/config.json`:

```json
{
  "gateway": {
    "host": "127.0.0.1",
    "port": 8766,
    "token": "<bearer-token>",
    "corsOrigins": ["https://app.example.com"]
  }
}
```

Env vars: `SOV_GATEWAY_HOST`, `SOV_GATEWAY_PORT`, `SOV_GATEWAY_TOKEN`. Resolution precedence:

- **host** — `--host` > `SOV_GATEWAY_HOST` > `gateway.host` > `127.0.0.1`
- **port** — `--port` > `SOV_GATEWAY_PORT` > `gateway.port` > `8766`. The resolved value is validated to an integer in `[1, 65535]`; anything else (`0`, `70000`, `8080x`) is a fatal startup error.
- **token** — `SOV_GATEWAY_TOKEN` > `gateway.token` (trimmed; empty → no token)
- **corsOrigins** — `gateway.corsOrigins` (default `[]` = no cross-origin / same-origin only). **Config-only — there is no CLI flag or env var for it yet**; set it in `config.json`.

`corsOrigins` is an allow-list of browser origins. When set, the gateway echoes `Access-Control-Allow-Origin` for a matching `Origin` (and only a matching one) and answers preflight `OPTIONS` with the methods/headers the protocol uses (incl. `Authorization`, `Content-Type`, `Last-Event-ID`). Required for browser clients (the reference web UI is Phase C of the roadmap).

### Driving the gateway from a browser

The gateway is genuinely browser-drivable — this has been validated live, cross-origin, against a real model, with a tool-use/permission round-trip streaming end to end. But there are a few realities a client author must know up front; they are not obvious, and the first one bites everyone.

**The browser `EventSource` API cannot consume the SSE stream.** `EventSource` cannot set an `Authorization` header, and every `/sessions/*` route — including `GET /sessions/:id/events` — is bearer-gated, so an `EventSource` connection just gets a **401**. There is no query-param-token escape hatch. **Consume the SSE stream with `fetch()` + a `ReadableStream` reader instead**, which lets you send the bearer header and parse the `event:` / `id:` / `data:` frames yourself. This is the single most important thing to get right.

A few more realities, all confirmed live:

- **Use `res.ok`, not `res.status === 200`.** `POST /sessions` returns **201**, `POST /sessions/:id/turns` returns **202**, and approvals return **200**. A client that hard-codes `=== 200` will treat session-create and turn-submit as failures.
- **Re-subscribe per turn.** The SSE stream **ends** when `turn_complete` (or `turn_error`) arrives — the reader's `read()` returns `done`. A multi-turn client opens a fresh `fetch('/sessions/:id/events', …)` for each turn (open the stream, post the turn, read to completion, repeat). Reconnect-with-replay across a single long-lived stream is Phase B; today the lifecycle is per-turn.
- **CORS.** Set `gateway.corsOrigins` to your web app's exact origin(s) (e.g. `["https://app.example.com"]`, or `["http://localhost:5173"]` in dev). The gateway then handles the preflight `OPTIONS` and allows the `Authorization`, `Content-Type`, and `Last-Event-ID` request headers. It echoes the exact origin back — never `*` — so the allow-list must match the browser's `Origin` byte-for-byte (scheme + host + port).
- **Permission modes.** Under the `default` permission mode, the read-only shell-command allow-list (`echo`, `ls`, `cat`, `pwd`, `grep`, `find`, `git status`, … — these resolve as virtual *read* operations) is auto-allowed, so **not every command prompts**. A turn like "list the files in src/" can complete with no `permission_request` at all, while a write or an arbitrary command does prompt. Operators exposing the gateway should understand the *effective* policy (mode + the rule layer in `settings.json`), not assume every action surfaces an approval.

The canonical browser client flow — open a session, stream its events with the bearer header, submit a turn, and approve any permission prompt:

```js
const BASE = 'https://host:8766';
const TOKEN = '…';                       // the gateway bearer token
const authHeaders = { Authorization: `Bearer ${TOKEN}` };

// 1) Open a session (201, not 200).
const created = await fetch(`${BASE}/sessions`, { method: 'POST', headers: authHeaders });
if (!created.ok) throw new Error(`open session: ${created.status}`);
const { sessionId } = await created.json();

// Stream this turn's events. EventSource can't send Authorization → 401,
// so read the SSE body manually with a ReadableStream reader. Resolves when
// the turn ends (turn_complete / turn_error); call it again for the next turn.
async function streamTurn(onEvent) {
  const res = await fetch(`${BASE}/sessions/${sessionId}/events`, { headers: authHeaders });
  if (!res.ok) throw new Error(`events: ${res.status}`); // 401 if EventSource were used
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;                                     // stream ends per turn
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {           // frames are \n\n-delimited
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const type = frame.match(/^event:\s*(.*)$/m)?.[1];
      const data = frame.match(/^data:\s*(.*)$/m)?.[1];  // also: id: <seq> for Last-Event-ID
      if (type && data) onEvent(type, JSON.parse(data));
    }
  }
}

// 2) Start streaming, then 3) submit the turn (202).
const streamDone = streamTurn(async (type, ev) => {
  if (type === 'text_delta') process.stdout.write(ev.text);
  // 4) On a permission prompt, approve it (200) so the turn unparks.
  if (type === 'permission_request') {
    await fetch(`${BASE}/sessions/${sessionId}/approvals/${ev.requestId}`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    });
  }
});
const turn = await fetch(`${BASE}/sessions/${sessionId}/turns`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: 'what files are in src/?' }),
});
if (!turn.ok) throw new Error(`turn: ${turn.status}`);   // 202 = accepted
await streamDone;
```

### Security model

Exposing the gateway exposes a **tool-running agent** — read this before binding off-loopback.

- **Loopback by default.** The default host is `127.0.0.1`, so out of the box the gateway is reachable only from the same machine, exactly like the per-invocation TUI server. On loopback, a token is optional (back-compat).
- **Refuse-to-boot when exposed without auth.** If the resolved host is **not** loopback (anything other than `127.0.0.1` / `::1` / `localhost` / the `127/8` block) **and** no token is configured, `sov gateway` hard-exits (exit 1) with an actionable message and never binds. There is no anonymous off-loopback mode.
- **Bearer auth on every `/sessions/*` route, including the SSE stream.** Requests without a valid `Authorization: Bearer <token>` get 401. The compare is constant-time; the token is never logged or printed (the boot banner shows only `auth=on`/`off`).
- **`/health` is open** so liveness probes don't need the token.
- **CORS is closed by default** and opens only to the exact origins you allow-list (exact-origin echo, never `*`).
- **Effective permission policy ≠ "every action prompts".** Under the `default` mode the read-only shell allow-list (`echo`, `ls`, `cat`, …) auto-resolves as virtual reads, so those never raise a `permission_request`. The policy that actually governs a remote session is the combination of the permission *mode* and the *rule layer* (`settings.json` allow/ask/deny) — reason about that combined surface, not the prompt stream alone.
- **One token = one full-access principal.** Whoever holds the token gets the harness's **full tool powers** (Bash, file edit, web) under whatever permission policy is configured — there is no per-principal scoping yet (multi-user identity + authz is Phase E of the roadmap). **When you expose the gateway, run it behind a constrained permission policy** (a tightened `settings.local.json` allow/deny set, ideally a dedicated bundle) rather than a dev machine's broad `allow Bash(*)`. As with `sov serve`, put TLS (a reverse proxy) in front since the token travels on the wire.
- **Robust to bad input.** Malformed/empty JSON bodies on `/turns` and `/approvals` return a structured **400** (not a 500 with a stack), an out-of-range/garbage port fails fast at startup, and SIGINT/SIGTERM aborts in-flight session turns before closing the database — a clean shutdown even mid-turn.

### Deployment

Keep `sov gateway` running in a long-lived pane, a launchd plist, or a systemd service (a supervised always-on host is Phase D of the roadmap). SIGINT/SIGTERM trigger a graceful shutdown (`server.stop()` + `runtime.dispose()`). The cron tick runs inside the runtime lifecycle here too, so a long-lived gateway is also a cron host.

## Themes

The Go TUI resolves built-in themes by name: `dark` (Catppuccin Mocha — the default), `light` (Catppuccin Latte), `tokyo-night`, and `sovereign`.

```bash
/theme            # opens picker (TTY only)
/theme light      # switches inline + persists to ~/.harness/config.json
/theme tokyo-night
/theme dark       # back to default
```

User themes load from `<harness-home>/themes/<name>.toml` (TOML) at startup and appear in the picker by filename. The `NO_COLOR` environment variable is honored at startup (disables ANSI color, per the standard convention) without changing your saved config — useful for CI / piped output.

`/theme` sets the **interactive Go TUI** theme (persisted as the top-level `theme` config field). CLI-output surfaces (`sov config`, `sov drive`) use a separate, smaller TS theme — the `ui.theme` config field, whose built-ins are `dark` / `light` / `no-color`.

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

Bare `sov config` opens the branded Bubble Tea config TUI — the same surface `/config` (or `/settings`) opens in-session (2026-05-24 config UX rebuild). It's a hierarchical drill-in menu: a curated catalog of ~10 groups (plus per-provider subgroups) covering every field in the settings schema, each row showing its current value and a badge — `✓ live` for settings that apply immediately, `⟳ next session` for those that need a restart. Enter edits a field: enum and boolean fields open a sub-picker; string, number, and secret fields open an inline editor (secrets masked). Every edit is validated against the settings schema before writing; on a validation failure the editor re-opens with your typed value preserved and the error shown as the subtitle so you fix it in place. The scriptable `show` / `path` / `get` / `set` / `unset` verbs remain as escape hatches.

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
| `ui.theme` | enum | `dark` | TS CLI-output theme (`sov config` / `sov drive` chalk output): `dark` \| `light` \| `no-color`. Distinct from the interactive Go TUI theme — that's the top-level `theme` field, set via `/theme`. `NO_COLOR` env overrides. |
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
| `learning.recall.enabled` | bool | `true` | (On by default as of v0.6.16.) When on, recall splices matching instinct lessons in front of the latest user message each turn. Fail-open and a no-op when the corpus is empty, so it's byte-identical for sessions with nothing to recall. Set `false` to opt out. |
| `learning.recall.maxLessons` | int > 0 | `8` | cap on how many lessons recall surfaces per turn |
| `learning.recall.tokenBudget` | int > 0 | `1200` | cap on the injected recall snapshot size |
| `learning.evidenceSaturation` | num > 0 | `13` | (Learning-loop spike Phase 1.) τ for the saturating confidence curve — ~6 obs clears the 0.3 prune floor, ~20 clears the 0.7 promotion gate |
| `learning.synthesizeOnSessionEndAfter` | int > 0 | `10` | (Learning-loop spike Phase 1.) trigger end-of-session synthesis once ≥ N new observations have accrued |

## Learning recall

(Learning-loop spike Phase 1.) The learning loop is closed: instincts synthesized from prior sessions can be **recalled** in front of the agent on a later turn. Recall is a deterministic, in-context injection — it reads the project's instinct corpus, ranks lessons by trigger overlap with the latest user message and confidence, fits them to a token budget, and prepends a fenced `<learned-context>` snapshot to the latest user message (mirroring the MEMORY.md injection). No model call; no auto-promotion. Subsystem detail lives in [`docs/architecture.md`](architecture.md) ("Learning Layer — the four-port contract").

Recall is **on by default** (as of v0.6.16 — founder decision 2026-06-04, after the spike's Q1 cleared its bar). It stays fail-open and is a no-op when the instinct corpus is empty, so a fresh harness with nothing learned yet behaves byte-identically. Recall is wired on the turns route (TUI / `sov serve` / `sov drive`). Opt out, or tune the knobs, per the config table above:

```bash
sov config set learning.recall.enabled false    # opt out of per-turn recall
sov config set learning.recall.maxLessons 5      # surface at most 5 lessons/turn
sov config set learning.recall.tokenBudget 800   # cap the injected snapshot
```

Two more knobs improve **synthesis yield** (how many instincts the corpus actually produces): `learning.evidenceSaturation` shapes the confidence curve so real-world evidence counts reach usable confidence, and `learning.synthesizeOnSessionEndAfter` triggers a synthesis pass at session end once enough new observations have accrued. Both are optional overrides; their defaults are baked into the runtime.

### The recall eval (`bun run eval:learning`)

The with-vs-without correctness-flip eval proves a lesson available in session N changes behavior in session N+1 with no human in the loop. It runs two arms per scenario (recall off, then recall on) through the semantic driver and scores correctness flips (baseline fails → with-learning passes) and tool-call efficiency.

```bash
bun run eval:learning
```

It has two tracks: **Track A** — curated, non-derivable scenarios with seeded instincts (isolates recall→behavior; the gate); **Track B** — the full loop end-to-end (session N observations → real synthesis → instinct → session N+1 recall). The eval drives the live `sov` binary and uses the semantic judge, so it needs an `ANTHROPIC_API_KEY` (or `~/.harness/config.json` credentials) and is not part of `bun test`. The deterministic wiring is separately proven without LLM variance in `tests/server/turns.recall.test.ts`; a CI-visible recall-behavior signal mirrors the scenarios in `tests/semantic/suites/24-learning-recall.cases.ts`. Phase 1 verdict: **PASS — 6 flips / 0 regressions.**

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

Every turn is saved to `~/.harness/sessions.db` by default. When the session exits, it prints a resume command:

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

When the model runs a tool, the TUI prints a one-line summary under the `[tool: name input]` header by default — `└─ ok · 663 lines, 22.7K chars` for success, `└─ error · ...` (red) for failure. The full tool output stays available to the model but doesn't dominate your conversation view.

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
| `/resume` | Picker over recent sessions; prints the resume command for a fresh session. (TTY only.) |
| `/stats` | Mid-session metrics card (mirrors the goodbye summary shape). |
| `/quit` (`/exit`, `/q`) | Exit the session after printing the summary. |

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
| `/theme [<name>]` | Picker over built-in themes (`dark`, `light`, `tokyo-night`, `sovereign`); inline arg skips picker. Persists to config. |

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
HARNESS_REDACTION=off sov
```

Source: `src/permissions/secretRedactor.ts` (detector), `src/permissions/inputTransformer.ts` (wrapper), `src/permissions/redactSecretsTransformer.ts` (Write/Edit/NotebookEdit field bridge).

### Shell Command Virtual Tool Mapping

Read-only Bash commands automatically resolve against `Read` permission rules. If your allow rules include `Read` or `Read(*.ts)`, then `Bash("cat src/main.ts")` runs without prompting because the shell AST analyzer classifies `cat` as a read operation. Write and edit commands (`cp`, `rm`, `chmod`, etc.) do not benefit from this — they still follow Bash-specific rules. Command substitution (`$(...)`, backticks) is always treated as unsafe and requires explicit Bash rules.

When a prompt is required, the TUI renders a yellow-bordered modal:

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

Type `! <command>` at the input prompt to run the rest as a bash command with your TTY inherited. This is the explicit escape hatch for cases `BashTool` can't handle: `sudo`, TouchID, pagers, interactive editors. The harness does not capture inline-shell output for the model — you typed `!` to do something for yourself, not to feed state to the agent.

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

### Managing skills from the TUI (M11.17)

| Command | Behavior |
|---|---|
| `/skills` (or `/skills list`) | Lists currently-visible skills + a cheatsheet of the verbs below |
| `/skills install <path>` | Installs from a local path. `<path>` may be a `SKILL.md` file or a directory containing one. Reads the skill's `name:` from frontmatter and installs to `$HARNESS_HOME/skills/<name>/`. Refuses to overwrite an existing skill of the same name. |
| `/skills uninstall <name>` | Removes `$HARNESS_HOME/skills/<name>/`. Only touches user-installed skills; bundle and default-bundle skills are read-only. |
| `/skills reload` | Re-reads the skill cache without restarting the session. Useful after dropping a file in manually or running install/uninstall in another session. |

Install/uninstall touch only the user skills root (`$HARNESS_HOME/skills/`). Bundle skills, agent-created skills (nested under `agent-created/`), and default-bundle skills are not affected. After install the cache auto-refreshes so the new skill is immediately available in the autocomplete popup and as a `/<name>` dispatch.

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

When microcompaction fires, the TUI prints `[cleared N stale tool results, ~XK tokens]`. Set `"enabled": false` to disable.

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

Use `/rollback` to switch the active session back to the parent:

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

Run with stricter permission prompts:

```bash
sov --permission-mode ask --bundle ~/code/sovereign-ai-docs
```

Run locally through Ollama:

```bash
sov --provider ollama --model qwen2.5:3b --bundle ~/code/sovereign-ai-docs
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

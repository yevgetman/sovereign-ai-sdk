# Hermes loop — reference snapshot

Status: reference. Not a spec. Not a decision to adopt Hermes.
Written: 2026-10-06
Checkout: `~/code/hermes-agent` at `e97923c38acb` (2026-10-06, MIT, Nous Research)
Apex lock: `~/code/me/ops/sov-headless-loop.md`

This file points at the Hermes source. It does not copy it. Open the cited file when you need the body.

---

## What the loop is

Hermes runs its own agent loop in Python. A turn calls a model over HTTP, runs tool calls inside the Hermes process, appends the results, and calls the model again. The vendor coding apps (Claude Code, Codex, Grok) do not own that cycle.

One bypass exists. If `api_mode == "codex_app_server"`, the turn is handed to a `codex app-server` subprocess. That switch is off unless set. There is no matching bypass for Claude or Grok.

License of the loop: `LICENSE` at the repo root (MIT). The loop is in the tree. Nous Portal (the hosted model router, bill, and hosted tools) is not.

## One turn, in order

Admission sits in front of the cycle.

| Step | Where | What it does |
|---|---|---|
| Admit the turn | `agent/turn_facade.py` (`TurnFacadeMixin.run_conversation`, module doc at the top) | Takes a cross-process turn lease, then forwards into the cycle. |
| Build loop state | `agent/conversation_loop.py` around the `_LoopState(...)` call just above the `while` | Resets per-turn flags. The gateway reuses agent objects, so this state must not leak into the next message. |
| Optional Codex bypass | same file, the `api_mode == "codex_app_server"` block immediately above the `while` | Hands the whole turn to `agent/transports/codex_app_server_session.py`. On failure, `agent/turn_recovery.py` (`activate_codex_app_server_fallback`) can fall back into the generic cycle. |
| Cycle | `while (s.api_call_count < agent.max_iterations and agent.iteration_budget.remaining > 0)` | Stops on a text answer, a step budget, an interrupt, or a hard error. |
| Each iteration | `_run_phase(...)` calls in that `while` | `begin_iteration` → `prepare_iteration` → `assemble_api_request` → `run_preflight_gate` → `announce_api_call`. |
| One model call | `_run_api_retry_loop` in the same file | `nous_rate_limit_guard` → `build_api_request` → `perform_api_call` → `check_api_response`. Retries live here. |
| The HTTP call itself | `agent/turn_api_call.py` (`perform_api_call`) | Streaming decision, middleware, the actual client call. |
| Branch | the `run_tool_round if s.assistant_message.tool_calls else finish_text_response` line | Tool calls continue the cycle. Text ends the turn. |
| Close | `agent/turn_finalizer.py` (`finalize_turn`), called after the `while` | Writes the turn result. |

The phase functions are the durable map. Read `conversation_loop.py` from `_LoopState` through the end of the `while`. Do not paste that function into a new spec.

## How a model call is authenticated

The cycle does not care which company is on the other end. A provider profile sets `api_mode`, the base URL, and the auth type. Three modes matter for the subscription question:

| Profile | File | Mode | Auth | Endpoint the client uses |
|---|---|---|---|---|
| `openai-codex` | `plugins/model-providers/openai-codex/__init__.py` | `codex_responses` | OAuth (ChatGPT login) | `https://chatgpt.com/backend-api/codex` |
| `anthropic` | `plugins/model-providers/anthropic/__init__.py` (`AnthropicProfile`, `api_mode="anthropic_messages"`) | Anthropic Messages | API key **or** a Claude Code OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`) | `https://api.anthropic.com` |
| `xai` | `plugins/model-providers/xai/__init__.py` | Responses API | API key, or the OAuth bearer from the SuperGrok / X Premium+ login | `https://api.x.ai/v1` |

Subscription behavior, including the plan limits Hermes documents, is in `website/docs/integrations/providers.md` (the "Logging in with your provider subscription" table). The xAI login flow is `website/docs/user-guide/features/xai-grok-oauth.md`.

Claude is the one that impersonates a coding product on the wire. `agent/anthropic_adapter.py` stamps Claude Code identity (user-agent and beta headers, and a Claude Code system-prompt shape) so a Max plan accepts the call. It shells out only to read the `claude` version string for that user-agent. It does not run `claude -p` for the turn. Search that file for `CLAUDE_CODE_SYSTEM_PROMPT` and `_claude_code_oauth_identity_headers`.

Most non-Anthropic providers go through an OpenAI-SDK client (`agent/agent_runtime_helpers.py` builds `OpenAI(...)`). Anthropic uses `sdk.Anthropic(...)` in `agent/anthropic_adapter.py`.

## Tools, and what the model is forced to see

Tool bundles are named toolsets. Every tool belongs to one. A session, a platform, or a CLI flag enables a set.

- Registry and the always-loaded core list: `toolsets.py`, `_HERMES_CORE_TOOLS` at the top of the file. That list includes shell, files, web, a large browser set, memory, cron, kanban, and `computer_use`.
- Named bundles (`web`, `file`, `terminal`, `debugging`, `coding`, platform presets such as `hermes-cli`): the `TOOLSETS` dict in the same file.
- Operator surface: `website/docs/reference/toolsets-reference.md` and `website/docs/user-guide/features/tools.md`.

Tool search is progressive disclosure for the long tail, not a pre-turn decision.

- Behavior: `website/docs/user-guide/features/tool-search.md`.
- Implementation: `tools/tool_search.py`. The header states the invariant: core tools stay direct. MCP tools, non-core plugins, and a curated cold list are replaced by `tool_search`, `tool_describe`, and `tool_call`.

So a short chat turn still receives the core schema. Search removes the long tail. It does not remove the core. Nothing in this loop asks a small classifier which bundle to mount before the main model is called. The bundle is config.

## Hardening that is part of the loop

These are the pieces worth studying. They are not a shopping list.

- **Save the tool call before it runs.** `agent/turn_tool_round.py`, the docstring on `run_tool_round`. A crash must resume from the transcript, not from memory. A failed append ends the turn instead of running the tool.
- **Retries and classified errors.** `_run_api_retry_loop` in `agent/conversation_loop.py`, plus `agent/error_classifier.py`.
- **Context compression.** Preflight gate in the `while`, and `agent/turn_preflight.py` (`compress_after_tool_results`, imported by `turn_tool_round.py`). Cap: `max_compression_attempts` on the agent (default 3, set next to `_LoopState`).
- **Step budget.** The `while` condition: `max_iterations` and `iteration_budget`.
- **Provider fallback.** The Codex app-server fallback cited above is one case. Credential-pool refresh on a 401 is reset per turn in the same preamble (`_auth_pool_refresh_counts`).

## What is product, not loop

Leave these. Kernel and Telekit already own the equivalent surface.

- Messaging gateway and platform adapters under `gateway/` and `website/docs/user-guide/messaging/`.
- Desktop shell: `apps/desktop/` (`package.json` `"private": true` is an npm flag, not a closed-source flag; the source is in the tree).
- Cron, kanban, voice, image and video tools: entries in `_HERMES_CORE_TOOLS` and `TOOLSETS`.
- Nous Portal: `website/docs/integrations/nous-portal.md`. The client is in the repo. The service is hosted.

Programmatic entry points, for comparison only: `website/docs/reference/cli-commands.md` describes `hermes -z` (one prompt in, final text out) and `hermes chat -q`. Both still boot the Hermes app.

## Read next

- `docs/02-architecture/sov-loop-as-built.md` — the loop this repo already has.
- `docs/02-architecture/hermes-to-sov-gap.md` — the delta. Not a spec.
- `~/code/me/ops/sov-headless-loop.md` — the locked choice.

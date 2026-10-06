# Hermes → SOV gap

Status: gap report. **Not a spec. Not a plan. Do not implement from this file.**
Written: 2026-10-06
Apex lock: `~/code/me/ops/sov-headless-loop.md`

A later spec should be able to start from this page and from the two source maps it cites. This page stops at "what would have to change" and "what a spec must still decide."

---

## The gap that matters

Kernel needs a headless turn that does not boot Claude Code, Codex, or Grok Build, and that can use the Owner's ChatGPT, Claude Max, and SuperGrok logins.

SOV already has the loop (`packages/sdk/src/core/query.ts`) and the in-process call (`packages/sdk/src/agent/createAgent.ts`). Hermes already has the three logins and a fatter, more defensive cycle (`~/code/hermes-agent`, map in `hermes-loop-reference.md`). The work is to close three holes in SOV. It is not to port Hermes.

## Delta

| Need | SOV today | Hermes reference | Close it by |
|---|---|---|---|
| Call the loop without a TUI or a CLI | `createAgent().run()` | `hermes -z` still boots the Hermes app | Call `run()` from Telekit. Do not add a shell-out. |
| ChatGPT subscription | No provider. OpenAI path is an API key (`packages/sdk/src/providers/openai.ts`) | `plugins/model-providers/openai-codex/__init__.py`, mode `codex_responses`, OAuth, `chatgpt.com/backend-api/codex` | A new provider on the `LLMProvider` port. The cycle stays `query()`. |
| Claude Max subscription | `packages/sdk/src/providers/anthropic.ts` is an API key. Subscription access is `src/runtime/subprocessExecutor.ts` (`claude -p`), and that path is barred from gateway and cron | `plugins/model-providers/anthropic/__init__.py` plus `agent/anthropic_adapter.py` (Claude Code identity on an HTTP call) | Extend the Anthropic provider with the OAuth identity. Leave `subprocessExecutor.ts` as the attended opt-in it already is. |
| SuperGrok / X Premium+ | No xAI provider | `plugins/model-providers/xai/__init__.py` and `website/docs/user-guide/features/xai-grok-oauth.md` | A new provider on the same port. Some SuperGrok tiers return HTTP 403 after login. The spec has to say what the caller does then. |
| Small tool schema per task | Native tools are eager (`src/tool/registry.ts`). `allowedTools` is null on the main lanes (`src/router/lanes.ts`) | Named toolsets in `toolsets.py`. Core list stays eager. `tools/tool_search.py` only hides the long tail | A closed choice **before** `provider.stream`, mapped onto `allowedTools`. Tool search stays for MCP. Do not copy the Hermes core list. |
| Survive a crash mid-tool | Session store exists. The tool call is not required to hit that store before `runTools()` | `agent/turn_tool_round.py`, docstring on `run_tool_round` | One ordering rule in the cycle: persist the tool call, then run it. A failed persist ends the turn. |
| Bound a runaway turn | `maxTurns` in `query()` and the loop detector | `max_iterations`, `iteration_budget`, classified retries, compression (`agent/conversation_loop.py`) | Keep `maxTurns` and the detector. A spec decides whether retries and compression need to grow, and by how much. Copying Hermes's compression stack is not assumed. |

## Work a spec would have to slice

In dependency order. Names are for the spec author, not milestones.

1. **Provider port for three logins.** Each login is an `LLMProvider` (`packages/sdk/src/providers/types.ts`). The Anthropic one extends the file that already exists. The other two are new. Token storage, refresh, and what is logged are part of this slice. The Hermes adapter is the behavior reference. Do not import Hermes.
2. **Pre-turn toolset.** A closed set of bundle names. Code maps a name to tool names and passes `allowedTools` into the pool `query()` already accepts. The main turn in `assembleToolPool` learns to honor that list. MCP deferral and `ToolSearch` stay as they are.
3. **Who picks the bundle.** The apex lock says the choice happens before the main model, so a chat task does not carry coding tools. Jev is the decision model Kernel already runs for effort and model band. This report does not choose the pack, the fail-closed bundle, or whether a second model sits beside Jev. A spec has to.
4. **Persist-before-run.** One change in the tool branch of `query()` (the `tool_use` filter and the `runTools()` call). The session port to write is the existing `SessionStore`. The spec has to name the record shape.
5. **Caller.** Telekit calls `run()` and reads `RunResult`. No new CLI. `sov run` stays a human/machine CLI and is not the Kernel path.

## Explicit non-goals

- Adopting Hermes, or shelling out to `hermes -z`.
- Porting the Hermes gateway, desktop, cron, kanban, voice, or browser set.
- Turning on `codex app-server` inside SOV. That bypass hands the loop back to a coding app.
- Replacing `subprocessExecutor.ts` in the interactive sub-agent seam. It stays off by default.
- Reselling a consumer subscription. The apex lock repeats the 2026-06-22 ban.
- Building the model-router organ (`~/code/me/projects/model-router.md`). A toolset choice is not that router.

## What a spec still has to decide

These are open on purpose.

- Which Claude Max call shape is required (headers, system-prompt identity, beta flags), verified against current Anthropic terms, not copied blindly from `anthropic_adapter.py`.
- What a 403 from xAI means for the caller.
- The bundle names and the tool names inside each bundle.
- Fail-closed bundle when the pre-turn choice is missing or slow.
- Whether retries and compression are in the first slice or a later one.
- Where the OAuth tokens live on this Mac, and who may read them.

## Read next

- `docs/02-architecture/hermes-loop-reference.md`
- `docs/02-architecture/sov-loop-as-built.md`
- `docs/04-extending/extending.md` — how a provider is added today.
- `~/code/me/ops/sov-headless-loop.md`

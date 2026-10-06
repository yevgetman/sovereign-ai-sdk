# SOV loop — as built

Status: current-state analysis for the headless-loop choice. Not a spec.
Written: 2026-10-06
Apex lock: `~/code/me/ops/sov-headless-loop.md`

The request lifecycle in broad strokes is still `docs/02-architecture/runtime-architecture.md`. This file is the narrower map a session needs before writing the headless-loop spec: the cycle, the tool pool, the providers, and the subscription path that exists today.

---

## The role of this loop

`createAgent().run()` is the function Kernel should call. It is in-process. It does not draw a TUI. The TUI, `sov drive`, and `sov run` are surfaces on top of the same cycle.

Two entry points are easy to confuse:

| Entry | Where | What a caller actually starts |
|---|---|---|
| `createAgent(config).run(input)` | `packages/sdk/src/agent/createAgent.ts` | The loop. One turn. Streaming events, then a `RunResult`. |
| `sov run --json --stdin` | `docs/03-cli-reference/usage.md` (the `run` row) | A one-shot machine contract. It still starts the same HTTP+SSE server path as the TUI, then exits. |

The locked choice is the first row. Shelling out to `sov run` boots an app around the loop. That is the compromise this work is trying to leave.

## One turn, in order

`createAgent` builds an `Agent`. Each `run()` merges standing config with per-turn overrides and delegates the cycle to `query()`.

1. **Resolve provider and model.** `createAgent.ts`, step 1 inside `run` (`resolveRunProvider`). A string name becomes an `LLMProvider`. A concrete provider is used as given.
2. **Seed messages.** A string becomes one user message. An array is copied. `query()` owns the history it mutates.
3. **Session id, system prompt, tools.** The following numbered steps in the same function. Tools are a pool, not a growing catalog inside the cycle.
4. **`query()`.** `packages/sdk/src/core/query.ts`. Signature and defaults are at `export async function* query`. The cycle is `for (let turn = 0; turn < maxTurns; turn++)`.
5. **One model call.** Inside that `for`: `provider.stream({ model, system, messages, tools: toToolSchemas(toolPool), ... })`. Events yield as they arrive. The assistant message is pushed onto `history`.
6. **Tool branch.** `assistant.content` is filtered to `tool_use` blocks (just after the history push). No tool calls: the turn can end. Tool calls: `runTools()` executes them and the `for` continues until `maxTurns`, an abort, or a terminal stop.
7. **Loop detector.** `LoopDetectorState` runs once per turn, before dispatch. The policy (`enforce` / `warn` / `off`) is in that same block. A throw inside the detector must not fail the turn (`guarded`).

`query()` returns a `Terminal` reason (`end_turn`, `tool_use` exhausted, `max_turns`, `interrupted`, `error`). `run()` wraps that as a `RunResult`. Read `createAgent.ts` from the `Agent` type down through the `query()` call rather than copying it.

Design principle 1 still holds: the cycle is an async generator. `docs/01-overview/design-principles.md`.

## What the model is forced to see

`assembleToolPool` in `src/tool/registry.ts` builds the pool for a context.

- Native tools are the `REGISTERED_TOOLS` array in that file. They are eager: `shouldDefer` defaults to `false` in `packages/sdk/src/tool/buildTool.ts`.
- `isEnabled(ctx)` can hide a tool. The comment on `assembleToolPool` says `ctx` is reserved for later filters (skills, permission modes). It is not a per-task bundle picker.
- MCP tools merge into the same pool. They default to `shouldDefer: true` (`DECISIONS.md` records that rule; the runtime note is `docs/02-architecture/runtime-architecture.md`, the MCP paragraph).
- `ToolSearch` is appended and closes over the deferred subset. Implementation: `packages/sdk/src/tools/ToolSearchTool.ts`. The model sees a name and a hint for a deferred tool, then asks for the schema.

So the long tail is already deferred. The native coding set is not. A chat turn still pays for shell, files, search, web, memory, skills, and delegation.

`allowedTools` exists and is unused on the main turn:

- Sub-agents and workflows pass a filtered pool (`src/cli/missionRun.ts` scopes to `agentDef.allowedTools`).
- Task lanes in `src/router/lanes.ts` set `allowedTools: null` for `cheap-task`, `moderate-task`, and `frontier-task`. Only the `delegator` lane restricts the pool, and it restricts it to `AgentTool`.

There is no named toolset registry and no pre-turn classifier.

## Providers today

All of these speak an API key or a local server. None of them is a ChatGPT, Claude Max, or SuperGrok subscription login.

| Provider | File | Notes |
|---|---|---|
| `anthropic` | `packages/sdk/src/providers/anthropic.ts` (`readonly name = 'anthropic'`) | Messages API. API key. |
| `openai` | `packages/sdk/src/providers/openai.ts` | Chat completions. API key. Subclasses cover OpenAI-compatible servers. |
| `openrouter` | same file, `this.name === 'openrouter'` branches | Same transport, different request extras (reasoning, prompt cache). |
| `ollama` | `packages/sdk/src/providers/ollama.ts` | Local. |
| `mock` | `packages/sdk/src/providers/mock.ts` | Tests. |

The provider port is `packages/sdk/src/providers/types.ts` (`LLMProvider`, `stream`). A new login is a new provider behind that port. It is not a new loop.

## The subscription path that exists, and why it is the wrong one for Telekit

`src/runtime/subprocessExecutor.ts` spawns `claude -p`. The file header states the constraint: this replaces `createAgent().run()` for one delegated sub-agent, the subprocess runs Claude Code's own loop, and the seam is `subscriptionExecutor.enabled: false` by default. It is reachable only from the interactive sub-agent seam. Cron, channels, and the gateway do not get it. Default permission mode is `bypass` because a headless `claude -p` has no approver.

The operator-facing writeup is `docs/03-cli-reference/usage.md`, the subscription-executor section. The prompt the model sees is `bundle-default/prompts/subscription-executor.md`.

That is the old compromise, sitting inside SOV: subscription access by booting a coding app. It cannot be the Telekit path. The header says so.

## What is already the right shape

- The cycle is a library call, not a TUI.
- Tools, permissions, and hooks are ports on that call (`canUseTool`, `hookRunner` on `query()`).
- Deferred MCP tools and `ToolSearch` already bound the long tail.
- `allowedTools` is the hole a pre-turn choice would fill. The main turn does not use it yet.
- Prompt caching, effort, and the loop detector are already in the cycle. Do not rebuild them.

## What is absent

- No ChatGPT Codex HTTP provider, no Claude Code OAuth identity on the Anthropic provider, no xAI OAuth provider.
- No toolset mounted from a closed choice before `provider.stream`.
- No "write the tool call to the session store before `runTools()`" rule of the kind Hermes treats as a durability invariant. Session persistence exists (`SessionStore` port; see `runtime-architecture.md`). The ordering guarantee does not.
- `sov run` is still a server boot. Fine as a CLI. Wrong as the Telekit call.

## Read next

- `docs/02-architecture/hermes-loop-reference.md` — the external reference for the three missing pieces.
- `docs/02-architecture/hermes-to-sov-gap.md` — the delta. Not a spec.
- `docs/02-architecture/runtime-architecture.md` — the rest of the runtime.
- `~/code/me/ops/sov-headless-loop.md` — the locked choice.

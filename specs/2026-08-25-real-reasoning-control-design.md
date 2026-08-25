# Real reasoning control: `off` disables, and effort is settable per turn — design

**Status:** GREEN-LIT 2026-08-25 by the CEO — *"Do number 2. The SOV harness must be able to
send actual effort to the provider for reasoning on/off, not just a suggestion. If this is a
gap in the SOV harness, we must address it on that level."* Plan:
`plans/2026-08-25-real-reasoning-control.md`.
**Date:** 2026-08-25
**Author:** the Kernel agent, appleo node, for a sovereign-ai-sdk session
**Origin:** a production tailor run on app.appleo.ai took 3m21s; 191 s of it was model time and
~90% of the 15.3K output tokens were glm-5.2 *reasoning* under `thinking.effort: low`.

---

## 0. TL;DR

On the OpenRouter lane, `effort: 'off'` **omits** the `reasoning` param. Models that reason by
default (z-ai/glm-5.x, DeepSeek R1, Qwen thinking, …) then reason anyway. `low` is advisory
for them. So the harness has no real off switch on that lane, and no way to set effort for one
turn over the gateway HTTP API.

Fix, at the harness level:
1. **`off` sends an explicit disable.** OpenRouter lane, reasoning-capable model:
   `reasoning: { enabled: false }`. Measured on glm-5.2 (2026-08-25): 0 reasoning tokens.
2. **Per-turn effort over the wire.** `PostTurnRequest.effort` (`off|low|medium|high|max`),
   validated at the boundary, wins over the session's effort for THIS turn only.
3. The appleo tailor lane posts `effort: 'off'` (env `AGENT_TAILOR_EFFORT`, default `off`).

## 1. Evidence (measured, OpenRouter, z-ai/glm-5.2, same prompt, max_tokens 400)

| request | reasoning tokens | completion tokens | answer |
|---|---|---|---|
| no `reasoning` param | 400 | 400 | **none** (hit the cap while reasoning) |
| `reasoning: { effort: "low" }` | 332 | 360 | yes |
| `reasoning: { exclude: true }` | 258 | 284 | yes (reasoning hidden, still paid) |
| `reasoning: { effort: "none" }` | 0 | 26 | yes |
| **`reasoning: { enabled: false }`** | **0** | **27** | yes |

Code: `packages/sdk/src/providers/openai.ts` `reasoningEnabled()` is false for `off`, so
`buildKwargs` adds nothing; `providers/effort.ts` `openrouterReasoningFor('off')` returns `{}`.
The `sov` local lane already solved the same problem the same way (`enable_thinking: false`).
Gateway: `src/server/routes/turns.ts` passes `effort: sessionCtx.effort` (session-wide, set by
`/effort`); `PostTurnRequest` has `model` and `instructions` per turn but no `effort`.

## 2. Design

### 2.1 Provider (openrouter lane)
- `openrouterReasoningFor(effort)` returns `{ reasoning: { enabled: false } }` for `off`.
- `buildKwargs`: for `name === 'openrouter'` and `openrouterModelSupportsReasoning(model)`,
  send the unified param for **every defined effort including `off`**. `effort === undefined`
  (host never set one) stays byte-identical (param omitted) — the preflight/legacy path.
- Non-gated models: unchanged (no param). Other lanes: unchanged (Anthropic `off` already
  means no thinking; OpenAI o-series cannot disable — documented as a known limit).
- `reasoningEnabled()` semantics unchanged (it still answers "is CoT on?" for stream parsing).

### 2.2 Gateway per-turn effort
- `packages/protocol/src/endpoints.ts`: `PostTurnRequest.effort?: string` (doc: the
  REASONING_EFFORTS vocabulary; absent ⇒ the session's effort).
- `src/server/routes/turns.ts`: validate at the boundary — absent/undefined ⇒ undefined; a
  string in `REASONING_EFFORTS` ⇒ that value; **anything else ⇒ 400**
  `{ error: 'effort must be one of off|low|medium|high|max' }` (a typo must not silently
  become "no control"). Thread `perTurnEffort` like `perTurnModel` into runTurnInBackground;
  PerTurn gets `effort: perTurnEffort ?? sessionCtx.effort`. Never mutates `sessionCtx.effort`.
- `/effort` slash command and `thinking.effort` config unchanged.

### 2.3 appleo platform
- `AGENT_TAILOR_EFFORT` env → `config.agentTailorEffort` (`off|low|medium|high|max`, default
  `off`; invalid ⇒ config load error). `TailorRunDeps.tailorEffort`; the tailor pass posts
  `postTurn(..., TAILOR_TURN_KIND, undefined, undefined, effort)`. `PostTurnBody.effort`.
  Chat keeps the gateway default (`low`).

## 3. Tests
- effort.ts: `off` ⇒ `{ reasoning: { enabled: false } }`; on-levels unchanged.
- openai.test.ts (openrouter block): gated model + `off` ⇒ body has `reasoning.enabled === false`
  and no `reasoning.effort`; undefined effort ⇒ no `reasoning` key; non-gated model + `off` ⇒
  no key; `openai` proper + `off` ⇒ unchanged.
- turns route: `effort: 'off'` on a turn ⇒ the provider request carries `effort: 'off'` while the
  session's effort stays `low`; absent ⇒ session effort; `effort: 'huge'` ⇒ 400 and no turn
  starts; invalid type ⇒ 400.
- platform: config default/validation; client body carries `effort` only when supplied
  (prefix byte-identical); run-service passes the configured effort to postTurn.

## 4. Rollout
sov commits → harness 0.6.71 / sdk 0.10.1 (additive) → build linux-arm64 → appleo runs it via
the local override immediately (pre-authorised) → **release cut staged for the CEO** → pin.
Verify with one tailor run: trace `provider_response.usage` and the turn log's thinking bytes.

## 5. Known limits (not in scope)
- OpenAI o-series/gpt-5 cannot disable reasoning; `off` there remains "omit the dial".
- `low` on binary-thinking models (GLM) means "on". A budget (`reasoning.max_tokens`) is
  possible for Anthropic/Gemini/Qwen via OpenRouter; deferred until a lane needs it.

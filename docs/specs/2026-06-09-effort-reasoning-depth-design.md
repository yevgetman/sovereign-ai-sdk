# `/effort` — reasoning-depth control (design)

**Date:** 2026-06-09
**Status:** Approved (autonomous build — no approval gate per `docs/conventions/autonomous-feature-builds.md`)
**Topic:** A native `/effort` slash command + config default that dials per-turn **reasoning depth** (extended-thinking budget), forked per provider at the adapter boundary.

---

## 1. Motivation

Claude Code, Codex, OpenCode, and Qwen Code all expose a "reasoning effort" control: a small named dial that tells the model how hard to think before replying. This harness today has the **receive** half of extended thinking fully built (it parses `thinking_delta` / `reasoning_content` and renders `thinking` blocks) but **no control half** — there is no command, no config, and the one stubbed request field (`ProviderRequest.thinking?: { budgetTokens?: number }`, `src/providers/types.ts:29`) is never populated and never forwarded.

This feature lights up that path end-to-end so a user can type `/effort high` (or set a config default) and get measurably deeper reasoning per turn, across providers.

## 2. Prior art (what the reference tools do)

| Tool | Surface | Levels | Maps to | Default |
|---|---|---|---|---|
| **Claude Code** | `/effort` cmd, `--effort`, env, `ultrathink` keyword | `low / medium / high / max` | server-side `output_config.effort` string (private beta `effort-2025-11-24`) | model-dep → API `high` |
| **Codex** (`model_reasoning_effort`) | `config.toml` key, `omx reasoning`, `-c` flag | `low / medium / high / xhigh` | OpenAI `reasoning:{ effort }` string | `high` |
| **OpenCode** | per-model `providerOptions` / variants | `none / minimal / low / medium / high / xhigh / max` | OpenAI→`reasoning_effort`; Anthropic→`thinking.budget_tokens`; Gemini→`thinkingConfig` | gpt-5: `medium` |
| **Qwen Code** | `generationConfig.reasoning` field | `low / medium / high` (+ `false`=off) | Anthropic→`budget_tokens` (16k/32k/64k); OpenAI→pass-through; Gemini→`thinkingLevel` | unset = native |

**Two invariants extracted:**
1. Effort is **named levels** (universal) and is **per-turn reasoning depth**, decoupled from the agentic tool/turn loop. None of the four scale `maxTurns`.
2. The level→wire mapping **forks per provider** — OpenAI-family reasoning models take a `reasoning_effort` *string*; Anthropic takes a `thinking.budget_tokens` *integer*.

Claude Code's newest path uses a private server-side `effort` beta unavailable over the public API, so for Anthropic we target the **public `thinking.budget_tokens` mechanism** (Qwen's mapping is the citable reference).

## 3. Design decisions

- **D1 — Scope: reasoning depth ONLY.** `/effort` controls per-turn extended-thinking depth. It does **not** touch `maxTurns` / agentic looping (a separate, already-configurable knob). Rationale: matches all four reference tools; conflating the two would surprise anyone who knows them.
- **D2 — Named levels only (no numeric override).** Vocabulary: **`off · low · medium · high · max`**. Matches Claude Code's `low/medium/high/max`, plus `off` because here effort *is* the thinking switch. No raw-token-budget argument (user-confirmed "named levels only").
- **D3 — Provider-neutral level on the request, forked at the adapter.** Add `effort?: ReasoningEffort` to `ProviderRequest`. Each transport's `buildKwargs` maps the abstract level to its own wire shape. The level — not a pre-computed budget — crosses the core→provider boundary, so each provider owns its own translation (mirrors OpenCode/Qwen).
- **D4 — Default `off` (backwards-compatible).** With no config and no command, `effort = off` ⇒ **byte-identical request to today** (no `thinking`, no `reasoning_effort`). Defaulting to anything else would silently enable extended thinking for every existing user (cost + latency + max_tokens implications). Opt-in only.
- **D5 — Per-session sticky + config default, mirroring `/model`.** `/effort <level>` mutates live `runtime.effort` (like `setModel` mutates `runtime.model`) and emits a TUI side-effect. The default comes from a new `thinking.effort` config field (settable via `/config`). Per-session, not persisted to disk by the command itself (matches `/model`'s live-mutation model; persistence is via `/config`).
- **D6 — Capability-gated, fail-soft.** If `effort != off` but the active model doesn't support reasoning, the request is sent **unchanged** (no `thinking`/`reasoning_effort`) and the command surfaces a one-line notice. Never send a thinking param to a model that will 400 on it. Mirrors OpenCode's `model.capabilities.reasoning` gate.
- **D7 — Anthropic API constraints handled at the adapter.** When thinking is enabled for an Anthropic request: (a) `budget_tokens ≥ 1024`; (b) `budget_tokens < max_tokens` — raise the request's `max_tokens` floor to `budget_tokens + RESPONSE_HEADROOM` when needed; (c) **drop `temperature`** (the API rejects `temperature != 1` with thinking enabled); (d) attach the **interleaved-thinking beta** (`interleaved-thinking-2025-05-14`) so reasoning persists across tool-use turns in this agentic harness.
- **D8 — OpenAI-wire mapping.** For `apiMode: 'openai'` reasoning models, map level → `reasoning_effort: 'low'|'medium'|'high'` (`max`→`high`, `off`→omit). For local OpenAI-wire engines (`sov`, `ollama`), additionally pass a best-effort `chat_template_kwargs: { enable_thinking: true }` when effort != off (these already surface `reasoning_content` on the receive side). Non-reasoning OpenAI models are caught by the D6 gate.
- **D9 — No Gemini path.** This harness has no Google/Gemini provider (`apiMode ∈ anthropic | openai | ollama | sov`), so the Gemini `thinkingConfig` branch the reference tools carry is out of scope.

## 4. Level → wire mapping (the core table)

Constants live in a new pure module `src/providers/effort.ts`.

| Level | Anthropic `budget_tokens` | OpenAI `reasoning_effort` | sov/ollama `enable_thinking` |
|---|---|---|---|
| `off` | — (omit `thinking`) | — (omit) | `false` / omit |
| `low` | 4_000 | `low` | `true` |
| `medium` | 8_000 | `medium` | `true` |
| `high` | 16_000 | `high` | `true` |
| `max` | 24_000 (clamped `< maxTokens` ceiling) | `high` | `true` |

- `RESPONSE_HEADROOM = 8_192`. Anthropic `max_tokens` floor when thinking on: `min(MAX_TOKENS_CEILING, max(currentMaxTokens, budgetTokens + RESPONSE_HEADROOM))`.
- `MAX_TOKENS_CEILING = 32_000` — a conservative output ceiling so the raised `max_tokens` never exceeds a 4.x model's output cap and 400s. **Implementer note (T2):** verify the actual per-model output ceilings for the harness's Anthropic models (`claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-*`) and clamp to the real value where known; fall back to `MAX_TOKENS_CEILING` when unknown. The ladder above is sized so `budget + headroom ≤ 32k` at every level.
- Budget constants are tunable in one place; documented in `usage.md`.
- The interleaved-thinking beta relaxes the strict `budget_tokens < max_tokens` rule, but raising `max_tokens` (capped) is kept as belt-and-suspenders to avoid 400s on adapters/models that still enforce it.

## 5. Types & vocabulary

```ts
// src/providers/effort.ts
export const REASONING_EFFORTS = ['off', 'low', 'medium', 'high', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const EFFORT_BUDGET_TOKENS: Record<ReasoningEffort, number>; // off→0
export const RESPONSE_HEADROOM = 8_192;
export const MIN_THINKING_BUDGET = 1_024;

export function modelSupportsReasoning(model: string, apiMode: ApiMode): boolean;
export function anthropicThinkingFor(effort, maxTokens): { thinking?, maxTokens, dropTemperature } ;
export function openAiReasoningFor(effort): { reasoning_effort?: 'low'|'medium'|'high' };
```

`modelSupportsReasoning` heuristic (allow-list by model family; unknown ⇒ false to avoid 400s):
- `anthropic`: the **4.x hybrid family supports extended thinking** — `claude-(haiku|sonnet|opus)-4` ⇒ true (this includes the harness's **default model `claude-haiku-4-5`**, so the feature works out of the box). Pre-4 families (`claude-3*`, `claude-2*`) ⇒ false.
- `openai`: `o1`/`o3`/`o4`/`gpt-5` families ⇒ true; `gpt-4*` / `gpt-3*` ⇒ false.
- `sov`: true (local reasoning engine — the lane exists to think).
- `ollama`: true (best-effort; reasoning models surface `reasoning_content`).
- **Implementer note (T1):** confirm `claude-haiku-4-5` accepts the `thinking` param against the live API during T2 adapter testing; if it rejects it, demote `haiku-4` to `false` and document. Sonnet/Opus 4.x are known-good.

## 6. Integration anchors (file:line as of HEAD)

- `src/providers/types.ts:29` — `ProviderRequest`: add `effort?: ReasoningEffort` (keep/retire the legacy `thinking?` field — see §8).
- `src/providers/anthropic.ts:87‑99` — `buildKwargs`: map `req.effort` → `thinking` + raise `max_tokens` + drop `temperature`; `stream()` (`:107‑117`) attach interleaved beta when thinking on.
- `src/providers/openai.ts:143‑158` — `buildKwargs`: map `req.effort` → `reasoning_effort`; `sov`/`ollama` add `enable_thinking`. (`sov` inherits this verbatim via `src/providers/sov.ts`.)
- `src/core/types.ts:94‑139` — `QueryParams`: add `effort?: ReasoningEffort`.
- `src/core/query.ts:47‑58` (destructure) + `:143‑152` (spread into `provider.stream({...})`) — thread `effort`.
- `src/config/schema.ts` — add `thinking: { effort: ReasoningEffort }` block, default `{ effort: 'off' }` (test the absent-parent default path — see `project_zod_nested_default_absent_parent`).
- `src/server/runtime.ts` (`buildRuntime`) — init `runtime.effort` from config `thinking.effort`.
- `src/server/commandContext.ts:148‑157` — `CommandContext`: add `effort` getter + `setEffort` (mutates `runtime.effort` + `sideEffects.effortChanged`).
- `src/commands/types.ts` — `CommandContext.setEffort?` + `effort?`; `CommandSideEffects.effortChanged?`.
- turns route (`src/server/routes/turns.ts`) — thread `effort: runtime.effort` into the `query()` params (alongside `model: runtime.model`).
- `src/commands/effortControl.ts` (NEW) — the `/effort` command (mirror `src/commands/pickers.ts`).
- `src/commands/registry.ts:57‑161` — register `effortCommand` in `COMMANDS`.
- `packages/tui/` — handle `effortChanged` side-effect (mirror `modelChanged`), per the TUI style guide (`style.S.*`).
- `src/config/catalog.ts` — surface `thinking.effort` in `/config`.

## 7. Command UX (`/effort`)

- `/effort` (no arg) → show current level + per-provider effect for the active model; if interactive, open a picker of the five levels (mirror `/model`'s `pickerOpen` card).
- `/effort <off|low|medium|high|max>` → set live; reply `effort set to <level> (...)`. If the active model doesn't support reasoning (D6), still set the state but append a notice: `note: <model> doesn't support reasoning depth — no effect until you switch to a reasoning model.`
- `/effort status` | `/effort current` → alias for the no-arg show (non-interactive form).
- Invalid arg → usage string listing the five levels.

## 8. The legacy `thinking?` field

`ProviderRequest.thinking?: { budgetTokens?: number }` is dead today. **Decision: retire it** in favor of `effort?: ReasoningEffort` (the named-levels contract). No caller sets it, so removal is safe and keeps one canonical knob. (If a raw-budget escape hatch is ever wanted, it returns as a separate advanced field — YAGNI now.)

## 9. Out of scope (v1)

- Agentic-looping control (`maxTurns`) — separate knob, already config-settable.
- Numeric / raw-token-budget argument (user chose named levels only).
- A `--effort` startup CLI flag and an env override (Claude Code has both) — deferrable; the slash command + config default cover the ask. Noted as a fast-follow.
- `ultrathink`-style magic-keyword escalation.
- Gemini `thinkingConfig` (no provider).
- Per-agent/per-lane effort (the task-router lanes could grow this later).

## 10. Backwards compatibility

`effort` defaults to `off` everywhere it is unset (config absent, `QueryParams.effort` undefined, `ProviderRequest.effort` undefined) ⇒ adapters emit the **exact same request body as today**. The only new always-present surface is the registered `/effort` command and the `thinking.effort` config field (both inert at `off`). No bundle changes.

## 11. Testing strategy

- **Unit (pure):** `effort.ts` — budget table, `modelSupportsReasoning` matrix, `anthropicThinkingFor` clamping + headroom + temperature-drop, `openAiReasoningFor`.
- **Adapter:** capture the request body from `buildKwargs` for Anthropic + OpenAI at each level (incl. `off` ⇒ byte-identical to pre-change; `max` ⇒ budget clamped under a small `max_tokens`; thinking-on ⇒ no `temperature`).
- **Plumbing:** `query()` forwards `effort` into `provider.stream` (MockProvider captures the request).
- **Config:** absent-parent default ⇒ `off`; explicit set round-trips.
- **Command:** `/effort high` mutates `runtime.effort` + emits `effortChanged`; unsupported-model notice path; invalid-arg usage.
- **Semantic:** a `tests/semantic/suites/NN-effort.cases.ts` case — `/effort high` then a reasoning-heavy prompt produces a `thinking` block / deeper answer (judge-scored, best-effort).
- **Go:** `effortChanged` side-effect decode + render.
- Gate: `bun run lint && bun run typecheck && bun run test` green (no new failures beyond the known env-only set).

## 12. Ship

Docs (`usage.md` command + config, `architecture.md` request-build note, `extending.md` if a new extension seam), testing-log entry, commit/push, `sov upgrade`, cut the next patch release (`src/` + `packages/tui/` changed).

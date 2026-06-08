# `sov` Provider · Bucket A · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Checkbox
> steps. Executes per `docs/conventions/autonomous-feature-builds.md`; model per
> `docs/conventions/subagent-policy.md`. Read the cited files first, then TDD (`bun run test`,
> `bun run lint`, `bun run typecheck`). Design: `docs/specs/2026-06-08-sov-provider-design.md`.

**Goal:** a first-class `sov` local lane that consumes what the L1 engine already emits — reasoning
separation, real tool-ids, grammar-valid JSON, thinking budget — with **zero engine changes**.

**Architecture:** add `'sov'` to the `apiMode` union + a thin `SovProvider`; put standard-OpenAI
gains (reasoning, real tool-ids) in the **shared** `OpenAIProvider` translator; put `vllm-mlx`-flavored
request kwargs (`enable_thinking`/`thinking_token_budget`, `response_format`) in `SovProvider`.
Keyless loopback default; the home for a later Bucket-B `/sov/*` control-plane.

**Tech stack:** TypeScript on Bun, `bun:test`, Biome, Zod (config schema).

---

## Investigation findings (cite while implementing)

- **Provider seam.** `apiMode: 'anthropic'|'openai'|'ollama'` union — `src/providers/models.ts:5`
  and `instantiateTransport` in `src/providers/resolver.ts`. Registry `PROVIDER_REGISTRY`
  `src/providers/models.ts:14-46`; `contextLengthFor` `:64-66`. `instantiateTransport` throws
  `CredentialUnavailableError` for anthropic/openai without a key; **ollama is keyless** (the path
  to mirror). Unknown-provider throw: `src/providers/resolver.ts:87`. Keyless `authType: 'none'`
  defaulting is ollama-special-cased in the resolver return + `numCtx` handling.
- **Shared translation target.** `OpenAIProvider.buildKwargs` `src/providers/openai.ts:111-126`
  (no thinking/response_format today); stream translation ~`src/providers/openai.ts:159-228`
  (no reasoning branch; tool-id fabricated `:180-192` as `tool_${index}`).
- **Internal events to map onto.** `{ type: 'thinking_delta'; thinking }` `src/core/types.ts:67`;
  final block `{ type: 'thinking' }` `:18`. Anthropic is the only current producer
  (`src/providers/anthropic.ts:155-157`) — match its event shape exactly.
- **Request fields already plumbed.** `ProviderRequest.thinking?: { budgetTokens?: number }`
  `src/providers/types.ts:29`; `cacheEnabled?` `:31` (leave no-op this bucket).
- **Config schema.** `ProviderConfigSchema` `src/config/schema.ts:17`; `providers` block (4 keys,
  strict) `:262-267`; `router.localProvider: z.string()` `:277`.
- **Engine contract (verified in `~/code/sovereign-ai-inference/.venv/.../vllm_mlx`).** Emits
  `reasoning_content` (msg + delta) `api/models.py:201,499`; tool ids `api/tool_calling.py:166…`;
  `ChatCompletionRequest` accepts `response_format` `api/models.py:175`, `enable_thinking` +
  `thinking_token_budget` `:191-195`. Served model name defaults to `"sovereign"`.

---

## Tasks (TDD, subagent-driven)

- [ ] **T1 — Shared translator: reasoning + real tool-ids (`src/providers/openai.ts`).**
  RED: tests that an SSE chunk with `delta.reasoning_content` yields a `thinking_delta` event (not
  `text_delta`) and a closing `thinking` block; that a `tool_calls` delta carrying `id` preserves
  it; that a missing id still falls back to the synthesized form. GREEN: add a reasoning branch to
  the stream translator and prefer `tool_calls[].id` over `tool_${index}`. Benefits the generic
  `openai`/`openrouter` lanes too — keep their existing tests green.

- [ ] **T2 — Register the `sov` provider (`models.ts` + `resolver.ts` + `config/schema.ts`).**
  RED: `resolveProvider('sov', model)` builds a **keyless** client at the loopback default and does
  **not** throw `unknown provider` or `CredentialUnavailableError`; `authType` is `'none'`. GREEN:
  add `'sov'` to the `apiMode` union; `PROVIDER_REGISTRY.sov` (`apiMode:'sov'`,
  `defaultBaseUrl:'http://127.0.0.1:8000/v1'`, `defaultModel:'sovereign'`, no `authEnvVar`);
  `instantiateTransport` branch building `SovProvider` keyless (mirror the ollama no-key path);
  `providers.sov: ProviderConfigSchema.optional()` in the schema. Confirm `normalizeProviderName`
  passes `sov` through.

- [ ] **T3 — `SovProvider` request kwargs (`src/providers/sov.ts`).**
  RED: `buildKwargs` for a req with `thinking.budgetTokens` emits `enable_thinking: true` +
  `thinking_token_budget: <n>`; a req requesting JSON emits `response_format`; a plain req emits
  neither. GREEN: `SovProvider` reusing the OpenAI translation (extend or compose `OpenAIProvider`)
  and overriding `buildKwargs` to add the two `vllm-mlx` fields. Leave `cacheEnabled` a no-op
  (documented; Bucket C).

- [ ] **T4 — Wire `sov` as the local lane (router).**
  RED: with `router.localProvider: 'sov'`, lane resolution + boot preflight
  (`src/router/preflight.ts:41-72`) succeed **keyless**. GREEN: any router-side allowlist/choice
  that constrains `localProvider` (e.g. `src/config/catalog.ts` `PROVIDER_CHOICES`) includes `sov`.

- [ ] **T5 — Live integration (gated, opt-in).**
  Gated on an env pointing at a real engine (e.g. `SOV_ENGINE_URL` / `SOV_TEST_MODEL`). Assert
  against a running L1 server: `reasoning_content` surfaces as `thinking`; tool calls carry the
  engine's `call_…` ids; `response_format` yields valid JSON; `thinking_token_budget` actually caps
  reasoning. **Pin the exact tool-call streaming shape here** (whole vs fragment) and adjust T1 if
  the live capture differs from the source read. This is the AC6-adjacent cross-repo proof.

---

## Done when

- [ ] T1–T4 green offline (`bun run test`), lint + typecheck clean; existing openai/openrouter/ollama
  tests unbroken.
- [ ] `sov` is a configurable first-class provider + local lane, keyless, loopback-default.
- [ ] T5 passes against a live engine (or is documented-skipped with the gating env).
- [ ] No engine changes in this bucket; `cacheEnabled` no-op is documented, not silently dropped.
- [ ] Testing-log updated per `docs/conventions/testing-log.md`.

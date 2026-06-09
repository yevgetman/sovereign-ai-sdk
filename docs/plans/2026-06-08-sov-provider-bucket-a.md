# `sov` Provider · Bucket A · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Checkbox
> steps. Executes per `docs/conventions/autonomous-feature-builds.md`; model per
> `docs/conventions/subagent-policy.md` (Opus — touches `src/providers/`). Read the cited files
> first, then TDD (`bun run test`, `bun run lint`, `bun run typecheck`). Design:
> `docs/specs/2026-06-08-sov-provider-design.md`.

**Goal:** a first-class `sov` local lane that consumes what the L1 engine already emits — reasoning
separation + real tool-ids — with **zero engine changes**, and the keyless seam that makes the
engine usable as the router's local lane (and the future home for the Bucket-B `/sov/*` surface).

**Architecture:** add `'sov'` to the `apiMode` union + a thin keyless `SovProvider`; put the
standard-OpenAI gain (reasoning translation) in the **shared** `translateOpenAIStream` (every
OpenAI-compatible backend benefits). **Thinking-budget + `response_format` passthrough are
deferred** — no harness caller sets them today (see the design's "what's actually sourced" table);
forwarding `undefined` is speculative.

**Tech stack:** TypeScript on Bun, `bun:test`, Biome, Zod (config schema).

---

## Investigation findings (cite while implementing)

- **Provider seam.** `apiMode: 'anthropic'|'openai'|'ollama'` union — `src/providers/types.ts:40`,
  `src/providers/models.ts:5`, and `instantiateTransport` in `src/providers/resolver.ts`. Registry
  `PROVIDER_REGISTRY` `src/providers/models.ts:14-46`; `contextLengthFor` `:64-66`.
  `instantiateTransport` throws `CredentialUnavailableError` for anthropic/openai without a key;
  **ollama is keyless** (the path to mirror). Unknown-provider throw: `src/providers/resolver.ts:87`.
- **Shared translation target.** `translateOpenAIStream` `src/providers/openai.ts:159-228`. Content
  branch `:174-178`; tool-call accumulation `:180-193` — note `:186` `if (call.id) current.id =
  call.id` **already preserves** engine ids (the `tool_${index}` at `:182` is only a no-id
  fallback). Final content blocks assembled `:198-208`. `OpenAIChatChunk.delta` type `:51-71` has
  **no** `reasoning_content` field yet.
- **Internal events to map onto.** `{ type: 'thinking_delta'; thinking }` `src/core/types.ts:67`;
  final block `{ type: 'thinking'; thinking }` `:18`. Anthropic is the current producer
  (`src/providers/anthropic.ts:155-157`) — match its event shape; thinking block precedes text in
  content ordering.
- **Keyless construction.** `OpenAIProvider` throws without a key `src/providers/openai.ts:89` and
  sends `authorization: Bearer …` `:138`. `SovProvider` must do neither when no key is set.
- **Config schema.** `ProviderConfigSchema` `src/config/schema.ts:17`; `providers` block (4 keys,
  strict) `:262-267`; `router.localProvider: z.string()` `:277`. Catalog provider choices:
  `src/config/catalog.ts` (`PROVIDER_CHOICES`).
- **Engine contract (verified in `~/code/sovereign-ai-inference/.venv/.../vllm_mlx`).** Emits
  `reasoning_content` (msg + delta) `api/models.py:201,499`; tool ids `api/tool_calling.py:166…`.
  Served model name defaults to `"sovereign"`.

---

## Tasks (TDD, subagent-driven, Opus)

- [ ] **T1 — Shared translator: reasoning + tool-id regression test (`src/providers/openai.ts`).**
  RED: tests that an SSE chunk with `delta.reasoning_content` yields a `thinking_delta` event (not
  `text_delta`) and a closing `{type:'thinking'}` block ordered before any text; **and** a
  regression test that a `tool_calls` delta carrying `id=call_abc` preserves it through to the
  `tool_use` block (proves `:186`, no fabrication). GREEN: add `reasoning_content?: string | null`
  to the chunk delta type; add a reasoning branch to `translateOpenAIStream` (accumulate, yield
  `thinking_delta`, push a `thinking` block first in the final content). Keep
  openai/openrouter tests green.

- [ ] **T2 — Keyless `sov` provider (`src/providers/sov.ts` + union + registry + resolver + schema).**
  RED: `resolveProvider('sov', model)` builds a **keyless** client at the loopback default, does
  **not** throw `unknown provider`/`CredentialUnavailableError`, and `authType === 'none'`;
  `SovProvider.stream` sends **no** `authorization` header when no key. GREEN: add `'sov'` to the
  `apiMode` union in **all three** sites (`types.ts:40`, `models.ts:5`, `resolver.ts`
  `instantiateTransport` param); `PROVIDER_REGISTRY.sov` (`apiMode:'sov'`,
  `defaultBaseUrl:'http://127.0.0.1:8000/v1'`, `defaultModel:'sovereign'`, no `authEnvVar`);
  `SovProvider` (reuses `messagesToOpenAI`/`buildKwargs`/`translateOpenAIStream`; keyless ctor;
  omit auth header when no key); `instantiateTransport` `sov` branch; `authType 'none'` default for
  `sov`; `providers.sov: ProviderConfigSchema.optional()`. Confirm `normalizeProviderName` passes
  `sov` through.

- [ ] **T4 — Wire `sov` as the router local lane.**
  RED: with `router.localProvider: 'sov'`, lane resolution + boot preflight
  (`src/router/preflight.ts`) succeed **keyless**; the catalog accepts `sov` as a `localProvider`
  choice. GREEN: add `sov` to `PROVIDER_CHOICES` / any `localProvider` allowlist in
  `src/config/catalog.ts`.

- [ ] **T4-live — Live integration (gated, opt-in).**
  Gated on an env pointing at a real engine (e.g. `SOV_ENGINE_URL`). Assert against a running L1
  server: `reasoning_content` surfaces as `thinking`; tool calls carry the engine's `call_…` ids.
  **Pin the exact tool-call streaming shape here** and adjust T1 if the live capture differs from
  the source read. Document-skip if no live engine is reachable.

> **Deferred (not this bucket):** thinking-budget + `response_format` passthrough — no harness caller
> sets them today. Revisit when the harness grows a structured-output / thinking-budget request path.

---

## Done when

- [ ] T1, T2, T4 green offline (`bun run test`), lint + typecheck clean; existing
  openai/openrouter/ollama/resolver tests unbroken.
- [ ] `sov` is a configurable first-class **keyless** provider + local lane, loopback-default.
- [ ] T4-live passes against a live engine, or is documented-skipped with the gating env.
- [ ] No engine changes; deferred passthroughs documented (not silently dropped); `cacheEnabled`
  remains a documented no-op.
- [ ] `docs/testing-log.md` updated per `docs/conventions/testing-log.md`.

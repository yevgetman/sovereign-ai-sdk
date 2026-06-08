# `sov` Provider (local Sovereign-engine lane) · Design

> Cross-repo co-design. The **L1 inference engine** (`~/code/sovereign-ai-inference`) is a
> standalone OpenAI-compatible MLX server. Its Phase-4 decision doc
> (`docs/plans/2026-06-08-phase-4-sov-seam.md` over there) ruled out a request-path proxy and
> committed to **supervise-only now, fork later**, splitting the harness↔engine wants into three
> buckets. **This design is "Bucket A": the harness-side work that needs zero engine changes** —
> a first-class `sov` provider that consumes what the engine *already emits*.

## Why

The harness's "local lane" today is Ollama or an OpenAI `baseUrl` override against a **closed**
provider registry — a `sov` name throws `unknown provider` (`src/providers/resolver.ts:87`), and
`openai` apiMode **requires** an API key (`src/providers/resolver.ts:~218`) while only `ollama` is
keyless. Meanwhile the harness is **already pre-wired** to ask for things the local adapter
silently drops: `ProviderRequest.thinking.budgetTokens` and `cacheEnabled`
(`src/providers/types.ts:29,31`) are honored for Anthropic and ignored for openai/ollama. And the
engine emits *more than the harness parses*. Bucket A closes that gap.

**Verified against the pinned engine (`vllm-mlx==0.3.0`) source — all four have real targets, no engine change:**

| Hook | Engine target (verified) | Harness gap today |
|---|---|---|
| Reasoning separation | emits `reasoning_content` on message **and** streaming delta (`vllm_mlx/api/models.py:201,499`) | openai translator has no reasoning branch → CoT contaminates `content` |
| Real tool-call ids | assigns `id=call_{uuid}` per call (`vllm_mlx/api/tool_calling.py:166…`) | harness fabricates `tool_${index}` (`src/providers/openai.ts:180-192`) |
| Grammar-valid JSON | accepts `response_format` (`vllm_mlx/api/models.py:175`) | harness never sends it; repairs client-side via `__parse_error` |
| Thinking budget | accepts `enable_thinking` + `thinking_token_budget` (`vllm_mlx/api/models.py:191-195`) | local adapter never reads `req.thinking` |

## Decision — extend the apiMode union with `sov`

`apiMode` is a typed union `'anthropic' | 'openai' | 'ollama'` (`src/providers/models.ts:5`,
`src/providers/resolver.ts instantiateTransport`). Per the founder choice (first-class provider +
shared parsing), we **add `'sov'` to the union** and a thin `SovProvider` rather than masquerade as
`openai` with a dummy key. Rationale:

- **Keyless loopback** posture (mirror the `ollama` keyless path, not openai's key-required throw) —
  no dummy-key hack.
- A real **home for Bucket B** (`/sov/*` control-plane: model identity, context length, readiness,
  capabilities, load) and any future co-design surface. Masquerading-as-openai leaves nowhere clean
  for that.
- Keeps the generic `openai` lane honest — it stays a vanilla OpenAI client.

### The shared-vs-sov split

- **Shared (`src/providers/openai.ts`), benefits every OpenAI-compatible backend:** the stream
  translator learns to map `delta.reasoning_content` → the existing `{ type: 'thinking_delta' }`
  event (`src/core/types.ts:67`; final block `:18`), and to **use the engine's `tool_calls[].id`**
  when present, synthesizing only as fallback.
- **`sov`-specific (`src/providers/sov.ts` + registry/resolver/schema), `vllm-mlx`-flavored:** a
  `SovProvider` that reuses the OpenAI translation but overrides `buildKwargs`
  (`src/providers/openai.ts:111`) to forward `enable_thinking` + `thinking_token_budget` (from
  `req.thinking.budgetTokens`) and `response_format`; registered **keyless** with a loopback
  default base.

## Scope

**In (Bucket A):** the `sov` apiMode + `SovProvider`; shared `reasoning_content`/tool-id translation;
`sov` request kwargs (thinking budget, `response_format`); registry + resolver + config-schema
wiring (`providers.sov`, `router.localProvider: 'sov'`); unit coverage + one live-gated integration.

**Out (later buckets, per the L1 decision doc):**
- **Bucket B** — `/sov/*` control-plane reads (model identity, context length, readiness,
  capabilities, load gauge, warm). Served by the engine's supervisor on a sibling port; the
  `SovProvider` is where the harness-side calls will land. *Separate plan.*
- **Bucket C** — engine request-path residue (`cached_tokens` in usage, per-token runaway abort,
  richer `stop_reason`). Forces the engine fork; **dogfood-gated**, only if AC6 proves it.
- **Prompt-cache control** is moot here: `vllm-mlx` prefix-caches automatically (no breakpoint hint
  needed). `cacheEnabled` stays a no-op on this lane until Bucket C surfaces cache-hit *telemetry*.

## Non-goals / risks

- **Not** changing the engine. If a live check contradicts a source-verified field, the engine is
  source-of-truth — re-confirm against the running server before coding around it.
- **Tool-call streaming granularity:** the engine assigns ids but may emit tool calls parsed from
  full text rather than incremental OpenAI-style fragment deltas (`vllm_mlx/api/tool_calling.py`
  `parse_tool_calls`). The translator change must handle *both* "id present on a whole tool_call"
  and the legacy fragment path — pin the exact shape with a live capture in T5.
- **Registry default model:** a single-model engine serves under its `served_model_name` (default
  `"sovereign"`); the `sov` registry `defaultModel` should reflect that, not an HF id.

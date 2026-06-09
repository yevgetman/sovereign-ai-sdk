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
`openai` apiMode **requires** an API key (`src/providers/resolver.ts` `instantiateTransport`) while
only `ollama` is keyless. Meanwhile the engine emits *more than the harness parses*: a local
reasoning model's chain-of-thought lands inline in `content` as undifferentiated text because the
OpenAI translator has no reasoning branch.

## What's actually sourced (and what isn't)

An execution-time audit corrected the original four-item scope. A passthrough is only real if the
harness has a **caller** that sets the field — otherwise it forwards `undefined` and is speculative
(YAGNI). Verified against the pinned engine (`vllm-mlx==0.3.0`) source **and** the harness call sites:

| Hook | Engine accepts | Harness caller today? | This bucket |
|---|---|---|---|
| Reasoning `reasoning_content` → `thinking_delta` | emits on msg **and** delta (`vllm_mlx/api/models.py:201,499`) | yes — turn loop consumes the stream + renders `thinking` | **BUILD** (fixes a real break) |
| Real tool-call ids | assigns `id=call_{uuid}` (`vllm_mlx/api/tool_calling.py:166…`) | yes — but `src/providers/openai.ts:186` **already captures** `call.id` | **TEST only** (regression guard) |
| Thinking budget | `enable_thinking` + `thinking_token_budget` (`vllm_mlx/api/models.py:191-195`) | **no** — nothing sets `req.thinking.budgetTokens` (grep: only Anthropic *parses* thinking blocks) | **DEFER** |
| `response_format` (grammar JSON) | accepts `response_format` (`vllm_mlx/api/models.py:175`) | **no** — `ProviderRequest` has no such field, no caller | **DEFER** |

The two deferred items become real only once the harness grows a caller (a config/router knob that
sets a thinking budget; a structured-output path through `ProviderRequest`). That's its own
increment — "make the harness *request* these" — distinct from this bucket's thesis ("parse what the
engine already emits"). Building them now would be unused surface.

## Decision — extend the apiMode union with `sov`

`apiMode` is a typed union `'anthropic' | 'openai' | 'ollama'` (`src/providers/types.ts:40`,
`src/providers/models.ts:5`, `src/providers/resolver.ts`). Per the founder choice (first-class
provider + shared parsing), we **add `'sov'` to the union** and a thin `SovProvider` rather than
masquerade as `openai` with a dummy key. Rationale:

- **Keyless loopback** posture (mirror the `ollama` keyless path, not openai's key-required throw) —
  no dummy-key hack; omit the `authorization` header when no key is set.
- A real **home for Bucket B** (`/sov/*` control-plane: model identity, context length, readiness,
  capabilities, load) and any future co-design surface.
- Keeps the generic `openai` lane a vanilla OpenAI client.

### The shared-vs-sov split

- **Shared (`src/providers/openai.ts`), benefits every OpenAI-compatible backend:** the stream
  translator (`translateOpenAIStream`) learns to map `delta.reasoning_content` → the existing
  `{ type: 'thinking_delta' }` event (`src/core/types.ts:67`; final block `{ type: 'thinking' }`
  `:18`), matching the Anthropic producer's shape (`src/providers/anthropic.ts:155-157`). Tool-ids
  already survive (`openai.ts:186`) — a regression test locks that in.
- **`sov`-specific (`src/providers/sov.ts` + registry/resolver/schema):** a `SovProvider` that is a
  **keyless** OpenAI-compatible transport — reuses `translateOpenAIStream` / `messagesToOpenAI` /
  `buildKwargs`, but its constructor does **not** require a key and its `stream()` omits the auth
  header when none is set; `name`/`apiMode` = `sov`, loopback default base. No request-kwargs
  override this bucket (nothing to pass through yet).

## Scope

**In (Bucket A, this increment):** shared `reasoning_content` → `thinking_delta` translation + a
tool-id regression test; the keyless `sov` apiMode + `SovProvider`; registry + resolver +
config-schema wiring (`providers.sov`, `router.localProvider: 'sov'`); unit coverage + one
live-gated integration.

**Out (later increments / buckets):**
- **Thinking-budget + `response_format` passthrough** — deferred until the harness has a caller
  (see table). Engine already supports both; this is harness-request-side work.
- **Bucket B** — `/sov/*` control-plane reads (model identity, context length, readiness,
  capabilities, load gauge, warm), served by the engine's supervisor on a sibling port; the
  `SovProvider` is where the harness-side calls will land. *Separate plan.*
- **Bucket C** — engine request-path residue (`cached_tokens` in usage, per-token runaway abort,
  richer `stop_reason`). Forces the engine fork; **dogfood-gated**.
- **Prompt-cache control** is moot: `vllm-mlx` prefix-caches automatically. `cacheEnabled` stays a
  no-op on this lane until Bucket C surfaces cache-hit *telemetry*.

## Non-goals / risks

- **Not** changing the engine. If a live check contradicts a source-verified field, the engine is
  source-of-truth — re-confirm against the running server.
- **Tool-call streaming granularity:** the engine assigns ids but may emit tool calls parsed from
  full text rather than incremental OpenAI-style fragment deltas
  (`vllm_mlx/api/tool_calling.py` `parse_tool_calls`). The translator already handles both "id on a
  whole tool_call" and the fragment path — the live capture (T4-live) pins the exact shape.
- **Served model name:** a single-model engine serves under its `served_model_name` (default
  `"sovereign"`); the `sov` registry `defaultModel` reflects that, not an HF id.

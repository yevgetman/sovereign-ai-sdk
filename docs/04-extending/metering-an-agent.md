# Metering An Agent

Token usage and estimated cost are read from surfaces that **already exist** — there is no separate "usage observer" to install. This recipe names the three read surfaces (per-run, per-span, per-turn), the invariants a meter must respect, and the public primitives for building your own.

> **No new concept.** The `RunResult`, the `traceRecorder` hook, and the gateway wire *are* the metering surface. This feature made what they carry **correct and complete**; it did not add a parallel observer. An external metering tool (a billing meter, a cost dashboard) consumes these surfaces directly — nothing scrapes logs.

## The three read surfaces

Pick the surface that matches your granularity: the whole run, each model/tool span, or each gateway turn on the wire.

### (a) Per-run — `RunResult`

An embedded SDK agent (`createAgent().run()`) returns per-run totals on `RunResult`:

- **`usage?: TokenUsage`** — the run's summed, phase-broken token usage.
- **`estimatedCostUsd?: number`** — that `usage` priced against the provider/model the run used.

**Accumulator semantics:** a tool-loop turn makes N provider calls; `usage` is the **sum of the per-call finals** (last-seen value per field within each call, summed across the loop) — the total, not just the last call. Both fields are **absent** (not `undefined`) when the stream reported no usage. The returned figure shares one `finalizeUsage` result with the persistence path, so it is byte-identical to what `recordTokenUsage` recorded, and `estimatedCostUsd` is the same cost the persistence path stored.

```ts
const result = await agent.run({ prompt: 'summarize this file' });
if (result.usage !== undefined) {
  meter.record(result.usage, result.estimatedCostUsd);
}
```

### (b) Per-span — `traceRecorder`

Supply a `traceRecorder` (the `ObservePort`) to observe individual model calls and tool spans as the turn runs:

- **`provider_response`** — one per model call, carrying that call's **complete final usage** (`usage`), `latencyMs`, `ttftMs?`, `stopReason`, plus `provider`/`model`/`purpose`. Usage is **merged per field within the call**, so a call whose provider emits usage across split deltas (Anthropic sends input+cache on `message_start`, output on `message_delta`) still carries all fields — earlier fields are not dropped by a later output-only delta.
- **`tool_start`** — marks a tool span's start (`tool`, `toolUseId`).
- **`tool_end`** — the span's terminal on success, carrying `durationMs` and `outputBytes`. (`tool_error` carries `durationMs` + `message` on the error path.)

Attributing tokens to an *individual tool call* is estimation, not ground truth — providers report usage per **model call**, not per `tool_use` block. That classification belongs in the consumer (reading `tool_end.outputBytes`), not in the SDK.

### (c) Per-turn — the gateway wire

A `sov gateway` turn publishes per-turn totals on two events (the "SDK-native token counting" server-side consumers gate on):

- **`turn_complete.usage`** — the phase-broken turn total in the protocol's **snake_case** shape (`input_tokens`, `output_tokens`, `cache_creation_input_tokens?`, `cache_read_input_tokens?`). Omitted entirely when the turn reported no usage.
- **Final `status_update`** — `tokensIn` / `tokensOut` / `cost` (the turn total, correct under tool loops) plus **`cacheHitRate`** = `cacheRead / (input + cacheRead + cacheCreation)`, reported only when the provider surfaced cache phase fields.

Both totals are **summed across all hops** of the turn (including an overflow-recovery compaction hop), not the last provider call.

## Invariants a meter must respect

- **The four phase fields are DISJOINT and ADDITIVE.** `inputTokens`, `outputTokens`, `cacheCreationInputTokens`, and `cacheReadInputTokens` never overlap, and **cost = Σ (phase × price)**. Never fold them into one figure before pricing — folding double-counts.
- **`reasoningTokens` is informational, never priced.** It is a *subset already counted inside* `outputTokens` (the reasoning/thinking tokens a provider breaks out, e.g. OpenAI `reasoning_tokens`). `estimateCostUsd` deliberately excludes it; adding it to the sum would double-count. Use it for classification/observability only.
- **OpenAI `prompt_tokens` is mapped with cache subtraction.** OpenAI's `prompt_tokens` *includes* cached tokens, so the provider maps `prompt_tokens_details.cached_tokens → cacheReadInputTokens` and sets `inputTokens = prompt_tokens − cached_tokens`, preserving the disjoint-phase invariant (matching Anthropic, where `input_tokens` already excludes cache reads).
- **`PRICING_VERSION` pins the table you priced against.** `PRICE_TABLE` is a readonly built-in; `PRICING_VERSION` (an integer, starts at `1`) is bumped on **any** table change. A meter that stores costs should also store the `PRICING_VERSION` it priced with, so a later table change is auditable.

## Building your own meter — the public primitives

The accumulator and pricing primitives are barrel-exported (`@yevgetman/sov-sdk`) precisely so external meters reuse the exact per-call/summed semantics instead of re-deriving them (re-deriving is how the gateway's turn-undercount bug happened):

```ts
import {
  createUsageAccumulator, accumulateUsage, finalizeUsage, // usage math
  estimateCostUsd, formatUsd, PRICE_TABLE, PRICING_VERSION, // pricing
  type UsageAccumulator, type TokenUsage, type TokenPricesPerMillion,
} from '@yevgetman/sov-sdk';

let acc = createUsageAccumulator();
for (const event of stream) {
  acc = accumulateUsage(acc, event); // feed the StreamEvent stream
}
const usage = finalizeUsage(acc);    // summed per-call finals, or undefined
if (usage !== undefined) {
  const cost = estimateCostUsd('anthropic', 'claude-...', usage);
  console.log(formatUsd(cost), 'at pricing v' + PRICING_VERSION);
}
```

`accumulateUsage` keeps the last-seen value per field within a call and sums per-call finals across calls; `finalizeUsage` flushes the trailing call and returns `undefined` when no `usage_delta` ever arrived. Pass `PRICE_TABLE` / `PRICING_VERSION` to price and pin exactly as the SDK does.

---

## Metering with Assay (the official pairing)

[Assay](https://github.com/yevgetman/assay) is the SDK's **official token auditing
and valuation solution** — a standalone local-first metering store (pricing,
work-type classification, waste detection, per-turn task ROI, LLM-judge
valuation). The integration is a **wire, not a dependency**: the SDK ships
`createAssayUsageRecorder`, a `traceRecorder` that streams **usage-only**
OpenTelemetry `gen_ai` spans (token counts, identities, tool names, timings —
never content) to a local `assay serve` endpoint. Contract:
`specs/2026-07-05-assay-integration-design.md` (SOV-ASSAY WIRE v1); the golden
fixture `fixtures/assay-wire-v1.json` is conformance-tested in both repos.

```ts
import { createAgent, createAssayUsageRecorder } from '@yevgetman/sov-sdk';

const assay = createAssayUsageRecorder({
  token: process.env.ASSAY_TOKEN!,       // the assay tenant bearer token
  // endpoint: 'http://127.0.0.1:4318',  // default — local assay serve
  // identity: 'sov',                    // lands as the assay principal
});

const agent = createAgent({ /* … */, traceRecorder: assay.record });
const result = await agent.run({ prompt: '…' });
await assay.flush();                      // drain before process exit
```

What lands in assay: one **priced chat span per model call** (five phase-broken
usage fields, priced by assay's own versioned table) carrying the **dominant
tool** its completion invoked (assay classifies it `mechanical`/`tooling`
inline), plus one **execute_tool span** per tool execution (identity + timing,
honestly unpriced; disable via `emitToolSpans: false`). Sessions map to assay
sessions; each turn is an assay **task** (`sov.turn.id` — configure the assay
tenant with `taskIdAttribute: "sov.turn.id"`). Export is fire-and-forget: a
failed batch retries once then drops (counted in `stats()`), the queue is
bounded, and `record` never throws into the agent loop. Assay-side setup
(tenants file, serve) is in assay's own docs — the SDK needs only the endpoint
and token.

---

## Read next

- [`04-extending/extending.md`](extending.md) — the broader recipe set (adding a provider adds its pricing entry).
- [`02-architecture/runtime-architecture.md`](../02-architecture/runtime-architecture.md) — the trace/observe seam and the gateway wire these surfaces ride.

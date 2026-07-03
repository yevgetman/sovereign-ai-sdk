# Spec — Billing-grade usage telemetry (the SDK "usage observer")

- **Date:** 2026-07-03
- **Author:** Julie (Gene's AI assistant), from a full code analysis of the current master (`7042d71`, v0.6.48)
- **Status:** Presented to the CEO with the build directive already issued (2026-07-03 session "Julie2"): the CEO ordered spec + build in one directive, which this spec treats as the SOP-12 green-light.
- **Driver:** `~/code/me/specs/2026-07-03-assay-design.md` (the `assay` token-metering foundation) and the platform's deferred **Slice 5c** (`resume-as-code-platform/docs/specs/2026-06-30-platform-billing-and-tiers-design.md` §3.1), which is explicitly *gated on native token counting in the Sovereign AI SDK*. Vision origin: `sovereign-ai-docs/business/architecture/token-value-accounting.md` (B-0013).

## 1. Summary

Make the SDK the **authoritative, billing-grade source of token-usage truth**: correct the two usage-accounting bugs in the current telemetry, complete the phase breakdown, surface per-run usage/cost on `RunResult`, export the metering primitives from the public barrel, and populate the already-defined per-turn wire field (`turn_complete.usage`). **No new observer concept is introduced** — the existing `traceRecorder` hook + the event stream *are* the usage observer; this feature makes what they carry correct and complete.

One sentence: *after this feature, any SDK embedder or gateway consumer can read exact, phase-broken, per-model-call and per-turn token usage + estimated cost from surfaces that already exist — and a meter like `assay` can bill from them without scraping.*

## 2. Current state (verified findings)

Two bugs, four gaps — all verified against source on master:

- **F1 (BUG — turn undercount, gateway).** `src/server/routes/turns.ts` tracks `latestUsage = streamEvent.usage` (last-writer-wins, ~line 881). A tool-loop turn makes N provider calls; only the **final call's** usage is recorded to `sessionDb.recordTokenUsage` and reported on the final `status_update`. The SDK's own `usageAccumulator` (`packages/sdk/src/core/usageAccumulator.ts`) exists precisely because per-call finals must be **summed** — the gateway doesn't use it. Every multi-call turn under-bills today. This also skews `session_summary.tokens` (fed from sessionDb).
- **F2 (BUG — per-call field loss, query loop).** `packages/sdk/src/core/query.ts` (~line 174) sets `usage = event.usage` per `usage_delta`, last-delta-wins **within a call**. Anthropic emits two deltas per call (message_start: input+cache fields; message_delta: output). Fields absent from the later delta are dropped, so the `provider_response` trace event can lose input/cache figures. Correct semantics: last-seen **per field** (the accumulator's per-call rule).
- **F3 (gap).** `turn_complete.usage` (`packages/protocol/src/events.ts:85-96`) defines a phase-broken snake_case shape — the gateway never populates it (`turns.ts` ~line 1039 publishes without `usage`). Same for `status_update.cacheHitRate` — defined, never assigned.
- **F4 (gap).** `RunResult` carries no usage or cost. `createAgent` runs the accumulator, then discards the total unless a `sessionStore` is present (`createAgent.ts` step 9).
- **F5 (gap).** The metering primitives aren't public: `usageAccumulator` is marked INTERNAL (not barrel-exported); `pricing.ts` isn't in the barrel and `PRICE_TABLE` is module-private and **unversioned** (only reachable via the undocumented `./providers/pricing` subpath).
- **F6 (gap).** The OpenAI-family provider maps only `prompt_tokens`/`completion_tokens` (`openai.ts` ~line 330): no `prompt_tokens_details.cached_tokens` (cache reads billed at full input price in our estimate) and no `completion_tokens_details.reasoning_tokens`. `TokenUsage` has no reasoning field at all — the assay schema's `tok_reasoning` can never be fed.

## 3. Scope

**In:** the six work items in §4 (accumulator export + fixes + completions + RunResult + barrel + gateway wire) and their tests/docs.

**Out (explicit non-goals):**
- **Per-tool-call token attribution.** Providers report usage per **model call**, not per tool_use block. Attributing tokens to individual tool calls is estimation, and belongs in the consumer (assay's classifier layer reading `tool_end.outputBytes`), not in the SDK's ground truth.
- **A new observer hook.** `traceRecorder` (per-model-call `provider_response` with usage/latency/stopReason; per-tool-span `tool_start`/`tool_end` with duration/outputBytes) + the yielded `usage_delta` stream are the observation surface. Documenting them as such is in scope; a parallel "UsageObserver" concept is not.
- **Budgets/enforcement, routing, value modeling** — downstream consumers (assay, the platform wallet, a future router).

## 4. Design (work items)

- **W1 — Export the accumulator.** Un-INTERNAL `usageAccumulator.ts`; barrel-export `createUsageAccumulator`, `accumulateUsage`, `finalizeUsage`, and type `UsageAccumulator`. The gateway (W6) and external meters need exactly these semantics; duplicating them is how F1 happened.
- **W2 — Fix `provider_response` usage (F2).** In `query.ts`, merge `usage_delta` fields per call (last-seen per field) instead of overwriting the whole object. The trace event then carries the call's complete final usage.
- **W3 — `RunResult` usage + cost (F4).** Add optional `usage?: TokenUsage` and `estimatedCostUsd?: number` to `RunResult`, from the accumulator `createAgent` already runs (absent when the stream reported no usage — mirroring `finalizeUsage`'s `undefined`). Additive, semver-minor; update the frozen-surface test.
- **W4 — Public pricing surface (F5).** Barrel-export `estimateCostUsd`, `formatUsd`, type `TokenPricesPerMillion`; export `PRICE_TABLE` (readonly) plus a new `PRICING_VERSION` integer const (starts at `1`, bumped on any table change) so consumers (assay's versioned `pricing_ref`) can pin what they priced against.
- **W5 — Phase completeness (F6).** Add `reasoningTokens?: number` to `TokenUsage` + the accumulator's field list. **Invariant:** the four existing phase fields are disjoint and additive (cost = Σ phase × price); `reasoningTokens` is *informational* — a subset of `outputTokens`, never added to cost. OpenAI mapping: `completion_tokens_details.reasoning_tokens → reasoningTokens`; `prompt_tokens_details.cached_tokens → cacheReadInputTokens` with `inputTokens = prompt_tokens − cached_tokens` (preserving the disjoint-phase invariant; matches Anthropic semantics where `input_tokens` excludes cache reads). Add `cacheReadInput` prices for the OpenAI table entries (50% of input per OpenAI's published discount). Anthropic unchanged (thinking tokens are inside `output_tokens`, not separately reported).
- **W6 — Gateway correctness + wire enrichment (F1, F3).** `runOnce` feeds the W1 accumulator from the events it already consumes (`message_start`/`message_stop`/`usage_delta`); each runOnce's final → `sessionDb.recordTokenUsage` under the sessionId it ran as (preserving the compaction-hop attribution). The **turn total** (summed across hops) feeds the final `status_update` (`tokensIn`/`tokensOut`/`cost`, now correct, plus `cacheHitRate = cacheRead / (input + cacheRead + cacheCreation)` when cache fields are present) and populates **`turn_complete.usage`** (the protocol's snake_case phase shape). This is the "SDK-native token counting" 5c is gated on, delivered server-side on the wire.
- **W7 — Docs.** Document the usage-observer surface (an `docs/04-extending/` recipe: metering an agent — RunResult for per-run totals, `traceRecorder` for per-span, the gateway wire for per-turn), CHANGELOG, and the conventions the tests pin.

## 5. Consumers (why each item earns its place)

| Consumer | Reads |
|---|---|
| `assay` producer 2 (embedded SDK agents) | W3 `RunResult.usage/estimatedCostUsd` (per-run), W1+W2 `traceRecorder`/`provider_response` (per-model-call spans), W4 pricing/`PRICING_VERSION` |
| `assay` producer 1 / platform Slice 5c | W6 `turn_complete.usage` — phase-broken per-turn, server-side, correct under tool loops |
| `sov` TUI `/cost`, `session_summary` | W6 fixes the undercount they currently inherit from sessionDb |
| Token-value project (the moat) | W5 `reasoningTokens` + the disjoint-phase invariant it classifies against |

## 6. Compatibility

- All type changes are **additive optional fields** or **new exports** — no existing signature changes. The 0.1.0 frozen-surface test (`tests/sdk/surface.test.ts`) is *extended*, not rewritten.
- Wire: `turn_complete.usage` and `status_update.cacheHitRate` are already-optional fields going from never-set → set; existing consumers (TUI, platform relay) ignore unknown/absent-then-present optionals by construction.
- Behavior change: `status_update.tokensIn/tokensOut/cost` become **correct** (larger on multi-call turns). This is a bug fix, called out in the CHANGELOG.
- Packages: `@yevgetman/sov-sdk` 0.1.0 → 0.2.0 (additive surface; npm publish remains held — CEO's button).

## 7. Testing

TDD throughout (RED → GREEN per task): accumulator reasoning-field tests; a query-loop test pinning per-field merge on split deltas (F2 regression); createAgent multi-call RunResult usage/cost tests against the mock provider; OpenAI mapping tests (cached-token subtraction, reasoning subset, price-table cache entries); **a gateway multi-call turn test pinning the F1 undercount fix** (the load-bearing regression test); surface-test additions; `bun run lint && bun run typecheck && bun run test` green at every commit.

## 8. References

- Driver spec: `~/code/me/specs/2026-07-03-assay-design.md` (§6 producer 2, §8.1, §11)
- Platform gate: `resume-as-code-platform/docs/specs/2026-06-30-platform-billing-and-tiers-design.md` §3.1 (Slice 5c)
- Vision: `sovereign-ai-docs/business/architecture/token-value-accounting.md` (B-0013)
- Code: `packages/sdk/src/core/usageAccumulator.ts`, `core/query.ts`, `agent/createAgent.ts`, `providers/{pricing,openai,anthropic}.ts`, `src/server/routes/turns.ts`, `packages/protocol/src/events.ts`

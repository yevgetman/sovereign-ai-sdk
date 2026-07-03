# Plan — Billing-grade usage telemetry

Spec: `specs/2026-07-03-usage-telemetry-design.md`. Branch: `usage-telemetry` → merge to master.
Process: SOP-12 autonomous subagent build — fresh subagent per task, TDD (RED→GREEN), review between tasks, gate (`bun run lint && bun run typecheck && bun run test`) green at every commit, atomic commits.

## Tasks

### T1 — Accumulator public + `reasoningTokens` (W1 + W5a)
- `packages/sdk/src/core/types.ts`: add `reasoningTokens?: number` to `TokenUsage` with a doc comment stating the invariant: informational subset of `outputTokens`, never priced.
- `packages/sdk/src/core/usageAccumulator.ts`: add `reasoningTokens` to `USAGE_FIELDS`; update the header comment (drop "INTERNAL: not barrel-exported").
- `packages/sdk/src/sdk.ts`: export `createUsageAccumulator`, `accumulateUsage`, `finalizeUsage`, type `UsageAccumulator`.
- Tests: accumulator sums/carries `reasoningTokens` like other fields; absent-field contract holds; surface test extended for the new exports.

### T2 — Fix `provider_response` per-field usage merge (W2 / F2)
- `packages/sdk/src/core/query.ts` (~line 174): replace `usage = event.usage` with a per-field merge (`usage = { ...usage, ...definedFieldsOf(event.usage) }` semantics — last-seen per field within the call).
- Test (RED first): a mock provider emitting split deltas (first: input+cache; second: output only) → `provider_response` trace event carries ALL fields.

### T3 — OpenAI phase mapping + public pricing (W5b + W4)
- `packages/sdk/src/providers/openai.ts` (~line 328): map `prompt_tokens_details.cached_tokens → cacheReadInputTokens` with `inputTokens = prompt_tokens − cached_tokens` (disjoint-phase invariant); `completion_tokens_details.reasoning_tokens → reasoningTokens`. Guard for absent details objects (older/local engines).
- `packages/sdk/src/providers/pricing.ts`: add `cacheReadInput` to the two openai entries (gpt-4o: 1.25, gpt-4o-mini: 0.075); export `PRICE_TABLE` (as readonly) + new `export const PRICING_VERSION = 1`; `estimateCostUsd` unchanged (reasoning ⊆ output — assert via comment + test).
- `packages/sdk/src/sdk.ts`: export `estimateCostUsd`, `formatUsd`, `PRICE_TABLE`, `PRICING_VERSION`, type `TokenPricesPerMillion`.
- Tests: OpenAI chunk-stream mapping (subtraction, reasoning, absent-details); cost math unchanged by reasoningTokens; cache-read pricing for openai models; surface test extended.

### T4 — `RunResult.usage` + `estimatedCostUsd` (W3 / F4)
- `packages/sdk/src/agent/createAgent.ts`: `RunResult` gains `usage?: TokenUsage`, `estimatedCostUsd?: number`; compute once from the existing accumulator (`finalizeUsage`) and share between persistence + return (call `finalizeUsage` once). Absent when no usage was reported. Cost via `estimateCostUsd(provider.name, model, usage)`.
- Tests: multi-call tool-loop run on the mock provider → RunResult sums per-call finals; no-usage stream → both fields absent; cost matches the pricing table; persistence path unchanged (same figure recorded).

### T5 — Gateway: accumulate + wire (W6 / F1 + F3)
- `src/server/routes/turns.ts`: replace the `latestUsage` last-writer-wins tracking with the W1 accumulator, fed from the events the loop already sees (`message_start`/`message_stop`/`usage_delta`). Per-runOnce final → `sessionDb.recordTokenUsage` under that hop's sessionId (compaction attribution preserved). Turn total (sum across hops) → final `status_update` (`tokensIn`/`tokensOut`/`cost` + `cacheHitRate = cacheRead/(input+cacheRead+cacheCreation)` when cache fields present) and → `turn_complete.usage` (protocol snake_case shape, omitted when no usage).
- Tests (RED first): **multi-call tool-loop turn → status_update/turn_complete/sessionDb carry the SUM, not the last call** (the F1 regression pin); turn_complete.usage populated with cache fields; single-call turn byte-compatible otherwise; overflow-recovery hop still records per-session correctly.

### T6 — Docs, changelog, versions (W7)
- New `docs/04-extending/metering-an-agent.md`: the three read surfaces (RunResult per-run; traceRecorder per-span — provider_response/tool_end; gateway wire per-turn), the disjoint-phase invariant, reasoningTokens caveat, PRICING_VERSION.
- CHANGELOG: bug-fix callout (multi-call turns previously under-reported usage/cost) + additions.
- Versions: repo 0.6.48 → 0.6.49; `packages/sdk` 0.1.0 → 0.2.0 (+ `packages/protocol` untouched — no wire type changes). Update `docs/06-testing/testing-log.md`.
- `AGENTS.md ≡ CLAUDE.md` diff check; boundary lint green.

## Ship
Gate green → merge `usage-telemetry` → master → push → `sov upgrade` (runtime changed) → update driver spec (`me/specs/2026-07-03-assay-design.md` §6.2 note: prerequisite SHIPPED) → report.

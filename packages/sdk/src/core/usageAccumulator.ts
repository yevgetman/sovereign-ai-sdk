// src/core/usageAccumulator.ts — cross-call token-usage accumulation for the
// tool loop (Task 4.2). OPEN core, PUBLIC: barrel-exported from src/sdk.ts (W1)
// so the gateway and external meters reuse the exact per-call/summed semantics
// (duplicating them is how the gateway's turn-undercount bug happened).
//
// Five accumulated fields (USAGE_FIELDS): the four DISJOINT, ADDITIVE phase
// fields (input / output / cache-creation / cache-read) plus `reasoningTokens`,
// an INFORMATIONAL SUBSET of `outputTokens` (reasoning tokens a provider broke
// out separately). All five accumulate identically here — last-seen per field
// within a call, summed across calls — but reasoningTokens overlaps output and
// is NEVER priced; only the accumulation is this module's concern.
//
// query() emits one or more `usage_delta` events per provider call (for
// Anthropic: one at message_start carrying inputTokens + cache fields, one at
// message_delta carrying that call's FINAL cumulative outputTokens). Deltas
// within a single call are CUMULATIVE-FROM-ZERO for that call, so the correct
// per-run total is: keep the LAST-SEEN value PER FIELD within a call, then SUM
// those per-call finals across the tool loop. A call is flushed at each per-call
// boundary — `message_start` (a new call begins) AND `message_stop` (the call's
// terminal) — folding its last-seen values into the running totals;
// `finalizeUsage` flushes once more for any trailing call after the stream ends.
// Flushing is idempotent (an empty flush is a no-op), so pairing both boundaries
// never double-counts, and a custom provider that emits only message_stop per
// call (no message_start) is still summed correctly (F23).
//
// This is an open RE-IMPLEMENTATION of the semantics the proprietary gateway
// uses for OpenAI usage reporting (src/openai/streaming/chunks.ts) — NOT an
// import of it (the boundary forbids that), and with one deliberate
// divergence: the gateway folds cache-read/creation tokens into an OpenAI
// `prompt_tokens` figure, while this module keeps the four `TokenUsage` fields
// SEPARATE — `recordTokenUsage` stores them separately and `estimateCostUsd`
// prices them separately (folding would double-count cost).
//
// Field-absence contract: a field is summed treating a call that omitted it as
// 0, but a field NO call ever reported stays ABSENT from the total — the
// persistence path sees exactly the fields the provider reported, matching how
// the old single-call snapshot serialized. A stream with no `usage_delta` at
// all finalizes to `undefined`, so `recordTokenUsage` stays skipped exactly as
// before.

import type { StreamEvent, TokenUsage } from './types.js';

const USAGE_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheCreationInputTokens',
  'cacheReadInputTokens',
  'reasoningTokens',
] as const satisfies readonly (keyof TokenUsage)[];

/** Immutable accumulator state. `totals` holds the summed per-call finals so
 *  far (only fields some call actually reported); `call` holds the in-progress
 *  call's last-seen values per field; `sawUsage` records whether ANY
 *  usage_delta arrived, gating finalize's `undefined` (no-usage) result. */
export type UsageAccumulator = {
  readonly totals: Readonly<TokenUsage>;
  readonly call: Readonly<TokenUsage>;
  readonly sawUsage: boolean;
};

export function createUsageAccumulator(): UsageAccumulator {
  return { totals: {}, call: {}, sawUsage: false };
}

/** Flush the in-progress call's last-seen values into the running totals and
 *  reset the per-call tracker. Returns a new accumulator. Fields the call
 *  never reported contribute nothing (an all-empty flush is a no-op), so
 *  flushing on the FIRST message_start is naturally safe — no gate needed. */
function flushCall(acc: UsageAccumulator): UsageAccumulator {
  const totals: TokenUsage = { ...acc.totals };
  for (const field of USAGE_FIELDS) {
    const callValue = acc.call[field];
    if (callValue !== undefined) totals[field] = (totals[field] ?? 0) + callValue;
  }
  return { totals, call: {}, sawUsage: acc.sawUsage };
}

/** Fold one stream event into the accumulator. Returns a new accumulator (or
 *  the same state for events that don't affect usage).
 *  - `message_start`: a new provider call has begun — flush the prior call.
 *  - `message_stop`: the per-call terminal — flush this call. query() treats
 *    message_stop as the per-call terminal and every shipped provider emits it
 *    after that call's usage_delta, so flushing here makes accounting correct
 *    even for a custom provider that omits message_start between calls (F23).
 *    The flush is idempotent — a subsequent message_start/finalize flushes an
 *    empty call, contributing nothing — so pairing both boundaries never
 *    double-counts.
 *  - `usage_delta`: record the last-seen value PER FIELD for the current call
 *    (a later delta that omits a field does not clear the earlier value). */
export function accumulateUsage(acc: UsageAccumulator, ev: StreamEvent): UsageAccumulator {
  if (ev.type === 'message_start' || ev.type === 'message_stop') return flushCall(acc);
  if (ev.type !== 'usage_delta') return acc;
  const call: TokenUsage = { ...acc.call };
  for (const field of USAGE_FIELDS) {
    const value = ev.usage[field];
    if (value !== undefined) call[field] = value;
  }
  return { totals: acc.totals, call, sawUsage: true };
}

/** Flush the trailing call (no next message_start closes it) and return the
 *  summed per-run total — or `undefined` when the stream reported no usage at
 *  all, so the caller skips `recordTokenUsage` exactly as before. Pure: safe
 *  to call more than once on the same state. */
export function finalizeUsage(acc: UsageAccumulator): TokenUsage | undefined {
  const flushed = flushCall(acc);
  if (!flushed.sawUsage) return undefined;
  return { ...flushed.totals };
}

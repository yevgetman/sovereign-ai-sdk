// The ONE prompt-caching policy, shared by every transport that emits
// Anthropic-style `cache_control` breakpoints.
//
// Two lanes reach Anthropic models and both must place their breakpoints in
// exactly the same places:
//   1. the Anthropic transport (`providers/anthropic.ts`) — the native
//      `/v1/messages` shape, where markers ride on `TextBlockParam` /
//      `ContentBlockParam`;
//   2. the OpenAI-format transport's **openrouter** lane
//      (`providers/openai.ts`) — `POST /v1/chat/completions`, where markers
//      ride on `{ type: 'text', … }` content parts and OpenRouter forwards
//      them to Anthropic verbatim.
//
// The policy (which segment, which messages, how many markers) lives HERE and
// only here so the two lanes cannot drift into different caching behaviour —
// drift is invisible in unit tests per lane and only shows up as a cost
// regression in production billing.
// Spec: specs/2026-08-25-openrouter-cache-and-image-passthrough-design.md §2.2.
//
// This module is pure policy arithmetic: no provider types, no wire shapes, no
// I/O. Each transport applies the indices it returns to its own block type.
//
// ONE KNOWN DIVERGENCE, deliberate and documented rather than papered over:
// the two lanes decide "is there a system prompt at all?" differently. The
// Anthropic lane (`systemToSdk`) decides on `segments.length === 0` and emits
// the segment texts verbatim, so `[{ text: '', cacheable: true }]` yields a
// message carrying an EMPTY text block. The openrouter lane decides on the
// FLATTENED, trimmed text, so the same input yields no system message at all.
// This module owns WHICH segment gets the breakpoint; emptiness handling stays
// with each transport. The divergence is not fixed here because zero behaviour
// change on the Anthropic lane is a constraint of the lifting refactor
// (plan 2026-08-25-openrouter-anthropic-prompt-caching, task 1) — revisit it
// only with an Anthropic-lane behaviour change in scope.

import type { SystemSegment } from '../core/types.js';

/**
 * How many trailing messages are eligible for a cache breakpoint.
 *
 * The system prompt is the big stable prefix, but a long tool-calling turn
 * grows its own history; marking the last few messages is what lets that
 * growing prefix be read from cache on the next iteration instead of re-read
 * at full price.
 */
export const RECENT_MESSAGE_CACHE_WINDOW = 3;

/**
 * Anthropic's hard per-request limit on `cache_control` breakpoints. Our
 * policy budgets it as 1 system-prompt marker + at most
 * `RECENT_MESSAGE_CACHE_WINDOW` (3) recent-message markers = 4 exactly, so a
 * conforming transport can never exceed the limit.
 */
export const MAX_CACHE_BREAKPOINTS = 4;

/**
 * Index of the first message eligible for a cache breakpoint: the last
 * `RECENT_MESSAGE_CACHE_WINDOW` messages, clamped at 0 for short histories.
 * A message at index >= this value is in the window.
 */
export function recentMessageCacheFrom(messageCount: number): number {
  return Math.max(0, messageCount - RECENT_MESSAGE_CACHE_WINDOW);
}

/**
 * Index of the LAST item satisfying `predicate`, or -1 if none does. The
 * generic form of "put the breakpoint on the last cacheable thing" — used for
 * system segments and for the content blocks/parts of a marked message.
 *
 * A missing item — a hole in a sparse array, or a literal `null`/`undefined`
 * element — never matches and is never handed to `predicate`: there is nothing
 * there to carry a marker, and a predicate written against `T` should not have
 * to defend against a nullish `T`.
 */
export function lastIndexWhere<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item == null) continue;
    if (predicate(item)) return i;
  }
  return -1;
}

/**
 * Index of the last cacheable system segment, or -1 when no segment is
 * cacheable (caching disabled upstream, or a fully volatile prompt). The
 * breakpoint goes on the LAST cacheable segment so everything before it —
 * the whole stable prefix — is covered by the one marker.
 */
export function findLastCacheableSegment(segments: SystemSegment[]): number {
  return lastIndexWhere(segments, (segment) => segment.cacheable);
}

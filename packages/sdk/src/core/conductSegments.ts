// packages/sdk/src/core/conductSegments.ts — persona-segment placement.
//
// Persona segments are cacheable-stable engine output. Inserting them right
// after the cacheable base prefix keeps the provider prompt cache intact
// (stable content stays contiguous) and keeps persona AHEAD of the dynamic
// tail (system/user context, per-turn instruction tails). With no cacheable
// base at all (e.g. a bare-string system prompt), persona leads: identity-first.

import type { SystemSegment } from './types.js';

export function insertPersonaSegments(
  base: SystemSegment[],
  persona: SystemSegment[],
): SystemSegment[] {
  if (persona.length === 0) return base;
  let lastCacheable = -1;
  for (let i = 0; i < base.length; i++) {
    const segment = base[i];
    if (segment?.cacheable) lastCacheable = i;
  }
  return [...base.slice(0, lastCacheable + 1), ...persona, ...base.slice(lastCacheable + 1)];
}

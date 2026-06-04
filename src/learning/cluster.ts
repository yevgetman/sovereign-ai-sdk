// src/learning/cluster.ts
// Phase 13.4 — pure deterministic clustering of observations. No I/O.
// Groups by (tool_name, action-pattern, status). The action-pattern is a
// NORMALIZED form of tool_input_summary: quoted strings, filesystem paths,
// and numbers are collapsed to placeholders (<str>, <path>, <n>) before the
// 80-char cap is applied. Normalizing the variable parts lets structurally
// similar observations co-cluster — e.g. `ls ~/a` and `ls ~/b` share a key
// instead of fragmenting into singleton clusters that never reach the
// propose bar.
//
// v0 keeps clustering deterministic and explicit; embedding-based
// similarity is explicitly out of scope per build plan.

import type { Observation } from './types.js';

export interface Cluster {
  key: string;
  observations: Observation[];
}

const ACTION_PATTERN_MAX = 80;

/**
 * Collapse the variable parts of a tool-input summary into stable
 * placeholders so structurally-similar invocations normalize to the same
 * action pattern. Order matters: quoted strings are collapsed first (so the
 * path/number rules don't chew up their contents), then paths, then numbers.
 */
export function normalizeActionPattern(summary: string): string {
  return summary
    .replace(/(['"])(?:\\.|(?!\1).)*\1/g, '<str>') // quoted strings
    .replace(/[~.]?\/[^\s'"]+/g, '<path>') // paths (abs, rel, ~/)
    .replace(/\b\d[\d.,:_-]*\b/g, '<n>') // numbers
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ACTION_PATTERN_MAX);
}

/** Build a deterministic key from a single observation. */
export function clusterKey(obs: Observation): string {
  return `${obs.tool_name}::${normalizeActionPattern(obs.tool_input_summary)}::${obs.status}`;
}

/** Group observations by deterministic key. Returns clusters sorted by
 *  size descending (bigger clusters first — those are the strongest
 *  candidates for instinct extraction). */
export function clusterObservations(observations: Observation[]): Cluster[] {
  const map = new Map<string, Cluster>();
  for (const obs of observations) {
    const key = clusterKey(obs);
    const existing = map.get(key);
    if (existing) {
      existing.observations.push(obs);
    } else {
      map.set(key, { key, observations: [obs] });
    }
  }
  return Array.from(map.values()).sort((a, b) => b.observations.length - a.observations.length);
}

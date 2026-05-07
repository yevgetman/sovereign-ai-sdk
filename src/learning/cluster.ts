// src/learning/cluster.ts
// Phase 13.4 — pure deterministic clustering of observations. No I/O.
// Groups by (tool_name, action-pattern, status). The action-pattern is
// derived from tool_input_summary truncated to 80 chars to keep cluster
// keys stable across slight input variation.
//
// v0 keeps clustering deterministic and explicit; embedding-based
// similarity is explicitly out of scope per build plan.

import type { Observation } from './types.js';

export interface Cluster {
  key: string;
  observations: Observation[];
}

const ACTION_PATTERN_MAX = 80;

/** Build a deterministic key from a single observation. */
export function clusterKey(obs: Observation): string {
  const ap = obs.tool_input_summary.slice(0, ACTION_PATTERN_MAX);
  return `${obs.tool_name}::${ap}::${obs.status}`;
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

// Phase 13.3 — shared id + provenance helpers used by review proposal tools
// (memory_propose, skill_propose, and any future propose-then-promote tool).

import { createHash, randomBytes } from 'node:crypto';

/** Returns a sortable proposal id of the form `YYYY-MM-DD-<8 hex chars>`. */
export function newProposalId(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `${date}-${randomBytes(4).toString('hex')}`;
}

/** SHA-256 over (range start : range end : excerpt). Returns `sha256:<hex>`. */
export function hashSource(excerpt: string, range: readonly [number, number]): string {
  const h = createHash('sha256');
  h.update(`${range[0]}:${range[1]}:${excerpt}`);
  return `sha256:${h.digest('hex')}`;
}

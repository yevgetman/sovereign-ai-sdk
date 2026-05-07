// src/learning/promotion.ts
// Phase 13.4 — pure cross-project instinct promotion check.
// Surfaces instincts appearing in ≥ 2 projects at confidence ≥ 0.7.
// Synthesizer iterates over all known projects' instincts via
// InstinctStore.list(projectId) for each id from listAllProjects(),
// flattens, and feeds the resulting list to this helper.
//
// No I/O. Promotion candidates still require human approval via
// Phase 13.3's /review approve before becoming durable memory or
// skill changes — Qwen Code's "dream" anti-pattern is explicitly
// rejected (see qwen-code-analysis.md §3.4).

import type { Instinct } from './types.js';

export interface PromotionCandidate {
  trigger: string;
  action: string;
  domain: Instinct['domain'];
  evidenceProjects: Array<{
    projectId: string;
    confidence: number;
    evidenceCount: number;
  }>;
}

export interface PromotionThresholds {
  minProjects: number;
  minConfidence: number;
}

const DEFAULT_THRESHOLDS: PromotionThresholds = {
  minProjects: 2,
  minConfidence: 0.7,
};

/** Group project-scoped instincts by (trigger, action, domain) triple
 *  and surface those appearing in ≥ minProjects projects at
 *  confidence ≥ minConfidence. Sorted by total evidence count
 *  descending so the strongest candidates surface first. */
export function findPromotionCandidates(
  perProjectInstincts: Instinct[],
  thresholds: Partial<PromotionThresholds> = {},
): PromotionCandidate[] {
  const { minProjects, minConfidence } = { ...DEFAULT_THRESHOLDS, ...thresholds };

  // Filter to project-scoped instincts at or above the confidence floor.
  const eligible = perProjectInstincts.filter(
    (i) => i.scope === 'project' && i.confidence >= minConfidence,
  );

  // Group by (trigger, action, domain). Same trigger/action across
  // projects must also share domain to count as the same instinct —
  // otherwise we'd cross-promote semantically-different behaviors that
  // happen to share a label.
  const groups = new Map<string, Instinct[]>();
  for (const inst of eligible) {
    const key = `${inst.trigger}::${inst.action}::${inst.domain}`;
    const arr = groups.get(key) ?? [];
    arr.push(inst);
    groups.set(key, arr);
  }

  // Build candidates from groups with ≥ minProjects DISTINCT project_ids.
  const out: PromotionCandidate[] = [];
  for (const arr of groups.values()) {
    const projectIds = new Set(
      arr.map((i) => i.project_id).filter((id): id is string => id !== null),
    );
    if (projectIds.size < minProjects) continue;
    const first = arr[0];
    if (!first) continue;
    // Aggregate per-project confidence + evidence count. If multiple
    // instincts in the same project share the trigger/action (rare but
    // possible if the synthesizer races itself), pick the highest
    // confidence per project so the candidate reflects the project's
    // best representative.
    const perProject = new Map<string, { confidence: number; evidenceCount: number }>();
    for (const inst of arr) {
      if (inst.project_id === null) continue;
      const existing = perProject.get(inst.project_id);
      if (existing === undefined || inst.confidence > existing.confidence) {
        perProject.set(inst.project_id, {
          confidence: inst.confidence,
          evidenceCount: inst.evidence_count,
        });
      }
    }
    out.push({
      trigger: first.trigger,
      action: first.action,
      domain: first.domain,
      evidenceProjects: Array.from(perProject.entries()).map(([projectId, v]) => ({
        projectId,
        confidence: v.confidence,
        evidenceCount: v.evidenceCount,
      })),
    });
  }

  // Sort by total evidence count descending (strongest first), then by
  // distinct-project count to break ties (broader reach beats deeper
  // single-project evidence).
  return out.sort((a, b) => {
    const aEv = a.evidenceProjects.reduce((n, p) => n + p.evidenceCount, 0);
    const bEv = b.evidenceProjects.reduce((n, p) => n + p.evidenceCount, 0);
    if (aEv !== bEv) return bEv - aEv;
    return b.evidenceProjects.length - a.evidenceProjects.length;
  });
}

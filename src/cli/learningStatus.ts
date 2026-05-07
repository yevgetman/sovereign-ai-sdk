// src/cli/learningStatus.ts
// Phase 13.4 — `harness learning status` CLI handler. Read-only.
// Lists per-project instinct counts + confidence histogram + last
// synthesis timestamp.

import chalk from 'chalk';
import { resolveHarnessHome } from '../config/paths.js';
import { InstinctStore } from '../learning/instinctStore.js';
import { GLOBAL_PROJECT_ID } from '../learning/paths.js';
import type { Instinct, InstinctDomain } from '../learning/types.js';

export interface LearningStatusOpts {
  project?: string;
  harnessHome?: string;
}

export interface ProjectStatus {
  projectId: string;
  total: number;
  byDomain: Record<InstinctDomain, number>;
  byScope: { project: number; global: number };
  histogram: { lt30: number; from30to70: number; gte70: number; gte90: number };
  latestEvidenceAt: string | null;
}

export function getLearningStatus(opts: LearningStatusOpts = {}): ProjectStatus[] {
  const harnessHome = opts.harnessHome ?? resolveHarnessHome();
  const store = new InstinctStore(harnessHome);
  const projectIds =
    opts.project !== undefined ? [opts.project] : [GLOBAL_PROJECT_ID, ...store.listAllProjects()];

  const results: ProjectStatus[] = [];
  for (const projectId of projectIds) {
    const instincts = store.list(projectId);
    if (instincts.length === 0 && opts.project === undefined) continue; // skip empty in summary mode
    results.push(buildStatus(projectId, instincts));
  }
  return results;
}

function buildStatus(projectId: string, instincts: Instinct[]): ProjectStatus {
  const byDomain: Record<InstinctDomain, number> = {
    'code-style': 0,
    testing: 0,
    git: 0,
    debugging: 0,
    workflow: 0,
    tooling: 0,
  };
  let projectScope = 0;
  let globalScope = 0;
  const histogram = { lt30: 0, from30to70: 0, gte70: 0, gte90: 0 };
  let latestEvidenceAt: string | null = null;
  for (const i of instincts) {
    byDomain[i.domain] += 1;
    if (i.scope === 'project') projectScope += 1;
    else globalScope += 1;
    if (i.confidence < 0.3) histogram.lt30 += 1;
    else if (i.confidence < 0.7) histogram.from30to70 += 1;
    else if (i.confidence < 0.9) histogram.gte70 += 1;
    else histogram.gte90 += 1;
    if (latestEvidenceAt === null || i.last_evidence_at > latestEvidenceAt) {
      latestEvidenceAt = i.last_evidence_at;
    }
  }
  return {
    projectId,
    total: instincts.length,
    byDomain,
    byScope: { project: projectScope, global: globalScope },
    histogram,
    latestEvidenceAt,
  };
}

export function formatLearningStatus(statuses: ProjectStatus[]): string {
  if (statuses.length === 0) {
    return chalk.dim('no instincts yet — run a few sessions to seed the corpus\n');
  }
  const lines: string[] = [];
  for (const s of statuses) {
    lines.push(chalk.bold(`# project: ${s.projectId}`));
    lines.push(`  total: ${chalk.cyan(String(s.total))}`);
    lines.push(`  scope: project=${s.byScope.project} · global=${s.byScope.global}`);
    const domains = Object.entries(s.byDomain)
      .filter(([, n]) => n > 0)
      .map(([d, n]) => `${d}=${n}`)
      .join(' · ');
    if (domains.length > 0) {
      lines.push(`  domains: ${domains}`);
    }
    const h = s.histogram;
    lines.push(
      `  confidence: <0.3=${h.lt30} · 0.3-0.7=${h.from30to70} · 0.7-0.9=${h.gte70} · ≥0.9=${h.gte90}`,
    );
    lines.push(`  latest evidence: ${chalk.dim(s.latestEvidenceAt ?? '(none)')}`);
    lines.push('');
  }
  return lines.join('\n');
}

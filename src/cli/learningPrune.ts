// src/cli/learningPrune.ts
// Phase 13.4 — `harness learning prune` CLI handler. Drops sub-threshold
// instincts past their aging window via the pure shouldPrune() helper.

import chalk from 'chalk';
import { loadSettings } from '../config/loader.js';
import { resolveHarnessHome } from '../config/paths.js';
import { shouldPrune } from '../learning/confidence.js';
import { InstinctStore } from '../learning/instinctStore.js';
import { GLOBAL_PROJECT_ID } from '../learning/paths.js';
import type { Instinct } from '../learning/types.js';

const DEFAULT_PRUNE_BELOW_CONFIDENCE = 0.3;
const DEFAULT_PRUNE_AGE_DAYS = 30;

export interface LearningPruneOpts {
  project?: string;
  dryRun?: boolean;
  harnessHome?: string;
  pruneBelowConfidence?: number;
  pruneAgeDays?: number;
}

export interface PruneResult {
  candidates: Array<{ projectId: string; instinct: Instinct }>;
  removed: number;
  dryRun: boolean;
}

export function runLearningPrune(opts: LearningPruneOpts = {}): PruneResult {
  const harnessHome = opts.harnessHome ?? resolveHarnessHome();
  const settings = loadSettings();
  const pruneBelowConfidence =
    opts.pruneBelowConfidence ??
    settings.learning?.pruneBelowConfidence ??
    DEFAULT_PRUNE_BELOW_CONFIDENCE;
  const pruneAgeDays =
    opts.pruneAgeDays ?? settings.learning?.pruneAgeDays ?? DEFAULT_PRUNE_AGE_DAYS;

  const store = new InstinctStore(harnessHome);
  const projectIds =
    opts.project !== undefined ? [opts.project] : [GLOBAL_PROJECT_ID, ...store.listAllProjects()];

  const candidates: PruneResult['candidates'] = [];
  for (const projectId of projectIds) {
    const instincts = store.list(projectId);
    for (const instinct of instincts) {
      if (
        shouldPrune(
          instinct.confidence,
          instinct.last_evidence_at,
          pruneBelowConfidence,
          pruneAgeDays,
        )
      ) {
        candidates.push({ projectId, instinct });
      }
    }
  }

  const dryRun = opts.dryRun ?? false;
  if (!dryRun) {
    for (const { projectId, instinct } of candidates) {
      store.remove(projectId, instinct.id);
    }
  }

  return {
    candidates,
    removed: dryRun ? 0 : candidates.length,
    dryRun,
  };
}

export function formatPruneResult(result: PruneResult): string {
  if (result.candidates.length === 0) {
    return chalk.dim('no instincts to prune\n');
  }
  const action = result.dryRun ? 'would prune' : 'pruned';
  const lines: string[] = [`${chalk.bold(`${result.candidates.length}`)} instinct(s) ${action}:`];
  for (const { projectId, instinct } of result.candidates) {
    lines.push(
      `  ${chalk.dim(projectId.slice(0, 12))}  ${chalk.cyan(instinct.id.slice(0, 14))}  conf=${instinct.confidence}  last_evidence=${chalk.dim(instinct.last_evidence_at)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

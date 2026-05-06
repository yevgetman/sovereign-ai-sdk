// Canonical filesystem layout for review/* artifacts under $HARNESS_HOME.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type ReviewState = 'pending' | 'approved' | 'rejected';
export type ReviewKind = 'memory' | 'skills' | 'consolidation';

const REVIEW_STATES: ReviewState[] = ['pending', 'approved', 'rejected'];
const REVIEW_KINDS: ReviewKind[] = ['memory', 'skills', 'consolidation'];

export function reviewDir(harnessHome: string, state: ReviewState, kind: ReviewKind): string {
  return join(harnessHome, 'review', state, kind);
}

export function proposalPath(
  harnessHome: string,
  state: ReviewState,
  kind: 'memory' | 'consolidation',
  proposalId: string,
): string {
  return join(reviewDir(harnessHome, state, kind), `${proposalId}.md`);
}

export function skillProposalDir(
  harnessHome: string,
  state: ReviewState,
  proposalId: string,
): string {
  return join(reviewDir(harnessHome, state, 'skills'), proposalId);
}

export function ensureReviewDirs(harnessHome: string): void {
  for (const state of REVIEW_STATES) {
    for (const kind of REVIEW_KINDS) {
      mkdirSync(reviewDir(harnessHome, state, kind), { recursive: true });
    }
  }
}

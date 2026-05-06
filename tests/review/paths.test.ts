import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureReviewDirs,
  proposalPath,
  reviewDir,
  skillProposalDir,
} from '../../src/review/paths.js';

describe('review paths', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-review-paths-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('reviewDir returns canonical layout', () => {
    expect(reviewDir(home, 'pending', 'memory')).toBe(join(home, 'review', 'pending', 'memory'));
    expect(reviewDir(home, 'approved', 'skills')).toBe(join(home, 'review', 'approved', 'skills'));
    expect(reviewDir(home, 'rejected', 'consolidation')).toBe(
      join(home, 'review', 'rejected', 'consolidation'),
    );
  });

  test('ensureReviewDirs creates pending tree idempotently', () => {
    ensureReviewDirs(home);
    expect(existsSync(join(home, 'review', 'pending', 'memory'))).toBe(true);
    expect(existsSync(join(home, 'review', 'pending', 'skills'))).toBe(true);
    expect(existsSync(join(home, 'review', 'pending', 'consolidation'))).toBe(true);
    // second call should not throw
    ensureReviewDirs(home);
  });

  test('proposalPath returns <home>/review/<state>/<kind>/<id>.md for memory', () => {
    expect(proposalPath(home, 'pending', 'memory', '2026-05-06-abc')).toBe(
      join(home, 'review', 'pending', 'memory', '2026-05-06-abc.md'),
    );
  });

  test('skillProposalDir returns directory path for skill proposals', () => {
    expect(skillProposalDir(home, 'pending', '2026-05-06-xyz')).toBe(
      join(home, 'review', 'pending', 'skills', '2026-05-06-xyz'),
    );
  });
});

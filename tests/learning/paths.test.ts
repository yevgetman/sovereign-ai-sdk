import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GLOBAL_PROJECT_ID,
  ensureGlobalLearningDirs,
  ensureLearningDirs,
  instinctPath,
  instinctsDir,
  learningRoot,
  observationsPath,
  projectRoot,
} from '../../src/learning/paths.js';

describe('learning paths', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-learning-paths-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('learningRoot + projectRoot return canonical layout', () => {
    expect(learningRoot(home)).toBe(join(home, 'learning'));
    expect(projectRoot(home, 'proj-abc')).toBe(join(home, 'learning', 'proj-abc'));
  });

  test('observationsPath, instinctsDir, instinctPath compose correctly', () => {
    expect(observationsPath(home, 'p1')).toBe(join(home, 'learning', 'p1', 'observations.jsonl'));
    expect(instinctsDir(home, 'p1')).toBe(join(home, 'learning', 'p1', 'instincts'));
    expect(instinctPath(home, 'p1', 'i-abc')).toBe(
      join(home, 'learning', 'p1', 'instincts', 'i-abc.md'),
    );
  });

  test('ensureLearningDirs creates project instinct tree idempotently', () => {
    ensureLearningDirs(home, 'p1');
    expect(existsSync(join(home, 'learning', 'p1', 'instincts'))).toBe(true);
    ensureLearningDirs(home, 'p1'); // idempotent
  });

  test('ensureGlobalLearningDirs creates _global tree', () => {
    ensureGlobalLearningDirs(home);
    expect(existsSync(join(home, 'learning', GLOBAL_PROJECT_ID, 'instincts'))).toBe(true);
  });
});

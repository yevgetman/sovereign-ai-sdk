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

  // FIX 4 (defense-in-depth) — the project id is synthesizer-LLM-supplied and
  // becomes a filesystem path segment. A traversal id like '../../x' must be
  // rejected before it's joined, mirroring the userId guard.
  describe('projectId path-segment validation', () => {
    const traversal = ['../../x', '..', 'a/b', 'foo/../bar', './x', '.', 'a\\b', ''];

    for (const bad of traversal) {
      test(`projectRoot rejects traversal projectId ${JSON.stringify(bad)}`, () => {
        expect(() => projectRoot(home, bad)).toThrow();
      });
      test(`instinctPath rejects traversal projectId ${JSON.stringify(bad)}`, () => {
        expect(() => instinctPath(home, bad, 'i-1')).toThrow();
      });
      test(`observationsPath rejects traversal projectId ${JSON.stringify(bad)}`, () => {
        expect(() => observationsPath(home, bad)).toThrow();
      });
    }

    test('legitimate hex project id (getProjectId format) is accepted', () => {
      // getProjectId returns a 16-char SHA-256 hex slice.
      const id = 'a1b2c3d4e5f6a7b8';
      expect(projectRoot(home, id)).toBe(join(home, 'learning', id));
    });

    test('legitimate name-hash style project id is accepted', () => {
      const id = 'sovereign-harness-ab12cd34';
      expect(instinctsDir(home, id)).toBe(join(home, 'learning', id, 'instincts'));
    });

    test('the _global sentinel project id is accepted', () => {
      expect(projectRoot(home, GLOBAL_PROJECT_ID)).toBe(join(home, 'learning', GLOBAL_PROJECT_ID));
    });
  });

  // Finding #13 (sibling of FIX 4) — the instinct id is the SECOND path
  // segment and is synthesizer-LLM-supplied (validated only as
  // z.string().min(1) at the tool boundary). A traversal id like
  // '../../../../tmp/secret' must be rejected before it's joined, or it
  // escapes the project's instincts dir (arbitrary read / cross-user instinct
  // leak). FIX 4 hardened projectId but left instinctId open.
  describe('instinctId path-segment validation', () => {
    const validProjectId = 'a1b2c3d4e5f6a7b8';
    const traversal = [
      '../../../../tmp/secret',
      '..',
      '../../alice/learning/abcdef0123456789/instincts/20260610-real',
      'a/b',
      'foo/../bar',
      './x',
      '.',
      'a\\b',
      '20260610.real',
      '',
    ];

    for (const bad of traversal) {
      test(`instinctPath rejects traversal instinctId ${JSON.stringify(bad)}`, () => {
        expect(() => instinctPath(home, validProjectId, bad)).toThrow();
      });
    }

    test('legitimate timestamp-hex instinct id (newInstinctId format) is accepted', () => {
      // newInstinctId() emits `<14-digit-timestamp>-<12-hex>`.
      const id = '20260610120000-abcdef012345';
      expect(instinctPath(home, validProjectId, id)).toBe(
        join(home, 'learning', validProjectId, 'instincts', `${id}.md`),
      );
    });

    test('a traversal instinctId cannot escape even with a valid projectId + userId', () => {
      // The escape FIX 4 missed: project_id passes, but '../../...' as the id
      // would resolve outside the instincts dir. Must throw at the chokepoint.
      expect(() => instinctPath(home, validProjectId, '../../../../tmp/secret', 'bob')).toThrow();
    });
  });
});

// tests/learning-layer/index.test.ts
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsPersist } from '../../src/learning-layer/adapters/harness/persistFs.js';
import { createLearningLayer } from '../../src/learning-layer/index.js';
import { serializeInstinct } from '../../src/learning/instinctSerde.js';
import type { Instinct } from '../../src/learning/types.js';

const home = mkdtempSync(join(tmpdir(), 'layer-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('createLearningLayer.recall', () => {
  test('returns a formatted snapshot for a relevant seeded instinct', async () => {
    const persist = createFsPersist(home);
    const inst: Instinct = {
      id: 'tests',
      trigger: 'running the test suite',
      action: 'use bun test',
      confidence: 0.6,
      evidence_count: 10,
      domain: 'testing',
      scope: 'project',
      project_id: 'proj',
      project_name: 'demo',
      created_at: '2026-06-03T00:00:00.000Z',
      last_evidence_at: '2026-06-03T00:00:00.000Z',
      observation_ids: [],
    };
    await persist.write('learning/proj/instincts/tests.md', serializeInstinct(inst, ''));
    const layer = createLearningLayer({ persist, reason: { complete: async () => '' } });
    const res = await layer.recall({
      projectId: 'proj',
      latestUserText: 'run the test suite',
      tokenBudget: 1000,
      maxLessons: 8,
    });
    expect(res.injectionText).toContain('use bun test');
    expect(res.lessons.map((l) => l.id)).toContain('tests');
  });

  test('recall is fail-open: a broken corpus yields an empty result, not a throw', async () => {
    const persist = createFsPersist(mkdtempSync(join(tmpdir(), 'layer2-')));
    const layer = createLearningLayer({ persist, reason: { complete: async () => '' } });
    const res = await layer.recall({
      projectId: 'nope',
      latestUserText: 'x',
      tokenBudget: 1000,
      maxLessons: 8,
    });
    expect(res).toEqual({ injectionText: '', lessons: [] });
  });
});

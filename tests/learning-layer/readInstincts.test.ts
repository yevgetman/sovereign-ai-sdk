// tests/learning-layer/readInstincts.test.ts
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsPersist } from '../../src/learning-layer/adapters/harness/persistFs.js';
import { readInstincts } from '../../src/learning-layer/recall/readInstincts.js';
import { serializeInstinct } from '../../src/learning/instinctSerde.js';
import type { Instinct } from '../../src/learning/types.js';

const home = mkdtempSync(join(tmpdir(), 'read-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const inst = (id: string, over: Partial<Instinct> = {}): Instinct =>
  ({
    id,
    trigger: `t-${id}`,
    action: `a-${id}`,
    confidence: 0.5,
    evidence_count: 6,
    domain: 'testing',
    scope: 'project',
    project_id: 'proj',
    project_name: 'demo',
    created_at: '2026-06-03T00:00:00.000Z',
    last_evidence_at: '2026-06-03T00:00:00.000Z',
    observation_ids: [],
    ...over,
  }) as Instinct;

describe('readInstincts', () => {
  test('reads project + _global instincts; tolerates a malformed file', async () => {
    const p = createFsPersist(home);
    await p.write('learning/proj/instincts/a.md', serializeInstinct(inst('a'), ''));
    await p.write(
      'learning/_global/instincts/g.md',
      serializeInstinct(inst('g', { scope: 'global', project_id: null, project_name: null }), ''),
    );
    await p.write('learning/proj/instincts/broken.md', 'garbage');
    const got = await readInstincts(p, 'proj');
    expect(got.map((i) => i.id).sort()).toEqual(['a', 'g']); // broken skipped, not thrown
  });
});

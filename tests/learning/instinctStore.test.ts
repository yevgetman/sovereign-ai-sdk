import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstinctStore } from '../../src/learning/instinctStore.js';
import { GLOBAL_PROJECT_ID, ensureLearningDirs, instinctPath } from '../../src/learning/paths.js';
import type { Instinct } from '../../src/learning/types.js';

function makeInstinct(overrides: Partial<Instinct> = {}): Instinct {
  return {
    id: '01HKZQR8M5N6P7Q8R9S0T1U2V3',
    trigger: 'when writing TS function',
    action: 'add return type annotation',
    confidence: 0.62,
    evidence_count: 8,
    domain: 'code-style',
    scope: 'project',
    project_id: 'p1',
    project_name: 'sovereign-ai-sdk',
    created_at: '2026-05-06T10:00:00Z',
    last_evidence_at: '2026-05-06T15:30:00Z',
    observation_ids: ['obs-aaa1', 'obs-aaa2'],
    ...overrides,
  };
}

describe('InstinctStore', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-store-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('write + read round-trip preserves all fields including observation_ids array', () => {
    const store = new InstinctStore(home);
    const instinct = makeInstinct();
    store.write(instinct, '# Body content\n\nEvidence summary here.');
    const round = store.read('p1', instinct.id);
    expect(round).toEqual(instinct);
  });

  test('readWithBody returns parsed instinct + raw body', () => {
    const store = new InstinctStore(home);
    const instinct = makeInstinct();
    store.write(instinct, '# Body\n\nLine two.');
    const result = store.readWithBody('p1', instinct.id);
    expect(result.instinct).toEqual(instinct);
    expect(result.body).toContain('# Body');
    expect(result.body).toContain('Line two');
  });

  test('global-scope instincts land under _global directory', () => {
    const store = new InstinctStore(home);
    const instinct = makeInstinct({ scope: 'global', project_id: null });
    store.write(instinct, 'global body');
    const round = store.read(GLOBAL_PROJECT_ID, instinct.id);
    expect(round.scope).toBe('global');
    expect(round.project_id).toBeNull();
  });

  test('write throws when scope=project but project_id is null', () => {
    const store = new InstinctStore(home);
    const bad = makeInstinct({ project_id: null });
    expect(() => store.write(bad, 'body')).toThrow();
  });

  // FIX 4 (defense-in-depth) — a synthesizer-supplied project_id that contains
  // a path traversal must be rejected at the path boundary, never written
  // outside the project's learning dir.
  test('write rejects a path-traversal project_id', () => {
    const store = new InstinctStore(home);
    const bad = makeInstinct({ project_id: '../../escape' });
    expect(() => store.write(bad, 'body')).toThrow();
  });

  test('list returns empty array on missing project dir', () => {
    const store = new InstinctStore(home);
    expect(store.list('does-not-exist')).toEqual([]);
  });

  test('list skips malformed .md files (does not throw)', () => {
    const store = new InstinctStore(home);
    ensureLearningDirs(home, 'p1');
    // Write one valid + one malformed
    const valid = makeInstinct();
    store.write(valid, 'ok');
    writeFileSync(instinctPath(home, 'p1', 'malformed'), 'not yaml at all');
    const items = store.list('p1');
    expect(items.length).toBe(1);
    expect(items[0]?.id).toBe(valid.id);
  });

  test('remove deletes the file (no error on missing)', () => {
    const store = new InstinctStore(home);
    const instinct = makeInstinct();
    store.write(instinct, 'body');
    store.remove('p1', instinct.id);
    expect(store.list('p1')).toEqual([]);
    // No throw on second call
    store.remove('p1', instinct.id);
  });

  test('listAllProjects enumerates project ids excluding _global', () => {
    const store = new InstinctStore(home);
    store.write(makeInstinct({ project_id: 'projA' }), 'a');
    store.write(makeInstinct({ id: 'i2', project_id: 'projB' }), 'b');
    store.write(makeInstinct({ id: 'i3', scope: 'global', project_id: null }), 'g');
    const projects = store.listAllProjects().sort();
    expect(projects).toEqual(['projA', 'projB']);
  });
});

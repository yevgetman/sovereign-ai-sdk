// Phase 13.4 — tests for `harness learning {status,prune,export}` CLI handlers.
// Each test uses a fresh tmpdir for harnessHome to keep state hermetic.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';
import { formatExportResult, runLearningExport } from '../../src/cli/learningExport.js';
import { formatPruneResult, runLearningPrune } from '../../src/cli/learningPrune.js';
import { formatLearningStatus, getLearningStatus } from '../../src/cli/learningStatus.js';
import { InstinctStore } from '../../src/learning/instinctStore.js';
import type { Instinct } from '../../src/learning/types.js';

chalk.level = 1;
function strip(s: string): string {
  return s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
}

function makeInstinct(overrides: Partial<Instinct> = {}): Instinct {
  return {
    id: '01HKZQR8M5N6P7Q8R9S0T1U2V3',
    trigger: 'when writing TS function',
    action: 'add return type annotation',
    confidence: 0.62,
    evidence_count: 8,
    domain: 'code-style',
    scope: 'project',
    project_id: 'proj-1',
    project_name: 'sovereign',
    created_at: '2026-05-06T10:00:00Z',
    last_evidence_at: '2026-05-06T10:00:00Z',
    observation_ids: ['o1'],
    ...overrides,
  };
}

describe('learning status', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-learning-status-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('formats empty state cleanly', () => {
    expect(strip(formatLearningStatus([]))).toContain('no instincts yet');
  });

  test('counts instincts per project + by domain + confidence histogram', () => {
    const store = new InstinctStore(home);
    store.write(makeInstinct({ id: 'i1', confidence: 0.5 }), 'b');
    store.write(makeInstinct({ id: 'i2', confidence: 0.85, domain: 'testing' }), 'b');
    const result = getLearningStatus({ harnessHome: home, project: 'proj-1' });
    expect(result.length).toBe(1);
    const s = result[0];
    if (!s) throw new Error('expected status');
    expect(s.total).toBe(2);
    expect(s.byDomain['code-style']).toBe(1);
    expect(s.byDomain.testing).toBe(1);
    expect(s.histogram.from30to70).toBe(1);
    expect(s.histogram.gte70).toBe(1);
  });

  test('skips empty projects in summary mode but includes specified project', () => {
    const store = new InstinctStore(home);
    store.write(makeInstinct({ id: 'i1', project_id: 'proj-1' }), 'b');
    // Summary mode: only proj-1 reported
    const summary = getLearningStatus({ harnessHome: home });
    expect(summary.some((s) => s.projectId === 'proj-1')).toBe(true);
    // Explicit empty project: returns one row (count 0)
    const explicit = getLearningStatus({ harnessHome: home, project: 'empty' });
    expect(explicit.length).toBe(1);
    expect(explicit[0]?.total).toBe(0);
  });
});

describe('learning prune', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-learning-prune-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('formats empty result cleanly', () => {
    const result = runLearningPrune({ harnessHome: home });
    expect(result.candidates.length).toBe(0);
    expect(strip(formatPruneResult(result))).toContain('no instincts to prune');
  });

  test('removes sub-threshold + aged instincts; preserves recent / high-confidence', () => {
    const store = new InstinctStore(home);
    const oldDate = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const recentDate = new Date(Date.now() - 5 * 86_400_000).toISOString();
    // Aged + sub-threshold → should prune
    store.write(makeInstinct({ id: 'aged-low', confidence: 0.2, last_evidence_at: oldDate }), 'b');
    // Aged but high-confidence → keep
    store.write(makeInstinct({ id: 'aged-high', confidence: 0.5, last_evidence_at: oldDate }), 'b');
    // Recent but sub-threshold → keep
    store.write(
      makeInstinct({ id: 'recent-low', confidence: 0.2, last_evidence_at: recentDate }),
      'b',
    );

    const result = runLearningPrune({ harnessHome: home, project: 'proj-1' });
    expect(result.removed).toBe(1);
    expect(result.candidates[0]?.instinct.id).toBe('aged-low');
    expect(
      store
        .list('proj-1')
        .map((i) => i.id)
        .sort(),
    ).toEqual(['aged-high', 'recent-low']);
  });

  test('--dry-run lists without removing', () => {
    const store = new InstinctStore(home);
    const oldDate = new Date(Date.now() - 60 * 86_400_000).toISOString();
    store.write(makeInstinct({ id: 'aged-low', confidence: 0.2, last_evidence_at: oldDate }), 'b');
    const result = runLearningPrune({ harnessHome: home, project: 'proj-1', dryRun: true });
    expect(result.removed).toBe(0);
    expect(result.candidates.length).toBe(1);
    // file still on disk
    expect(store.list('proj-1').length).toBe(1);
  });
});

describe('learning export', () => {
  let home: string;
  let outDir: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-learning-export-home-'));
    outDir = mkdtempSync(join(tmpdir(), 'sov-learning-export-out-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });

  test('returns count + null destination when no --output', () => {
    const result = runLearningExport({ projectId: 'proj-1', harnessHome: home });
    expect(result.count).toBe(0);
    expect(result.destination).toBeNull();
  });

  test('writes one .md per instinct under --output dir', () => {
    const store = new InstinctStore(home);
    store.write(makeInstinct({ id: 'i1' }), '# body 1');
    store.write(makeInstinct({ id: 'i2' }), '# body 2');
    const result = runLearningExport({ projectId: 'proj-1', output: outDir, harnessHome: home });
    expect(result.count).toBe(2);
    expect(result.destination).toBe(outDir);
    expect(result.files.length).toBe(2);
    for (const f of result.files) {
      expect(existsSync(f)).toBe(true);
      const content = readFileSync(f, 'utf-8');
      expect(content).toMatch(/^---/);
    }
  });

  test('formatExportResult shows counts cleanly', () => {
    expect(
      strip(formatExportResult({ projectId: 'p', count: 0, destination: null, files: [] })),
    ).toContain('no instincts found');
    expect(
      strip(formatExportResult({ projectId: 'p', count: 3, destination: '/tmp/out', files: [] })),
    ).toContain('3 instinct(s) exported to /tmp/out');
  });
});

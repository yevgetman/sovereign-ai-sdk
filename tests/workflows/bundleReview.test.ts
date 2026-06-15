// W6 — verify the example workflow shipped in bundle-default/workflows/ is
// valid against the live WorkflowDefSchema and structurally matches the
// fan-out → verify → synthesize pattern documented in usage.md / extending.md.
// Guards against a schema change (src/workflows/types.ts) silently invalidating
// the shipped example, and against the example drifting from the docs. Mirrors
// tests/agents/bundleDefault.test.ts (the bundled-artifact test precedent).

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadAgents } from '../../src/agents/loader.js';
import { WorkflowDefSchema } from '../../src/workflows/types.js';

const BUNDLE_DEFAULT_ROOT = join(import.meta.dir, '..', '..', 'bundle-default');
const REVIEW_PATH = join(BUNDLE_DEFAULT_ROOT, 'workflows', 'review.yaml');

async function loadReviewDef() {
  const raw = await readFile(REVIEW_PATH, 'utf8');
  const parsed = WorkflowDefSchema.safeParse(parseYaml(raw));
  return parsed;
}

describe('bundle-default review workflow', () => {
  test('parses cleanly against WorkflowDefSchema', async () => {
    const parsed = await loadReviewDef();
    if (!parsed.success) {
      throw new Error(`review.yaml invalid: ${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
    expect(parsed.data.name).toBe('review');
    expect(parsed.data.description.length).toBeGreaterThan(10);
  });

  test('declares the diff + dimensions args the docs describe', async () => {
    const parsed = await loadReviewDef();
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const args = parsed.data.args ?? {};
    expect(args.diff?.type).toBe('string');
    expect(args.diff?.required).toBe(true);
    expect(args.dimensions?.type).toBe('list');
    expect(args.dimensions?.required).toBe(true);
  });

  test('implements the fan-out → verify → synthesize phase shape', async () => {
    const parsed = await loadReviewDef();
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const phases = parsed.data.phases;
    expect(phases.map((p) => p.id)).toEqual(['find', 'verify', 'synthesize']);

    // Phase 1: parallel map fan-out over the args list, JSON output to thread on.
    const find = phases[0];
    expect(find?.map?.over).toBe('args.dimensions');
    expect(find?.task?.output).toBe('json');

    // Phase 2: dynamic fan-out over the prior phase's flattened JSON output.
    const verify = phases[1];
    expect(verify?.map?.over).toBe('find.findings');
    expect(verify?.task?.output).toBe('json');

    // Phase 3: a fixed single-task synthesis (tasks form, not bare task).
    const synthesize = phases[2];
    expect(synthesize?.tasks).toHaveLength(1);
    expect(synthesize?.map).toBeUndefined();
  });

  test('threads outputs forward via the documented refs', async () => {
    const raw = await readFile(REVIEW_PATH, 'utf8');
    // The verify phase consumes a finding field; synthesis consumes the map results.
    expect(raw).toContain('{{dimension}}');
    expect(raw).toContain('{{args.diff}}');
    expect(raw).toContain('{{finding.claim}}');
    expect(raw).toContain('{{verify.results}}');
  });

  test('every referenced agent exists in the bundle registry', async () => {
    const parsed = await loadReviewDef();
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const tmpHome = mkdtempSync(join(tmpdir(), 'sovereign-workflow-agents-'));
    try {
      const registry = await loadAgents({
        cwd: tmpHome,
        harnessHome: tmpHome,
        bundleRoot: BUNDLE_DEFAULT_ROOT,
      });
      const referenced = new Set<string>();
      for (const phase of parsed.data.phases) {
        if (phase.task) referenced.add(phase.task.agent);
        for (const t of phase.tasks ?? []) referenced.add(t.agent);
      }
      expect([...referenced].sort()).toEqual(['explore', 'plan', 'verify']);
      for (const name of referenced) {
        expect(registry.byName.has(name)).toBe(true);
      }
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('is side-effect free: no task declares writes (all read-only)', async () => {
    const parsed = await loadReviewDef();
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    for (const phase of parsed.data.phases) {
      const tasks = [phase.task, ...(phase.tasks ?? [])].filter((t) => t !== undefined);
      for (const t of tasks) {
        expect(t?.writes).toBeUndefined();
      }
    }
  });

  test('the synthesis lane override names a recognized cost lane', async () => {
    const parsed = await loadReviewDef();
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const recognizedLanes = new Set(['cheap-task', 'moderate-task', 'frontier-task']);
    const synthTask = parsed.data.phases[2]?.tasks?.[0];
    expect(synthTask?.lane).toBeDefined();
    expect(recognizedLanes.has(synthTask?.lane ?? '')).toBe(true);
  });
});

// tests/learning/integration.test.ts
// Phase 13.4 Task 11 — end-to-end integration. No real model calls; fake
// scheduler simulates the synthesizer's child dispatch. Exercises every
// surface from observation writer through promotion logic.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLearningStatus } from '../../src/cli/learningStatus.js';
import { reinforce } from '../../src/learning/confidence.js';
import { InstinctStore } from '../../src/learning/instinctStore.js';
import { LearningObserver } from '../../src/learning/observer.js';
import { observationsPath } from '../../src/learning/paths.js';
import { __test_resetProjectIdCache, getProjectId } from '../../src/learning/project.js';
import { findPromotionCandidates } from '../../src/learning/promotion.js';
import { runSynthesizer } from '../../src/learning/synthesizer.js';
import type { Instinct } from '../../src/learning/types.js';
import type { SubagentScheduler } from '../../src/runtime/scheduler.js';
import type { Tool, ToolContext, ToolResult } from '../../src/tool/types.js';
import { InstinctProposeTool } from '../../src/tools/InstinctProposeTool.js';
import { InstinctUpdateConfidenceTool } from '../../src/tools/InstinctUpdateConfidenceTool.js';

function makeCtx(home: string, sessionId = 'sess-1'): ToolContext {
  return { cwd: '/tmp', sessionId, harnessHome: home } as unknown as ToolContext;
}

function fakeScheduler(record: Array<Record<string, unknown>>): SubagentScheduler {
  return {
    delegate: async (input: Record<string, unknown>) => {
      record.push(input);
      return {
        childSessionId: 'child-1',
        agentName: input.agentName,
        resolvedProvider: 'fake',
        resolvedModel: 'fake-1',
        terminal: { reason: 'completed' as const },
        summary: 'ok',
        iterationsUsed: 1,
        toolCallCount: 0,
        durationMs: 1,
      };
    },
  } as unknown as SubagentScheduler;
}

describe('Phase 13.4 — end-to-end Check (synthetic)', () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    __test_resetProjectIdCache();
    home = mkdtempSync(join(tmpdir(), 'sov-13.4-int-home-'));
    cwd = mkdtempSync(join(tmpdir(), 'sov-13.4-int-cwd-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  test('observe → write 20 records to observations.jsonl', async () => {
    const observer = new LearningObserver({ harnessHome: home, cwd, sessionId: 'sess-1' });
    for (let i = 0; i < 20; i++) {
      observer.observe({
        toolName: i % 2 === 0 ? 'Bash' : 'FileRead',
        toolInput: { i },
        status: 'success',
        durationMs: 5,
      });
    }
    await observer.drain();
    const project = getProjectId(cwd);
    const path = observationsPath(home, project.id);
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(20);
  });

  test('propose 3 instincts → instinct files appear with correct shape', async () => {
    const ctx = makeCtx(home);
    const proposed: Instinct[] = [];
    for (const seed of [
      {
        trigger: 'when writing TS function',
        action: 'add return type',
        domain: 'code-style' as const,
        evidence_count: 6,
      },
      {
        trigger: 'before pushing',
        action: 'run lint + typecheck',
        domain: 'workflow' as const,
        evidence_count: 4,
      },
      {
        trigger: 'when adding new test',
        action: 'AAA structure',
        domain: 'testing' as const,
        evidence_count: 5,
      },
    ]) {
      const result = (await InstinctProposeTool.call(
        {
          trigger: seed.trigger,
          action: seed.action,
          evidence_count: seed.evidence_count,
          domain: seed.domain,
          scope: 'project',
          project_id: 'proj-1',
          project_name: 'sov',
          observation_ids: ['o1', 'o2', 'o3'],
        },
        ctx,
      )) as ToolResult<{ instinct: Instinct }>;
      proposed.push(result.data.instinct);
    }
    expect(proposed.length).toBe(3);

    const store = new InstinctStore(home);
    const onDisk = store.list('proj-1');
    expect(onDisk.length).toBe(3);
    for (const inst of onDisk) {
      expect(inst.confidence).toBeGreaterThan(0);
      expect(inst.confidence).toBeLessThan(0.9);
      expect(inst.scope).toBe('project');
      expect(inst.project_id).toBe('proj-1');
    }
  });

  test('reinforce + contradict update confidence per the pure helpers', async () => {
    const ctx = makeCtx(home);
    const created = (await InstinctProposeTool.call(
      {
        trigger: 't',
        action: 'a',
        evidence_count: 5,
        domain: 'code-style',
        scope: 'project',
        project_id: 'proj-1',
        project_name: 'sov',
        observation_ids: [],
      },
      ctx,
    )) as ToolResult<{ instinct: Instinct }>;
    const initialConfidence = created.data.instinct.confidence;
    const id = created.data.instinct.id;

    // Reinforce with 3 new pieces of evidence — confidence must rise
    const reinforced = (await InstinctUpdateConfidenceTool.call(
      {
        id,
        project_id: 'proj-1',
        action: 'reinforce',
        evidence_count: 3,
        reason: 'more evidence seen',
      },
      ctx,
    )) as ToolResult<{ instinct: Instinct; previousConfidence: number }>;
    expect(reinforced.data.instinct.confidence).toBeGreaterThan(initialConfidence);
    // Math should equal the pure reinforce() output
    expect(reinforced.data.instinct.confidence).toBeCloseTo(reinforce(initialConfidence, 3), 3);

    // Contradict drops confidence sharply
    const contradicted = (await InstinctUpdateConfidenceTool.call(
      { id, project_id: 'proj-1', action: 'contradict', reason: 'user rejected pattern' },
      ctx,
    )) as ToolResult<{ instinct: Instinct; previousConfidence: number }>;
    expect(contradicted.data.instinct.confidence).toBeLessThan(reinforced.data.instinct.confidence);
  });

  test('cross-project promotion surfaces matching instincts above threshold', async () => {
    const ctx = makeCtx(home);
    // Project A: same trigger+action+domain
    await InstinctProposeTool.call(
      {
        trigger: 'when writing TS function',
        action: 'add return type',
        evidence_count: 12,
        domain: 'code-style',
        scope: 'project',
        project_id: 'projA',
        project_name: 'A',
        observation_ids: [],
      },
      ctx,
    );
    // Project B: same trigger+action+domain
    await InstinctProposeTool.call(
      {
        trigger: 'when writing TS function',
        action: 'add return type',
        evidence_count: 8,
        domain: 'code-style',
        scope: 'project',
        project_id: 'projB',
        project_name: 'B',
        observation_ids: [],
      },
      ctx,
    );
    // Project A: a different instinct (single-project, won't promote)
    await InstinctProposeTool.call(
      {
        trigger: 'before pushing',
        action: 'run lint',
        evidence_count: 5,
        domain: 'workflow',
        scope: 'project',
        project_id: 'projA',
        project_name: 'A',
        observation_ids: [],
      },
      ctx,
    );

    const store = new InstinctStore(home);
    const allInstincts: Instinct[] = [];
    for (const projectId of store.listAllProjects()) {
      allInstincts.push(...store.list(projectId));
    }
    // A single InstinctProposeTool call yields confidence ≈ 0.07-0.10
    // (logarithmic reinforce from zero), well below the default 0.7 floor.
    // Lower the threshold for this synthetic check so the math is the focus,
    // not the confidence-curve calibration.
    const candidates = findPromotionCandidates(allInstincts, { minConfidence: 0.05 });
    expect(candidates.length).toBe(1);
    expect(candidates[0]?.trigger).toBe('when writing TS function');
    expect(candidates[0]?.evidenceProjects.length).toBe(2);
    const projectIds = candidates[0]?.evidenceProjects.map((p) => p.projectId).sort();
    expect(projectIds).toEqual(['projA', 'projB']);
  });

  test('learning status rolls up counts correctly per project', async () => {
    const ctx = makeCtx(home);
    // Two instincts in projA, one in projB
    for (let i = 0; i < 2; i++) {
      await InstinctProposeTool.call(
        {
          trigger: `t${i}`,
          action: 'a',
          evidence_count: 5,
          domain: 'code-style',
          scope: 'project',
          project_id: 'projA',
          project_name: 'A',
          observation_ids: [],
        },
        ctx,
      );
    }
    await InstinctProposeTool.call(
      {
        trigger: 'tB',
        action: 'a',
        evidence_count: 5,
        domain: 'testing',
        scope: 'project',
        project_id: 'projB',
        project_name: 'B',
        observation_ids: [],
      },
      ctx,
    );

    const statuses = getLearningStatus({ harnessHome: home });
    const projA = statuses.find((s) => s.projectId === 'projA');
    const projB = statuses.find((s) => s.projectId === 'projB');
    expect(projA?.total).toBe(2);
    expect(projA?.byDomain['code-style']).toBe(2);
    expect(projB?.total).toBe(1);
    expect(projB?.byDomain.testing).toBe(1);
  });

  test('runSynthesizer dispatches with augmented pool + correct prompt', async () => {
    const calls: Array<Record<string, unknown>> = [];
    await runSynthesizer({
      scheduler: fakeScheduler(calls),
      parentSessionId: 'parent-1',
      parentSignal: new AbortController().signal,
      parentToolPool: [] as Tool<unknown, unknown>[],
      parentToolContext: makeCtx(home, 'parent-1'),
      harnessHome: home,
      projectId: 'proj-abc',
      projectName: 'sov',
      recentObservationCount: 50,
    });

    expect(calls.length).toBe(1);
    const call = calls[0];
    expect(call?.agentName).toBe('instinct-synthesizer');
    expect(call?.prompt as string).toContain('proj-abc');
    expect(call?.prompt as string).toContain('observations.jsonl');

    // Augmented pool contains all 4 instinct tools
    const pool = call?.parentToolPool as Array<{ name: string }>;
    const names = new Set(pool.map((t) => t.name));
    expect(names.has('instinct_list')).toBe(true);
    expect(names.has('instinct_view')).toBe(true);
    expect(names.has('instinct_propose')).toBe(true);
    expect(names.has('instinct_update_confidence')).toBe(true);
  });
});

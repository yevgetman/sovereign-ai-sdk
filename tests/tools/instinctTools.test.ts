import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Instinct } from '../../src/learning/types.js';
import type { ToolContext } from '../../src/tool/types.js';
import { InstinctListTool } from '../../src/tools/InstinctListTool.js';
import { InstinctProposeTool } from '../../src/tools/InstinctProposeTool.js';
import { InstinctUpdateConfidenceTool } from '../../src/tools/InstinctUpdateConfidenceTool.js';
import { InstinctViewTool } from '../../src/tools/InstinctViewTool.js';

function makeCtx(home: string): ToolContext {
  return { cwd: '/tmp', sessionId: 'sess-1', harnessHome: home } as unknown as ToolContext;
}

describe('instinct tools', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-instinct-tools-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('instinct_propose creates an instinct with computed initial confidence', async () => {
    const ctx = makeCtx(home);
    const result = await InstinctProposeTool.call(
      {
        trigger: 'when writing TS function',
        action: 'add return type annotation',
        evidence_count: 5,
        domain: 'code-style',
        scope: 'project',
        project_id: 'p1',
        project_name: 'pp',
        observation_ids: ['o1', 'o2', 'o3'],
      },
      ctx,
    );
    const data = result.data as { instinct: Instinct };
    expect(data.instinct.id).toMatch(/^[0-9]{14}-[0-9a-f]{12}$/);
    expect(data.instinct.confidence).toBeGreaterThan(0);
    expect(data.instinct.confidence).toBeLessThan(0.9);
    expect(data.instinct.evidence_count).toBe(5);
  });

  test('instinct_propose throws when scope=project + project_id=null', async () => {
    await expect(
      InstinctProposeTool.call(
        {
          trigger: 't',
          action: 'a',
          evidence_count: 3,
          domain: 'code-style',
          scope: 'project',
          project_id: null,
          project_name: null,
          observation_ids: [],
        },
        makeCtx(home),
      ),
    ).rejects.toThrow();
  });

  test('instinct_view fetches the instinct + body', async () => {
    const ctx = makeCtx(home);
    const created = await InstinctProposeTool.call(
      {
        trigger: 't',
        action: 'a',
        evidence_count: 5,
        domain: 'code-style',
        scope: 'project',
        project_id: 'p1',
        project_name: 'pp',
        observation_ids: ['o1'],
      },
      ctx,
    );
    const id = (created.data as { instinct: Instinct }).instinct.id;
    const view = await InstinctViewTool.call({ project_id: 'p1', id }, ctx);
    const viewed = view.data as { instinct: Instinct; body: string };
    expect(viewed.instinct.id).toBe(id);
    expect(viewed.body.length).toBeGreaterThan(0);
  });

  test('instinct_list filters by domain/scope/min_confidence', async () => {
    const ctx = makeCtx(home);
    await InstinctProposeTool.call(
      {
        trigger: 't1',
        action: 'a1',
        evidence_count: 5,
        domain: 'code-style',
        scope: 'project',
        project_id: 'p1',
        project_name: 'pp',
        observation_ids: [],
      },
      ctx,
    );
    await InstinctProposeTool.call(
      {
        trigger: 't2',
        action: 'a2',
        evidence_count: 5,
        domain: 'testing',
        scope: 'project',
        project_id: 'p1',
        project_name: 'pp',
        observation_ids: [],
      },
      ctx,
    );
    const all = await InstinctListTool.call({ project_id: 'p1' }, ctx);
    expect((all.data as { instincts: Instinct[] }).instincts.length).toBe(2);
    const filtered = await InstinctListTool.call({ project_id: 'p1', domain: 'testing' }, ctx);
    expect((filtered.data as { instincts: Instinct[] }).instincts.length).toBe(1);
  });

  test('instinct_update_confidence reinforce raises confidence; contradict drops it', async () => {
    const ctx = makeCtx(home);
    const created = await InstinctProposeTool.call(
      {
        trigger: 't',
        action: 'a',
        evidence_count: 5,
        domain: 'code-style',
        scope: 'project',
        project_id: 'p1',
        project_name: 'pp',
        observation_ids: [],
      },
      ctx,
    );
    const id = (created.data as { instinct: Instinct }).instinct.id;

    const reinforced = await InstinctUpdateConfidenceTool.call(
      { id, project_id: 'p1', action: 'reinforce', evidence_count: 3, reason: 'more evidence' },
      ctx,
    );
    const r = reinforced.data as { instinct: Instinct; previousConfidence: number };
    expect(r.instinct.confidence).toBeGreaterThan(r.previousConfidence);

    const contradicted = await InstinctUpdateConfidenceTool.call(
      { id, project_id: 'p1', action: 'contradict', reason: 'user rejected' },
      ctx,
    );
    const c = contradicted.data as { instinct: Instinct; previousConfidence: number };
    expect(c.instinct.confidence).toBeLessThan(c.previousConfidence);
  });

  test('all four tools throw when harnessHome is absent', async () => {
    const noHome = { cwd: '/tmp', sessionId: 'x' } as unknown as ToolContext;
    const minimalProposeInput = {
      trigger: 't',
      action: 'a',
      evidence_count: 3,
      domain: 'code-style' as const,
      scope: 'project' as const,
      project_id: 'p1',
      project_name: 'pp',
      observation_ids: [],
    };
    await expect(InstinctListTool.call({ project_id: 'p1' }, noHome)).rejects.toThrow(
      /harnessHome/,
    );
    await expect(InstinctViewTool.call({ project_id: 'p1', id: 'x' }, noHome)).rejects.toThrow(
      /harnessHome/,
    );
    await expect(InstinctProposeTool.call(minimalProposeInput, noHome)).rejects.toThrow(
      /harnessHome/,
    );
    await expect(
      InstinctUpdateConfidenceTool.call(
        { id: 'x', project_id: 'p1', action: 'reinforce', reason: 'r' },
        noHome,
      ),
    ).rejects.toThrow(/harnessHome/);
  });
});

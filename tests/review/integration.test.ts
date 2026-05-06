// Phase 13.3 — end-to-end Check: propose, approve, reject, list, consolidate.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';
import { REVIEW_OPS_COMMANDS } from '../../src/commands/reviewOps.js';
import { ReviewManager } from '../../src/review/manager.js';
import type { SubagentScheduler } from '../../src/runtime/scheduler.js';
import type { Tool, ToolContext } from '../../src/tool/types.js';
import { MemoryProposeTool } from '../../src/tools/MemoryProposeTool.js';
import { SkillProposeTool } from '../../src/tools/SkillProposeTool.js';
import { makeCtx } from '../commands/_makeCtx.js';

chalk.level = 1;

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

function strip(s: string): string {
  return s.replace(ANSI, '');
}

const reviewCmd = REVIEW_OPS_COMMANDS.find((c) => c.name === 'review');
if (!reviewCmd || reviewCmd.type !== 'local') {
  throw new Error('review command not registered as local');
}

describe('Phase 13.3 — end-to-end Check', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-13.3-int-'));
    mkdirSync(join(home, 'memory'), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('full lifecycle: propose 2 memory + 1 skill → approve 1 memory + 1 skill, reject 1 memory', async () => {
    const toolCtx = {
      cwd: '/tmp',
      sessionId: 'sess-1',
      harnessHome: home,
    } as ToolContext;

    // 1. Propose two memory items + one skill item.
    const m1 = await MemoryProposeTool.call(
      {
        target: 'MEMORY.md',
        memoryType: 'project',
        body: '# pnpm-only\n\n**Why:** lockfile is pnpm.\n\n**How to apply:** install/update commands.',
        sourceMessageRange: [0, 5],
        sourceExcerpt: 'pnpm only',
        traceId: 't1',
      },
      toolCtx,
    );

    const m2 = await MemoryProposeTool.call(
      {
        target: 'USER.md',
        memoryType: 'user',
        body: '# go-first user\n\nUser has 10y of Go, new to React.',
        sourceMessageRange: [6, 10],
        sourceExcerpt: 'go expert',
        traceId: 't2',
      },
      toolCtx,
    );

    const s1 = await SkillProposeTool.call(
      {
        skillName: 'rename-db-column',
        description: 'Two-phase Postgres rename + backfill',
        whenToUse: 'Renaming a NOT NULL column on a large table',
        body: '# rename-db-column\n\n1. Add nullable\n2. Backfill\n3. Swap',
        sourceMessageRange: [11, 30],
        sourceExcerpt: 'rename flow',
        traceId: 't3',
      },
      toolCtx,
    );

    expect(m1.observation?.status).toBe('success');
    expect(m2.observation?.status).toBe('success');
    expect(s1.observation?.status).toBe('success');

    const m1Id = (m1.data as { proposalId: string; path: string }).proposalId;
    const m2Id = (m2.data as { proposalId: string; path: string }).proposalId;
    const s1Id = (s1.data as { proposalId: string; path: string }).proposalId;

    // 2. /review list shows three pending entries.
    const cmdCtx = makeCtx({
      harnessHome: home,
      sessionId: 'sess-1',
    });

    const listBefore = strip(await reviewCmd.call('list', cmdCtx));
    expect(listBefore).toContain(m1Id);
    expect(listBefore).toContain(m2Id);
    expect(listBefore).toContain(s1Id);

    // 3. Approve m1 → MEMORY.md updates with body content.
    const approveM1 = strip(await reviewCmd.call(`approve ${m1Id}`, cmdCtx));
    expect(approveM1.toLowerCase()).toContain('approved');
    expect(readFileSync(join(home, 'memory', 'MEMORY.md'), 'utf-8')).toContain('pnpm-only');

    // 4. Reject m2 → USER.md must NOT exist.
    const rejectM2 = strip(await reviewCmd.call(`reject ${m2Id}`, cmdCtx));
    expect(rejectM2.toLowerCase()).toContain('rejected');
    expect(existsSync(join(home, 'memory', 'USER.md'))).toBe(false);
    expect(existsSync(join(home, 'review', 'rejected', 'memory', `${m2Id}.md`))).toBe(true);

    // 5. Approve s1 → skills/agent-created/<name>/SKILL.md must appear.
    const approveS1 = strip(await reviewCmd.call(`approve ${s1Id}`, cmdCtx));
    expect(approveS1.toLowerCase()).toContain('approved');
    expect(existsSync(join(home, 'skills', 'agent-created', 'rename-db-column', 'SKILL.md'))).toBe(
      true,
    );

    // 6. /review list now empty.
    const listAfter = strip(await reviewCmd.call('list', cmdCtx));
    expect(listAfter.toLowerCase()).toContain('no pending');
  });

  test('/review consolidate dispatches review-consolidate agent via ReviewManager', async () => {
    const seen: string[] = [];

    const fakeScheduler = {
      delegate: async (input: { agentName: string }) => {
        seen.push(input.agentName);
        return {
          childSessionId: 'child-1',
          agentName: input.agentName,
          resolvedProvider: 'fake',
          resolvedModel: 'fake-1',
          terminal: { reason: 'completed' as const },
          summary: 'done',
          iterationsUsed: 1,
          toolCallCount: 0,
          durationMs: 1,
        };
      },
    } as unknown as SubagentScheduler;

    const mgr = new ReviewManager({
      scheduler: fakeScheduler,
      sessionId: 'parent-1',
      signal: new AbortController().signal,
      thresholds: { userTurnsForMemoryReview: 9999, toolIterationsForSkillReview: 9999 },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      parentToolPool: [] as Tool<unknown, unknown>[],
      parentToolContext: {
        cwd: '/tmp',
        sessionId: 'parent-1',
        harnessHome: home,
      } as ToolContext,
    });

    const cmdCtx = makeCtx({
      harnessHome: home,
      sessionId: 'parent-1',
      reviewManager: mgr,
    });

    const out = strip(await reviewCmd.call('consolidate', cmdCtx));
    expect(out.toLowerCase()).toContain('dispatched');

    // Wait for async dispatch to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(seen).toContain('review-consolidate');
  });
});

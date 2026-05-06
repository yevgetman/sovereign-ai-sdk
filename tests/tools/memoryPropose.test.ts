import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMemoryProposal } from '../../src/review/proposal.js';
import type { ToolContext } from '../../src/tool/types.js';
import { MemoryProposeTool } from '../../src/tools/MemoryProposeTool.js';
import type { MemoryProposeOutput } from '../../src/tools/MemoryProposeTool.js';

function makeCtx(home: string, sessionId = 'sess-1'): ToolContext {
  return {
    cwd: '/tmp',
    sessionId,
    harnessHome: home,
  } as ToolContext;
}

describe('memory_propose tool', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-memprop-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('writes a pending proposal with provenance and returns proposalId', async () => {
    const result = await MemoryProposeTool.call(
      {
        target: 'MEMORY.md',
        memoryType: 'project',
        body: 'Use pnpm not npm in this repo\n\n**Why:** lockfile is pnpm-only.\n\n**How to apply:** any install/update command.',
        sourceMessageRange: [4, 8],
        sourceExcerpt: 'user said pnpm',
        traceId: 'trace-abc',
      },
      makeCtx(home),
    );

    expect(result.observation?.status).toBe('success');
    const data = result.data as MemoryProposeOutput;
    expect(data.proposalId).toMatch(/^\d{4}-\d{2}-\d{2}-/);
    expect(result.observation?.artifacts).toBeDefined();

    const proposalId = data.proposalId;
    const file = join(home, 'review', 'pending', 'memory', `${proposalId}.md`);
    expect(existsSync(file)).toBe(true);

    const parsed = parseMemoryProposal(readFileSync(file, 'utf-8'));
    expect(parsed.target).toBe('MEMORY.md');
    expect(parsed.memoryType).toBe('project');
    expect(parsed.sessionId).toBe('sess-1');
    expect(parsed.parentSessionId).toBe(null);
    expect(parsed.traceId).toBe('trace-abc');
    expect(parsed.sourceHash).toMatch(/^sha256:/);
    expect(parsed.author).toBe('review-memory');
    expect(parsed.status).toBe('pending');
    expect(parsed.body).toContain('Use pnpm not npm');
  });

  test('throws when harnessHome is absent', async () => {
    const badCtx = { cwd: '/tmp', sessionId: 'x' } as ToolContext;
    await expect(
      MemoryProposeTool.call(
        {
          target: 'MEMORY.md',
          memoryType: 'project',
          body: 'b',
          sourceMessageRange: [0, 0],
          sourceExcerpt: 'x',
          traceId: 't',
        },
        badCtx,
      ),
    ).rejects.toThrow(/harnessHome/);
  });

  test('auto-promote bypass writes directly to MEMORY.md when reviewAutoPromoteMemory is true', async () => {
    const ctx = {
      cwd: '/tmp',
      sessionId: 'sess-1',
      harnessHome: home,
      reviewAutoPromoteMemory: true,
    } as ToolContext;

    const result = await MemoryProposeTool.call(
      {
        target: 'MEMORY.md',
        memoryType: 'project',
        body: 'auto-promoted entry body',
        sourceMessageRange: [0, 1],
        sourceExcerpt: 'x',
        traceId: 't',
      },
      ctx,
    );

    expect(result.observation?.status).toBe('success');
    expect(result.observation?.summary).toContain('auto-promoted');

    const memFile = join(home, 'memory', 'MEMORY.md');
    expect(existsSync(memFile)).toBe(true);
    expect(readFileSync(memFile, 'utf-8')).toContain('auto-promoted entry body');

    // Should NOT have written to pending/
    expect(existsSync(join(home, 'review', 'pending', 'memory'))).toBe(false);
  });

  test('writes USER.md target distinctly from MEMORY.md target', async () => {
    const result = await MemoryProposeTool.call(
      {
        target: 'USER.md',
        memoryType: 'user',
        body: 'User has 10y of Go.',
        sourceMessageRange: [0, 1],
        sourceExcerpt: 'go',
        traceId: 't2',
      },
      makeCtx(home),
    );
    const data = result.data as MemoryProposeOutput;
    const id = data.proposalId;
    const parsed = parseMemoryProposal(
      readFileSync(join(home, 'review', 'pending', 'memory', `${id}.md`), 'utf-8'),
    );
    expect(parsed.target).toBe('USER.md');
    expect(parsed.memoryType).toBe('user');
  });
});

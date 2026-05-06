import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';
import { REVIEW_OPS_COMMANDS } from '../../src/commands/reviewOps.js';
import type { CommandContext } from '../../src/commands/types.js';
import { serializeMemoryProposal, serializeSkillProposalMeta } from '../../src/review/proposal.js';

chalk.level = 1;

const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

function strip(s: string): string {
  return s.replace(ANSI_RE, '');
}

function makeCtx(home: string): CommandContext {
  return { harnessHome: home, sessionId: 'sess-1' } as unknown as CommandContext;
}

function seedMemoryProposal(home: string, id: string, body = 'Use pnpm not npm') {
  const dir = join(home, 'review', 'pending', 'memory');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.md`),
    serializeMemoryProposal({
      proposalId: id,
      type: 'memory',
      target: 'MEMORY.md',
      memoryType: 'project',
      sessionId: 'sess',
      parentSessionId: null,
      traceId: 'trace',
      sourceMessageRange: [0, 5],
      sourceHash: 'sha256:x',
      sourceExcerpt: 'snippet',
      author: 'review-memory',
      createdAt: '2026-05-06T00:00:00Z',
      status: 'pending',
      body,
    }),
  );
}

function seedSkillProposal(home: string, id: string, name: string) {
  const dir = join(home, 'review', 'pending', 'skills', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'meta.json'),
    serializeSkillProposalMeta({
      proposalId: id,
      type: 'skill',
      skillName: name,
      sessionId: 'sess',
      parentSessionId: null,
      traceId: 'trace',
      sourceMessageRange: [0, 1],
      sourceHash: 'sha256:y',
      sourceExcerpt: 'snippet',
      author: 'review-skill',
      createdAt: '2026-05-06T00:00:00Z',
      status: 'pending',
    }),
  );
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: test\nwhenToUse: test\n---\nbody`,
  );
}

const reviewCmd = REVIEW_OPS_COMMANDS.find((c) => c.name === 'review');
if (!reviewCmd || reviewCmd.type !== 'local')
  throw new Error('review command not registered as local');

describe('/review list', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-rv-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('reports empty when no proposals', async () => {
    const out = await reviewCmd.call('list', makeCtx(home));
    expect(strip(out).toLowerCase()).toContain('no pending');
  });

  test('lists pending memory + skill proposals', async () => {
    seedMemoryProposal(home, '2026-05-06-aaa');
    seedSkillProposal(home, '2026-05-06-bbb', 'my-skill');
    const out = strip(await reviewCmd.call('list', makeCtx(home)));
    expect(out).toContain('2026-05-06-aaa');
    expect(out).toContain('2026-05-06-bbb');
    expect(out).toContain('memory');
    expect(out).toContain('skill');
  });
});

describe('/review show', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-rv-'));
    mkdirSync(join(home, 'memory'), { recursive: true });
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('returns frontmatter + body excerpt for memory proposal', async () => {
    seedMemoryProposal(home, '2026-05-06-ddd', 'My durable note');
    const out = strip(await reviewCmd.call('show 2026-05-06-ddd', makeCtx(home)));
    expect(out).toContain('2026-05-06-ddd');
    expect(out).toContain('My durable note');
    expect(out).toContain('MEMORY.md');
  });

  test('clear error when id missing', async () => {
    const out = strip(await reviewCmd.call('show 9999-99-99-zzz', makeCtx(home)));
    expect(out.toLowerCase()).toContain('not found');
  });
});

describe('/review approve', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-rv-'));
    mkdirSync(join(home, 'memory'), { recursive: true });
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('memory proposal: appends body to MEMORY.md, moves to approved/', async () => {
    seedMemoryProposal(home, '2026-05-06-bbb', 'Use pnpm not npm in this repo');
    const out = strip(await reviewCmd.call('approve 2026-05-06-bbb', makeCtx(home)));
    expect(out.toLowerCase()).toContain('approved');
    expect(readFileSync(join(home, 'memory', 'MEMORY.md'), 'utf-8')).toContain(
      'Use pnpm not npm in this repo',
    );
    expect(existsSync(join(home, 'review', 'pending', 'memory', '2026-05-06-bbb.md'))).toBe(false);
    expect(existsSync(join(home, 'review', 'approved', 'memory', '2026-05-06-bbb.md'))).toBe(true);
  });

  test('skill proposal: copies SKILL.md to skills/agent-created/<name>/, moves directory to approved/', async () => {
    seedSkillProposal(home, '2026-05-06-eee', 'my-skill');
    const out = strip(await reviewCmd.call('approve 2026-05-06-eee', makeCtx(home)));
    expect(out.toLowerCase()).toContain('approved');
    expect(existsSync(join(home, 'skills', 'agent-created', 'my-skill', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(home, 'review', 'pending', 'skills', '2026-05-06-eee'))).toBe(false);
    expect(existsSync(join(home, 'review', 'approved', 'skills', '2026-05-06-eee'))).toBe(true);
  });
});

describe('/review reject', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-rv-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('moves to rejected/, does not touch MEMORY.md', async () => {
    seedMemoryProposal(home, '2026-05-06-ccc');
    const out = strip(await reviewCmd.call('reject 2026-05-06-ccc', makeCtx(home)));
    expect(out.toLowerCase()).toContain('rejected');
    expect(existsSync(join(home, 'memory', 'MEMORY.md'))).toBe(false);
    expect(existsSync(join(home, 'review', 'rejected', 'memory', '2026-05-06-ccc.md'))).toBe(true);
  });
});

describe('/review consolidate', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-rv-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('dispatches via reviewManager.runConsolidationPass when manager is present', async () => {
    const calls: string[] = [];
    const fakeManager = {
      runConsolidationPass: (h: string) => {
        calls.push(h);
      },
    } as unknown as import('../../src/review/manager.js').ReviewManager;
    const ctx = {
      harnessHome: home,
      sessionId: 'sess-1',
      reviewManager: fakeManager,
    } as unknown as CommandContext;
    const out = strip(await reviewCmd.call('consolidate', ctx));
    expect(out.toLowerCase()).toContain('dispatched');
    expect(calls).toEqual([home]);
  });

  test('clear error when reviewManager is missing', async () => {
    const ctx = { harnessHome: home, sessionId: 'sess-1' } as unknown as CommandContext;
    const out = strip(await reviewCmd.call('consolidate', ctx));
    expect(out.toLowerCase()).toContain('not available');
  });
});

describe('/review activity', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-rv-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('reports no review sessions when listSessions returns empty', async () => {
    const ctx = {
      harnessHome: home,
      sessionId: 'parent-1',
      listSessions: () => [],
    } as unknown as CommandContext;
    const out = strip(await reviewCmd.call('activity', ctx));
    expect(out.toLowerCase()).toContain('no review-fork');
  });

  test('lists review children of the current parent session', async () => {
    // title is stored as "subagent:<agentName>" by terminalRepl.ts
    const ctx = {
      harnessHome: home,
      sessionId: 'parent-1',
      listSessions: () => [
        // unrelated session — different parent
        {
          sessionId: 'unrelated',
          parentSessionId: 'other',
          title: 'subagent:review-memory',
          lastUpdated: 1762400000,
        },
        // matches: review-memory child of our parent
        {
          sessionId: 'rm-child-1',
          parentSessionId: 'parent-1',
          title: 'subagent:review-memory',
          lastUpdated: 1762400100,
        },
        // matches: review-skill child of our parent
        {
          sessionId: 'rs-child-1',
          parentSessionId: 'parent-1',
          title: 'subagent:review-skill',
          lastUpdated: 1762400200,
        },
        // not a review fork — explore child
        {
          sessionId: 'expl-child',
          parentSessionId: 'parent-1',
          title: 'subagent:explore',
          lastUpdated: 1762400300,
        },
      ],
    } as unknown as CommandContext;
    const out = strip(await reviewCmd.call('activity', ctx));
    expect(out).toContain('rm-child');
    expect(out).toContain('rs-child');
    expect(out).not.toContain('expl-child'); // non-review children excluded
    expect(out).not.toContain('unrelated'); // wrong parent excluded
  });

  test('shows correct session count in header', async () => {
    const ctx = {
      harnessHome: home,
      sessionId: 'parent-1',
      listSessions: () => [
        {
          sessionId: 'rm-a',
          parentSessionId: 'parent-1',
          title: 'subagent:review-memory',
          lastUpdated: 1762400100,
        },
        {
          sessionId: 'rm-b',
          parentSessionId: 'parent-1',
          title: 'subagent:review-consolidate',
          lastUpdated: 1762400200,
        },
      ],
    } as unknown as CommandContext;
    const out = strip(await reviewCmd.call('activity', ctx));
    expect(out).toContain('2 review session(s)');
  });
});

describe('/review unknown verb', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-rv-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('returns usage on unknown verb', async () => {
    const out = strip(await reviewCmd.call('badverb', makeCtx(home)));
    expect(out.toLowerCase()).toContain('usage');
    expect(out).toContain('/review');
  });
});

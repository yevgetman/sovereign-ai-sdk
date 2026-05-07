import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';
import { REVIEW_OPS_COMMANDS } from '../../src/commands/reviewOps.js';
import type { CommandContext } from '../../src/commands/types.js';
import {
  serializeConsolidationProposal,
  serializeMemoryProposal,
  serializeSkillProposalMeta,
} from '../../src/review/proposal.js';

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

function seedConsolidationProposal(
  home: string,
  proposalId: string,
  affectedEntries: string[],
  body: string,
) {
  const dir = join(home, 'review', 'pending', 'consolidation');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${proposalId}.md`),
    serializeConsolidationProposal({
      proposalId,
      type: 'consolidation',
      target: 'MEMORY.md',
      affectedEntries,
      sessionId: 'sess',
      parentSessionId: null,
      traceId: 'trace',
      author: 'review-consolidate',
      createdAt: '2026-05-07T00:00:00Z',
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

  test('memory proposal: rejects when MEMORY.md cap would be exceeded', async () => {
    // Pre-fill MEMORY.md to near-capacity
    const memFile = join(home, 'memory', 'MEMORY.md');
    mkdirSync(join(home, 'memory'), { recursive: true });
    writeFileSync(memFile, 'x'.repeat(2100)); // close to 2200 cap

    // Seed a proposal whose body would push past the cap
    const id = '2026-05-07-cap-test';
    seedMemoryProposal(home, id, 'y'.repeat(500));

    const out = strip(await reviewCmd.call(`approve ${id}`, makeCtx(home)));
    expect(out.toLowerCase()).toContain('cap exceeded');
    expect(out).toContain('MEMORY.md');
    expect(out.toLowerCase()).toContain('consolidate');

    // MEMORY.md size unchanged
    expect(readFileSync(memFile, 'utf-8').length).toBe(2100);
    // Proposal still in pending/, not approved/
    expect(existsSync(join(home, 'review', 'pending', 'memory', `${id}.md`))).toBe(true);
    expect(existsSync(join(home, 'review', 'approved', 'memory', `${id}.md`))).toBe(false);
  });

  test('memory proposal: succeeds when within cap (regression — happy path)', async () => {
    seedMemoryProposal(home, '2026-05-07-ok', 'tiny note');
    const out = strip(await reviewCmd.call('approve 2026-05-07-ok', makeCtx(home)));
    expect(out.toLowerCase()).toContain('approved');
    expect(existsSync(join(home, 'memory', 'MEMORY.md'))).toBe(true);
    expect(readFileSync(join(home, 'memory', 'MEMORY.md'), 'utf-8')).toContain('tiny note');
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
          totalTokens: 1000,
          msgCount: 3,
        },
        // matches: review-memory child of our parent
        {
          sessionId: 'rm-child-1',
          parentSessionId: 'parent-1',
          title: 'subagent:review-memory',
          lastUpdated: 1762400100,
          totalTokens: 1000,
          msgCount: 3,
        },
        // matches: review-skill child of our parent
        {
          sessionId: 'rs-child-1',
          parentSessionId: 'parent-1',
          title: 'subagent:review-skill',
          lastUpdated: 1762400200,
          totalTokens: 1000,
          msgCount: 3,
        },
        // not a review fork — explore child
        {
          sessionId: 'expl-child',
          parentSessionId: 'parent-1',
          title: 'subagent:explore',
          lastUpdated: 1762400300,
          totalTokens: 1000,
          msgCount: 3,
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
          totalTokens: 1000,
          msgCount: 3,
        },
        {
          sessionId: 'rm-b',
          parentSessionId: 'parent-1',
          title: 'subagent:review-consolidate',
          lastUpdated: 1762400200,
          totalTokens: 1000,
          msgCount: 3,
        },
      ],
    } as unknown as CommandContext;
    const out = strip(await reviewCmd.call('activity', ctx));
    expect(out).toContain('2 review session(s)');
  });

  test('excludes phantom rows (zero tokens AND zero messages)', async () => {
    const ctx = {
      harnessHome: home,
      sessionId: 'parent-1',
      listSessions: () => [
        // productive review-memory child
        {
          sessionId: 'rm-real',
          parentSessionId: 'parent-1',
          title: 'subagent:review-memory',
          lastUpdated: 1762400100,
          totalTokens: 1500,
          msgCount: 4,
        },
        // phantom — got cancelled before streaming
        {
          sessionId: 'rm-phantom',
          parentSessionId: 'parent-1',
          title: 'subagent:review-memory',
          lastUpdated: 1762400200,
          totalTokens: 0,
          msgCount: 0,
        },
      ],
    } as unknown as CommandContext;

    const out = strip(await reviewCmd.call('activity', ctx));
    expect(out).toContain('rm-real');
    expect(out).not.toContain('rm-phantom');
    expect(out).toMatch(/1 review session/);
    expect(out).toContain('+1 phantom');
  });

  test('returns honest message when all rows are phantoms', async () => {
    const ctx = {
      harnessHome: home,
      sessionId: 'parent-1',
      listSessions: () => [
        {
          sessionId: 'rm-1',
          parentSessionId: 'parent-1',
          title: 'subagent:review-memory',
          lastUpdated: 1762400100,
          totalTokens: 0,
          msgCount: 0,
        },
      ],
    } as unknown as CommandContext;

    const out = strip(await reviewCmd.call('activity', ctx));
    expect(out.toLowerCase()).toContain('no productive');
    expect(out).toContain('1 phantom row');
  });
});

describe('/review revoke', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-revoke-'));
    mkdirSync(join(home, 'memory'), { recursive: true });
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('revokes a memory approval: removes block + moves proposal to rejected/', async () => {
    seedMemoryProposal(home, '2026-05-07-rev', 'My durable note');
    await reviewCmd.call('approve 2026-05-07-rev', makeCtx(home));
    expect(readFileSync(join(home, 'memory', 'MEMORY.md'), 'utf-8')).toContain('My durable note');

    const out = strip(await reviewCmd.call('revoke 2026-05-07-rev', makeCtx(home)));
    expect(out.toLowerCase()).toContain('revoked');

    expect(readFileSync(join(home, 'memory', 'MEMORY.md'), 'utf-8')).not.toContain(
      'My durable note',
    );
    expect(existsSync(join(home, 'review', 'approved', 'memory', '2026-05-07-rev.md'))).toBe(false);
    expect(existsSync(join(home, 'review', 'rejected', 'memory', '2026-05-07-rev.md'))).toBe(true);
  });

  test('revokes a skill approval: deletes skills/agent-created/<name>/ + moves proposal', async () => {
    seedSkillProposal(home, '2026-05-07-skill-rev', 'my-test-skill');
    await reviewCmd.call('approve 2026-05-07-skill-rev', makeCtx(home));
    expect(existsSync(join(home, 'skills', 'agent-created', 'my-test-skill', 'SKILL.md'))).toBe(
      true,
    );

    const out = strip(await reviewCmd.call('revoke 2026-05-07-skill-rev', makeCtx(home)));
    expect(out.toLowerCase()).toContain('revoked');

    expect(existsSync(join(home, 'skills', 'agent-created', 'my-test-skill'))).toBe(false);
    expect(existsSync(join(home, 'review', 'rejected', 'skills', '2026-05-07-skill-rev'))).toBe(
      true,
    );
  });

  test('errors clearly when revoke target id is not found in approved/', async () => {
    const out = strip(await reviewCmd.call('revoke 9999-99-99-zzz', makeCtx(home)));
    expect(out.toLowerCase()).toContain('not found');
  });

  test('errors clearly when no id given', async () => {
    const out = strip(await reviewCmd.call('revoke', makeCtx(home)));
    expect(out.toLowerCase()).toContain('usage');
    expect(out).toContain('revoke <id>');
  });

  test('removes the right block when MEMORY.md contains multiple approvals', async () => {
    seedMemoryProposal(home, '2026-05-07-a', 'First note FOO');
    seedMemoryProposal(home, '2026-05-07-b', 'Second note BAR');
    seedMemoryProposal(home, '2026-05-07-c', 'Third note BAZ');
    await reviewCmd.call('approve 2026-05-07-a', makeCtx(home));
    await reviewCmd.call('approve 2026-05-07-b', makeCtx(home));
    await reviewCmd.call('approve 2026-05-07-c', makeCtx(home));

    await reviewCmd.call('revoke 2026-05-07-b', makeCtx(home));

    const memContent = readFileSync(join(home, 'memory', 'MEMORY.md'), 'utf-8');
    expect(memContent).toContain('First note FOO');
    expect(memContent).not.toContain('Second note BAR');
    expect(memContent).toContain('Third note BAZ');
  });

  test('idempotent on already-removed block: still moves proposal to rejected/', async () => {
    seedMemoryProposal(home, '2026-05-07-stale', 'stale note');
    await reviewCmd.call('approve 2026-05-07-stale', makeCtx(home));
    // User manually removed the block:
    writeFileSync(join(home, 'memory', 'MEMORY.md'), 'unrelated content\n');

    const out = strip(await reviewCmd.call('revoke 2026-05-07-stale', makeCtx(home)));
    expect(out.toLowerCase()).toContain('not found');
    expect(out.toLowerCase()).toContain('rejected');
    expect(existsSync(join(home, 'review', 'rejected', 'memory', '2026-05-07-stale.md'))).toBe(
      true,
    );
  });
});

describe('/review approve — consolidation deletes originals (Item 4)', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-cons-del-'));
    mkdirSync(join(home, 'memory'), { recursive: true });
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('approving a consolidation removes affected entries + appends consolidated block', async () => {
    seedMemoryProposal(home, '2026-05-07-orig-a', 'Original A content');
    seedMemoryProposal(home, '2026-05-07-orig-b', 'Original B content');
    await reviewCmd.call('approve 2026-05-07-orig-a', makeCtx(home));
    await reviewCmd.call('approve 2026-05-07-orig-b', makeCtx(home));

    const memBefore = readFileSync(join(home, 'memory', 'MEMORY.md'), 'utf-8');
    expect(memBefore).toContain('Original A content');
    expect(memBefore).toContain('Original B content');

    seedConsolidationProposal(
      home,
      '2026-05-07-cons-1',
      ['2026-05-07-orig-a', '2026-05-07-orig-b'],
      'Merged note: combines A and B',
    );

    const out = strip(await reviewCmd.call('approve 2026-05-07-cons-1', makeCtx(home)));
    expect(out.toLowerCase()).toContain('approved');
    expect(out).toContain('merged 2 entries');

    const memAfter = readFileSync(join(home, 'memory', 'MEMORY.md'), 'utf-8');
    expect(memAfter).not.toContain('Original A content');
    expect(memAfter).not.toContain('Original B content');
    expect(memAfter).toContain('Merged note: combines A and B');
  });

  test('consolidation that shrinks the file passes cap check even when originals were at cap', async () => {
    // Pre-fill MEMORY.md to near-capacity via an approval
    seedMemoryProposal(home, '2026-05-07-fat', 'x'.repeat(2000));
    await reviewCmd.call('approve 2026-05-07-fat', makeCtx(home));
    expect(readFileSync(join(home, 'memory', 'MEMORY.md'), 'utf-8').length).toBeGreaterThan(1900);

    seedConsolidationProposal(
      home,
      '2026-05-07-cons-shrink',
      ['2026-05-07-fat'],
      'short merged note',
    );

    const out = strip(await reviewCmd.call('approve 2026-05-07-cons-shrink', makeCtx(home)));
    expect(out.toLowerCase()).toContain('approved');
    // After shrinking, file should be much smaller than before
    expect(readFileSync(join(home, 'memory', 'MEMORY.md'), 'utf-8').length).toBeLessThan(500);
  });

  test('consolidation rejects when post-deletion content + new block still exceeds cap', async () => {
    // Set up: one original at moderate size we won't delete, plus a small one we will.
    seedMemoryProposal(home, '2026-05-07-keep', 'y'.repeat(800));
    seedMemoryProposal(home, '2026-05-07-del', 'z'.repeat(200));
    await reviewCmd.call('approve 2026-05-07-keep', makeCtx(home));
    await reviewCmd.call('approve 2026-05-07-del', makeCtx(home));
    // MEMORY.md ~ 1100 chars now (cap is 2200)

    // A consolidation that deletes only -del (~200 chars) but appends a giant block (~2000)
    // would push past cap (1100 - 200 + 2000 ~ 2900 > 2200).
    seedConsolidationProposal(home, '2026-05-07-cons-bloat', ['2026-05-07-del'], 'a'.repeat(2000));

    const out = strip(await reviewCmd.call('approve 2026-05-07-cons-bloat', makeCtx(home)));
    expect(out.toLowerCase()).toContain('cap exceeded');
    // File state unchanged — no partial deletion
    const memAfter = readFileSync(join(home, 'memory', 'MEMORY.md'), 'utf-8');
    expect(memAfter).toContain('z'.repeat(50)); // original -del content still present
    // Proposal still pending
    expect(
      existsSync(join(home, 'review', 'pending', 'consolidation', '2026-05-07-cons-bloat.md')),
    ).toBe(true);
    expect(
      existsSync(join(home, 'review', 'approved', 'consolidation', '2026-05-07-cons-bloat.md')),
    ).toBe(false);
  });

  test('missing affectedEntry is non-fatal: continues with the rest', async () => {
    seedMemoryProposal(home, '2026-05-07-real', 'Real entry');
    await reviewCmd.call('approve 2026-05-07-real', makeCtx(home));

    seedConsolidationProposal(
      home,
      '2026-05-07-cons-mixed',
      ['2026-05-07-real', '2026-05-07-ghost'],
      'Merged from real + ghost (ghost was already gone)',
    );

    const out = strip(await reviewCmd.call('approve 2026-05-07-cons-mixed', makeCtx(home)));
    expect(out.toLowerCase()).toContain('approved');
    // Only one entry was actually removed (the ghost was missing), so the
    // success annotation should reflect that.
    expect(out).toContain('merged 1 entry');
    const memAfter = readFileSync(join(home, 'memory', 'MEMORY.md'), 'utf-8');
    expect(memAfter).not.toContain('Real entry');
    expect(memAfter).toContain('Merged from real + ghost');
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

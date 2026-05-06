import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseSkillProposalMeta } from '../../src/review/proposal.js';
import type { ToolContext, ToolResult } from '../../src/tool/types.js';
import { type SkillProposeOutput, SkillProposeTool } from '../../src/tools/SkillProposeTool.js';

function makeCtx(home: string): ToolContext {
  return {
    cwd: '/tmp',
    sessionId: 'sess-1',
    harnessHome: home,
  } as ToolContext;
}

describe('skill_propose tool', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-skillprop-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('writes pending skill directory with meta.json + SKILL.md', async () => {
    const result = (await SkillProposeTool.call(
      {
        skillName: 'rename-db-column',
        description: 'Two-phase column rename + backfill on Postgres',
        whenToUse: 'Renaming a NOT NULL column on a large production table',
        body: '# rename-db-column\n\n1. Add new column nullable\n2. Backfill\n3. Swap',
        sourceMessageRange: [4, 26],
        sourceExcerpt: 'pg rename flow',
        traceId: 'trace-xyz',
      },
      makeCtx(home),
    )) as ToolResult<SkillProposeOutput>;

    expect(result.observation?.status).toBe('success');
    const id = result.data.proposalId;
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}-/);

    const dir = join(home, 'review', 'pending', 'skills', id);
    expect(existsSync(join(dir, 'meta.json'))).toBe(true);
    expect(existsSync(join(dir, 'SKILL.md'))).toBe(true);

    const meta = parseSkillProposalMeta(readFileSync(join(dir, 'meta.json'), 'utf-8'));
    expect(meta.skillName).toBe('rename-db-column');
    expect(meta.author).toBe('review-skill');
    expect(meta.parentSessionId).toBe(null);
    expect(meta.status).toBe('pending');
    expect(meta.sourceHash).toMatch(/^sha256:/);

    const skillBody = readFileSync(join(dir, 'SKILL.md'), 'utf-8');
    expect(skillBody).toContain('---');
    expect(skillBody).toContain('name: rename-db-column');
    expect(skillBody).toContain('description: Two-phase');
    expect(skillBody).toContain('whenToUse: Renaming');
    expect(skillBody).toContain('1. Add new column nullable');
  });

  test('rejects invalid skillName via input schema', () => {
    expect(() => {
      SkillProposeTool.inputSchema.parse({
        skillName: 'bad name with spaces',
        description: 'x',
        whenToUse: 'x',
        body: 'x',
        sourceMessageRange: [0, 1],
        sourceExcerpt: 'x',
        traceId: 't',
      });
    }).toThrow();
  });

  test('throws when harnessHome is absent', async () => {
    const badCtx = { cwd: '/tmp', sessionId: 'x' } as ToolContext;
    await expect(
      SkillProposeTool.call(
        {
          skillName: 'fine-name',
          description: 'x',
          whenToUse: 'x',
          body: 'x',
          sourceMessageRange: [0, 1],
          sourceExcerpt: 'x',
          traceId: 't',
        },
        badCtx,
      ),
    ).rejects.toThrow(/harnessHome/);
  });

  test('SKILL.md frontmatter survives the skill-loader YAML round-trip with tricky inputs', async () => {
    const result = (await SkillProposeTool.call(
      {
        skillName: 'tricky-skill',
        description: 'Two-phase: rename and backfill',
        whenToUse: 'Step 1\nStep 2',
        body: 'body',
        sourceMessageRange: [0, 1],
        sourceExcerpt: 'x',
        traceId: 't',
      },
      makeCtx(home),
    )) as ToolResult<SkillProposeOutput>;

    const id = result.data.proposalId;
    const skillPath = join(home, 'review', 'pending', 'skills', id, 'SKILL.md');
    const raw = readFileSync(skillPath, 'utf-8');
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    expect(match).not.toBeNull();
    const parsed = parseYaml(match?.[1] ?? '') as Record<string, string>;
    expect(parsed.name).toBe('tricky-skill');
    expect(parsed.description).toBe('Two-phase: rename and backfill');
    expect(parsed.whenToUse).toBe('Step 1\nStep 2');
  });
});

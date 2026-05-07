// Phase 13.3 follow-up (Backlog Item 2) — round-trip audit for the C2
// auto-promote provenance comment in SkillProposeTool. Verifies SKILL.md
// written via the auto-promote bypass path remains parseable by
// loadSkillFromPath (the runtime's actual skill loader entry point) and
// that the provenance comment lands AFTER the YAML frontmatter so the
// frontmatter parser is unaffected.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSkillFromPath } from '../../src/skills/loader.js';
import type { ToolContext } from '../../src/tool/types.js';
import { SkillProposeTool } from '../../src/tools/SkillProposeTool.js';

const AGENT_CREATED_CLASSIFICATION = {
  source: 'agent-created',
  trustTier: 'agent-created',
} as const;

function makeCtx(home: string, sessionId = 'sess-audit-skill-1'): ToolContext {
  return {
    cwd: '/tmp',
    sessionId,
    harnessHome: home,
    reviewAutoPromoteSkills: true,
  } as ToolContext;
}

describe('SkillProposeTool auto-promote — provenance audit', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-skillpropose-audit-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('auto-promote SKILL.md loads cleanly through skill loader', async () => {
    await SkillProposeTool.call(
      {
        skillName: 'audit-skill-simple',
        description: 'Audit test skill',
        whenToUse: 'Round-trip auditing',
        body: '# audit-skill-simple\n\n1. Step one\n2. Step two',
        sourceMessageRange: [0, 5],
        sourceExcerpt: 'simple excerpt',
        traceId: 'trace-audit-skill-1',
      },
      makeCtx(home),
    );

    const skillPath = join(home, 'skills', 'agent-created', 'audit-skill-simple', 'SKILL.md');
    const skill = await loadSkillFromPath(skillPath, AGENT_CREATED_CLASSIFICATION);
    expect(skill).not.toBeNull();
    expect(skill?.name).toBe('audit-skill-simple');
    expect(skill?.description).toBe('Audit test skill');
    expect(skill?.whenToUse).toBe('Round-trip auditing');
    expect(skill?.source).toBe('agent-created');
    expect(skill?.trustTier).toBe('agent-created');
    // Provenance comment is in the body (after frontmatter)
    expect(skill?.body).toContain('proposal:');
    expect(skill?.body).toContain('auto-promoted');
    expect(skill?.body).toContain('session:sess-audit-skill-1');
  });

  test('auto-promote with -- in excerpt: skill loader still parses (provenance comment in body, not frontmatter)', async () => {
    await SkillProposeTool.call(
      {
        skillName: 'audit-skill-tricky',
        description: 'tricky description',
        whenToUse: 'when stress-testing escapes',
        body: '# audit-skill-tricky\n\nbody',
        sourceMessageRange: [0, 1],
        sourceExcerpt: 'this -- has -- doubles',
        traceId: 'trace-audit-skill-2',
      },
      makeCtx(home),
    );

    const skillPath = join(home, 'skills', 'agent-created', 'audit-skill-tricky', 'SKILL.md');
    const fileContent = readFileSync(skillPath, 'utf-8');
    // Provenance comment should appear after the frontmatter close (`---\n`)
    // and BEFORE the body. The comment *content* (between <!-- and -->) must
    // not contain '--' (would terminate HTML comments early); the outer
    // `<!--` / `-->` delimiters legitimately contain dashes.
    const provenanceLine = fileContent.split('\n').find((l) => l.includes('proposal:')) ?? '';
    const provenanceInner = provenanceLine.replace(/^.*<!--\s*/, '').replace(/\s*-->.*$/, '');
    expect(provenanceInner).not.toContain('--');
    expect(provenanceInner).toContain('this - has - doubles');

    // Skill loader still works — frontmatter is intact.
    const skill = await loadSkillFromPath(skillPath, AGENT_CREATED_CLASSIFICATION);
    expect(skill).not.toBeNull();
    expect(skill?.name).toBe('audit-skill-tricky');
    expect(skill?.description).toBe('tricky description');
    expect(skill?.whenToUse).toBe('when stress-testing escapes');
  });

  test('auto-promote with very long excerpt: truncated; skill loader still works', async () => {
    const longExcerpt = 'a'.repeat(500);
    await SkillProposeTool.call(
      {
        skillName: 'audit-skill-long',
        description: 'long-excerpt skill',
        whenToUse: 'when testing truncation',
        body: '# audit-skill-long\n\nbody',
        sourceMessageRange: [0, 1],
        sourceExcerpt: longExcerpt,
        traceId: 'trace-audit-skill-3',
      },
      makeCtx(home),
    );
    const skillPath = join(home, 'skills', 'agent-created', 'audit-skill-long', 'SKILL.md');
    const fileContent = readFileSync(skillPath, 'utf-8');
    const provenanceLine = fileContent.split('\n').find((l) => l.includes('proposal:')) ?? '';
    expect(provenanceLine).toContain('...');
    // Sanity ceiling on the comment length (200 chars truncated excerpt + other fields)
    expect(provenanceLine.length).toBeLessThan(800);

    const skill = await loadSkillFromPath(skillPath, AGENT_CREATED_CLASSIFICATION);
    expect(skill).not.toBeNull();
    expect(skill?.name).toBe('audit-skill-long');
    expect(skill?.description).toBe('long-excerpt skill');
    expect(skill?.whenToUse).toBe('when testing truncation');
  });
});

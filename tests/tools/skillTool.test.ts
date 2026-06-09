import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Skill, SkillRegistry } from '../../src/skills/types.js';
import type { ToolContext } from '../../src/tool/types.js';
import { SkillTool } from '../../src/tools/SkillTool.js';

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'sovereign-skill-tool-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeSkill(path: string): Skill {
  return {
    name: 'simplify',
    description: 'Review code for reuse and quality',
    whenToUse: 'User asks to simplify code',
    allowedTools: ['Read', 'Edit'],
    path,
    realpath: path,
    dir: dirname(path),
    source: 'project',
    trustTier: 'trusted',
    allowShellInterpolation: true,
    metadata: {
      harness: {
        requiresToolsets: [],
        requiresTools: [],
        fallbackForToolsets: [],
        fallbackForTools: [],
      },
    },
    guard: { action: 'allow', findings: [] },
    body: 'Simplify {{args}}.',
  };
}

function writeSkill(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `---
name: simplify
description: Review code for reuse and quality
allowedTools: [Read, Edit]
whenToUse: User asks to simplify code
---
Simplify {{args}}.
`,
  );
}

describe('SkillTool', () => {
  test('returns expanded skill prompt body', async () => {
    await withTmp(async (dir) => {
      const skillPath = join(dir, 'simplify.md');
      writeSkill(skillPath);
      const skill = makeSkill(skillPath);
      const skills: SkillRegistry = {
        skills: [skill],
        byName: new Map([[skill.name, skill]]),
      };
      const ctx: ToolContext = {
        cwd: dir,
        bundleRoot: dir,
        sessionId: 'skill-tool-test',
        skills,
      };

      const result = await SkillTool.call({ skill: 'simplify', args: 'src/main.ts' }, ctx);
      expect(result.data.prompt).toBe('Simplify src/main.ts.');
      const rendered = SkillTool.renderResult?.(result.data);
      expect(rendered?.content).toContain("Skill 'simplify' activated");
      // Feature B — the model-invoked SkillTool path is advisory: the allowed
      // tools are surfaced as guidance (not a hard pool restriction, unlike the
      // user-invoked `/skill` path). The rendered line lists the tools AND
      // states the advisory nature.
      expect(rendered?.content).toContain('Read, Edit');
      expect(rendered?.content.toLowerCase()).toContain('advisory');
    });
  });

  test('throws clearly for unknown skills', async () => {
    const ctx: ToolContext = {
      cwd: process.cwd(),
      bundleRoot: process.cwd(),
      sessionId: 'skill-tool-test',
      skills: { skills: [], byName: new Map() },
    };
    await expect(SkillTool.call({ skill: 'missing' }, ctx)).rejects.toThrow('unknown skill');
  });
});

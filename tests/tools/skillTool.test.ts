import { describe, expect, test } from 'bun:test';
import type { Skill, SkillRegistry } from '../../src/skills/types.js';
import type { ToolContext } from '../../src/tool/types.js';
import { SkillTool } from '../../src/tools/SkillTool.js';

const skill: Skill = {
  name: 'simplify',
  description: 'Review code for reuse and quality',
  whenToUse: 'User asks to simplify code',
  allowedTools: ['Read', 'Edit'],
  path: '/tmp/simplify.md',
  realpath: '/tmp/simplify.md',
  source: 'project',
  body: 'Simplify {{args}}.',
};

const skills: SkillRegistry = {
  skills: [skill],
  byName: new Map([[skill.name, skill]]),
};

const ctx: ToolContext = {
  cwd: process.cwd(),
  bundleRoot: process.cwd(),
  sessionId: 'skill-tool-test',
  skills,
};

describe('SkillTool', () => {
  test('returns expanded skill prompt body', async () => {
    const result = await SkillTool.call({ skill: 'simplify', args: 'src/main.ts' }, ctx);
    expect(result.data.prompt).toBe('Simplify src/main.ts.');
    const rendered = SkillTool.renderResult?.(result.data);
    expect(rendered?.content).toContain("Skill 'simplify' activated");
    expect(rendered?.content).toContain('Allowed tools: Read, Edit');
  });

  test('throws clearly for unknown skills', async () => {
    await expect(SkillTool.call({ skill: 'missing' }, ctx)).rejects.toThrow('unknown skill');
  });
});

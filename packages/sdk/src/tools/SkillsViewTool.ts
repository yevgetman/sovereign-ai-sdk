import { getSkillRegistry } from '../skills/registry.js';
// Progressive skill disclosure. Returns the full body for one visible skill,
// or a specific reference file under that skill's directory.

import { readFile, stat } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { z } from 'zod';
import { resolveSkillResource } from '../skills/activation.js';
import { reloadSkill } from '../skills/loader.js';
import { buildTool } from '../tool/buildTool.js';

const inputSchema = z.object({
  name: z.string().min(1).describe('Visible skill name to inspect.'),
  path: z
    .string()
    .optional()
    .describe('Optional path to a reference file under the skill directory.'),
});

type Input = z.infer<typeof inputSchema>;

type Output = {
  skill: string;
  path: string;
  content: string;
};

export const SkillsViewTool = buildTool<Input, Output>({
  name: 'skill_view',
  description: () => 'View a visible skill body, or a reference file inside its skill directory.',
  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  renderHint: { kind: 'markdown' },
  checkPermissions: async () => ({ behavior: 'allow' }),
  affectedPaths: (input) => (input.path ? [input.path] : []),
  async call(input, ctx) {
    const skill = getSkillRegistry(ctx).byName.get(input.name);
    if (!skill) {
      const available =
        getSkillRegistry(ctx)
          .skills.map((s) => s.name)
          .join(', ') || 'none';
      throw new Error(`unknown skill '${input.name}'. Available skills: ${available}`);
    }

    if (ctx.skillRuntime) {
      const inspected = await ctx.skillRuntime.inspect(skill.name, input.path);
      return {
        data: { skill: inspected.skill.name, path: inspected.path, content: inspected.content },
        observation: {
          status: 'success',
          summary: `viewed ${inspected.path} for ${inspected.skill.name}`,
        },
      };
    }
    const current = await reloadSkill(skill);
    if (!input.path) {
      return {
        data: {
          skill: current.name,
          path: 'SKILL.md',
          content: current.body,
        },
        observation: {
          status: 'success',
          summary: `viewed SKILL.md for ${current.name}`,
          artifacts: [current.path],
        },
      };
    }

    const target = await resolveSkillResource(current, input.path);
    const targetStat = await stat(target);
    if (!targetStat.isFile()) {
      throw new Error(`skill reference path is not a file: ${input.path}`);
    }
    const content = await readFile(target, 'utf8');
    return {
      data: {
        skill: current.name,
        path: relative(dirname(current.realpath), target),
        content,
      },
      observation: {
        status: 'success',
        summary: `viewed ${relative(dirname(current.realpath), target)} (skill ${current.name})`,
        artifacts: [target],
      },
    };
  },
  renderResult: (out) => ({
    content: [`<skill name="${out.skill}" path="${out.path}">`, out.content, '</skill>'].join('\n'),
  }),
});

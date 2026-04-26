// Progressive skill disclosure. Returns the full body for one visible skill,
// or a specific reference file under that skill's directory.

import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { expandSkillPrompt, expandSkillText, reloadSkill } from '../skills/loader.js';
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
  checkPermissions: async () => ({ behavior: 'allow' }),
  affectedPaths: (input) => (input.path ? [input.path] : []),
  async call(input, ctx) {
    const skill = ctx.skills?.byName.get(input.name);
    if (!skill) {
      const available = ctx.skills?.skills.map((s) => s.name).join(', ') || 'none';
      throw new Error(`unknown skill '${input.name}'. Available skills: ${available}`);
    }

    const current = await reloadSkill(skill);
    if (!input.path) {
      return {
        data: {
          skill: current.name,
          path: 'SKILL.md',
          content: await expandSkillPrompt(current, {
            cwd: ctx.cwd,
            sessionId: ctx.sessionId,
          }),
        },
      };
    }

    const target = resolve(current.dir, input.path);
    if (!isInside(current.dir, target)) {
      throw new Error(`skill reference path escapes skill directory: ${input.path}`);
    }
    const targetStat = await stat(target);
    if (!targetStat.isFile()) {
      throw new Error(`skill reference path is not a file: ${input.path}`);
    }
    const content = await readFile(target, 'utf8');
    return {
      data: {
        skill: current.name,
        path: relative(current.dir, target),
        content: await expandSkillText(current, content, {
          cwd: ctx.cwd,
          sessionId: ctx.sessionId,
        }),
      },
    };
  },
  renderResult: (out) => ({
    content: [`<skill name="${out.skill}" path="${out.path}">`, out.content, '</skill>'].join('\n'),
  }),
});

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

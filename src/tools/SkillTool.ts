// SkillTool lets the model activate a markdown skill by name. It returns
// the expanded skill body as a tool_result so the continuation turn can use
// those instructions.

import { z } from 'zod';
import { expandSkillPrompt, reloadSkill } from '../skills/loader.js';
import { buildTool } from '../tool/buildTool.js';

const inputSchema = z.object({
  skill: z.string().min(1).describe('Skill name to activate.'),
  args: z.string().optional().describe('Optional arguments passed to the skill body.'),
});

type Input = z.infer<typeof inputSchema>;

type Output = {
  skill: string;
  prompt: string;
  allowedTools: string[];
};

export const SkillTool = buildTool<Input, Output>({
  name: 'SkillTool',
  description: () =>
    'Activate a markdown skill by name. Returns the expanded skill instructions for the next turn.',
  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  checkPermissions: async () => ({ behavior: 'allow' }),
  async call(input, ctx) {
    const skill = ctx.skills?.byName.get(input.skill);
    if (!skill) {
      const available = ctx.skills?.skills.map((s) => s.name).join(', ') || 'none';
      throw new Error(`unknown skill '${input.skill}'. Available skills: ${available}`);
    }
    const current = await reloadSkill(skill);
    const prompt = await expandSkillPrompt(current, { args: input.args ?? '', cwd: ctx.cwd });
    return {
      data: {
        skill: current.name,
        prompt,
        allowedTools: current.allowedTools,
      },
    };
  },
  renderResult: (out) => ({
    content: [
      `Skill '${out.skill}' activated.`,
      out.allowedTools.length > 0 ? `Allowed tools: ${out.allowedTools.join(', ')}` : '',
      '<skill-prompt>',
      out.prompt,
      '</skill-prompt>',
    ]
      .filter(Boolean)
      .join('\n'),
  }),
});

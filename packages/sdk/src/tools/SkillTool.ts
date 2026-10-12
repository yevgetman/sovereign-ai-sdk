// SkillTool lets the model activate a markdown skill by name. It returns
// the expanded skill body as a tool_result so the continuation turn can use
// those instructions.

import { z } from 'zod';
import { type SkillActivationEnvelope, activateSkill } from '../skills/activation.js';
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
  activation: SkillActivationEnvelope;
};

export const SkillTool = buildTool<Input, Output>({
  name: 'SkillTool',
  description: () =>
    'Activate a markdown skill by name. Returns the expanded skill instructions for the next turn.',
  inputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  renderHint: { kind: 'markdown' },
  // Recheck guard against fresh content; shell separately uses the Bash gate.
  checkPermissions: async () => ({ behavior: 'allow' }),
  async call(input, ctx) {
    const skill = ctx.skills?.byName.get(input.skill);
    if (!skill) {
      const available = ctx.skills?.skills.map((s) => s.name).join(', ') || 'none';
      throw new Error(`unknown skill '${input.skill}'. Available skills: ${available}`);
    }
    if (!ctx.skillActivation)
      throw new Error('SkillTool requires a turn-owned skill activation state');
    const { prompt, activation } = await activateSkill(skill, {
      source: 'model',
      args: input.args ?? '',
      toolContext: ctx,
      state: ctx.skillActivation,
    });
    return {
      data: {
        skill: activation.name,
        prompt,
        allowedTools: [...activation.allowedTools],
        activation,
      },
      observation: {
        status: 'success',
        summary: `activated skill ${activation.name}`,
        artifacts: [skill.path],
      },
    };
  },
  renderResult: (out) => ({
    content: [
      `Skill '${out.skill}' activated.`,
      out.allowedTools.length > 0
        ? `Allowed tools (enforced for this turn): ${out.allowedTools.join(', ')}`
        : '',
      '<skill-prompt>',
      out.prompt,
      '</skill-prompt>',
    ]
      .filter(Boolean)
      .join('\n'),
  }),
});

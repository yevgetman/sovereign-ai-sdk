// Progressive skills discovery. The system prompt carries only a reminder;
// models call this tool to see the current visible skill index on demand.

import { z } from 'zod';
import { buildTool } from '../tool/buildTool.js';

const OUTPUT_CHAR_CAP = 3_000;

const inputSchema = z.object({
  query: z.string().optional().describe('Optional case-insensitive filter by name or description.'),
});

type Input = z.infer<typeof inputSchema>;

type ListedSkill = {
  name: string;
  description: string;
  whenToUse: string;
};

type Output = {
  query?: string;
  skills: ListedSkill[];
  truncated: boolean;
};

export const SkillsListTool = buildTool<Input, Output>({
  name: 'skills_list',
  description: () =>
    'List visible skills by name and short description. Use query to narrow the index.',
  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  checkPermissions: async () => ({ behavior: 'allow' }),
  async call(input, ctx) {
    const needle = input.query?.trim().toLowerCase();
    const candidates = (ctx.skills?.skills ?? [])
      .filter((skill) => {
        if (!needle) return true;
        return [skill.name, skill.description, skill.whenToUse]
          .join('\n')
          .toLowerCase()
          .includes(needle);
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const skills: ListedSkill[] = [];
    let chars = 0;
    let truncated = false;
    for (const skill of candidates) {
      const listed = {
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse,
      };
      const nextChars = chars + JSON.stringify(listed).length + 2;
      if (nextChars > OUTPUT_CHAR_CAP) {
        truncated = true;
        break;
      }
      chars = nextChars;
      skills.push(listed);
    }

    return {
      data: {
        ...(input.query !== undefined ? { query: input.query } : {}),
        skills,
        truncated,
      },
    };
  },
  renderResult: (out) => ({
    content: out.skills.length === 0 ? 'No visible skills matched.' : JSON.stringify(out, null, 2),
  }),
});

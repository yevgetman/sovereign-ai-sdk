// Adapt loaded skills into PromptCommands. Skills and slash commands share
// the same dispatch and tool-scope path in Phase 9.

import type { PromptCommand } from '../commands/types.js';
import type { ContentBlock } from '../core/types.js';
import { expandSkillPrompt, reloadSkill } from './loader.js';
import type { Skill, SkillRegistry } from './types.js';

export function buildSkillCommands(registry: SkillRegistry): PromptCommand[] {
  return registry.skills.map(skillToCommand);
}

function skillToCommand(skill: Skill): PromptCommand {
  return {
    type: 'prompt',
    name: skill.name,
    description: skill.description,
    allowedTools: skill.allowedTools,
    getPromptForCommand: async (args, ctx): Promise<ContentBlock[]> => [
      {
        type: 'text',
        text: await expandSkillPrompt(await reloadSkill(skill), { args, cwd: ctx.cwd }),
      },
    ],
  };
}

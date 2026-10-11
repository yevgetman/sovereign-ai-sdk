// Command-only plugin workflows retain their own host-owned descriptor. They
// stay out of the model's catalog and still activate through the shared gate.
import { buildSkillCommands } from '@yevgetman/sov-sdk/skills/commands';
import type { Skill } from '@yevgetman/sov-sdk/skills/types';
import { COMMANDS, buildCommandRegistry } from '../commands/registry.js';
import type { Runtime } from './runtime.js';

export function resolveSkillInvocation(
  runtime: Pick<Runtime, 'skills' | 'pluginCommands'>,
  name: string,
  source: 'user' | 'command',
): Skill | undefined {
  const catalogSkill = runtime.skills.byName.get(name);
  if (source === 'user' && catalogSkill) return catalogSkill;
  const command = buildCommandRegistry([
    ...COMMANDS,
    ...runtime.pluginCommands,
    ...buildSkillCommands(runtime.skills),
  ]).get(name);
  if (command?.type !== 'prompt' || !command.skill) return undefined;
  const descriptor = command.skill.descriptor ?? catalogSkill;
  // A trusted descriptor may still be malformed. Refuse an identity mismatch
  // rather than activating a different workflow under the requested name.
  return descriptor?.name === name && command.skill.name === name ? descriptor : undefined;
}

// Skill visibility gates. Phase 9.5 supports primary/fallback skill pairs
// that are hidden based on currently active tools and toolsets.

import type { Skill, SkillRegistry } from './types.js';

export function isSkillVisible(
  skill: Skill,
  activeToolsets: readonly string[],
  activeTools: readonly string[],
): boolean {
  const activeToolsetSet = new Set(activeToolsets);
  const activeToolSet = new Set(activeTools);
  const harness = skill.metadata.harness;

  if (!isSubset(harness.requiresToolsets, activeToolsetSet)) return false;
  if (!isSubset(harness.requiresTools, activeToolSet)) return false;
  if (intersects(harness.fallbackForToolsets, activeToolsetSet)) return false;
  if (intersects(harness.fallbackForTools, activeToolSet)) return false;
  return true;
}

export function filterSkillRegistry(
  registry: SkillRegistry,
  activeToolsets: readonly string[],
  activeTools: readonly string[],
): SkillRegistry {
  const skills = registry.skills.filter((skill) =>
    isSkillVisible(skill, activeToolsets, activeTools),
  );
  return {
    skills,
    byName: new Map(skills.map((skill) => [skill.name, skill])),
  };
}

export function inferActiveToolsets(activeTools: readonly string[]): string[] {
  const toolSet = new Set(activeTools);
  const out = new Set<string>();
  if (toolSet.has('Bash')) out.add('terminal');
  if (
    toolSet.has('FileRead') ||
    toolSet.has('FileWrite') ||
    toolSet.has('FileEdit') ||
    toolSet.has('Glob') ||
    toolSet.has('Grep')
  ) {
    out.add('filesystem');
  }
  if (toolSet.has('Grep') || toolSet.has('Glob')) out.add('search');
  if (toolSet.has('memory')) out.add('memory');
  if (toolSet.has('SkillTool') || toolSet.has('skills_list') || toolSet.has('skill_view')) {
    out.add('skills');
  }
  return [...out].sort();
}

function isSubset(required: readonly string[], active: ReadonlySet<string>): boolean {
  return required.every((value) => active.has(value));
}

function intersects(values: readonly string[], active: ReadonlySet<string>): boolean {
  return values.some((value) => active.has(value));
}

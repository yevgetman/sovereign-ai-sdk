// Skill model shared by the loader, slash-command adapter, system prompt,
// and SkillTool. Phase 9 keeps skills as markdown files with frontmatter;
// Phase 9.5 adds progressive disclosure and third-party guard rails.

export type SkillSource = 'project' | 'user' | 'bundle';

export type Skill = {
  name: string;
  description: string;
  whenToUse: string;
  allowedTools: string[];
  path: string;
  realpath: string;
  source: SkillSource;
  body: string;
};

export type SkillRegistry = {
  skills: Skill[];
  byName: Map<string, Skill>;
};

export type SkillExpansionOptions = {
  args?: string;
  cwd: string;
};

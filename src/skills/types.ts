// Skill model shared by the loader, slash-command adapter, system prompt,
// and SkillTool. Phase 9 keeps skills as markdown files with frontmatter;
// Phase 9.5 adds progressive disclosure and third-party guard rails.

export type SkillSource = 'project' | 'user' | 'bundle' | 'community' | 'agent-created' | 'plugin';

export type SkillTrustTier = 'builtin' | 'trusted' | 'community' | 'agent-created';

export type SkillGuardLevel = 'info' | 'medium' | 'critical';

export type SkillGuardFinding = {
  level: SkillGuardLevel;
  category: string;
  pattern: string;
  file: string;
};

export type SkillGuardDecision = {
  action: 'allow' | 'ask' | 'block';
  findings: SkillGuardFinding[];
};

export type SkillHarnessMetadata = {
  requiresToolsets: string[];
  requiresTools: string[];
  fallbackForToolsets: string[];
  fallbackForTools: string[];
};

export type Skill = {
  name: string;
  description: string;
  whenToUse: string;
  allowedTools: string[];
  path: string;
  realpath: string;
  dir: string;
  source: SkillSource;
  trustTier: SkillTrustTier;
  /** Whether the body's inline-shell interpolation (`` `!cmd` `` / `` !`cmd` ``)
   *  is allowed to execute on expand. Forced FALSE for `source:'plugin'` skills
   *  at the loader chokepoint (NOT manifest-controlled) — inline shell runs
   *  OUTSIDE the permission layer, so a plugin must never reach it. TRUE for
   *  every other (trusted/user/bundle/project) source. Variable substitution is
   *  unaffected either way; only the shell-command expansion is gated. */
  allowShellInterpolation: boolean;
  metadata: {
    harness: SkillHarnessMetadata;
  };
  guard: SkillGuardDecision;
  body: string;
};

export type SkillRegistry = {
  skills: Skill[];
  byName: Map<string, Skill>;
};

export type SkillExpansionOptions = {
  args?: string;
  cwd: string;
  sessionId?: string;
};

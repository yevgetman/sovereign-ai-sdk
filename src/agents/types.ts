// AgentDefinition — the record produced by the agent loader and consumed by
// the Phase 13 sub-agent scheduler + AgentTool. Mirrors the Skill record's
// shape so the loader pattern (markdown + YAML frontmatter, three search
// paths, project-precedence dedupe) carries over directly.
//
// `model` and `role` are mutually exclusive. `model` pins the child to a
// literal provider/model string; `role` resolves through the Phase 13.2
// capability profile to whichever model in the configured pool best fits the
// role (e.g. "explore" → cheapest fast small model with adequate context).
//
// `systemPrompt` is read from the frontmatter field if present, otherwise the
// markdown body becomes the prompt — short prompts can stay inline in
// frontmatter, longer ones live more naturally as the body.

export type AgentSource = 'project' | 'user' | 'bundle';

export type AgentTrustTier = 'builtin' | 'trusted';

export type AgentDefinition = {
  name: string;
  description: string;
  whenToUse?: string;
  systemPrompt: string;
  allowedTools: string[];
  model?: string;
  role?: string;
  maxTurns: number;
  readOnly: boolean;
  supportsMissionState: boolean;
  path: string;
  realpath: string;
  dir: string;
  source: AgentSource;
  trustTier: AgentTrustTier;
};

export type AgentRegistry = {
  agents: AgentDefinition[];
  byName: Map<string, AgentDefinition>;
};

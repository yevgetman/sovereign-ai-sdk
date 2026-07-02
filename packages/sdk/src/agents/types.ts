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
  /**
   * Phase 1 T5 — when true, the scheduler hands the child its parent's tool
   * pool (minus the global exclusion set) instead of the strict `allowedTools`
   * allowlist. Default false preserves Phase 13's strict-allowlist behavior.
   */
  inheritParentTools: boolean;
  /**
   * Phase 1 T5 — names of subagent types this child is permitted to dispatch
   * via `AgentTool`. When non-empty, `AgentTool` is removed from the child's
   * exclusion set (see `buildSubagentExclusions`) and AgentTool calls are
   * restricted to listed names (enforcement in T8). Default `[]` keeps the
   * Phase 13.5 no-recursive-spawn ceiling.
   */
  allowedSubagents: string[];
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

export function filterAgentRegistry(
  registry: AgentRegistry,
  excludeRoles: ReadonlySet<string>,
): AgentRegistry {
  const filtered = registry.agents.filter((a) => a.role === undefined || !excludeRoles.has(a.role));
  const byName = new Map<string, AgentDefinition>();
  for (const a of filtered) byName.set(a.name, a);
  return { agents: filtered, byName };
}

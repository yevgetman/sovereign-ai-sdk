import type { AgentConfig } from '../agent/createAgent.js';
import type { CanUseTool } from '../permissions/types.js';
import type { CapabilityProfileRegistry } from '../tool/capabilityProfiles.js';
import type { EstimateRequestBudget, TreeBudget } from './treeBudget.js';

/** Host-selected configuration; model-selected children may only narrow its tool pool. */
export type ChildPolicy = {
  inheritedConfig?: Omit<
    AgentConfig,
    | 'provider'
    | 'model'
    | 'tools'
    | 'toolset'
    | 'sessionStore'
    | 'transcripts'
    | 'maxTokens'
    | 'maxTurns'
  >;
  canUseTool?: CanUseTool;
  capabilityProfiles?: CapabilityProfileRegistry;
  profile?: string;
  treeBudget?: TreeBudget;
  estimateRequestBudget?: EstimateRequestBudget;
};

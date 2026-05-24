import type { LaneConfig, TaskRoutingConfig } from '../config/schema.js';

export const LANE_DEFAULTS: Record<'cheap-task' | 'moderate-task' | 'frontier-task', LaneConfig> = {
  'cheap-task': {
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    allowedTools: null,
    maxTokens: null,
    timeoutMs: 120_000,
  },
  'moderate-task': {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    allowedTools: null,
    maxTokens: null,
    timeoutMs: 120_000,
  },
  'frontier-task': {
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    allowedTools: null,
    maxTokens: null,
    timeoutMs: 120_000,
  },
};

const DELEGATOR_DEFAULTS: LaneConfig = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  allowedTools: ['AgentTool'],
  maxTokens: null,
  timeoutMs: 120_000,
};

export function resolveLane(
  name: string,
  cfg: TaskRoutingConfig | undefined,
): LaneConfig | undefined {
  if (name === 'delegator') {
    return {
      ...DELEGATOR_DEFAULTS,
      model: cfg?.delegator?.model ?? DELEGATOR_DEFAULTS.model,
    };
  }
  if (name === 'cheap-task' || name === 'moderate-task' || name === 'frontier-task') {
    const defaults = LANE_DEFAULTS[name];
    const override = cfg?.lanes?.[name];
    if (override === undefined) return defaults;
    const merged: LaneConfig = { ...defaults };
    if (override.provider !== undefined) merged.provider = override.provider;
    if (override.model !== undefined) merged.model = override.model;
    if (override.allowedTools !== undefined) merged.allowedTools = override.allowedTools;
    if (override.maxTokens !== undefined) merged.maxTokens = override.maxTokens;
    if (override.timeoutMs !== undefined) merged.timeoutMs = override.timeoutMs;
    return merged;
  }
  return undefined;
}

// SPIKE — gate the subscription-executor role out of the model-visible
// AgentTool enum unless its config is enabled (an off-by-default install must
// never expose the headless-subprocess delegation surface). Also re-confirms
// the pre-existing task-routing-role gating is preserved.

import { describe, expect, test } from 'bun:test';
import type { AgentDefinition, AgentRegistry } from '../../src/agents/types.js';
import { computeToolVisibleAgents } from '../../src/server/runtime.js';

function agent(name: string, role?: string): AgentDefinition {
  return {
    name,
    description: `${name} agent`,
    systemPrompt: 'x',
    allowedTools: [],
    ...(role !== undefined ? { role } : {}),
    maxTurns: 5,
    readOnly: true,
    supportsMissionState: false,
    inheritParentTools: false,
    allowedSubagents: [],
    path: `/tmp/${name}.md`,
    realpath: `/tmp/${name}.md`,
    dir: '/tmp',
    source: 'bundle',
    trustTier: 'builtin',
  };
}

function registry(agents: AgentDefinition[]): AgentRegistry {
  const byName = new Map<string, AgentDefinition>();
  for (const a of agents) byName.set(a.name, a);
  return { agents: [...agents], byName };
}

const base = registry([
  agent('explore', 'explore'),
  agent('subscription-executor', 'subscription-executor'),
  agent('cheap-task', 'cheap-task'),
]);

describe('computeToolVisibleAgents — subscription-executor gating', () => {
  test('hides subscription-executor when its config is disabled', () => {
    const visible = computeToolVisibleAgents(base, {
      taskRoutingEnabled: false,
      subscriptionExecutorEnabled: false,
    });
    expect(visible.byName.has('subscription-executor')).toBe(false);
    // unrelated agents stay visible
    expect(visible.byName.has('explore')).toBe(true);
    // task-routing roles still hidden (pre-existing behavior)
    expect(visible.byName.has('cheap-task')).toBe(false);
  });

  test('shows subscription-executor when its config is enabled', () => {
    const visible = computeToolVisibleAgents(base, {
      taskRoutingEnabled: false,
      subscriptionExecutorEnabled: true,
    });
    expect(visible.byName.has('subscription-executor')).toBe(true);
    expect(visible.byName.has('explore')).toBe(true);
    // task routing still off → cheap-task still hidden
    expect(visible.byName.has('cheap-task')).toBe(false);
  });

  test('both flags on → everything visible', () => {
    const visible = computeToolVisibleAgents(base, {
      taskRoutingEnabled: true,
      subscriptionExecutorEnabled: true,
    });
    expect(visible.byName.has('subscription-executor')).toBe(true);
    expect(visible.byName.has('cheap-task')).toBe(true);
    expect(visible.byName.has('explore')).toBe(true);
    // no exclusions → returns the same registry reference
    expect(visible).toBe(base);
  });

  test('task routing on but subscription executor off → executor hidden, lanes shown', () => {
    const visible = computeToolVisibleAgents(base, {
      taskRoutingEnabled: true,
      subscriptionExecutorEnabled: false,
    });
    expect(visible.byName.has('subscription-executor')).toBe(false);
    expect(visible.byName.has('cheap-task')).toBe(true);
  });
});

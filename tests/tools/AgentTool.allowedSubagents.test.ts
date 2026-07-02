// Phase 1 T8 — AgentTool allowedSubagents recursion guard. When the parent
// agent (identified by `ctx.parentAgentName`) declares a non-empty
// `allowedSubagents` list, AgentTool restricts the `subagent_type` argument
// to that list. Empty or undefined parent-name = no restriction (top-level
// harness calls + parents without policy stay unrestricted).
//
// Scheduler-side wiring is exercised in tests/runtime/scheduler.test.ts;
// these tests focus on AgentTool's enforcement of the policy.

import { describe, expect, test } from 'bun:test';
import type { AgentDefinition, AgentRegistry } from '@yevgetman/sov-sdk/agents/types';
import type { DelegateInput } from '@yevgetman/sov-sdk/runtime/scheduler';
import type { ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { AgentTool } from '@yevgetman/sov-sdk/tools/AgentTool';

function makeAgent(name: string, allowedSubagents: string[] = []): AgentDefinition {
  return {
    name,
    description: `${name} agent`,
    systemPrompt: 'be concise',
    allowedTools: ['Read'],
    maxTurns: 5,
    readOnly: true,
    supportsMissionState: false,
    inheritParentTools: false,
    allowedSubagents,
    path: `/tmp/${name}.md`,
    realpath: `/tmp/${name}.md`,
    dir: '/tmp',
    source: 'bundle',
    trustTier: 'builtin',
  };
}

function makeRegistry(agents: AgentDefinition[]): AgentRegistry {
  const byName = new Map<string, AgentDefinition>();
  for (const a of agents) byName.set(a.name, a);
  return { agents, byName };
}

type SchedulerStub = NonNullable<ToolContext['subagentScheduler']>;

function makeStubScheduler(delegateCalls: unknown[] = []): SchedulerStub {
  return {
    activeChildren: () => 0,
    delegate: async (input: DelegateInput) => {
      delegateCalls.push(input);
      return {
        childSessionId: 'child-test',
        agentName: input.agentName,
        resolvedProvider: 'anthropic',
        resolvedModel: 'claude-haiku-4-5-20251001',
        terminal: { reason: 'completed' as const },
        summary: 'fake summary',
        iterationsUsed: 1,
        toolCallCount: 0,
        distinctToolNames: [],
        durationMs: 42,
      };
    },
  } as unknown as SchedulerStub;
}

describe('AgentTool allowedSubagents enforcement', () => {
  test('rejects subagent_type not in parent allowedSubagents', async () => {
    const calls: unknown[] = [];
    const ctx: ToolContext = {
      cwd: process.cwd(),
      sessionId: 'child-of-delegator',
      parentAgentName: 'delegator',
      agents: makeRegistry([
        makeAgent('delegator', ['cheap-task']),
        makeAgent('cheap-task'),
        makeAgent('frontier-task'),
      ]),
      subagentScheduler: makeStubScheduler(calls),
    };
    await expect(
      AgentTool.call({ subagent_type: 'frontier-task', prompt: 'hi' }, ctx),
    ).rejects.toThrow(/not allowed to invoke subagent_type 'frontier-task'/);
    expect(calls).toHaveLength(0);
  });

  test('allows subagent_type that IS in parent allowedSubagents', async () => {
    const calls: unknown[] = [];
    const ctx: ToolContext = {
      cwd: process.cwd(),
      sessionId: 'child-of-delegator',
      parentAgentName: 'delegator',
      agents: makeRegistry([makeAgent('delegator', ['cheap-task']), makeAgent('cheap-task')]),
      subagentScheduler: makeStubScheduler(calls),
    };
    const result = await AgentTool.call({ subagent_type: 'cheap-task', prompt: 'hi' }, ctx);
    expect(calls).toHaveLength(1);
    expect((result.data as { agentName: string }).agentName).toBe('cheap-task');
  });

  test('no restriction when parent has empty allowedSubagents', async () => {
    const calls: unknown[] = [];
    const ctx: ToolContext = {
      cwd: process.cwd(),
      sessionId: 'child-of-delegator',
      parentAgentName: 'delegator',
      agents: makeRegistry([makeAgent('delegator', []), makeAgent('any-task')]),
      subagentScheduler: makeStubScheduler(calls),
    };
    const result = await AgentTool.call({ subagent_type: 'any-task', prompt: 'hi' }, ctx);
    expect(calls).toHaveLength(1);
    expect((result.data as { agentName: string }).agentName).toBe('any-task');
  });

  test('no restriction when parentAgentName is undefined (top-level call)', async () => {
    const calls: unknown[] = [];
    const ctx: ToolContext = {
      cwd: process.cwd(),
      sessionId: 'top-level',
      // parentAgentName intentionally omitted — top-level harness call.
      agents: makeRegistry([makeAgent('any-task')]),
      subagentScheduler: makeStubScheduler(calls),
    };
    const result = await AgentTool.call({ subagent_type: 'any-task', prompt: 'hi' }, ctx);
    expect(calls).toHaveLength(1);
    expect((result.data as { agentName: string }).agentName).toBe('any-task');
  });

  test('lists allowed names in the error message', async () => {
    const ctx: ToolContext = {
      cwd: process.cwd(),
      sessionId: 'child-of-delegator',
      parentAgentName: 'delegator',
      agents: makeRegistry([
        makeAgent('delegator', ['cheap-task', 'moderate-task']),
        makeAgent('cheap-task'),
        makeAgent('moderate-task'),
        makeAgent('frontier-task'),
      ]),
      subagentScheduler: makeStubScheduler(),
    };
    await expect(
      AgentTool.call({ subagent_type: 'frontier-task', prompt: 'hi' }, ctx),
    ).rejects.toThrow(/Allowed: cheap-task, moderate-task/);
  });
});

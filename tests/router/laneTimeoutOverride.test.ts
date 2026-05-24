// Phase 2 T3 — AgentTool lane-timeout override resolution.
//
// Verifies the AgentTool resolves `perChildTimeoutMsOverride` from the
// ToolContext's `laneRegistry` when the target agent declares a `role`
// that maps to a configured lane, and threads it onto
// `scheduler.delegate()`. Three cases:
//
//   1. Lane hit → override passed to scheduler.delegate.
//   2. laneRegistry absent → no override (scheduler falls through to its
//      construction-time defaults).
//   3. Agent role not in registry → no override.
//
// The tests stub the scheduler so they assert the input shape
// directly, without booting a full runtime.
//
// Plan: docs/plans/2026-05-23-phase-2-task-routing.md (T3)
// Spec: docs/specs/2026-05-23-multi-provider-task-routing-design.md

import { describe, expect, test } from 'bun:test';
import type { AgentDefinition, AgentRegistry } from '../../src/agents/types.js';
import type {
  DelegateInput,
  DelegateResult,
  SubagentScheduler,
} from '../../src/runtime/scheduler.js';
import type { ToolContext } from '../../src/tool/types.js';

function makeAgent(overrides: Partial<AgentDefinition>): AgentDefinition {
  return {
    name: 'test-agent',
    description: 'Test agent',
    systemPrompt: 'You are a test agent.',
    allowedTools: [],
    inheritParentTools: false,
    allowedSubagents: [],
    maxTurns: 30,
    readOnly: true,
    supportsMissionState: false,
    path: '/test',
    realpath: '/test',
    dir: '/test',
    source: 'bundle',
    trustTier: 'builtin',
    ...overrides,
  };
}

function makeRegistry(agent: AgentDefinition): AgentRegistry {
  return {
    agents: [agent],
    byName: new Map([[agent.name, agent]]),
  };
}

function makeStubScheduler(capture: { override?: number | undefined }): {
  delegate: (input: DelegateInput) => Promise<DelegateResult>;
} {
  return {
    delegate: async (input: DelegateInput): Promise<DelegateResult> => {
      capture.override = input.perChildTimeoutMsOverride;
      return {
        childSessionId: 'child-id',
        agentName: input.agentName,
        resolvedProvider: 'mock',
        resolvedModel: 'mock-haiku',
        terminal: { reason: 'completed' },
        summary: 'ok',
        iterationsUsed: 1,
        toolCallCount: 0,
        distinctToolNames: [],
        durationMs: 1,
      };
    },
  };
}

describe('AgentTool resolves perChildTimeoutMsOverride from laneRegistry', () => {
  test('passes lane timeoutMs as perChildTimeoutMsOverride to scheduler.delegate', async () => {
    const agent = makeAgent({ name: 'cheap-task', role: 'cheap-task' });
    const agents = makeRegistry(agent);

    const capture: { override?: number | undefined } = {};
    const stubScheduler = makeStubScheduler(capture);

    const stubLaneRegistry = {
      lookup: (role: string) => {
        if (role === 'cheap-task') {
          return {
            provider: 'mock',
            model: 'mock-haiku',
            allowedTools: null,
            maxTokens: null,
            timeoutMs: 50,
          };
        }
        return undefined;
      },
      entries: () => [],
    };

    const ctx: Partial<ToolContext> = {
      sessionId: 'test-session',
      cwd: '/tmp/test',
      laneRegistry: stubLaneRegistry,
      agents,
      subagentScheduler: stubScheduler as unknown as SubagentScheduler,
    };

    const { AgentTool } = await import('../../src/tools/AgentTool.js');
    const result = await AgentTool.call(
      { subagent_type: 'cheap-task', prompt: 'do work' } as never,
      ctx as ToolContext,
    );
    // ToolResult shape from buildTool: { data, observation? }.
    expect(result.data).toBeDefined();
    expect(capture.override).toBe(50);
  });

  test('does NOT pass override when laneRegistry is absent', async () => {
    const agent = makeAgent({ name: 'explore', role: 'explore' });
    const agents = makeRegistry(agent);

    const capture: { override?: number | undefined } = { override: 99 };
    const stubScheduler = makeStubScheduler(capture);

    const ctx: Partial<ToolContext> = {
      sessionId: 'test-session',
      cwd: '/tmp/test',
      // laneRegistry deliberately absent
      agents,
      subagentScheduler: stubScheduler as unknown as SubagentScheduler,
    };

    const { AgentTool } = await import('../../src/tools/AgentTool.js');
    await AgentTool.call(
      { subagent_type: 'explore', prompt: 'do work' } as never,
      ctx as ToolContext,
    );
    expect(capture.override).toBeUndefined();
  });

  test('does NOT pass override when laneRegistry has no entry for the agent role', async () => {
    const agent = makeAgent({ name: 'unknown-role-agent', role: 'unknown-role' });
    const agents = makeRegistry(agent);

    const capture: { override?: number | undefined } = { override: 99 };
    const stubScheduler = makeStubScheduler(capture);

    const stubLaneRegistry = {
      lookup: (_role: string) => undefined,
      entries: () => [],
    };

    const ctx: Partial<ToolContext> = {
      sessionId: 'test-session',
      cwd: '/tmp/test',
      laneRegistry: stubLaneRegistry,
      agents,
      subagentScheduler: stubScheduler as unknown as SubagentScheduler,
    };

    const { AgentTool } = await import('../../src/tools/AgentTool.js');
    await AgentTool.call(
      { subagent_type: 'unknown-role-agent', prompt: 'do work' } as never,
      ctx as ToolContext,
    );
    expect(capture.override).toBeUndefined();
  });

  test('does NOT pass override when target agent has no role field', async () => {
    // Agents that pin `model` instead of `role` should never trigger a
    // lane lookup (the role path is what maps to lanes).
    const agent = makeAgent({ name: 'model-pinned', model: 'mock/mock-haiku' });
    const agents = makeRegistry(agent);

    const capture: { override?: number | undefined } = { override: 99 };
    const stubScheduler = makeStubScheduler(capture);

    const stubLaneRegistry = {
      lookup: (_role: string) => {
        // Should never be called when role is absent.
        throw new Error('laneRegistry.lookup must not be called when agent.role is undefined');
      },
      entries: () => [],
    };

    const ctx: Partial<ToolContext> = {
      sessionId: 'test-session',
      cwd: '/tmp/test',
      laneRegistry: stubLaneRegistry,
      agents,
      subagentScheduler: stubScheduler as unknown as SubagentScheduler,
    };

    const { AgentTool } = await import('../../src/tools/AgentTool.js');
    await AgentTool.call(
      { subagent_type: 'model-pinned', prompt: 'do work' } as never,
      ctx as ToolContext,
    );
    expect(capture.override).toBeUndefined();
  });
});

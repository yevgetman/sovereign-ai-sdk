import { describe, expect, test } from 'bun:test';
import { runTools } from '@yevgetman/sov-sdk/core/orchestrator';
import { activateSkill, createSkillActivationState } from '@yevgetman/sov-sdk/skills/activation';
import type { Skill } from '@yevgetman/sov-sdk/skills/types';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import type { ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { z } from 'zod';

function skill(name: string, allowedTools: string[], body = 'Use the allowed tools.'): Skill {
  return {
    name,
    description: 'Concurrent activation fixture',
    whenToUse: '',
    allowedTools,
    path: '/memory/SKILL.md',
    realpath: '/memory/SKILL.md',
    dir: '/memory',
    source: 'project',
    trustTier: 'trusted',
    allowShellInterpolation: true,
    metadata: {
      harness: {
        requiresToolsets: [],
        requiresTools: [],
        fallbackForToolsets: [],
        fallbackForTools: [],
      },
    },
    guard: { action: 'allow', findings: [] },
    body,
  };
}

const resolveSkill = async (current: Skill) => current;
const allowedResourceRoots: string[] = [];

function namedTool(name: string, effect = () => {}) {
  return buildTool<unknown, unknown>({
    name,
    description: () => name,
    inputSchema: z.unknown(),
    checkPermissions: async () => ({ behavior: 'allow' }),
    call: async () => {
      effect();
      return { data: 'ok' };
    },
  });
}

describe('parallel host skill activation', () => {
  test('disjoint activations cannot restore a tool removed by the first activation', async () => {
    let writes = 0;
    const read = namedTool('Read');
    const write = namedTool('Write', () => writes++);
    const state = createSkillActivationState({ tools: [read, write] });
    const context: ToolContext = { cwd: '/tmp', sessionId: 'fixture', skillActivation: state };
    const options = {
      source: 'user' as const,
      state,
      toolContext: context,
      resolveSkill,
      allowedResourceRoots,
    };
    await Promise.all([
      activateSkill(skill('read-only', ['Read']), options),
      activateSkill(skill('write-only', ['Write']), options),
    ]);
    for await (const _ of runTools(
      [{ type: 'tool_use', id: 'write', name: 'Write', input: {} }],
      context,
      [write],
      state.canUseTool,
    )) {
    }
    expect(writes).toBe(0);
    expect(state.tools).toEqual([]);
    expect(state.activations.map((activation) => activation.name)).toEqual([
      'read-only',
      'write-only',
    ]);
    expect((await state.restrictionCanUseTool(write, {}, context)).behavior).toBe('deny');
  });

  test('parallel inline expansion observes the earlier activation before executing', async () => {
    let commands = 0;
    const state = createSkillActivationState({
      tools: [namedTool('Read'), namedTool('Bash', () => commands++)],
      canUseTool: async () => ({ behavior: 'allow' }),
    });
    const context: ToolContext = { cwd: '/tmp', sessionId: 'fixture', skillActivation: state };
    const options = {
      source: 'user' as const,
      state,
      toolContext: context,
      resolveSkill,
      allowedResourceRoots,
    };
    const results = await Promise.allSettled([
      activateSkill(skill('read-only', ['Read']), options),
      activateSkill(skill('shell-only', ['Bash'], 'Shell !`touch marker`'), options),
    ]);
    expect(commands).toBe(0);
    expect(results[0]?.status).toBe('fulfilled');
    expect(results[1]?.status).toBe('rejected');
    expect(state.tools.map((tool) => tool.name)).toEqual(['Read']);
    expect(state.activations).toHaveLength(1);
  });

  test('a rejected queued activation releases later requests without granting its scope', async () => {
    const state = createSkillActivationState({ tools: [namedTool('Read'), namedTool('Write')] });
    const context: ToolContext = { cwd: '/tmp', sessionId: 'fixture', skillActivation: state };
    const options = {
      source: 'user' as const,
      state,
      toolContext: context,
      resolveSkill,
      allowedResourceRoots,
    };
    const results = await Promise.allSettled([
      activateSkill(
        { ...skill('blocked', ['Write']), guard: { action: 'block', findings: [] } },
        options,
      ),
      activateSkill(skill('read-only', ['Read']), options),
    ]);
    expect(results[0]?.status).toBe('rejected');
    expect(results[1]?.status).toBe('fulfilled');
    expect(state.tools.map((tool) => tool.name)).toEqual(['Read']);
    expect(state.activations.map((activation) => activation.name)).toEqual(['read-only']);
    await activateSkill(skill('third', ['Read']), options);
    expect(state.activations).toHaveLength(2);
  });

  test('an activation waiting on its host cannot block another turn state', async () => {
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = createSkillActivationState({ tools: [namedTool('Read')] });
    const second = createSkillActivationState({ tools: [namedTool('Write')] });
    const delayed = activateSkill(skill('first', ['Read']), {
      source: 'user',
      state: first,
      toolContext: { cwd: '/tmp', sessionId: 'same-session' },
      allowedResourceRoots,
      resolveSkill: async (current) => {
        entered();
        await gate;
        return current;
      },
    });
    try {
      await started;
      await activateSkill(skill('second', ['Write']), {
        source: 'user',
        state: second,
        toolContext: { cwd: '/tmp', sessionId: 'same-session' },
        resolveSkill,
        allowedResourceRoots,
      });
      expect(second.activations).toHaveLength(1);
      expect(first.activations).toHaveLength(0);
    } finally {
      release();
      await delayed;
    }
    expect(first.activations).toHaveLength(1);
  });

  test('a cancelled queued request performs no lookup and releases the following activation', async () => {
    const state = createSkillActivationState({ tools: [namedTool('Read')] });
    const context: ToolContext = { cwd: '/tmp', sessionId: 'fixture', skillActivation: state };
    const controller = new AbortController();
    let lookups = 0;
    const options = {
      source: 'user' as const,
      state,
      toolContext: context,
      resolveSkill,
      allowedResourceRoots,
    };
    const first = activateSkill(skill('first', ['Read']), options);
    const cancelled = activateSkill(skill('cancelled', ['Read']), {
      ...options,
      toolContext: { ...context, signal: controller.signal },
      resolveSkill: async (current) => {
        lookups++;
        return current;
      },
    });
    const last = activateSkill(skill('last', ['Read']), options);
    controller.abort();
    const results = await Promise.allSettled([first, cancelled, last]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(lookups).toBe(0);
    expect(state.activations.map((activation) => activation.name)).toEqual(['first', 'last']);
  });
});

// task_create tool tests. The tool is a thin wrapper around TaskManager;
// these tests exercise input validation, error surfaces (no manager, no
// agents registry, unknown agent), and the structured-output path.

import { describe, expect, test } from 'bun:test';
import type { AgentDefinition, AgentRegistry } from '@yevgetman/sov-sdk/agents/types';
import type { ToolContext, ToolResult } from '@yevgetman/sov-sdk/tool/types';
import { TaskCreateTool } from '@yevgetman/sov-sdk/tools/TaskCreateTool';
import type { CreateTaskInput, TaskRecord } from '../../src/tasks/types.js';

function makeAgent(name: string): AgentDefinition {
  return {
    name,
    description: `${name} agent`,
    systemPrompt: 'be concise',
    allowedTools: ['Read'],
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

function makeRegistry(names: string[]): AgentRegistry {
  const byName = new Map<string, AgentDefinition>();
  for (const n of names) byName.set(n, makeAgent(n));
  return { agents: names.map((n) => makeAgent(n)), byName };
}

type ManagerStub = NonNullable<ToolContext['taskManager']>;

function makeStubManager(opts: { recordOverride?: Partial<TaskRecord> } = {}): {
  manager: ManagerStub;
  createCalls: CreateTaskInput[];
} {
  const createCalls: CreateTaskInput[] = [];
  const manager = {
    create: async (input: CreateTaskInput) => {
      createCalls.push(input);
      const now = new Date().toISOString();
      const record: TaskRecord = {
        id: 't-stub-1',
        parentSessionId: input.parentSessionId,
        agent: input.agentName,
        prompt: input.prompt,
        state: 'queued',
        createdAt: now,
        updatedAt: now,
        ...opts.recordOverride,
      };
      return record;
    },
    get: () => null,
    list: () => [],
    stop: async () => null,
    output: () => null,
  } as unknown as ManagerStub;
  return { manager, createCalls };
}

describe('TaskCreateTool', () => {
  test('throws when no taskManager is wired in ToolContext', async () => {
    const ctx: ToolContext = {
      cwd: process.cwd(),
      sessionId: 'parent',
      agents: makeRegistry(['explore']),
    };
    await expect(
      TaskCreateTool.call({ subagent_type: 'explore', prompt: 'find auth' }, ctx),
    ).rejects.toThrow(/no task manager/);
  });

  test('throws when subagent_type is not registered', async () => {
    const { manager } = makeStubManager();
    const ctx: ToolContext = {
      cwd: process.cwd(),
      sessionId: 'parent',
      agents: makeRegistry(['explore']),
      taskManager: manager,
    };
    await expect(
      TaskCreateTool.call({ subagent_type: 'mystery', prompt: 'p' }, ctx),
    ).rejects.toThrow(/unknown subagent_type 'mystery'/);
  });

  test('delegates to manager.create and returns the queued record', async () => {
    const { manager, createCalls } = makeStubManager();
    const ctx: ToolContext = {
      cwd: process.cwd(),
      sessionId: 'parent-xyz',
      agents: makeRegistry(['explore']),
      taskManager: manager,
    };
    const result = await TaskCreateTool.call(
      { subagent_type: 'explore', prompt: 'find auth' },
      ctx,
    );
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.parentSessionId).toBe('parent-xyz');
    expect(createCalls[0]?.agentName).toBe('explore');
    expect(createCalls[0]?.prompt).toBe('find auth');
    const r = result as ToolResult<TaskRecord>;
    expect(r.data.id).toBe('t-stub-1');
    expect(r.data.state).toBe('queued');
    expect(r.observation?.status).toBe('success');
    expect(r.observation?.artifacts).toContain('task:t-stub-1');
  });
});

// task_list tool tests. The tool is a thin wrapper around TaskManager.list;
// these tests exercise input validation, error surfaces (no manager), and
// the default-vs-include_all filter path.

import { describe, expect, test } from 'bun:test';
import type { ToolContext, ToolResult } from '@yevgetman/sov-sdk/tool/types';
import { TaskListTool } from '@yevgetman/sov-sdk/tools/TaskListTool';
import type { TaskRecord } from '../../src/tasks/types.js';

function makeStubManager(records: TaskRecord[]): NonNullable<ToolContext['taskManager']> {
  return {
    create: async () => {
      const first = records[0];
      if (!first) throw new Error('makeStubManager: empty records');
      return first;
    },
    get: (id: string) => records.find((r) => r.id === id) ?? null,
    list: (_p: string, opts?: { includeAll?: boolean }) =>
      opts?.includeAll
        ? records
        : records.filter((r) => r.state === 'queued' || r.state === 'running'),
    stop: async () => null,
    output: () => null,
  } as unknown as NonNullable<ToolContext['taskManager']>;
}

const baseRecord: TaskRecord = {
  id: 't-1',
  parentSessionId: 'parent',
  agent: 'explore',
  prompt: 'p',
  state: 'running',
  createdAt: '2026-05-06T00:00:00.000Z',
  updatedAt: '2026-05-06T00:00:01.000Z',
};

describe('TaskListTool', () => {
  test('throws when no taskManager', async () => {
    const ctx: ToolContext = { cwd: process.cwd(), sessionId: 'parent' };
    await expect(TaskListTool.call({}, ctx)).rejects.toThrow(/no task manager/);
  });

  test('default filter returns active tasks for current session', async () => {
    const completed = { ...baseRecord, id: 't-2', state: 'completed' as const };
    const ctx: ToolContext = {
      cwd: process.cwd(),
      sessionId: 'parent',
      taskManager: makeStubManager([baseRecord, completed]),
    };
    const result = await TaskListTool.call({}, ctx);
    const r = result as ToolResult<{ tasks: TaskRecord[] }>;
    expect(r.data.tasks.map((t) => t.id)).toEqual(['t-1']);
  });

  test('include_all=true returns all states', async () => {
    const completed = { ...baseRecord, id: 't-2', state: 'completed' as const };
    const ctx: ToolContext = {
      cwd: process.cwd(),
      sessionId: 'parent',
      taskManager: makeStubManager([baseRecord, completed]),
    };
    const result = await TaskListTool.call({ include_all: true }, ctx);
    const r = result as ToolResult<{ tasks: TaskRecord[] }>;
    expect(r.data.tasks.map((t) => t.id)).toEqual(['t-1', 't-2']);
  });
});

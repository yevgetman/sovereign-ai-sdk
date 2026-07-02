// task_stop tool tests. The tool is a thin wrapper around TaskManager.stop;
// the test exercises the cooperative-cancellation path: stop is called
// with the id and the (possibly still-running) record is returned.

import { describe, expect, test } from 'bun:test';
import type { ToolContext, ToolResult } from '@yevgetman/sov-sdk/tool/types';
import { TaskStopTool } from '@yevgetman/sov-sdk/tools/TaskStopTool';
import type { TaskRecord } from '../../src/tasks/types.js';

const record: TaskRecord = {
  id: 't-1',
  parentSessionId: 'parent',
  agent: 'explore',
  prompt: 'p',
  state: 'cancelled',
  createdAt: '2026-05-06T00:00:00.000Z',
  updatedAt: '2026-05-06T00:00:02.000Z',
};

function makeStubManager(stopCalls: string[]): NonNullable<ToolContext['taskManager']> {
  return {
    create: async () => record,
    get: () => record,
    list: () => [],
    stop: async (id: string) => {
      stopCalls.push(id);
      return record;
    },
    output: () => null,
  } as unknown as NonNullable<ToolContext['taskManager']>;
}

describe('TaskStopTool', () => {
  test('calls manager.stop and returns the record', async () => {
    const calls: string[] = [];
    const ctx: ToolContext = {
      cwd: process.cwd(),
      sessionId: 'parent',
      taskManager: makeStubManager(calls),
    };
    const result = await TaskStopTool.call({ task_id: 't-1' }, ctx);
    expect(calls).toEqual(['t-1']);
    const r = result as ToolResult<TaskRecord>;
    expect(r.data.state).toBe('cancelled');
  });

  test('throws when no taskManager is wired in ToolContext', async () => {
    const ctx: ToolContext = { cwd: process.cwd(), sessionId: 'parent' };
    await expect(TaskStopTool.call({ task_id: 't-1' }, ctx)).rejects.toThrow(/no task manager/);
  });

  test('throws when task id is unknown (manager.stop returned null)', async () => {
    const calls: string[] = [];
    const stub: NonNullable<ToolContext['taskManager']> = {
      create: async () => record,
      get: () => null,
      list: () => [],
      stop: async (id: string) => {
        calls.push(id);
        return null;
      },
      output: () => null,
    } as unknown as NonNullable<ToolContext['taskManager']>;
    const ctx: ToolContext = {
      cwd: process.cwd(),
      sessionId: 'parent',
      taskManager: stub,
    };
    await expect(TaskStopTool.call({ task_id: 'no-such-id' }, ctx)).rejects.toThrow(
      /no task with id/,
    );
  });
});

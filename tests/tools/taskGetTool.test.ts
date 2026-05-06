// task_get tool tests. The tool is a thin wrapper around TaskManager.get;
// these tests exercise the happy path (known id returns full record) and
// the throws-on-unknown-id path.

import { describe, expect, test } from 'bun:test';
import type { TaskRecord } from '../../src/tasks/types.js';
import type { ToolContext, ToolResult } from '../../src/tool/types.js';
import { TaskGetTool } from '../../src/tools/TaskGetTool.js';

const record: TaskRecord = {
  id: 't-1',
  parentSessionId: 'parent',
  agent: 'explore',
  prompt: 'p',
  state: 'completed',
  createdAt: '2026-05-06T00:00:00.000Z',
  updatedAt: '2026-05-06T00:00:01.000Z',
  resultPreview: 'done',
};

function makeStubManager(): NonNullable<ToolContext['taskManager']> {
  return {
    create: async () => record,
    get: (id: string) => (id === 't-1' ? record : null),
    list: () => [],
    stop: async () => null,
    output: () => null,
  } as unknown as NonNullable<ToolContext['taskManager']>;
}

describe('TaskGetTool', () => {
  test('returns the record for a known id', async () => {
    const ctx: ToolContext = {
      cwd: process.cwd(),
      sessionId: 'parent',
      taskManager: makeStubManager(),
    };
    const result = await TaskGetTool.call({ task_id: 't-1' }, ctx);
    const r = result as ToolResult<TaskRecord>;
    expect(r.data.id).toBe('t-1');
    expect(r.data.state).toBe('completed');
  });

  test('throws on unknown id', async () => {
    const ctx: ToolContext = {
      cwd: process.cwd(),
      sessionId: 'parent',
      taskManager: makeStubManager(),
    };
    await expect(TaskGetTool.call({ task_id: 'no-such-id' }, ctx)).rejects.toThrow(
      /no task with id/,
    );
  });
});

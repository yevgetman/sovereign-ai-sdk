// task_output tool tests. The tool is a thin wrapper around TaskManager.output;
// these tests exercise the happy path (full output for completed task) and
// the throws-on-null-output path (manager.output returned null).

import { describe, expect, test } from 'bun:test';
import type { ToolContext, ToolResult } from '@yevgetman/sov-sdk/tool/types';
import { TaskOutputTool } from '@yevgetman/sov-sdk/tools/TaskOutputTool';
import type { TaskOutput } from '../../src/tasks/manager.js';

function makeStubManager(output: TaskOutput | null): NonNullable<ToolContext['taskManager']> {
  return {
    create: async () => ({
      id: 't-1',
      parentSessionId: 'parent',
      agent: 'explore',
      prompt: 'p',
      state: 'queued',
      createdAt: '2026-05-06T00:00:00.000Z',
      updatedAt: '2026-05-06T00:00:00.000Z',
    }),
    get: () => null,
    list: () => [],
    stop: async () => null,
    output: () => output,
  } as unknown as NonNullable<ToolContext['taskManager']>;
}

describe('TaskOutputTool', () => {
  test('returns full output for a completed task', async () => {
    const ctx: ToolContext = {
      cwd: process.cwd(),
      sessionId: 'parent',
      taskManager: makeStubManager({
        state: 'completed',
        summary: 'done',
        iterationsUsed: 3,
        toolCallCount: 2,
        durationMs: 1234,
        terminalReason: 'completed',
        childSessionId: 'child-1',
      }),
    };
    const result = await TaskOutputTool.call({ task_id: 't-1' }, ctx);
    const r = result as ToolResult<TaskOutput>;
    expect(r.data.state).toBe('completed');
    expect(r.data.summary).toBe('done');
    expect(r.observation?.artifacts).toContain('session:child-1');
  });

  test('observation status is "error" for timed_out state', async () => {
    const ctx: ToolContext = {
      cwd: process.cwd(),
      sessionId: 'parent',
      taskManager: makeStubManager({
        state: 'timed_out',
        summary: 'too slow',
        childSessionId: 'child-1',
      }),
    };
    const result = await TaskOutputTool.call({ task_id: 't-1' }, ctx);
    const r = result as ToolResult<TaskOutput>;
    expect(r.observation?.status).toBe('error');
  });

  test('throws for an unknown task id (manager.output returned null)', async () => {
    const ctx: ToolContext = {
      cwd: process.cwd(),
      sessionId: 'parent',
      taskManager: makeStubManager(null),
    };
    await expect(TaskOutputTool.call({ task_id: 'no-such-id' }, ctx)).rejects.toThrow(
      /no task with id/,
    );
  });
});

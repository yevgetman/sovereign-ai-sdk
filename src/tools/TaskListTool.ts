// Phase 13.2 — task_list tool. Returns active (queued + running) tasks
// for the current parent session by default; pass include_all=true for
// the full history including terminal states.

import { z } from 'zod';
import type { TaskRecord } from '../tasks/types.js';
import { buildTool } from '../tool/buildTool.js';

const TaskListInputSchema = z.object({
  include_all: z
    .boolean()
    .optional()
    .describe('When true, includes completed/failed/cancelled tasks. Default false (active only).'),
});

export type TaskListInput = z.infer<typeof TaskListInputSchema>;
export type TaskListOutput = { tasks: TaskRecord[] };

export const TaskListTool = buildTool<TaskListInput, TaskListOutput>({
  name: 'task_list',
  searchHint: 'List background sub-agent tasks.',
  description: () =>
    'List sub-agent tasks for the current session. Default: active tasks (queued + running). Pass include_all=true for the full history.',
  inputSchema: TaskListInputSchema,
  displayInput: (input) => (input.include_all ? 'all' : 'active'),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    const manager = ctx.taskManager;
    if (!manager) {
      throw new Error('task_list: no task manager in ToolContext');
    }
    const tasks = manager.list(ctx.sessionId, {
      ...(input.include_all === true ? { includeAll: true } : {}),
    });
    return {
      data: { tasks },
      observation: {
        status: 'success',
        summary: `${tasks.length} task${tasks.length === 1 ? '' : 's'}`,
      },
    };
  },
}) as unknown as import('../tool/types.js').Tool<unknown, unknown>;

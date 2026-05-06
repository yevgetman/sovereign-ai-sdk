// Phase 13.2 — task_stop tool. Cooperative cancellation: aborts the
// task's controller and returns the (possibly still-running) record.
// The state transition to 'cancelled' lands once the scheduler unwinds
// the in-flight delegate() — callers should poll task_get if they need
// to confirm.
//
// task_stop is in SUBAGENT_EXCLUDED_TOOLS — children cannot call it.
// Only the parent session's tool pool exposes it.

import { z } from 'zod';
import type { TaskRecord } from '../tasks/types.js';
import { buildTool } from '../tool/buildTool.js';

const TaskStopInputSchema = z.object({
  task_id: z.string().min(1).describe('The id returned by task_create.'),
});

export type TaskStopInput = z.infer<typeof TaskStopInputSchema>;

export const TaskStopTool = buildTool<TaskStopInput, TaskRecord>({
  name: 'task_stop',
  searchHint: 'Cancel a running sub-agent task.',
  description: () =>
    'Cancel a running task cooperatively. Returns the current record; state may still be running until the scheduler unwinds — re-read with task_get to confirm cancellation.',
  inputSchema: TaskStopInputSchema,
  displayInput: (input) => input.task_id,
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    const manager = ctx.taskManager;
    if (!manager) {
      throw new Error('task_stop: no task manager in ToolContext');
    }
    const record = await manager.stop(input.task_id);
    if (!record) {
      throw new Error(`task_stop: no task with id '${input.task_id}'`);
    }
    return {
      data: record,
      observation: {
        status: 'success',
        summary: `task ${record.id.slice(0, 8)} stop signaled`,
        artifacts: [`task:${record.id}`],
      },
    };
  },
}) as unknown as import('../tool/types.js').Tool<unknown, unknown>;

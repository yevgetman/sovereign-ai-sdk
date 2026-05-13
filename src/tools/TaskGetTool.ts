// Phase 13.2 — task_get tool. Returns the persisted TaskRecord for one
// task. Throws when the id is unknown so the model gets a clear error
// rather than a silent null.

import { z } from 'zod';
import type { TaskRecord } from '../tasks/types.js';
import { buildTool } from '../tool/buildTool.js';

const TaskGetInputSchema = z.object({
  task_id: z.string().min(1).describe('The id returned by task_create.'),
});

export type TaskGetInput = z.infer<typeof TaskGetInputSchema>;

export const TaskGetTool = buildTool<TaskGetInput, TaskRecord>({
  name: 'task_get',
  searchHint: 'Inspect one sub-agent task by id.',
  description: () =>
    'Return the full TaskRecord for one task: state, agent, prompt, timestamps, child session id, result preview.',
  inputSchema: TaskGetInputSchema,
  displayInput: (input) => input.task_id,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  renderHint: { kind: 'markdown' },
  async call(input, ctx) {
    const manager = ctx.taskManager;
    if (!manager) {
      throw new Error('task_get: no task manager in ToolContext');
    }
    const record = manager.get(input.task_id);
    if (!record) {
      throw new Error(`task_get: no task with id '${input.task_id}'`);
    }
    return {
      data: record,
      observation: {
        status: 'success',
        summary: `${record.id.slice(0, 8)} ${record.state}`,
        artifacts: [`task:${record.id}`],
      },
    };
  },
}) as unknown as import('../tool/types.js').Tool<unknown, unknown>;

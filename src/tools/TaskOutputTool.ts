// Phase 13.2 — task_output tool. Returns the bounded output payload
// from the manager: state, summary, counters, terminal reason, child
// session id, and the persisted result preview. The full transcript
// lives in the child session's messages — query it directly via
// childSessionId if needed.

import { z } from 'zod';
import type { TaskOutput } from '../tasks/manager.js';
import { buildTool } from '../tool/buildTool.js';

const TaskOutputInputSchema = z.object({
  task_id: z.string().min(1).describe('The id returned by task_create.'),
});

export type TaskOutputInput = z.infer<typeof TaskOutputInputSchema>;

export const TaskOutputTool = buildTool<TaskOutputInput, TaskOutput>({
  name: 'task_output',
  searchHint: 'Read the bounded output of a sub-agent task.',
  description: () =>
    'Return the output payload for a task: state, summary, counters, terminal reason, child session id, result preview. While the task is running, the payload is minimal; once terminal, includes summary and counters.',
  inputSchema: TaskOutputInputSchema,
  displayInput: (input) => input.task_id,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    const manager = ctx.taskManager;
    if (!manager) {
      throw new Error('task_output: no task manager in ToolContext');
    }
    const out = manager.output(input.task_id);
    if (!out) {
      throw new Error(`task_output: no task with id '${input.task_id}'`);
    }
    return {
      data: out,
      observation: {
        status: out.state === 'failed' ? 'error' : 'success',
        summary: `${input.task_id.slice(0, 8)} ${out.state}${
          out.iterationsUsed !== undefined ? ` (${out.iterationsUsed} turns)` : ''
        }`,
        artifacts:
          out.childSessionId !== undefined
            ? [`task:${input.task_id}`, `session:${out.childSessionId}`]
            : [`task:${input.task_id}`],
      },
    };
  },
}) as unknown as import('../tool/types.js').Tool<unknown, unknown>;

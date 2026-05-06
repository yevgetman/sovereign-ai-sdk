// Phase 13.2 — task_create tool. Spawns a sub-agent task and returns the
// queued record immediately. The model uses task_list / task_get /
// task_output to observe progress and task_stop to cancel.
//
// Patches: same subagent_type-enum patching pattern as AgentTool. The
// registry's patchSchemasAgainstAvailable() rewrites the open string
// to a closed enum at tool-pool assembly time.

import { z } from 'zod';
import type { TaskRecord } from '../tasks/types.js';
import { buildTool } from '../tool/buildTool.js';

const TaskCreateInputSchema = z.object({
  subagent_type: z.string().min(1).describe('The name of the loaded sub-agent to delegate to.'),
  prompt: z
    .string()
    .min(1)
    .describe(
      'The task description for the sub-agent. The agent runs as a separate session and only receives this prompt.',
    ),
});

export type TaskCreateInput = z.infer<typeof TaskCreateInputSchema>;

export const TaskCreateTool = buildTool<TaskCreateInput, TaskRecord>({
  name: 'task_create',
  searchHint: 'Spawn a background sub-agent task.',
  description: () =>
    [
      'Spawn a sub-agent task that runs in the background and returns immediately with a task id.',
      'Use this instead of AgentTool when you want to dispatch work and continue without blocking.',
      'Use task_get / task_output to inspect progress and task_stop to cancel.',
    ].join(' '),
  inputSchema: TaskCreateInputSchema,
  displayInput: (input) => `${input.subagent_type}: ${input.prompt}`,
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  async call(input, ctx) {
    const manager = ctx.taskManager;
    if (!manager) {
      throw new Error(
        'task_create: no task manager in ToolContext (harness bootstrap did not wire one)',
      );
    }
    const agents = ctx.agents;
    if (!agents || !agents.byName.has(input.subagent_type)) {
      const available = agents ? [...agents.byName.keys()].sort().join(', ') : '(none loaded)';
      throw new Error(
        `task_create: unknown subagent_type '${input.subagent_type}'. Available: ${available}`,
      );
    }
    const record = await manager.create({
      parentSessionId: ctx.sessionId,
      agentName: input.subagent_type,
      prompt: input.prompt,
      parentToolPool: ctx.parentToolPool ?? [],
      parentToolContext: ctx,
      ...(ctx.canUseTool !== undefined ? { canUseTool: ctx.canUseTool } : {}),
      ...(ctx.memoryManager !== undefined ? { memoryManager: ctx.memoryManager } : {}),
      ...(ctx.traceRecorder !== undefined ? { traceRecorder: ctx.traceRecorder } : {}),
    });
    return {
      data: record,
      observation: {
        status: 'success',
        summary: `task ${record.id.slice(0, 8)} ${record.state} (agent=${record.agent})`,
        artifacts: [`task:${record.id}`],
        next_actions: [
          `task_get { task_id: '${record.id}' }`,
          `task_output { task_id: '${record.id}' }`,
          `task_stop { task_id: '${record.id}' }`,
        ],
      },
    };
  },
}) as unknown as import('../tool/types.js').Tool<unknown, unknown>;

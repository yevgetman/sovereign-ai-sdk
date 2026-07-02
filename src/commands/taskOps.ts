// Phase 13.2 — /tasks slash command. Renders task lifecycle from the
// user's POV: list active tasks (default), show one, stop one, or list
// all (including terminal states). Tab-completion is out of scope for v0.

import type { CommandContext, SlashCommand } from '@yevgetman/sov-sdk/commands/types';
import chalk from 'chalk';
import type { TaskRecord, TaskState } from '../tasks/types.js';

const STATE_COLOR: Record<TaskState, (s: string) => string> = {
  queued: chalk.yellow,
  running: chalk.cyan,
  completed: chalk.green,
  failed: chalk.red,
  cancelled: chalk.gray,
  timed_out: chalk.red,
};

export const TASK_OPS_COMMANDS: SlashCommand[] = [
  {
    type: 'local',
    name: 'tasks',
    description: 'List background sub-agent tasks; show or stop one by id.',
    usage: '/tasks [all|show <id>|stop <id>]',
    call: async (rawArgs, ctx) => handleTasks(rawArgs, ctx),
  },
];

async function handleTasks(rawArgs: string, ctx: CommandContext): Promise<string> {
  const manager = ctx.taskManager;
  if (!manager) {
    return 'no task manager configured for this session';
  }
  const args = rawArgs.trim();
  if (!args || args === 'all') {
    const tasks = manager.list(ctx.sessionId, args === 'all' ? { includeAll: true } : {});
    if (tasks.length === 0) {
      return args === 'all' ? 'no tasks for this session' : 'no active tasks';
    }
    return formatList(tasks);
  }
  const firstSpace = args.search(/\s/);
  const verb = firstSpace === -1 ? args : args.slice(0, firstSpace);
  const rest = firstSpace === -1 ? '' : args.slice(firstSpace + 1).trim();
  if (verb === 'show') {
    if (!rest) return 'usage: /tasks show <id>';
    const record = manager.get(rest);
    if (!record) return `no task with id '${rest}'`;
    return formatRecord(record);
  }
  if (verb === 'stop') {
    if (!rest) return 'usage: /tasks stop <id>';
    const record = await manager.stop(rest);
    if (!record) return `no task with id '${rest}'`;
    return `task ${record.id} stop signaled (state=${record.state})`;
  }
  return `unknown /tasks verb: ${verb}\nusage: /tasks [all|show <id>|stop <id>]`;
}

function formatList(tasks: TaskRecord[]): string {
  const header = `${tasks.length} task${tasks.length === 1 ? '' : 's'}`;
  const rows = tasks.map((t) => {
    const colorize = STATE_COLOR[t.state];
    const idShort = t.id.slice(0, 12);
    const promptShort = t.prompt.length > 60 ? `${t.prompt.slice(0, 57)}...` : t.prompt;
    return `  ${chalk.dim(idShort)}  ${colorize(t.state.padEnd(10))}  ${chalk.cyan(t.agent.padEnd(10))}  ${chalk.gray(promptShort)}`;
  });
  return [chalk.bold(header), ...rows].join('\n');
}

function formatRecord(record: TaskRecord): string {
  const colorize = STATE_COLOR[record.state];
  const lines = [
    `${chalk.bold('task')}: ${record.id}`,
    `agent: ${record.agent}`,
    `state: ${colorize(record.state)}`,
    `parent: ${record.parentSessionId}`,
    `prompt: ${record.prompt}`,
    `created: ${record.createdAt}`,
    `updated: ${record.updatedAt}`,
  ];
  if (record.childSessionId) lines.push(`child session: ${record.childSessionId}`);
  if (record.traceId) lines.push(`trace id: ${record.traceId}`);
  if (record.resultPreview) lines.push(`preview: ${record.resultPreview}`);
  return lines.join('\n');
}

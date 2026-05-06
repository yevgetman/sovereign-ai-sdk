import { describe, expect, test } from 'bun:test';
import chalk from 'chalk';
import { TASK_OPS_COMMANDS } from '../../src/commands/taskOps.js';
import type { CommandContext } from '../../src/commands/types.js';
import type { TaskRecord } from '../../src/tasks/types.js';
import { makeCtx } from './_makeCtx.js';

chalk.level = 1;

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const strip = (s: string): string => s.replace(ANSI, '');

const tasksCmd = TASK_OPS_COMMANDS.find((c) => c.name === 'tasks');

function makeStubManager(
  records: TaskRecord[],
  stopCalls: string[] = [],
): NonNullable<CommandContext['taskManager']> {
  return {
    create: async () => {
      const first = records[0];
      if (!first) throw new Error('no records');
      return first;
    },
    get: (id: string) => records.find((r) => r.id === id) ?? null,
    list: (_p: string, opts?: { includeAll?: boolean }) =>
      opts?.includeAll
        ? records
        : records.filter((r) => r.state === 'queued' || r.state === 'running'),
    stop: async (id: string) => {
      stopCalls.push(id);
      return records.find((r) => r.id === id) ?? null;
    },
    output: () => null,
  } as unknown as NonNullable<CommandContext['taskManager']>;
}

const baseRecord: TaskRecord = {
  id: 't-aaaaaaaaaaaa',
  parentSessionId: 'parent',
  agent: 'explore',
  prompt: 'find auth',
  state: 'running',
  createdAt: '2026-05-06T00:00:00.000Z',
  updatedAt: '2026-05-06T00:00:01.000Z',
};

describe('/tasks slash command', () => {
  test('default invocation lists active tasks', async () => {
    expect(tasksCmd?.type).toBe('local');
    if (tasksCmd?.type !== 'local') return;
    const ctx = makeCtx({ taskManager: makeStubManager([baseRecord]) });
    const out = strip(await tasksCmd.call('', ctx));
    expect(out).toContain('t-aaaaaa');
    expect(out).toContain('running');
    expect(out).toContain('explore');
  });

  test('reports "no active tasks" when list is empty', async () => {
    if (tasksCmd?.type !== 'local') return;
    const ctx = makeCtx({ taskManager: makeStubManager([]) });
    const out = strip(await tasksCmd.call('', ctx));
    expect(out).toMatch(/no active tasks/i);
  });

  test('"all" arg includes terminal-state tasks', async () => {
    if (tasksCmd?.type !== 'local') return;
    const completed: TaskRecord = { ...baseRecord, id: 't-completed', state: 'completed' };
    const ctx = makeCtx({ taskManager: makeStubManager([baseRecord, completed]) });
    const out = strip(await tasksCmd.call('all', ctx));
    expect(out).toContain('t-completed'.slice(0, 12));
    expect(out).toContain('t-aaaaaa');
  });

  test('"show <id>" renders full record', async () => {
    if (tasksCmd?.type !== 'local') return;
    const ctx = makeCtx({ taskManager: makeStubManager([baseRecord]) });
    const out = strip(await tasksCmd.call(`show ${baseRecord.id}`, ctx));
    expect(out).toContain(baseRecord.id);
    expect(out).toContain('agent: explore');
    expect(out).toContain('state: running');
    expect(out).toContain('prompt: find auth');
  });

  test('"stop <id>" calls manager.stop and reports the record', async () => {
    if (tasksCmd?.type !== 'local') return;
    const stopCalls: string[] = [];
    const ctx = makeCtx({ taskManager: makeStubManager([baseRecord], stopCalls) });
    const out = strip(await tasksCmd.call(`stop ${baseRecord.id}`, ctx));
    expect(stopCalls).toEqual([baseRecord.id]);
    expect(out).toContain('signaled');
  });

  test('reports "no task manager configured" when ctx lacks one', async () => {
    if (tasksCmd?.type !== 'local') return;
    const ctx = makeCtx();
    const out = strip(await tasksCmd.call('', ctx));
    expect(out).toMatch(/no task manager/i);
  });
});

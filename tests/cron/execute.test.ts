import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCronJobExecutor } from '../../src/cron/execute.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cron-execute-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('cron executor', () => {
  test('runs a simple job through the injected agent and writes to outbox', async () => {
    const calls: string[] = [];
    const execute = buildCronJobExecutor({
      harnessHome: home,
      runAgent: async ({ prompt }) => {
        calls.push(prompt);
        return { ok: true, output: 'final assistant text' };
      },
      expandSkills: async () => '',
      runScript: async () => '',
    });
    const result = await execute({
      id: 'job-1',
      prompt: 'say hi',
      schedule: { kind: 'relative', offsetMs: 0 },
      deliver: 'local',
      skills: [],
      enabled: true,
      nextRunAt: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['say hi']);
    const outboxFiles = readdirSync(join(home, 'cron', 'outbox', 'job-1'));
    expect(outboxFiles).toHaveLength(1);
  });

  test('prepends skill bodies and script output to prompt', async () => {
    let captured = '';
    const execute = buildCronJobExecutor({
      harnessHome: home,
      runAgent: async ({ prompt }) => {
        captured = prompt;
        return { ok: true, output: 'ok' };
      },
      expandSkills: async (skills) => skills.map((s) => `<skill:${s}>`).join('\n\n---\n\n'),
      runScript: async () => 'script output\nline2',
    });
    await execute({
      id: 'job-1',
      prompt: 'operator prompt',
      schedule: { kind: 'relative', offsetMs: 0 },
      deliver: 'local',
      skills: ['s1', 's2'],
      script: 'pre.sh',
      enabled: true,
      nextRunAt: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    expect(captured).toContain('## Script output');
    expect(captured).toContain('script output');
    expect(captured).toContain('<skill:s1>');
    expect(captured).toContain('<skill:s2>');
    expect(captured).toContain('operator prompt');
  });

  test('[SILENT] output is recorded but not delivered', async () => {
    const execute = buildCronJobExecutor({
      harnessHome: home,
      runAgent: async () => ({ ok: true, output: '[SILENT] internal note' }),
      expandSkills: async () => '',
      runScript: async () => '',
    });
    const result = await execute({
      id: 'job-1',
      prompt: 'p',
      schedule: { kind: 'relative', offsetMs: 0 },
      deliver: 'local',
      skills: [],
      enabled: true,
      nextRunAt: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    expect(result.ok).toBe(true);
    // No outbox file when silent.
    const fs = require('node:fs');
    expect(fs.existsSync(join(home, 'cron', 'outbox', 'job-1'))).toBe(false);
  });

  test('script timeout records failure', async () => {
    const execute = buildCronJobExecutor({
      harnessHome: home,
      runAgent: async () => ({ ok: true, output: 'ok' }),
      expandSkills: async () => '',
      runScript: async () => {
        throw new Error('script timed out');
      },
    });
    const result = await execute({
      id: 'job-1',
      prompt: 'p',
      schedule: { kind: 'relative', offsetMs: 0 },
      deliver: 'local',
      skills: [],
      script: 'slow.sh',
      enabled: true,
      nextRunAt: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('script');
  });
});

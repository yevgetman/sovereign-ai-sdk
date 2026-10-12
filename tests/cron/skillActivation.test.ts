import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import { addJob } from '../../src/cron/jobs.js';
import { createProductionCronRunner } from '../../src/cron/wiring.js';
import { buildRuntime } from '../../src/server/runtime.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cron-skill-scope-'));
  process.env.SOV_TEST_MOCK_PROVIDER = '1';
  MockProvider.lastTools = undefined;
  mkdirSync(join(home, '.harness/skills'), { recursive: true });
});
afterEach(() => {
  // biome-ignore lint/performance/noDelete: process.env requires delete.
  delete process.env.SOV_TEST_MOCK_PROVIDER;
  MockProvider.lastTools = undefined;
  rmSync(home, { recursive: true, force: true });
});

describe('cron uses permissioned activation', () => {
  test('scheduled native scope reaches the provider schemas', async () => {
    writeFileSync(
      join(home, '.harness/skills/readonly.md'),
      '---\nname: readonly\ndescription: Read only\nallowedTools: [Read]\n---\nRead the scheduled input.',
    );
    const runtime = await buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      preflight: false,
      cronEnabled: false,
    });
    try {
      const job = addJob(home, {
        prompt: 'Report status',
        skills: ['readonly'],
        schedule: { kind: 'relative', offsetMs: 0 },
        deliver: 'local',
      });
      const result = await createProductionCronRunner(runtime, home).forceRunJob(job.id);
      expect(result.ok).toBe(true);
      expect(MockProvider.lastTools?.map((tool) => tool.name)).toEqual(['FileRead']);
    } finally {
      await runtime.dispose();
    }
  });

  test('scheduled inline context honors a Bash denial without a marker effect', async () => {
    writeFileSync(
      join(home, '.harness/skills/dynamic.md'),
      '---\nname: dynamic\ndescription: Dynamic context\nallowedTools: [Bash]\n---\n!`touch marker`',
    );
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash'] } }));
    const runtime = await buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      preflight: false,
      cronEnabled: false,
    });
    try {
      const job = addJob(home, {
        prompt: 'Report status',
        skills: ['dynamic'],
        schedule: { kind: 'relative', offsetMs: 0 },
        deliver: 'local',
      });
      const result = await createProductionCronRunner(runtime, home).forceRunJob(job.id);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('permission denied');
      expect(existsSync(join(home, '.harness/skills/marker'))).toBe(false);
      expect(MockProvider.lastTools).toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });
});

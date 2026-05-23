// Phase 17 T9 — End-to-end smoke pinning the spec's `Check` scenario:
//
//   "`harness cron add --schedule "every 1m" --prompt "echo hello"
//    --deliver local` creates job, first tick runs it, output appears
//    in state/artifacts/cron-outbox/."
//
// Adapted to the harness's actual storage layout, output appears in
// `<harnessHome>/cron/outbox/<jobId>/`. The agent is stubbed so the
// test runs without an LLM round-trip — the real LLM path is covered
// by `wiring.test.ts` (mock provider) and the project's separate
// semantic test suite (real Anthropic).
//
// Three scenarios:
// 1. Spec `Check`: add → tick → outbox file with stubbed assistant text.
// 2. [SILENT] negative: output recorded but no outbox delivery.
// 3. Paused-job negative: tick skips disabled jobs at the CLI layer.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCronAdd } from '../../src/cli/cronCommand.js';
import { buildCronJobExecutor } from '../../src/cron/execute.js';
import { getJob, pauseJob } from '../../src/cron/jobs.js';
import { CronRunner } from '../../src/cron/runner.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cron-smoke-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('Phase 17 spec — `Check` scenario', () => {
  test('add every-1m job, first tick runs it, output lands in cron-outbox', async () => {
    const added = runCronAdd(home, {
      schedule: 'every 1m',
      prompt: 'echo hello',
      deliver: 'local',
      skills: [],
    });
    expect(added.id).toBeTruthy();
    expect(added.enabled).toBe(true);

    // Stub the agent: real LLM not in scope for this smoke. The executor
    // prepends sections, so `expect(prompt).toContain('echo hello')` is the
    // right matcher — the operator prompt is the last (and here only) section.
    const executor = buildCronJobExecutor({
      harnessHome: home,
      runAgent: async ({ prompt, cronJobId }) => {
        expect(cronJobId).toBe(added.id);
        expect(prompt).toContain('echo hello');
        return { ok: true, output: 'hello (assistant)' };
      },
      expandSkills: async () => '',
      runScript: async () => '',
    });

    // Drive the runner with a fake clock advanced past the first tick. This
    // bypasses the 60-second setInterval and exercises dispatch directly —
    // the established pattern from T5's CronRunner tests.
    const runner = new CronRunner({
      harnessHome: home,
      now: () => Date.now() + 60_000 + 1000,
      runJob: executor,
    });
    await runner.runDueJobs();

    const outboxFiles = readdirSync(join(home, 'cron', 'outbox', added.id));
    expect(outboxFiles).toHaveLength(1);
    const firstEntry = outboxFiles[0];
    if (firstEntry === undefined) throw new Error('outbox entry missing');
    const content = readFileSync(join(home, 'cron', 'outbox', added.id, firstEntry), 'utf8');
    expect(content).toBe('hello (assistant)');
  });

  test('[SILENT] output is recorded internally but not delivered to outbox', async () => {
    const added = runCronAdd(home, {
      schedule: 'every 1m',
      prompt: 'p',
      deliver: 'local',
      skills: [],
    });
    const executor = buildCronJobExecutor({
      harnessHome: home,
      runAgent: async () => ({ ok: true, output: '[SILENT] internal' }),
      expandSkills: async () => '',
      runScript: async () => '',
    });
    const runner = new CronRunner({
      harnessHome: home,
      now: () => Date.now() + 60_000 + 1000,
      runJob: executor,
    });
    await runner.runDueJobs();

    // No outbox dir should exist for this job — the [SILENT] short-circuit
    // in src/channels/delivery.ts returns ok:true without writing.
    expect(existsSync(join(home, 'cron', 'outbox', added.id))).toBe(false);

    // But the job's lastResult reflects the run (ok=true). The runner
    // calls recordJobRun regardless of delivery outcome.
    const j = getJob(home, added.id);
    expect(j?.lastRunAt).toBeTruthy();
    expect(j?.lastResult?.ok).toBe(true);
  });

  test('disabled job is skipped on tick', async () => {
    const added = runCronAdd(home, {
      schedule: 'every 1m',
      prompt: 'p',
      deliver: 'local',
      skills: [],
    });
    pauseJob(home, added.id);

    let agentCalled = false;
    const executor = buildCronJobExecutor({
      harnessHome: home,
      runAgent: async () => {
        agentCalled = true;
        return { ok: true, output: 'x' };
      },
      expandSkills: async () => '',
      runScript: async () => '',
    });
    const runner = new CronRunner({
      harnessHome: home,
      now: () => Date.now() + 60_000 + 1000,
      runJob: executor,
    });
    await runner.runDueJobs();

    expect(agentCalled).toBe(false);
    expect(existsSync(join(home, 'cron', 'outbox', added.id))).toBe(false);
  });
});

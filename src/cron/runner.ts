import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { listJobs, recordJobRun } from './jobs.js';
import type { Job } from './types.js';

export type CronRunResult = {
  ok: boolean;
  output?: string;
  error?: string;
  deliveryOk?: boolean;
  durationMs: number;
};

export type CronRunnerOptions = {
  harnessHome: string;
  now: () => number;
  runJob: (job: Job) => Promise<CronRunResult>;
  tickIntervalMs?: number;
};

const DEFAULT_TICK_INTERVAL_MS = 60_000;

export class CronRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private lockHeld = false;

  constructor(private readonly opts: CronRunnerOptions) {}

  start(): void {
    if (this.timer) return;
    const interval = this.opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    const timer = setInterval(() => {
      void this.tick();
    }, interval);
    // Don't hold the process open just for the cron tick — the production
    // process always has another active handle (HTTP server, stdin) and
    // tests want a clean exit. Bun's Timeout exposes `unref()` like Node's.
    timer.unref?.();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.releaseTickLock();
  }

  async tick(): Promise<void> {
    if (this.inFlight) return;
    if (!this.tryAcquireTickLock()) return;
    this.inFlight = true;
    try {
      await this.runDueJobs();
    } finally {
      this.inFlight = false;
      this.releaseTickLock();
    }
  }

  async runDueJobs(): Promise<void> {
    const now = this.opts.now();
    const jobs = listJobs(this.opts.harnessHome);
    const due = jobs.filter((j) => j.enabled && j.nextRunAt !== null && j.nextRunAt <= now);
    for (const job of due) {
      const ranAt = this.opts.now();
      let result: CronRunResult;
      try {
        result = await this.opts.runJob(job);
      } catch (err) {
        result = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          durationMs: this.opts.now() - ranAt,
        };
      }
      recordJobRun(this.opts.harnessHome, job.id, ranAt, {
        ok: result.ok,
        ...(result.deliveryOk !== undefined ? { deliveryOk: result.deliveryOk } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
        durationMs: result.durationMs,
      });
    }
  }

  tryAcquireTickLock(): boolean {
    const lockDir = join(this.opts.harnessHome, 'cron', '.tick.lock');
    mkdirSync(join(this.opts.harnessHome, 'cron'), { recursive: true });
    try {
      mkdirSync(lockDir);
      this.lockHeld = true;
      return true;
    } catch (err) {
      // Lock already held → contention; surface other failures (EACCES,
      // ENOSPC, etc.) on stderr so they don't silently cause the loop
      // to no-op forever.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        process.stderr.write(`[cron] tick lock acquire failed: ${code ?? err}\n`);
      }
      return false;
    }
  }

  releaseTickLock(): void {
    if (!this.lockHeld) return;
    const lockDir = join(this.opts.harnessHome, 'cron', '.tick.lock');
    try {
      rmSync(lockDir, { recursive: true, force: true });
    } catch {
      /* swallow — releasing a lock must never throw */
    }
    this.lockHeld = false;
  }
}

/** Explicit, in-process admission and single-writer ownership for host work.
 * The callback must await all work, including transcript persistence, before
 * returning. This is not a distributed lease or an external-effect transaction. */
export type SessionWorkQueueOptions = {
  maxActiveSessions: number;
  maxQueued: number;
  maxQueuedPerSession: number;
};

export type SessionWorkQueueSnapshot = {
  active: number;
  queued: number;
  closed: boolean;
};

export type SessionWorkQueueErrorCode = 'closed' | 'queue_full' | 'cancelled';

export class SessionWorkQueueError extends Error {
  constructor(readonly code: SessionWorkQueueErrorCode) {
    super(`session work queue: ${code}`);
    this.name = 'SessionWorkQueueError';
  }
}

type Job = {
  sessionId: string;
  work: (signal: AbortSignal) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  controller: AbortController;
  cleanup: () => void;
};

/** One callback at a time per session, bounded concurrent sessions and queues.
 * Queue state is memory-only. Use one queue instance for every writer sharing
 * the same host-owned store; other instances/processes cannot be coordinated. */
export class SessionWorkQueue {
  private readonly options: SessionWorkQueueOptions;
  private readonly active = new Map<string, Job>();
  private readonly queued: Job[] = [];
  private closed = false;
  private shutdownPromise: Promise<void> | undefined;
  private finishShutdown: (() => void) | undefined;

  constructor(options: SessionWorkQueueOptions) {
    for (const name of ['maxActiveSessions', 'maxQueued', 'maxQueuedPerSession'] as const) {
      const value = options[name];
      if (!Number.isSafeInteger(value) || value < (name === 'maxActiveSessions' ? 1 : 0)) {
        throw new RangeError(
          `${name} must be a safe integer ${name === 'maxActiveSessions' ? '>= 1' : '>= 0'}`,
        );
      }
    }
    this.options = { ...options };
  }

  snapshot(): SessionWorkQueueSnapshot {
    return { active: this.active.size, queued: this.queued.length, closed: this.closed };
  }

  submit<T>(
    sessionId: string,
    work: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new SessionWorkQueueError('closed'));
    if (signal?.aborted) return Promise.reject(new SessionWorkQueueError('cancelled'));
    if (typeof sessionId !== 'string' || sessionId.length === 0)
      return Promise.reject(new TypeError('sessionId must be a nonempty string'));
    const canStart =
      !this.active.has(sessionId) && this.active.size < this.options.maxActiveSessions;
    if (
      !canStart &&
      (this.queued.length >= this.options.maxQueued ||
        this.queued.filter((job) => job.sessionId === sessionId).length >=
          this.options.maxQueuedPerSession)
    ) {
      return Promise.reject(new SessionWorkQueueError('queue_full'));
    }
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      const job: Job = {
        sessionId,
        work,
        resolve: (value) => resolve(value as T),
        reject,
        controller,
        cleanup: () => {},
      };
      if (signal) {
        const abort = () => {
          controller.abort();
          const index = this.queued.indexOf(job);
          if (index !== -1) {
            this.queued.splice(index, 1);
            job.cleanup();
            reject(new SessionWorkQueueError('cancelled'));
            this.drain();
          }
        };
        signal.addEventListener('abort', abort, { once: true });
        job.cleanup = () => signal.removeEventListener('abort', abort);
      }
      if (canStart) this.start(job);
      else this.queued.push(job);
    });
  }

  /** Close admission, cancel queued jobs, optionally signal active jobs, and
   * join ALL started callbacks. No timeout race: an uncooperative callback
   * keeps shutdown pending. A later caller may escalate to cancelRunning. */
  shutdown(cancelRunning = true): Promise<void> {
    if (!this.shutdownPromise) {
      this.closed = true;
      this.shutdownPromise = new Promise<void>((resolve) => {
        this.finishShutdown = resolve;
      });
      for (const job of this.queued.splice(0)) {
        job.cleanup();
        job.reject(new SessionWorkQueueError('closed'));
      }
    }
    if (cancelRunning) for (const job of this.active.values()) job.controller.abort();
    this.checkShutdown();
    return this.shutdownPromise;
  }

  private start(job: Job): void {
    this.active.set(job.sessionId, job);
    // Deferral ensures the active reservation exists before callbacks can
    // re-enter submit/shutdown. execute catches synchronous and async errors.
    void this.execute(job);
  }

  private async execute(job: Job): Promise<void> {
    let value: unknown;
    let failed = false;
    let error: unknown;
    try {
      await Promise.resolve();
      if (job.controller.signal.aborted) throw new SessionWorkQueueError('cancelled');
      value = await job.work(job.controller.signal);
      if (job.controller.signal.aborted) throw new SessionWorkQueueError('cancelled');
    } catch (err) {
      failed = true;
      error = err;
    }
    job.cleanup();
    this.active.delete(job.sessionId);
    if (failed) job.reject(error);
    else job.resolve(value);
    this.drain();
    this.checkShutdown();
  }

  private drain(): void {
    if (this.closed) return;
    while (this.active.size < this.options.maxActiveSessions) {
      const next = this.queued.findIndex((job) => !this.active.has(job.sessionId));
      if (next === -1) return;
      const [job] = this.queued.splice(next, 1);
      if (job) this.start(job);
    }
  }

  private checkShutdown(): void {
    if (this.closed && this.active.size === 0) this.finishShutdown?.();
  }
}

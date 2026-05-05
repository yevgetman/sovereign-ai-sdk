// Phase 13.4 — Semaphore primitive. Bounds the number of concurrent
// holders to `max`; queued callers wake up FIFO as releases arrive.
// AbortSignal-aware: a queued waiter whose signal aborts rejects
// without stealing the slot.
//
// Used by the per-lane concurrency caps (LaneSemaphores) and the v0
// global write-path lock for write-capable sub-agents. The path lock
// is just a Semaphore(1) — Phase 13's "profile-scoped path lock" v0
// is a single in-memory mutex; finer-grained per-path locking and
// cross-process coordination land later (Phase 16 daemon).

export class Semaphore {
  private available: number;
  private readonly waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (err: Error) => void;
    abortHandler?: () => void;
    signal?: AbortSignal;
  }> = [];

  constructor(max: number) {
    this.available = max;
  }

  /** Acquire one slot. Returns a release function the caller MUST call
   *  exactly once when done; double-release is a no-op (idempotent).
   *  When `signal` is supplied: an already-aborted signal rejects
   *  immediately; a signal aborted while waiting cancels the queued
   *  waiter without consuming a slot. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(this.abortError(signal));
    }
    if (this.available > 0) {
      this.available--;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter = { resolve, reject, signal } as {
        resolve: (release: () => void) => void;
        reject: (err: Error) => void;
        abortHandler?: () => void;
        signal?: AbortSignal;
      };
      if (signal !== undefined) {
        const abortHandler = (): void => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) {
            this.waiters.splice(idx, 1);
            reject(this.abortError(signal));
          }
        };
        waiter.abortHandler = abortHandler;
        signal.addEventListener('abort', abortHandler, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next === undefined) {
        this.available++;
        return;
      }
      if (next.signal !== undefined && next.abortHandler !== undefined) {
        next.signal.removeEventListener('abort', next.abortHandler);
      }
      next.resolve(this.makeRelease());
    };
  }

  private abortError(signal: AbortSignal): Error {
    const reason: unknown = (signal as AbortSignal & { reason?: unknown }).reason;
    if (reason instanceof Error) return reason;
    if (typeof reason === 'string' && reason.length > 0) return new Error(reason);
    const err = new Error('Semaphore.acquire aborted');
    (err as Error & { name: string }).name = 'AbortError';
    return err;
  }
}

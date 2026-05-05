// Phase 13.4 — Per-lane concurrency caps. Holds one Semaphore per lane
// (local / frontier) and exposes a single `acquire(lane, signal)` entry
// point. Both the router (single-session escalations) and the sub-agent
// scheduler (parent dispatching N children) call into the same instance
// so the global cap applies regardless of who issues the request.
//
// When a lane's cap is undefined, acquisition is unbounded — useful in
// tests and during local development where artificial limits add no
// value. Production deployments should configure both caps.
//
// Phase 10.6 declared maxConcurrentLocal / maxConcurrentFrontier as
// router-config fields but the primitive was premature there because
// the harness had no parallel provider calls. Sub-agents introduce them
// — the semaphore lands here.

import { Semaphore } from './semaphore.js';

export type LaneName = 'local' | 'frontier';

export type LaneSemaphoresOpts = {
  local?: number;
  frontier?: number;
};

export class LaneSemaphores {
  private readonly localSem?: Semaphore;
  private readonly frontierSem?: Semaphore;

  constructor(opts: LaneSemaphoresOpts) {
    if (opts.local !== undefined) this.localSem = new Semaphore(opts.local);
    if (opts.frontier !== undefined) this.frontierSem = new Semaphore(opts.frontier);
  }

  /** Acquire a slot on the given lane. Returns a release function the
   *  caller must invoke when done. When the lane has no cap configured,
   *  resolves immediately with a no-op release. */
  acquire(lane: LaneName, signal?: AbortSignal): Promise<() => void> {
    const sem = lane === 'local' ? this.localSem : this.frontierSem;
    if (sem === undefined) {
      return Promise.resolve(() => undefined);
    }
    return sem.acquire(signal);
  }
}

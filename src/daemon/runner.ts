// Daemon runner. Owns the per-profile single-instance lock, the typed event
// bus, the LRU session cache, and the approval queue. `startDaemon()` is the
// programmatic entry point; the `sov daemon` CLI command wraps it with signal
// handlers and an indefinite wait.

import { resolveHarnessHome } from '../config/paths.js';
import { type LockHandle, readLockInfo, tryAcquireLock } from '../config/profileLock.js';
import { ApprovalQueue } from './approvalQueue.js';
import { DaemonEventBus } from './eventBus.js';
import { SessionCache } from './sessionCache.js';

const DEFAULT_SESSION_CACHE_SIZE = 32;

export type DaemonHandle = {
  readonly bus: DaemonEventBus;
  readonly sessionCache: SessionCache;
  readonly approvalQueue: ApprovalQueue;
  shutdown(): void;
};

export type StartDaemonOpts = {
  readonly harnessHome?: string;
  readonly sessionCacheSize?: number;
  readonly approvalTtlMs?: number;
};

/**
 * Acquire the per-profile daemon lock and construct the daemon's in-memory
 * services. Throws when the lock is already held by an alive process.
 */
export function startDaemon(opts: StartDaemonOpts = {}): DaemonHandle {
  const home = opts.harnessHome ?? resolveHarnessHome();
  const lock = tryAcquireLock(home);
  if (lock === null) {
    const info = readLockInfo(home);
    const pidSuffix = info.pid !== undefined ? ` (PID ${info.pid})` : '';
    throw new Error(`daemon already running${pidSuffix}`);
  }

  const bus = new DaemonEventBus();
  const sessionCache = new SessionCache(opts.sessionCacheSize ?? DEFAULT_SESSION_CACHE_SIZE);
  const approvalQueue =
    opts.approvalTtlMs !== undefined ? new ApprovalQueue(opts.approvalTtlMs) : new ApprovalQueue();

  bus.emit({
    type: 'daemon_started',
    pid: process.pid,
    profile: home,
    harnessHome: home,
  });

  return buildHandle({ bus, sessionCache, approvalQueue, lock });
}

type HandleDeps = {
  readonly bus: DaemonEventBus;
  readonly sessionCache: SessionCache;
  readonly approvalQueue: ApprovalQueue;
  readonly lock: LockHandle;
};

function buildHandle(deps: HandleDeps): DaemonHandle {
  let stopped = false;
  return {
    bus: deps.bus,
    sessionCache: deps.sessionCache,
    approvalQueue: deps.approvalQueue,
    shutdown: () => {
      if (stopped) return;
      stopped = true;
      try {
        deps.bus.emit({ type: 'daemon_stopping', reason: 'explicit' });
      } finally {
        deps.lock.release();
      }
    },
  };
}

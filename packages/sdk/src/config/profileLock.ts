// Phase 10.7 — atomic mkdir-based PID lock per profile root. The lock
// directory itself (`<profile-home>/.sov.lock/`) is the lock; mkdir is the
// only POSIX primitive that's both creating-new and exclusive in one call.
// The PID written inside is informational — we use it to detect stale locks
// from a process that crashed without releasing.
//
// Phase 10.7 ships this as a pure helper. Integration into REPL startup is
// deferred so concurrent `sov` sessions against the same profile keep working
// for users who rely on that today; a future commit can turn it on as a
// hard guard (or an advisory banner) once we have a clearer signal.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SECURE_DIR_MODE, SECURE_FILE_MODE, chmodSafe } from '../util/secureFs.js';
import { resolveHarnessHome } from './paths.js';

const LOCK_DIR_NAME = '.sov.lock';
const PID_FILE_NAME = 'pid';

export type LockHandle = {
  /** The on-disk path of the lock directory (useful for diagnostics + tests). */
  readonly path: string;
  /** Remove the lock directory. Safe to call multiple times. */
  release(): void;
};

export type LockInfo = {
  /** True when the lock directory exists on disk. */
  held: boolean;
  /** The PID written inside, when present and parseable. */
  pid?: number;
  /** True when `pid` corresponds to an alive process on this host.
   *  False or undefined = the lock is stale and can be reclaimed. */
  alive?: boolean;
};

/** Try to acquire the lock. Returns a handle on success, `null` when the
 *  lock is held by an alive process. Stale locks (PID dead) are silently
 *  reclaimed. */
export function tryAcquireLock(home: string = resolveHarnessHome()): LockHandle | null {
  const lockDir = join(home, LOCK_DIR_NAME);
  if (!attemptMkdir(lockDir)) {
    const info = readLockInfo(home);
    if (info.alive) return null;
    // Stale — reclaim. The recursive rm + retry race is contained: if a third
    // process arrives between our rm and our second mkdir, that mkdir fails
    // and we report the lock as held (correctly).
    try {
      rmSync(lockDir, { recursive: true, force: true });
    } catch {
      return null;
    }
    if (!attemptMkdir(lockDir)) return null;
  }
  // Lock lives under HARNESS_HOME (0700), but keep it owner-only in its own
  // right (audit C6 sweep): the mkdir sets 0700 (see attemptMkdir) and the pid
  // file is 0600.
  const pidPath = join(lockDir, PID_FILE_NAME);
  writeFileSync(pidPath, `${process.pid}\n`, { encoding: 'utf8', mode: SECURE_FILE_MODE });
  chmodSafe(pidPath, SECURE_FILE_MODE);
  return {
    path: lockDir,
    release: () => {
      try {
        rmSync(lockDir, { recursive: true, force: true });
      } catch {
        // Already gone or no permission — safe to ignore on release.
      }
    },
  };
}

/** Inspect whether a lock is currently held and, when it is, whether the
 *  holding process is still alive. Used both by `tryAcquireLock` for stale
 *  detection and by callers that want to print a diagnostic banner. */
export function readLockInfo(home: string = resolveHarnessHome()): LockInfo {
  const lockDir = join(home, LOCK_DIR_NAME);
  if (!existsSync(lockDir)) return { held: false };
  const pidFile = join(lockDir, PID_FILE_NAME);
  if (!existsSync(pidFile)) return { held: true };
  let pid: number | undefined;
  try {
    const parsed = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) pid = parsed;
  } catch {
    // Treat unreadable as unknown — the held flag still tells the caller
    // someone owns the lock.
  }
  if (pid === undefined) return { held: true };
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (err) {
    // EPERM: the process exists but we lack permission to signal it (different
    // owner) — it is ALIVE, so the lock is NOT stale. ESRCH (and anything else)
    // means no such process → dead/stale. Mirrors lockUtil.isPidAlive; without
    // this, an EPERM was misread as dead and let a second daemon start.
    alive = (err as NodeJS.ErrnoException).code === 'EPERM';
  }
  return { held: true, pid, alive };
}

function attemptMkdir(path: string): boolean {
  try {
    // Non-recursive mkdir is the atomic exclusive primitive (throws EEXIST when
    // the lock is held). The 0700 mode keeps the lock dir owner-only; re-tighten
    // defensively since the create mode is umask-masked (audit C6 sweep).
    mkdirSync(path, { mode: SECURE_DIR_MODE });
    chmodSafe(path, SECURE_DIR_MODE);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

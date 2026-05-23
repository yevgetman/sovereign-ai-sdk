import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Shared lock primitives used by both cron file locks (.tick.lock and
// .jobs.lock). The locking strategy is mkdir-based (atomic on POSIX) with
// a PID file inside the lock directory so we can detect and recover from
// stale locks — i.e. lock dirs left behind by a crashed sov process.

// isPidAlive returns true if a process with the given PID is currently
// alive on this host. POSIX: process.kill(pid, 0) throws ESRCH if the
// PID doesn't exist; EPERM (or no throw) means it does. The signal 0
// is the "exist check" — it doesn't actually deliver a signal.
//
// Windows isn't a supported sov platform (see Phase 21 platform matrix),
// so we don't bother with a fallback there.
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM = exists but we lack permission to signal it; still alive.
    return code === 'EPERM';
  }
}

// readLockOwner returns the PID written inside a lock directory, or
// null if no PID file exists or the contents are unparseable. Treating
// "no PID file" as a stale lock is intentional — a half-created lock
// (mkdir succeeded but PID write failed) is no different from a dead
// owner from the caller's perspective.
export function readLockOwner(lockDir: string): number | null {
  try {
    const raw = readFileSync(join(lockDir, 'pid'), 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// tryAcquireOnce attempts to mkdir the lock directory and write our PID
// inside it. Returns true on success, false if the lock is already held
// by a live process. Stale locks (dead owner or missing PID file) are
// recovered: the function removes the stale dir and retries the mkdir
// once. Other errors (EACCES, ENOSPC) bubble up — the caller decides
// whether to surface them.
//
// The loop bound is 2: one initial try, plus one retry after stale-lock
// cleanup. If the second mkdir also collides we surrender (someone else
// won the race) rather than spin.
export function tryAcquireOnce(lockDir: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lockDir);
      // Write our PID atomically — the dir is freshly created so no
      // other process holds it.
      writeFileSync(join(lockDir, 'pid'), String(process.pid), 'utf8');
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      // Lock already exists — check if the owner is still alive.
      const owner = readLockOwner(lockDir);
      if (owner !== null && isPidAlive(owner)) {
        return false;
      }
      // Stale lock — remove and retry once.
      try {
        rmSync(lockDir, { recursive: true, force: true });
      } catch {
        // Couldn't clean up the stale lock; give up this acquire.
        return false;
      }
      // Loop iterates one more time to re-attempt the mkdir.
    }
  }
  // Two attempts failed; another process won the race after we cleaned up.
  return false;
}

// releaseLock removes the lock directory and its PID file. Tolerant of
// the dir not existing (already released, or never acquired). Releasing
// a lock must never throw — callers rely on this in finally blocks.
export function releaseLock(lockDir: string): void {
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    /* swallow — releasing a lock must never throw */
  }
}

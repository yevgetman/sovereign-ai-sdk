import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Shared lock primitives used by both cron file locks (.tick.lock and
// .jobs.lock). The locking strategy installs the lock directory by an atomic
// rename of a fully-built temp dir that ALREADY contains the PID file — so
// the lock never exists in a momentarily-empty "mkdir succeeded but PID not
// written yet" state, and the owner PID is present the instant the lock is.
// We still keep the PID file (to detect a crashed holder) and add an mtime
// staleness ceiling (to survive PID reuse after a crash/reboot).
//
// Two races the previous mkdir-then-write approach allowed, now closed:
//   1. Two processes both judging the lock stale, A removing+recreating it,
//      then B's rmSync deleting A's fresh lock → both "own" it. We now
//      reclaim a stale lock by an atomic rename of the stale dir to a unique
//      graveyard name; exactly one process can win that rename, so only the
//      winner proceeds to install its own lock. The loser sees ENOENT and
//      retries the acquire from scratch.
//   2. A long-held tick lock surviving a crash/reboot can look "live" if an
//      unrelated process later reuses the old PID. The mtime ceiling
//      reclaims any lock older than N hours regardless of PID liveness.

/** A lock older than this is reclaimed regardless of whether its recorded
 *  PID is alive — defends against PID reuse after a crash or reboot. A cron
 *  tick completes in well under a minute and the jobs lock is held for a
 *  single load→modify→save; 6h is comfortably longer than any legitimate
 *  hold yet short enough to self-heal within a day. */
const DEFAULT_STALE_CEILING_MS = 6 * 60 * 60 * 1000;

export type LockAcquireOptions = {
  /** Injectable clock for the mtime staleness ceiling (tests). */
  now?: () => number;
  /** Override the mtime staleness ceiling (tests / tuning). */
  staleCeilingMs?: number;
};

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

// lockMtimeMs returns the lock directory's last-modified time in epoch ms,
// or null if it can't be stat'd (already gone).
function lockMtimeMs(lockDir: string): number | null {
  try {
    return statSync(lockDir).mtimeMs;
  } catch {
    return null;
  }
}

// isLockStale decides whether an existing lock can be reclaimed. A lock is
// stale when ANY of:
//   - its PID file is missing or unparseable (a crashed half-write, or a
//     pre-atomic lock — treated as stale, matching the old contract);
//   - its recorded PID is no longer alive;
//   - its mtime is older than the staleness ceiling (defends against PID
//     reuse: a dead holder's PID now belongs to a live unrelated process).
function isLockStale(lockDir: string, opts: LockAcquireOptions): boolean {
  const ceilingMs = opts.staleCeilingMs ?? DEFAULT_STALE_CEILING_MS;
  const now = opts.now ? opts.now() : Date.now();
  const mtime = lockMtimeMs(lockDir);
  if (mtime !== null && now - mtime > ceilingMs) return true;
  const owner = readLockOwner(lockDir);
  if (owner === null) return true;
  return !isPidAlive(owner);
}

// installLock builds a fully-populated temp dir (containing our PID file)
// and atomically renames it onto `lockDir`. Returns true if we now own the
// lock, false if the rename collided with an existing lock dir. The temp dir
// is cleaned up on a collision so we never leak. Non-collision errors
// (EACCES, ENOSPC) bubble up to the caller.
function installLock(lockDir: string): boolean {
  const tmp = `${lockDir}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  mkdirSync(tmp, { recursive: true });
  writeFileSync(join(tmp, 'pid'), String(process.pid), 'utf8');
  try {
    // Atomic on POSIX: rename onto an existing NON-EMPTY dir (our lock always
    // has a pid file) fails with ENOTEMPTY/EEXIST, so this is a true
    // "create-if-absent". The PID file is present the instant the lock is.
    renameSync(tmp, lockDir);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Clean up our temp dir regardless of why the rename failed.
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
    if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'EISDIR' || code === 'ENOENT') {
      return false; // someone holds the lock — collision, not a hard error
    }
    throw err;
  }
}

// reclaimStaleLock atomically takes ownership of a stale lock by renaming it
// to a unique graveyard name, then deleting the graveyard. Only ONE process
// can win this rename (a directory can be renamed exactly once); the winner
// returns true and is then clear to install its own lock, while every loser
// gets ENOENT and returns false (it will retry the whole acquire). This is
// the fix for the double-reclaim race the old rmSync allowed.
function reclaimStaleLock(lockDir: string): boolean {
  const graveyard = `${lockDir}.dead.${process.pid}.${randomBytes(6).toString('hex')}`;
  try {
    renameSync(lockDir, graveyard);
  } catch {
    // Lost the race (another process already reclaimed/renamed it), or the
    // lock vanished. Either way we don't own it yet — retry from the top.
    return false;
  }
  try {
    rmSync(graveyard, { recursive: true, force: true });
  } catch {
    /* best-effort — the graveyard dir is uniquely named, orphan is harmless */
  }
  return true;
}

// tryAcquireOnce attempts to install the lock by atomic temp-dir rename.
// Returns true on success, false if the lock is held by a live, recent
// process. A stale lock (dead/missing PID owner, or older than the mtime
// ceiling) is reclaimed atomically and the install retried once. Hard errors
// (EACCES, ENOSPC) bubble up — the caller decides whether to surface them.
//
// The loop bound is 2: one initial install, plus one retry after a stale
// reclaim. If the second install also collides we surrender (someone else
// won the race) rather than spin.
export function tryAcquireOnce(lockDir: string, opts: LockAcquireOptions = {}): boolean {
  // Ensure the parent dir exists so the temp-dir mkdir + rename can land.
  mkdirSync(dirname(lockDir), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    if (installLock(lockDir)) return true;
    // Collision — the lock is held. Reclaim only if it's stale.
    if (!isLockStale(lockDir, opts)) return false;
    // Whether we win the atomic reclaim (clear to install our own lock next
    // iteration) or lose it (another process reclaimed first and may now hold
    // a fresh lock), the right move is the same: loop once more. The retry
    // re-attempts the install and, if that fresh lock is live, returns false.
    reclaimStaleLock(lockDir);
  }
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

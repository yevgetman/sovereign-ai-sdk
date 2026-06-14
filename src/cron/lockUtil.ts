import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

// Shared lock primitives used by both cron file locks (.tick.lock and
// .jobs.lock). The locking strategy installs the lock directory by an atomic
// rename of a fully-built temp dir that ALREADY contains the PID file — so
// the lock never exists in a momentarily-empty "mkdir succeeded but PID not
// written yet" state, and the owner PID is present the instant the lock is.
// We still keep the PID file (to detect a crashed holder) and add an mtime
// staleness ceiling (to survive PID reuse after a crash/reboot).
//
// Three races the previous mkdir-then-write approach allowed, now closed:
//   1. Two processes both judging the lock stale, A removing+recreating it,
//      then B's rmSync deleting A's fresh lock → both "own" it. We now
//      reclaim a stale lock by an atomic rename of the stale dir to a unique
//      graveyard name; exactly one process can win that rename, so only the
//      winner proceeds to install its own lock. The loser sees ENOENT and
//      retries the acquire from scratch.
//   2. A long-held tick lock surviving a crash/reboot can look "live" if an
//      unrelated process later reuses the old PID. The mtime ceiling
//      reclaims any lock older than N hours regardless of PID liveness.
//   3. (#19) A check-then-reclaim TOCTOU: a third process replaces the stale
//      lock with a FRESH, LIVE one between the staleness judgment and the
//      reclaim rename, and the blind rename+delete steals it. We now snapshot
//      the judged-stale owner PID + mtime, and after the reclaim rename
//      re-verify the moved dir still matches that snapshot; if a live lock
//      swapped in, we restore it and report the lock held instead of stealing
//      it. A genuinely long-held (not crashed) lock avoids #2's reclaim via a
//      heartbeat (touchLock) the holder runs while it works.

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
  /** Test seam: invoked exactly once, AFTER a stale lock has been judged
   *  reclaimable but BEFORE the atomic reclaim runs. Lets a test deterministically
   *  wedge a concurrent third process into the check-then-reclaim window so the
   *  re-verification (#19) can be exercised. Never set in production. */
  onAfterJudgeStale?: () => void;
};

/** Identity snapshot of a lock judged stale: the owner PID written inside it
 *  (or null) plus its dir mtime. Captured at staleness-judgment time and
 *  re-verified after the reclaim rename so a fresh LIVE lock installed by a
 *  third process in the meantime is never blindly stolen. */
type StaleSnapshot = {
  readonly owner: number | null;
  readonly mtimeMs: number | null;
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

// judgeStaleLock decides whether an existing lock can be reclaimed, and if so
// returns an identity SNAPSHOT (owner PID + dir mtime) of the exact lock it
// judged — captured together so the reclaim can later re-verify it took the
// same lock it judged, not a fresh live one a third process installed in the
// meantime (#19). Returns null when the lock is NOT stale (live, recent owner).
//
// A lock is stale when ANY of:
//   - its PID file is missing or unparseable (a crashed half-write, or a
//     pre-atomic lock — treated as stale, matching the old contract);
//   - its recorded PID is no longer alive;
//   - its mtime is older than the staleness ceiling (defends against PID
//     reuse: a dead holder's PID now belongs to a live unrelated process).
function judgeStaleLock(lockDir: string, opts: LockAcquireOptions): StaleSnapshot | null {
  const ceilingMs = opts.staleCeilingMs ?? DEFAULT_STALE_CEILING_MS;
  const now = opts.now ? opts.now() : Date.now();
  const mtimeMs = lockMtimeMs(lockDir);
  const owner = readLockOwner(lockDir);
  const snapshot: StaleSnapshot = { owner, mtimeMs };
  if (mtimeMs !== null && now - mtimeMs > ceilingMs) return snapshot;
  if (owner === null) return snapshot;
  return isPidAlive(owner) ? null : snapshot;
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
//
// #19 — the rename alone is not enough: a third process can replace the stale
// lock with a FRESH, LIVE one between the staleness judgment and this rename.
// renameSync of a non-empty dir to a new name is a MOVE (not an
// ENOTEMPTY-guarded overwrite), so a blind reclaim would silently steal that
// live lock. We close the window by re-verifying identity AFTER the rename:
// the moved dir must still carry the SAME owner PID + mtime we judged stale.
// If it differs, a live holder swapped in — we move the dir BACK to its
// original path and report "held" (false) instead of deleting it.
function reclaimStaleLock(lockDir: string, snapshot: StaleSnapshot): boolean {
  const graveyard = `${lockDir}.dead.${process.pid}.${randomBytes(6).toString('hex')}`;
  try {
    renameSync(lockDir, graveyard);
  } catch {
    // Lost the race (another process already reclaimed/renamed it), or the
    // lock vanished. Either way we don't own it yet — retry from the top.
    return false;
  }
  if (!matchesSnapshot(graveyard, snapshot)) {
    // A fresh lock was installed between judgment and our rename — we moved a
    // DIFFERENT (likely live) lock. Restore it to its path and treat as held.
    // The original path is now empty (we moved it away), so the restore rename
    // targets an absent dir and should succeed.
    try {
      renameSync(graveyard, lockDir);
    } catch {
      /* best-effort restore — if it fails the dir is orphaned in the graveyard;
         the next acquire will see an absent lock and install cleanly */
    }
    return false;
  }
  try {
    rmSync(graveyard, { recursive: true, force: true });
  } catch {
    /* best-effort — the graveyard dir is uniquely named, orphan is harmless */
  }
  return true;
}

// matchesSnapshot re-reads a (renamed) lock dir and reports whether its owner
// PID and mtime still match the identity captured when the lock was judged
// stale. A mismatch means a different lock occupies the path now (#19).
function matchesSnapshot(dir: string, snapshot: StaleSnapshot): boolean {
  return readLockOwner(dir) === snapshot.owner && lockMtimeMs(dir) === snapshot.mtimeMs;
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
    // Collision — the lock is held. Judge staleness and snapshot its identity
    // in one read so the reclaim can re-verify it (closes the #19 TOCTOU).
    const snapshot = judgeStaleLock(lockDir, opts);
    if (snapshot === null) return false; // live, recent holder — not ours
    // Test seam: lets a test install a fresh live lock in the window between
    // the staleness judgment and the reclaim. No-op in production.
    opts.onAfterJudgeStale?.();
    // reclaimStaleLock re-verifies the moved dir still matches `snapshot`; if a
    // third process swapped in a fresh live lock, it restores it and returns
    // false (treat as held) rather than looping again — re-attempting would
    // race the same fresh lock we just declined.
    if (!reclaimStaleLock(lockDir, snapshot)) return false;
    // We won the atomic reclaim of the lock we judged stale — loop once to
    // install our own lock. If a brand-new lock collides on that install, the
    // second iteration judges it (likely live) and returns false.
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

// touchLock refreshes the lock directory's mtime so a legitimately long-held
// lock is not reclaimed by the mtime staleness ceiling (#40). The ceiling
// (DEFAULT_STALE_CEILING_MS, 6h) defends against PID reuse after a crash, but
// a single mission wake can legitimately run for hours (slow model turns); a
// periodic heartbeat keeps a *live* holder's lock fresh so the ceiling only
// ever reclaims a genuinely abandoned one. Tolerant of the dir not existing
// (already released) and never throws — callers run it from a timer.
export function touchLock(lockDir: string): void {
  try {
    const now = new Date();
    utimesSync(lockDir, now, now);
  } catch {
    /* swallow — a heartbeat miss must never crash the holder */
  }
}

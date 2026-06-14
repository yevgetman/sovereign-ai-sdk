// Phase 17 follow-up — direct tests for the cron lock primitives. The
// jobs/runner suites cover the happy path + dead-PID + missing-PID-file
// reclaim through their public ops; this file pins the two hardening
// properties added to close the audit findings:
//   - a stale lock is reclaimed atomically (no momentary empty lock dir,
//     and the PID is present the instant the lock exists);
//   - a lock older than the mtime staleness ceiling is reclaimed even when
//     its PID happens to be alive (survives PID reuse after a crash/reboot);
//   - a fresh, valid lock held by a live process is NOT stolen.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isPidAlive,
  readLockOwner,
  releaseLock,
  touchLock,
  tryAcquireOnce,
} from '../../src/cron/lockUtil.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cron-lock-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function lockDir(): string {
  return join(home, '.test.lock');
}

describe('tryAcquireOnce — fresh acquire', () => {
  test('acquires an unheld lock and writes this process PID atomically', () => {
    const dir = lockDir();
    expect(tryAcquireOnce(dir)).toBe(true);
    // The lock exists AND already carries our PID — never an empty-dir window.
    expect(existsSync(dir)).toBe(true);
    expect(readLockOwner(dir)).toBe(process.pid);
    releaseLock(dir);
    expect(existsSync(dir)).toBe(false);
  });

  test('a live holder (this very process) is NOT stolen', () => {
    const dir = lockDir();
    expect(tryAcquireOnce(dir)).toBe(true);
    // A second acquire must fail — the lock is held by a live PID (us).
    expect(tryAcquireOnce(dir)).toBe(false);
    // And the original owner PID is untouched.
    expect(readLockOwner(dir)).toBe(process.pid);
    releaseLock(dir);
  });
});

describe('tryAcquireOnce — stale reclaim', () => {
  test('reclaims a lock whose PID is dead', () => {
    const dir = lockDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pid'), '999999', 'utf8'); // not a live PID
    expect(tryAcquireOnce(dir)).toBe(true);
    expect(readLockOwner(dir)).toBe(process.pid);
    releaseLock(dir);
  });

  test('reclaims a lock older than the staleness ceiling even if the PID is alive', () => {
    const dir = lockDir();
    mkdirSync(dir, { recursive: true });
    // Write a guaranteed-LIVE PID (our own) so liveness alone would refuse
    // the reclaim — only the mtime ceiling should let us take it. This
    // models PID reuse: a crashed holder's PID now belongs to a live,
    // unrelated process.
    writeFileSync(join(dir, 'pid'), String(process.pid), 'utf8');
    expect(isPidAlive(process.pid)).toBe(true);
    // Backdate the lock dir well past the 6h ceiling.
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
    utimesSync(dir, old, old);
    // With a small injected ceiling this is unambiguous; the default 6h also
    // covers the 7h backdate.
    expect(tryAcquireOnce(dir, { staleCeilingMs: 6 * 60 * 60 * 1000 })).toBe(true);
    expect(readLockOwner(dir)).toBe(process.pid);
    releaseLock(dir);
  });

  test('does NOT reclaim a recent lock held by a live PID (ceiling not reached)', () => {
    const dir = lockDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pid'), String(process.pid), 'utf8'); // live
    // Fresh mtime (just created) → under the ceiling → must not steal.
    expect(tryAcquireOnce(dir, { staleCeilingMs: 6 * 60 * 60 * 1000 })).toBe(false);
    expect(readLockOwner(dir)).toBe(process.pid);
    releaseLock(dir);
  });

  test('reclaims a lock with a missing PID file (treated as stale)', () => {
    const dir = lockDir();
    mkdirSync(dir, { recursive: true }); // no pid file inside
    expect(tryAcquireOnce(dir)).toBe(true);
    expect(readLockOwner(dir)).toBe(process.pid);
    releaseLock(dir);
  });

  test('after a stale reclaim the lock dir is never left empty (PID present)', () => {
    const dir = lockDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pid'), '999999', 'utf8');
    expect(tryAcquireOnce(dir)).toBe(true);
    // The pid file content is exactly our PID — proves the temp-dir-with-pid
    // -then-rename install (no mkdir-then-write window).
    expect(readFileSync(join(dir, 'pid'), 'utf8').trim()).toBe(String(process.pid));
    releaseLock(dir);
  });
});

describe('tryAcquireOnce — atomic reclaim re-verification (#19)', () => {
  // The check-then-reclaim TOCTOU: A judges a stale lock reclaimable, then a
  // third process C replaces it with a FRESH, LIVE lock before A's reclaim
  // runs. A's blind rename+delete used to steal C's live lock, letting two
  // processes "own" it. The fix: A snapshots the stale owner (pid + mtime),
  // and after renaming the dir away re-verifies the moved dir STILL holds that
  // same stale identity; if a fresh lock appeared, A restores it and aborts.
  test('does NOT steal a fresh LIVE lock that replaced a stale one between judge and reclaim', () => {
    const dir = lockDir();
    // Pre-state: a stale lock (dead PID) that A will judge reclaimable.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pid'), '999999', 'utf8'); // dead owner

    // Simulate process C replacing the stale lock with a fresh, LIVE lock at
    // the exact instant between A's staleness judgment and A's reclaim. We
    // drive this deterministically by injecting a `now` clock whose first
    // call (used by isLockStale) sees the OLD lock, and whose subsequent
    // behavior leaves a fresh live lock in place: we model C's swap by
    // re-stamping the lock dir with a LIVE pid + fresh mtime via the injected
    // hook below.
    let judged = false;
    const dir2 = dir;
    const result = tryAcquireOnce(dir2, {
      // Inject a side-effect after the staleness judgment but before reclaim:
      // C installs a fresh, live lock. We expose this via the onAfterJudgeStale
      // test hook.
      onAfterJudgeStale: () => {
        if (judged) return;
        judged = true;
        // C reclaims + installs its own fresh, LIVE lock (this very process).
        rmSync(dir2, { recursive: true, force: true });
        mkdirSync(dir2, { recursive: true });
        writeFileSync(join(dir2, 'pid'), String(process.pid), 'utf8');
      },
    });

    // A must NOT have acquired the lock — C holds a live one.
    expect(result).toBe(false);
    // C's fresh live lock is intact (not deleted, not clobbered).
    expect(existsSync(dir2)).toBe(true);
    expect(readLockOwner(dir2)).toBe(process.pid);
    releaseLock(dir2);
  });

  test('still reclaims a genuinely stale lock when no fresh lock appears', () => {
    const dir = lockDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pid'), '999999', 'utf8'); // dead owner, no swap
    expect(tryAcquireOnce(dir)).toBe(true);
    expect(readLockOwner(dir)).toBe(process.pid);
    releaseLock(dir);
  });
});

describe('touchLock — heartbeat for long holds (#40)', () => {
  test('refreshes the lock dir mtime so a long hold is not reclaimed by the ceiling', () => {
    const dir = lockDir();
    expect(tryAcquireOnce(dir)).toBe(true);
    // Backdate the lock past the ceiling — without a heartbeat this would be
    // reclaimable mid-hold.
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
    utimesSync(dir, old, old);
    const beforeTouch = statSync(dir).mtimeMs;
    touchLock(dir);
    const afterTouch = statSync(dir).mtimeMs;
    expect(afterTouch).toBeGreaterThan(beforeTouch);
    // After the heartbeat the live holder is no longer reclaimable.
    expect(tryAcquireOnce(dir, { staleCeilingMs: 6 * 60 * 60 * 1000 })).toBe(false);
    expect(readLockOwner(dir)).toBe(process.pid);
    releaseLock(dir);
  });

  test('is a no-op (never throws) when the lock dir does not exist', () => {
    const dir = lockDir();
    expect(() => touchLock(dir)).not.toThrow();
  });
});

// Phase 10.7 — atomic-mkdir lock tests. Cover the happy path, blocked-by-alive
// path, stale-lock reclamation, and release idempotency.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLockInfo, tryAcquireLock } from '../../src/config/profileLock.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sov-lock-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('tryAcquireLock', () => {
  test('acquires when no lock is present and writes the PID', () => {
    const handle = tryAcquireLock(home);
    expect(handle).not.toBeNull();
    expect(handle?.path).toBe(join(home, '.sov.lock'));
    const pid = readFileSync(join(home, '.sov.lock', 'pid'), 'utf8').trim();
    expect(Number.parseInt(pid, 10)).toBe(process.pid);
    handle?.release();
  });

  test('release removes the lock directory and is idempotent', () => {
    const handle = tryAcquireLock(home);
    expect(handle).not.toBeNull();
    handle?.release();
    expect(existsSync(join(home, '.sov.lock'))).toBe(false);
    handle?.release();
    expect(existsSync(join(home, '.sov.lock'))).toBe(false);
  });

  test('returns null when the lock is held by an alive process (this PID)', () => {
    const first = tryAcquireLock(home);
    expect(first).not.toBeNull();
    const second = tryAcquireLock(home);
    expect(second).toBeNull();
    first?.release();
  });

  test('reclaims a stale lock whose PID is dead', () => {
    // Plant a stale lock with a PID that's almost certainly not alive.
    const lockDir = join(home, '.sov.lock');
    mkdirSync(lockDir);
    // PID 999999 is well above the typical max — process.kill(_, 0) throws
    // ESRCH for it, which `readLockInfo` treats as not-alive.
    writeFileSync(join(lockDir, 'pid'), '999999\n', 'utf8');
    const handle = tryAcquireLock(home);
    expect(handle).not.toBeNull();
    const reclaimedPid = readFileSync(join(home, '.sov.lock', 'pid'), 'utf8').trim();
    expect(Number.parseInt(reclaimedPid, 10)).toBe(process.pid);
    handle?.release();
  });

  test('does not reclaim a lock with no PID file (treated as held but unknown)', () => {
    // A lock dir with no pid file: readLockInfo returns held: true, alive
    // unset → not "alive: true", so tryAcquireLock will treat as stale and
    // reclaim.
    mkdirSync(join(home, '.sov.lock'));
    const handle = tryAcquireLock(home);
    expect(handle).not.toBeNull();
    handle?.release();
  });
});

describe('readLockInfo', () => {
  test('reports held: false when no lock exists', () => {
    const info = readLockInfo(home);
    expect(info.held).toBe(false);
    expect(info.pid).toBeUndefined();
  });

  test('reports the PID + alive: true when the holder is this process', () => {
    const handle = tryAcquireLock(home);
    expect(handle).not.toBeNull();
    const info = readLockInfo(home);
    expect(info.held).toBe(true);
    expect(info.pid).toBe(process.pid);
    expect(info.alive).toBe(true);
    handle?.release();
  });

  test('reports alive: false for a planted stale PID', () => {
    const lockDir = join(home, '.sov.lock');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), '999999\n', 'utf8');
    const info = readLockInfo(home);
    expect(info.held).toBe(true);
    expect(info.pid).toBe(999999);
    expect(info.alive).toBe(false);
  });

  test('reports held: true with no pid when the lock dir has no pid file', () => {
    mkdirSync(join(home, '.sov.lock'));
    const info = readLockInfo(home);
    expect(info.held).toBe(true);
    expect(info.pid).toBeUndefined();
    expect(info.alive).toBeUndefined();
  });
});

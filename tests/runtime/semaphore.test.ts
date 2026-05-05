// Phase 13.4 — Semaphore tests. The semaphore is the primitive the
// sub-agent scheduler uses to enforce per-lane concurrency caps and the
// profile-scoped write-path lock. v0 in-memory; multi-process locking
// (when the daemon lands in Phase 16) extends but does not replace this.

import { describe, expect, test } from 'bun:test';
import { Semaphore } from '../../src/runtime/semaphore.js';

describe('Semaphore', () => {
  test('allows up to max concurrent holders', async () => {
    const sem = new Semaphore(2);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    let r3Held = false;
    const r3Promise = sem.acquire().then((release) => {
      r3Held = true;
      return release;
    });
    // Give the event loop a few turns to confirm r3 is still queued.
    await Promise.resolve();
    await Promise.resolve();
    expect(r3Held).toBe(false);

    r1();
    const r3 = await r3Promise;
    expect(r3Held).toBe(true);
    r2();
    r3();
  });

  test('preserves FIFO ordering for queued waiters', async () => {
    const sem = new Semaphore(1);
    const r1 = await sem.acquire();
    const order: number[] = [];
    const wait = (n: number) =>
      sem.acquire().then((release) => {
        order.push(n);
        release();
      });
    const p2 = wait(2);
    const p3 = wait(3);
    const p4 = wait(4);
    r1();
    await Promise.all([p2, p3, p4]);
    expect(order).toEqual([2, 3, 4]);
  });

  test('AbortSignal already aborted rejects acquire immediately', async () => {
    const sem = new Semaphore(0);
    const ctl = new AbortController();
    ctl.abort();
    await expect(sem.acquire(ctl.signal)).rejects.toThrow(/abort/i);
  });

  test('AbortSignal aborted while waiting cancels the queued waiter', async () => {
    const sem = new Semaphore(1);
    const r1 = await sem.acquire();
    const ctl = new AbortController();
    const queued = sem.acquire(ctl.signal);
    setTimeout(() => ctl.abort(), 5);
    await expect(queued).rejects.toThrow(/abort/i);
    // The semaphore should still be usable: r1 release frees the slot
    // and a fresh acquire succeeds.
    r1();
    const r2 = await sem.acquire();
    r2();
  });

  test('release is idempotent — calling twice does not double-decrement', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    release();
    release();
    // After the double-release, only one slot should be available.
    const r1 = await sem.acquire();
    let r2Acquired = false;
    sem.acquire().then(() => {
      r2Acquired = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(r2Acquired).toBe(false);
    r1();
  });

  test('max=0 leaves all acquires queued until manually unblocked', async () => {
    const sem = new Semaphore(0);
    let acquired = false;
    sem.acquire().then(() => {
      acquired = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(acquired).toBe(false);
    // No way to release without prior acquire; this just demonstrates that
    // capacity=0 is permitted and behaves as expected.
  });
});

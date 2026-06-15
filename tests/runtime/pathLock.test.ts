// PathLockManager — path-granular write lock (2026-06-15 multi-agent workflows).

import { describe, expect, test } from 'bun:test';
import { PathLockManager, scopesOverlap } from '../../src/runtime/pathLock.js';

const globs = (...g: string[]) => ({ kind: 'globs' as const, globs: g });
const ALL = { kind: 'all' as const };

describe('scopesOverlap', () => {
  test('all overlaps everything (incl. another all and any globs)', () => {
    expect(scopesOverlap(ALL, ALL)).toBe(true);
    expect(scopesOverlap(ALL, globs('src/a.ts'))).toBe(true);
    expect(scopesOverlap(globs('src/a.ts'), ALL)).toBe(true);
  });
  test('disjoint directory globs do not overlap', () => {
    expect(scopesOverlap(globs('src/foo/**'), globs('src/bar/**'))).toBe(false);
    expect(scopesOverlap(globs('a.ts'), globs('b.ts'))).toBe(false);
  });
  test('nested / containing globs overlap (conservative)', () => {
    expect(scopesOverlap(globs('src/foo/**'), globs('src/foo/bar.ts'))).toBe(true);
    expect(scopesOverlap(globs('src/**'), globs('src/foo/x.ts'))).toBe(true);
    expect(scopesOverlap(globs('src/a.ts'), globs('src/a.ts'))).toBe(true);
  });
  test('empty glob set matches nothing → never overlaps', () => {
    expect(scopesOverlap(globs(), globs('src/a.ts'))).toBe(false);
  });
});

describe('PathLockManager', () => {
  test('disjoint scopes acquire concurrently (no serialization)', async () => {
    const m = new PathLockManager();
    const r1 = await m.acquire(globs('src/foo/**'));
    const r2 = await m.acquire(globs('src/bar/**')); // resolves immediately — disjoint
    expect(m.heldCount()).toBe(2);
    r1();
    r2();
    expect(m.heldCount()).toBe(0);
  });

  test('overlapping scopes serialize (second waits for first release)', async () => {
    const m = new PathLockManager();
    const r1 = await m.acquire(globs('src/foo/**'));
    let granted = false;
    const p2 = m.acquire(globs('src/foo/bar.ts')).then((rel) => {
      granted = true;
      return rel;
    });
    await Promise.resolve(); // let p2 settle if it were going to
    expect(granted).toBe(false); // still blocked — overlaps the held scope
    r1();
    const r2 = await p2;
    expect(granted).toBe(true);
    r2();
  });

  test('an `all` scope blocks every subsequent acquire (legacy global-lock behavior)', async () => {
    const m = new PathLockManager();
    const rAll = await m.acquire(ALL);
    let granted = false;
    const p = m.acquire(globs('src/x.ts')).then((rel) => {
      granted = true;
      return rel;
    });
    await Promise.resolve();
    expect(granted).toBe(false);
    rAll();
    await p;
    expect(granted).toBe(true);
  });

  test('one release wakes ALL disjoint queued waiters (parallel fan-out)', async () => {
    const m = new PathLockManager();
    const rAll = await m.acquire(ALL); // hold everything
    const order: string[] = [];
    const pA = m.acquire(globs('a/**')).then((r) => {
      order.push('a');
      return r;
    });
    const pB = m.acquire(globs('b/**')).then((r) => {
      order.push('b');
      return r;
    });
    rAll(); // releasing the broad lock should grant BOTH disjoint waiters
    await Promise.all([pA, pB]);
    expect(order.sort()).toEqual(['a', 'b']);
    expect(m.heldCount()).toBe(2);
  });

  test('abort while queued rejects without taking a slot', async () => {
    const m = new PathLockManager();
    const rAll = await m.acquire(ALL);
    const ac = new AbortController();
    const p = m.acquire(globs('x/**'), ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow();
    rAll();
    expect(m.heldCount()).toBe(0); // the aborted waiter never consumed a slot
  });

  test('release is idempotent', async () => {
    const m = new PathLockManager();
    const r = await m.acquire(globs('a/**'));
    r();
    r(); // no-op
    expect(m.heldCount()).toBe(0);
  });
});

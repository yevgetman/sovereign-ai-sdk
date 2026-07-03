// PathLockManager — path-granular write lock (2026-06-15 multi-agent workflows).

import { describe, expect, test } from 'bun:test';
import { PathLockManager, scopesOverlap } from '@yevgetman/sov-sdk/runtime/pathLock';

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

  // 2026-06-15 review fix C1 — a mid-segment trailing wildcard (`src/foo*`)
  // must NOT be judged disjoint from a sibling it can actually match
  // (`Bun.Glob('src/foo*')` matches `src/foobar.ts`). The fix collapses the
  // glob to its containing DIRECTORY (`src`), so these overlap.
  test('mid-segment wildcard overlaps a same-directory literal it can match', () => {
    expect(scopesOverlap(globs('src/foo*'), globs('src/foobar.ts'))).toBe(true);
    expect(scopesOverlap(globs('src/user*.ts'), globs('src/users.ts'))).toBe(true);
    expect(scopesOverlap(globs('build/app?'), globs('build/app1'))).toBe(true);
    expect(scopesOverlap(globs('src/foo*'), globs('src/foobar'))).toBe(true);
  });

  test('distinct literal files in the same directory still run in parallel', () => {
    expect(scopesOverlap(globs('src/a.ts'), globs('src/b.ts'))).toBe(false);
  });

  // 2026-06-15 review fix H1 — case-insensitive FS (macOS default): scopes that
  // name the same directory in different case target the same inode, so they
  // must serialize (folded comparison).
  test('case-only / ./-prefix differences overlap (same-target safety)', () => {
    expect(scopesOverlap(globs('src/**'), globs('SRC/**'))).toBe(true);
    expect(scopesOverlap(globs('./src/**'), globs('src/**'))).toBe(true);
    expect(scopesOverlap(globs('src/a/**'), globs('SRC/A/**'))).toBe(true);
  });

  test('disjoint dirs differing only by a deeper segment still parallel', () => {
    expect(scopesOverlap(globs('src/a/**'), globs('src/b/**'))).toBe(false);
    expect(scopesOverlap(globs('pkg/x/**'), globs('pkg/y/**'))).toBe(false);
  });

  // 2026-07-02 SDK audit F3 — picomatch's negation (`!`) and alternation
  // (`(a|b)`) specials are NOT in GLOB_CHARS, so an earlier globPrefix() found
  // no wildcard and returned a LITERAL prefix (`!src/secret`, `(a|b)/c`),
  // judging these scopes DISJOINT — while the write-scope matcher admitted a far
  // wider tree (`!src/secret` → the whole tree; `(a|b)/c` → `a/c`). Two
  // "disjoint" write-capable tasks then raced the same file. globPrefix now
  // treats a leading `!` (negation) or any `(`/`|` (group/alternation) as an
  // unbounded wildcard it cannot collapse, returning the whole-tree prefix ('')
  // so the scope conservatively OVERLAPS everything and serializes.
  test('leading-negation glob overlaps everything (F3 no false-disjoint race)', () => {
    expect(scopesOverlap(globs('!src/secret'), globs('lib/**'))).toBe(true);
    expect(scopesOverlap(globs('!src/secret'), globs('anything/deep/x.ts'))).toBe(true);
  });
  test('alternation-group glob overlaps a sibling it can match (F3 no race)', () => {
    expect(scopesOverlap(globs('(a|b)/c'), globs('a/**'))).toBe(true);
    expect(scopesOverlap(globs('+(a|b).ts'), globs('a.ts'))).toBe(true);
  });
  test('regression: plain disjoint dir globs still parallelize (no over-serialize creep)', () => {
    expect(scopesOverlap(globs('src/**'), globs('lib/**'))).toBe(false);
    expect(scopesOverlap(globs('src/a.ts'), globs('lib/b.ts'))).toBe(false);
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

// Path-granular write lock (2026-06-15 — multi-agent workflows, see
// docs/specs/2026-06-15-multi-agent-workflows-design.md).
//
// Replaces the v0 single global write mutex (Semaphore(1)) for write-capable
// sub-agents. A holder declares a WRITE SCOPE; two holders run concurrently iff
// their scopes do NOT overlap, so a workflow fanning out write-capable tasks
// across disjoint paths (e.g. migrate N independent files) runs in parallel —
// while overlapping writers still serialize, preserving the no-clash invariant.
//
// Back-compat: a holder with NO declared scope acquires `{kind:'all'}`, which
// overlaps everything → identical to the old global Semaphore(1). Model-driven
// AgentTool delegation (which never declares paths) is therefore unchanged.
//
// Overlap is computed CONSERVATIVELY (a false "overlap" only costs parallelism,
// never correctness): a glob collapses to the DIRECTORY that bounds everything
// it could match (its containing directory when the first wildcard is mid- or
// whole-segment; the full literal path when it has no wildcard). Two scopes
// overlap if either collapsed directory is at or under the other. Pairing this
// with the workflow's enforced write-scope boundary (a child's writes outside
// its declared scope are denied at the permission layer) makes parallel write
// fan-out safe even if an author under-declares — a stray write fails closed
// rather than racing.
//
// CORRECTNESS NOTE (2026-06-15 review fix): the prefix is taken at a `/` segment
// boundary, NOT mid-segment. An earlier version cut `src/foo*` to `src/foo`,
// which `prefixesTouch` then judged disjoint from `src/foobar.ts` even though
// `Bun.Glob('src/foo*')` matches `src/foobar.ts` — a false-disjoint verdict
// that let two write-capable children race the same file. Collapsing to the
// containing directory (`src/foo*` → `src`) is the conservative fix.
// Comparison is also case-folded and `./`-normalized so same-target scopes that
// differ only in case (case-insensitive FS) or `./` prefix still serialize.

import { posix } from 'node:path';

/** A write scope: the whole tree (the conservative default), or a set of path
 *  globs relative to cwd. */
export type PathScope = { kind: 'all' } | { kind: 'globs'; globs: string[] };

const GLOB_CHARS = /[*?[\]{}]/;

/** Lexically canonicalize a wildcard-free path prefix for comparison: collapse
 *  `./`, `//`, and `..` segments, drop a trailing slash, and case-fold. A bare
 *  `.` (or empty) means the whole tree. */
function normalizePrefix(p: string): string {
  if (p === '') return '';
  const norm = posix.normalize(p).replace(/\/+$/, '');
  const canon = norm === '.' ? '' : norm;
  return canon.toLowerCase();
}

/** The bounding directory of a glob: when the glob has a wildcard, everything
 *  up to (and excluding) the last `/` before the FIRST wildcard — i.e. its
 *  containing directory at a segment boundary, never mid-segment. With no
 *  wildcard the full literal path. Examples (arrow shows the collapsed prefix):
 *  `src/foo/` + `**` collapses to `src/foo`; `src/foo*` to `src`; `src/a.ts` to
 *  `src/a.ts`; a leading-wildcard glob to the empty prefix (whole tree).
 *  Normalized + case-folded for comparison. */
function globPrefix(glob: string): string {
  const m = glob.match(GLOB_CHARS);
  if (m === null || m.index === undefined) return normalizePrefix(glob);
  const beforeWildcard = glob.slice(0, m.index);
  const lastSlash = beforeWildcard.lastIndexOf('/');
  return normalizePrefix(lastSlash === -1 ? '' : beforeWildcard.slice(0, lastSlash));
}

/** True when path-prefix `a` contains-or-equals `b` (or vice versa) — i.e. one
 *  is at or under the other in the tree. Both are already normalized + folded by
 *  {@link globPrefix}. An empty prefix ('') matches the whole tree. */
function prefixesTouch(a: string, b: string): boolean {
  if (a === '' || b === '') return true;
  if (a === b) return true;
  return b.startsWith(`${a}/`) || a.startsWith(`${b}/`);
}

/** Conservative overlap test between two scopes. `all` overlaps everything;
 *  empty glob sets match nothing (never overlap). */
export function scopesOverlap(a: PathScope, b: PathScope): boolean {
  if (a.kind === 'all' || b.kind === 'all') return true;
  const pa = a.globs.map(globPrefix);
  const pb = b.globs.map(globPrefix);
  for (const x of pa) {
    for (const y of pb) {
      if (prefixesTouch(x, y)) return true;
    }
  }
  return false;
}

type Waiter = {
  scope: PathScope;
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  abortHandler?: () => void;
  granted: boolean;
};

/**
 * Grants concurrent access to non-overlapping write scopes; serializes
 * overlapping ones. FIFO-fair on release (a release re-scans the wait queue in
 * arrival order and grants every waiter that no longer overlaps the held set —
 * so one release can wake several disjoint waiters at once, which is exactly the
 * parallel-fan-out case). Abort-aware: a queued waiter whose signal aborts
 * rejects without taking a slot. Mirrors the {@link Semaphore} contract.
 */
export class PathLockManager {
  private readonly held: PathScope[] = [];
  private readonly waiters: Waiter[] = [];

  /** Acquire the given scope. Returns a release fn the caller MUST call exactly
   *  once (idempotent). */
  acquire(scope: PathScope, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(this.abortError(signal));
    if (!this.overlapsHeld(scope)) {
      this.held.push(scope);
      return Promise.resolve(this.makeRelease(scope));
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        scope,
        resolve,
        reject,
        granted: false,
        ...(signal !== undefined ? { signal } : {}),
      };
      if (signal !== undefined) {
        waiter.abortHandler = () => {
          if (waiter.granted) return; // already won the slot; release handles it
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(this.abortError(signal));
        };
        signal.addEventListener('abort', waiter.abortHandler, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  /** Number of scopes currently held — for tests / observability. */
  heldCount(): number {
    return this.held.length;
  }

  private overlapsHeld(scope: PathScope): boolean {
    return this.held.some((h) => scopesOverlap(h, scope));
  }

  private makeRelease(scope: PathScope): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const i = this.held.indexOf(scope);
      if (i >= 0) this.held.splice(i, 1);
      this.drainQueue();
    };
  }

  /** Re-scan waiters in FIFO order; grant each whose scope no longer overlaps
   *  the held set (granted scopes join `held` so later waiters see them). */
  private drainQueue(): void {
    for (let i = 0; i < this.waiters.length; ) {
      const w = this.waiters[i];
      if (w === undefined) {
        i++;
        continue;
      }
      if (this.overlapsHeld(w.scope)) {
        i++;
        continue;
      }
      this.waiters.splice(i, 1);
      w.granted = true;
      if (w.abortHandler !== undefined && w.signal !== undefined) {
        w.signal.removeEventListener('abort', w.abortHandler);
      }
      this.held.push(w.scope);
      w.resolve(this.makeRelease(w.scope));
      // Do not advance `i` — the splice shifted the next waiter into slot `i`.
    }
  }

  private abortError(signal: AbortSignal): Error {
    const reason = (signal as AbortSignal & { reason?: unknown }).reason;
    if (reason instanceof Error) return reason;
    return new Error('path-lock acquisition aborted');
  }
}

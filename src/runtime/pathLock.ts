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
// never correctness): globs collapse to their literal path-prefix (the part
// before the first wildcard), and two scopes overlap if any prefix of one is a
// path-prefix of any prefix of the other. Pairing this with the workflow's
// enforced write-scope boundary (a child's writes outside its declared scope
// are denied at the permission layer) makes parallel write fan-out safe even if
// an author under-declares — a stray write fails closed rather than racing.

/** A write scope: the whole tree (the conservative default), or a set of path
 *  globs relative to cwd. */
export type PathScope = { kind: 'all' } | { kind: 'globs'; globs: string[] };

const GLOB_CHARS = /[*?[\]{}]/;

/** The literal directory/file prefix of a glob — everything before the first
 *  wildcard, with any trailing slash trimmed. `src/foo/**` → `src/foo`,
 *  `src/a.ts` → `src/a.ts`, `*` → ``. */
function globPrefix(glob: string): string {
  const m = glob.match(GLOB_CHARS);
  const literal = m === null || m.index === undefined ? glob : glob.slice(0, m.index);
  return literal.replace(/\/+$/, '');
}

/** True when path-prefix `a` contains-or-equals `b` (or vice versa) — i.e. one
 *  is at or under the other in the tree. An empty prefix ('') matches the whole
 *  tree. */
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

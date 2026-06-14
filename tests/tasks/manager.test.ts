// TaskManager tests — exercise the full lifecycle (queued -> running ->
// terminal) against a stub scheduler that we drive synchronously. The
// manager kicks off scheduler.delegate() fire-and-forget, so each test
// awaits a controllable promise to deterministically observe transitions.

import { describe, expect, test } from 'bun:test';
import { SessionDb } from '../../src/agent/sessionDb.js';
import type { Terminal } from '../../src/core/types.js';
import type { DelegateInput, DelegateResult } from '../../src/runtime/scheduler.js';
import { TaskManager } from '../../src/tasks/manager.js';
import { TaskStore } from '../../src/tasks/store.js';
import type { TaskRecord } from '../../src/tasks/types.js';
import type { ToolContext } from '../../src/tool/types.js';

type StubSchedulerStub = {
  delegate: (input: DelegateInput) => Promise<DelegateResult>;
};

function makeDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(stub: StubSchedulerStub): {
  db: SessionDb;
  store: TaskStore;
  manager: TaskManager;
  sessionId: string;
} {
  const db = SessionDb.open({ path: ':memory:' });
  const sessionId = db.createSession({ model: 'm', provider: 'p' });
  const store = new TaskStore(db);
  const manager = new TaskManager({
    store,
    scheduler: stub as unknown as ConstructorParameters<typeof TaskManager>[0]['scheduler'],
  });
  return { db, store, manager, sessionId };
}

/** Pre-create a child session row so the tasks.child_session_id FK is
 *  satisfied when the manager records the terminal record. In production
 *  the scheduler.createChildSession() inserts this row before delegate()
 *  resolves; the stub scheduler in these tests bypasses that, so we seed
 *  it ourselves. */
function seedChildSession(db: SessionDb, childId: string): void {
  const now = Date.now() / 1000;
  db.handle.run(
    `INSERT INTO sessions (
      session_id, model, provider, platform, created_at, last_updated,
      schema_version, metadata
    ) VALUES (?, 'm', 'p', 'cli', ?, ?, 4, '{}')`,
    [childId, now, now],
  );
}

const baseToolContext: ToolContext = { cwd: process.cwd(), sessionId: 'parent' };

const makeCompletedResult = (id: string, terminal: Terminal): DelegateResult => ({
  childSessionId: id,
  agentName: 'explore',
  resolvedProvider: 'fake',
  resolvedModel: 'fake-model',
  terminal,
  summary: 'fake summary',
  iterationsUsed: 1,
  toolCallCount: 0,
  distinctToolNames: [],
  durationMs: 5,
});

describe('TaskManager.create', () => {
  test('returns a queued record synchronously and transitions to running', async () => {
    const deferred = makeDeferred<DelegateResult>();
    const stub: StubSchedulerStub = {
      delegate: () => deferred.promise,
    };
    const { db, manager, sessionId } = setup(stub);
    const created = await manager.create({
      parentSessionId: sessionId,
      agentName: 'explore',
      prompt: 'find auth',
      parentToolPool: [],
      parentToolContext: baseToolContext,
    });
    expect(created.state).toBe('queued');
    expect(created.id.length).toBeGreaterThan(0);

    // The scheduler hasn't resolved yet; the manager should have already
    // fired off delegation, which started by transitioning to 'running'.
    // Yield a microtask so the inner state-update completes.
    await Promise.resolve();
    const running = manager.get(created.id);
    expect(running?.state).toBe('running');

    seedChildSession(db, 'child-1');
    deferred.resolve(makeCompletedResult('child-1', { reason: 'completed' }));
    // Two microtask drains — one for delegate.then, one for our handler.
    await new Promise((r) => setTimeout(r, 0));
    const final = manager.get(created.id);
    expect(final?.state).toBe('completed');
    expect(final?.childSessionId).toBe('child-1');
    expect(final?.resultPreview).toBe('fake summary');
    db.close();
  });
});

describe('TaskManager error / cancel mapping', () => {
  test('terminal.reason=error -> state=failed', async () => {
    const deferred = makeDeferred<DelegateResult>();
    const { db, manager, sessionId } = setup({ delegate: () => deferred.promise });
    const created = await manager.create({
      parentSessionId: sessionId,
      agentName: 'explore',
      prompt: 'p',
      parentToolPool: [],
      parentToolContext: baseToolContext,
    });
    seedChildSession(db, 'child-2');
    deferred.resolve(makeCompletedResult('child-2', { reason: 'error', error: new Error('boom') }));
    await new Promise((r) => setTimeout(r, 0));
    expect(manager.get(created.id)?.state).toBe('failed');
    db.close();
  });

  test('thrown rejection from scheduler -> state=failed and resultPreview holds error', async () => {
    const stub: StubSchedulerStub = {
      delegate: async () => {
        throw new Error('scheduler refused');
      },
    };
    const { db, manager, sessionId } = setup(stub);
    const created = await manager.create({
      parentSessionId: sessionId,
      agentName: 'explore',
      prompt: 'p',
      parentToolPool: [],
      parentToolContext: baseToolContext,
    });
    await new Promise((r) => setTimeout(r, 0));
    const final = manager.get(created.id);
    expect(final?.state).toBe('failed');
    expect(final?.resultPreview).toContain('scheduler refused');
    db.close();
  });

  test('user-aborted interrupted -> cancelled', async () => {
    // Simulate task_stop by aborting before delegate resolves.
    const deferred = makeDeferred<DelegateResult>();
    const { db, manager, sessionId } = setup({ delegate: () => deferred.promise });
    const created = await manager.create({
      parentSessionId: sessionId,
      agentName: 'explore',
      prompt: 'p',
      parentToolPool: [],
      parentToolContext: baseToolContext,
    });
    await manager.stop(created.id);
    seedChildSession(db, 'child-3');
    deferred.resolve(makeCompletedResult('child-3', { reason: 'interrupted' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(manager.get(created.id)?.state).toBe('cancelled');
    db.close();
  });

  // FINDING #30 — the subscription-executor (claude -p) returns its
  // cancel/timeout terminal IN-BAND as `reason: 'error'` (it never throws), so
  // delegate() resolves normally with an error terminal. The native AgentRunner
  // path instead THROWS on abort → scheduler returns `reason: 'interrupted'`
  // (correctly mapped to cancelled/timed_out). Pre-fix the manager mapped the
  // subprocess error terminal to 'failed' unconditionally, losing the cancel /
  // timeout distinction. These three cases assert native-vs-subprocess parity.
  test('user-aborted subprocess error terminal -> cancelled (not failed)', async () => {
    const deferred = makeDeferred<DelegateResult>();
    const { db, manager, sessionId } = setup({ delegate: () => deferred.promise });
    const created = await manager.create({
      parentSessionId: sessionId,
      agentName: 'subscription-executor',
      prompt: 'p',
      parentToolPool: [],
      parentToolContext: baseToolContext,
    });
    await manager.stop(created.id); // userAborted = true
    seedChildSession(db, 'child-sub-cancel');
    // The subprocess executor's in-band abort terminal: error + cancel message.
    deferred.resolve(
      makeCompletedResult('child-sub-cancel', {
        reason: 'error',
        error: new Error('subscription-executor cancelled by scheduler signal'),
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(manager.get(created.id)?.state).toBe('cancelled');
    db.close();
  });

  test('scheduler-timed-out subprocess error terminal -> timed_out (not failed)', async () => {
    const deferred = makeDeferred<DelegateResult>();
    const { db, manager, sessionId } = setup({ delegate: () => deferred.promise });
    const created = await manager.create({
      parentSessionId: sessionId,
      agentName: 'subscription-executor',
      prompt: 'p',
      parentToolPool: [],
      parentToolContext: baseToolContext,
    });
    // No manager.stop() — userAborted stays false (the scheduler/internal
    // timeout fired, not the user).
    seedChildSession(db, 'child-sub-timeout');
    deferred.resolve(
      makeCompletedResult('child-sub-timeout', {
        reason: 'error',
        error: new Error('subscription-executor timed out after 120000ms'),
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(manager.get(created.id)?.state).toBe('timed_out');
    db.close();
  });

  test('genuine subprocess error terminal (no abort) -> failed (regression guard)', async () => {
    const deferred = makeDeferred<DelegateResult>();
    const { db, manager, sessionId } = setup({ delegate: () => deferred.promise });
    const created = await manager.create({
      parentSessionId: sessionId,
      agentName: 'subscription-executor',
      prompt: 'p',
      parentToolPool: [],
      parentToolContext: baseToolContext,
    });
    seedChildSession(db, 'child-sub-err');
    // A real failure (non-zero exit) — userAborted false, not an abort message.
    deferred.resolve(
      makeCompletedResult('child-sub-err', {
        reason: 'error',
        error: new Error('subscription-executor exited 1: boom'),
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(manager.get(created.id)?.state).toBe('failed');
    db.close();
  });
});

describe('TaskManager.list / get', () => {
  test('list returns queued + running tasks for the parent', async () => {
    const deferred = makeDeferred<DelegateResult>();
    const { db, manager, sessionId } = setup({ delegate: () => deferred.promise });
    const a = await manager.create({
      parentSessionId: sessionId,
      agentName: 'explore',
      prompt: 'a',
      parentToolPool: [],
      parentToolContext: baseToolContext,
    });
    const b = await manager.create({
      parentSessionId: sessionId,
      agentName: 'explore',
      prompt: 'b',
      parentToolPool: [],
      parentToolContext: baseToolContext,
    });
    const list = manager.list(sessionId);
    expect(list.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    seedChildSession(db, 'child');
    deferred.resolve(makeCompletedResult('child', { reason: 'completed' }));
    // Drain pending fire-and-forget handlers before closing the db so
    // they don't race with db.close() and emit benign "Database has
    // closed" errors. Two task creations -> two pending delegations.
    await new Promise((r) => setTimeout(r, 0));
    db.close();
  });

  test('get returns null for an unknown id', () => {
    const { db, manager } = setup({
      delegate: async () => ({}) as unknown as DelegateResult,
    });
    expect(manager.get('no-such-id')).toBeNull();
    db.close();
  });
});

describe('TaskManager.output', () => {
  test('returns persisted state and preview after completion (controller cleaned up)', async () => {
    const deferred = makeDeferred<DelegateResult>();
    const { db, manager, sessionId } = setup({ delegate: () => deferred.promise });
    const created = await manager.create({
      parentSessionId: sessionId,
      agentName: 'explore',
      prompt: 'p',
      parentToolPool: [],
      parentToolContext: baseToolContext,
    });
    seedChildSession(db, 'child-out');
    deferred.resolve({
      ...makeCompletedResult('child-out', { reason: 'completed' }),
      summary: 'final result',
      iterationsUsed: 3,
      toolCallCount: 2,
      durationMs: 1234,
    });
    await new Promise((r) => setTimeout(r, 0));
    const out = manager.output(created.id);
    expect(out?.state).toBe('completed');
    expect(out?.resultPreview).toBe('final result');
    expect(out?.childSessionId).toBe('child-out');
    // After terminal, the controller is dropped — counters/summary/etc.
    // are unavailable (would need to be persisted to the row to survive).
    expect(out?.iterationsUsed).toBeUndefined();
    expect(out?.toolCallCount).toBeUndefined();
    expect(out?.durationMs).toBeUndefined();
    expect(out?.terminalReason).toBeUndefined();
    expect(out?.summary).toBeUndefined();
    db.close();
  });

  test('returns running-state counters from the controller while still running', async () => {
    const deferred = makeDeferred<DelegateResult>();
    const { db, manager, sessionId } = setup({ delegate: () => deferred.promise });
    const created = await manager.create({
      parentSessionId: sessionId,
      agentName: 'explore',
      prompt: 'p',
      parentToolPool: [],
      parentToolContext: baseToolContext,
    });
    // Drain microtasks so updateState('running') has landed but delegate
    // hasn't resolved yet.
    await Promise.resolve();
    const out = manager.output(created.id);
    expect(out?.state).toBe('running');
    // The controller is still in the map; iterationsUsed starts at 0 — a
    // legitimate zero, not "never updated". Reported now (was hidden by
    // the > 0 heuristic before the post-Phase-13.2 polish pass).
    expect(out?.iterationsUsed).toBe(0);
    expect(out?.toolCallCount).toBe(0);
    // Resolve and drain so the fire-and-forget handler completes its
    // updateOnComplete call before we close the db.
    seedChildSession(db, 'child-running');
    deferred.resolve(makeCompletedResult('child-running', { reason: 'completed' }));
    await new Promise((r) => setTimeout(r, 0));
    db.close();
  });

  test('returns minimal state-only payload while running', async () => {
    const deferred = makeDeferred<DelegateResult>();
    const { db, manager, sessionId } = setup({ delegate: () => deferred.promise });
    const created = await manager.create({
      parentSessionId: sessionId,
      agentName: 'explore',
      prompt: 'p',
      parentToolPool: [],
      parentToolContext: baseToolContext,
    });
    await Promise.resolve();
    const out = manager.output(created.id);
    expect(out?.state).toBe('running');
    expect(out?.summary).toBeUndefined();
    // Resolve and drain so the fire-and-forget handler completes its
    // updateOnComplete call before we close the db. Without this drain,
    // the handler races with db.close() and emits a benign "Database
    // has closed" error to stderr (which Bun surfaces in test output).
    seedChildSession(db, 'child');
    deferred.resolve(makeCompletedResult('child', { reason: 'completed' }));
    await new Promise((r) => setTimeout(r, 0));
    db.close();
  });
});

// FIX 4 — tasks.parent_session_id is ON DELETE CASCADE; a DELETE /sessions/:id
// during a running background task removes the task row. When the task then
// completes (or errors), updateOnComplete throws (changes===0 / SQLITE_BUSY).
// runDelegation is fire-and-forget (void), so an escaping throw becomes an
// UNHANDLED REJECTION and the AbortController/entry leaks. The terminal-write
// must be wrapped: log-don't-rethrow, and STILL clean up the controller +
// emit. A missing row is benign (mirrors updateState's has-row guard).
describe('TaskManager terminal-write resilience (row deleted mid-flight)', () => {
  /** A TaskStore stub whose updateOnComplete throws (the deleted-row /
   *  SQLITE_BUSY case) while get() still returns a row, so we can observe the
   *  controller cleanup via output() after the failed terminal write. */
  function makeThrowingStore(opts: {
    onComplete: () => never;
  }): ConstructorParameters<typeof TaskManager>[0]['store'] {
    const rows = new Map<string, TaskRecord>();
    const stub = {
      insert: (input: { id: string; parentSessionId: string; agent: string; prompt: string }) => {
        const rec: TaskRecord = {
          id: input.id,
          parentSessionId: input.parentSessionId,
          agent: input.agent,
          prompt: input.prompt,
          state: 'queued',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        rows.set(input.id, rec);
        return rec;
      },
      updateState: (id: string, state: TaskRecord['state']) => {
        const rec = rows.get(id);
        if (rec) rows.set(id, { ...rec, state });
      },
      updateOnComplete: () => opts.onComplete(),
      get: (id: string) => rows.get(id) ?? null,
      listByParent: () => [...rows.values()],
    };
    return stub as unknown as ConstructorParameters<typeof TaskManager>[0]['store'];
  }

  test('success path: terminal-write throw does not escape; controller cleaned up', async () => {
    const deferred = makeDeferred<DelegateResult>();
    const store = makeThrowingStore({
      onComplete: () => {
        throw new Error('no task with id (row deleted)');
      },
    });
    const manager = new TaskManager({
      store,
      scheduler: { delegate: () => deferred.promise } as unknown as ConstructorParameters<
        typeof TaskManager
      >[0]['scheduler'],
    });
    const created = await manager.create({
      parentSessionId: 'parent',
      agentName: 'explore',
      prompt: 'p',
      parentToolPool: [],
      parentToolContext: baseToolContext,
    });
    // While running, the controller is present → output exposes counters.
    await Promise.resolve();
    expect(manager.output(created.id)?.iterationsUsed).toBe(0);

    // Resolve with a normal completion → runDelegation's updateOnComplete throws.
    // The throw MUST NOT escape the void fire-and-forget; drain and assert the
    // controller was still dropped (output no longer exposes controller fields).
    deferred.resolve(makeCompletedResult('child', { reason: 'completed' }));
    await new Promise((r) => setTimeout(r, 0));
    const out = manager.output(created.id);
    // Row still exists in the stub; controller is gone → no live counters.
    expect(out).not.toBeNull();
    expect(out?.iterationsUsed).toBeUndefined();
    expect(out?.toolCallCount).toBeUndefined();
  });

  test('error path: terminal-write throw in the catch does not escape; controller cleaned up', async () => {
    const store = makeThrowingStore({
      onComplete: () => {
        throw new Error('no task with id (row deleted)');
      },
    });
    const manager = new TaskManager({
      store,
      // The scheduler itself rejects → runDelegation enters its catch, whose
      // updateOnComplete ALSO throws (deleted row). That second throw must not
      // escape either.
      scheduler: {
        delegate: async () => {
          throw new Error('scheduler refused');
        },
      } as unknown as ConstructorParameters<typeof TaskManager>[0]['scheduler'],
    });
    const created = await manager.create({
      parentSessionId: 'parent',
      agentName: 'explore',
      prompt: 'p',
      parentToolPool: [],
      parentToolContext: baseToolContext,
    });
    await new Promise((r) => setTimeout(r, 0));
    const out = manager.output(created.id);
    expect(out).not.toBeNull();
    // Controller dropped despite the catch-path write failing.
    expect(out?.iterationsUsed).toBeUndefined();
  });

  test('real DB: deleting the task row mid-flight does not throw on completion', async () => {
    // Faithful CASCADE scenario against the real store: insert via the manager,
    // delete the tasks row out from under it, then resolve delegate. The real
    // updateOnComplete sees changes===0 and would throw pre-fix.
    const deferred = makeDeferred<DelegateResult>();
    const { db, manager, sessionId } = setup({ delegate: () => deferred.promise });
    const created = await manager.create({
      parentSessionId: sessionId,
      agentName: 'explore',
      prompt: 'p',
      parentToolPool: [],
      parentToolContext: baseToolContext,
    });
    await Promise.resolve();
    // Simulate DELETE /sessions/:id cascading to the task row.
    db.handle.run('DELETE FROM tasks WHERE task_id = ?', [created.id]);
    seedChildSession(db, 'child-cascade');
    // Resolve — runDelegation's updateOnComplete now hits changes===0. The fix
    // swallows it (benign missing row); the test passing without an unhandled
    // rejection is the assertion. get() now returns null (row gone).
    deferred.resolve(makeCompletedResult('child-cascade', { reason: 'completed' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(manager.get(created.id)).toBeNull();
    db.close();
  });
});

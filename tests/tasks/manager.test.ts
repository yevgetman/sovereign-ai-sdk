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

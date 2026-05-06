// TaskStore tests — runs against an in-memory SessionDb so no filesystem
// touches. Each test opens a fresh handle.

import { describe, expect, test } from 'bun:test';
import { SessionDb } from '../../src/agent/sessionDb.js';
import { TaskStore } from '../../src/tasks/store.js';

function setup(): { db: SessionDb; store: TaskStore; sessionId: string } {
  const db = SessionDb.open({ path: ':memory:' });
  const sessionId = db.createSession({ model: 'm', provider: 'p' });
  const store = new TaskStore(db);
  return { db, store, sessionId };
}

describe('TaskStore.insert + get', () => {
  test('insert creates a queued row and get round-trips it', () => {
    const { db, store, sessionId } = setup();
    const record = store.insert({
      id: 't-1',
      parentSessionId: sessionId,
      agent: 'explore',
      prompt: 'find auth',
    });
    expect(record.state).toBe('queued');
    expect(record.id).toBe('t-1');
    expect(record.parentSessionId).toBe(sessionId);
    const fetched = store.get('t-1');
    expect(fetched?.id).toBe('t-1');
    expect(fetched?.state).toBe('queued');
    expect(fetched?.agent).toBe('explore');
    expect(fetched?.prompt).toBe('find auth');
    expect(fetched?.childSessionId).toBeUndefined();
    expect(fetched?.resultPreview).toBeUndefined();
    db.close();
  });

  test('get returns null for unknown id', () => {
    const { db, store } = setup();
    expect(store.get('no-such-id')).toBeNull();
    db.close();
  });
});

describe('TaskStore.updateState', () => {
  test('moves queued -> running and bumps updatedAt', () => {
    const { db, store, sessionId } = setup();
    const created = store.insert({
      id: 't-1',
      parentSessionId: sessionId,
      agent: 'explore',
      prompt: 'p',
    });
    const before = created.updatedAt;
    // Force a measurable updatedAt delta — Bun.sleepSync is synchronous
    // and reliable in tests.
    Bun.sleepSync(5);
    store.updateState('t-1', 'running');
    const after = store.get('t-1');
    expect(after?.state).toBe('running');
    expect(after).not.toBeNull();
    expect((after as { updatedAt: string }).updatedAt > before).toBe(true);
    db.close();
  });

  test('throws on unknown id (no silent no-op)', () => {
    const { db, store } = setup();
    expect(() => store.updateState('no-such-id', 'running')).toThrow();
    db.close();
  });
});

describe('TaskStore.updateOnComplete', () => {
  test('writes terminal state, child session id, trace id, result preview', () => {
    const { db, store, sessionId } = setup();
    store.insert({
      id: 't-1',
      parentSessionId: sessionId,
      agent: 'explore',
      prompt: 'p',
    });
    const childSessionId = db.createSession({
      model: 'm',
      provider: 'p',
      parentSessionId: sessionId,
    });
    store.updateOnComplete('t-1', {
      state: 'completed',
      childSessionId,
      traceId: childSessionId,
      resultPreview: 'found 3 files',
    });
    const after = store.get('t-1');
    expect(after?.state).toBe('completed');
    expect(after?.childSessionId).toBe(childSessionId);
    expect(after?.traceId).toBe(childSessionId);
    expect(after?.resultPreview).toBe('found 3 files');
    db.close();
  });
});

describe('TaskStore.listByParent', () => {
  test('returns rows for the parent newest-first; default filter is active states', () => {
    const { db, store, sessionId } = setup();
    store.insert({ id: 't-1', parentSessionId: sessionId, agent: 'explore', prompt: 'p1' });
    Bun.sleepSync(5);
    store.insert({ id: 't-2', parentSessionId: sessionId, agent: 'explore', prompt: 'p2' });
    Bun.sleepSync(5);
    store.updateState('t-1', 'running');
    store.updateOnComplete('t-2', { state: 'completed', resultPreview: 'done' });

    const active = store.listByParent(sessionId);
    expect(active.map((r) => r.id)).toEqual(['t-1']); // t-2 completed, filtered out

    const all = store.listByParent(sessionId, { includeAll: true });
    expect(all.map((r) => r.id)).toEqual(['t-2', 't-1']); // newest-first by created_at
    db.close();
  });

  test('omits rows for other parents', () => {
    const { db, store, sessionId } = setup();
    const otherParent = db.createSession({ model: 'm', provider: 'p' });
    store.insert({ id: 't-mine', parentSessionId: sessionId, agent: 'a', prompt: 'p' });
    store.insert({ id: 't-other', parentSessionId: otherParent, agent: 'a', prompt: 'p' });
    const rows = store.listByParent(sessionId, { includeAll: true });
    expect(rows.map((r) => r.id)).toEqual(['t-mine']);
    db.close();
  });
});

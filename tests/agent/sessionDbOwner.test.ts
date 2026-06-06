// Phase E-T3 — session ownership: a nullable `owner_id` column (migration
// 4→5) plus owner-aware reads (getSession / listSessions). Backs the
// multi-user gateway's per-principal session scoping (route enforcement is
// E-T4). Owner is optional everywhere — back-compat is load-bearing.

import { describe, expect, test } from 'bun:test';
import { SessionDb } from '../../src/agent/sessionDb.js';

function open(): SessionDb {
  return SessionDb.open({ path: ':memory:' });
}

/** Read the column names of the `sessions` table via PRAGMA table_info. */
function sessionColumns(db: SessionDb): string[] {
  const rows = db.handle.query<{ name: string }, []>('PRAGMA table_info(sessions)').all();
  return rows.map((r) => r.name);
}

describe('SessionDb migration 4→5 — owner_id column', () => {
  test('a fresh DB has the owner_id column', () => {
    const db = open();
    expect(sessionColumns(db)).toContain('owner_id');
    db.close();
  });

  test('rows created without an owner read back as ownerId === null', () => {
    const db = open();
    const id = db.createSession({ model: 'm', provider: 'p' });
    expect(db.getSession(id)?.ownerId).toBeNull();
    db.close();
  });
});

describe('SessionDb.createSession — owner', () => {
  test('records the owner when supplied', () => {
    const db = open();
    const id = db.createSession({ model: 'm', provider: 'p', owner: 'alice' });
    expect(db.getSession(id)?.ownerId).toBe('alice');
    db.close();
  });

  test('owner defaults to null when omitted', () => {
    const db = open();
    const id = db.createSession({ model: 'm', provider: 'p' });
    expect(db.getSession(id)?.ownerId).toBeNull();
    db.close();
  });
});

describe('SessionDb.getSession — owner filter', () => {
  test('returns the row when the owner matches', () => {
    const db = open();
    const id = db.createSession({ model: 'm', provider: 'p', owner: 'alice' });
    expect(db.getSession(id, 'alice')?.sessionId).toBe(id);
    db.close();
  });

  test('returns null when the owner does not match', () => {
    const db = open();
    const id = db.createSession({ model: 'm', provider: 'p', owner: 'alice' });
    expect(db.getSession(id, 'bob')).toBeNull();
    db.close();
  });

  test('returns the row regardless when no owner arg is passed (back-compat)', () => {
    const db = open();
    const id = db.createSession({ model: 'm', provider: 'p', owner: 'alice' });
    expect(db.getSession(id)?.sessionId).toBe(id);
    db.close();
  });

  test('owner filter excludes an unowned (null-owner) row', () => {
    const db = open();
    const id = db.createSession({ model: 'm', provider: 'p' });
    expect(db.getSession(id, 'alice')).toBeNull();
    expect(db.getSession(id)?.sessionId).toBe(id);
    db.close();
  });
});

describe('SessionDb.listSessions — owner filter', () => {
  test("returns only the given owner's sessions", () => {
    const db = open();
    const a1 = db.createSession({ model: 'm', provider: 'p', owner: 'alice' });
    const a2 = db.createSession({ model: 'm', provider: 'p', owner: 'alice' });
    db.createSession({ model: 'm', provider: 'p', owner: 'bob' });
    db.createSession({ model: 'm', provider: 'p' }); // unowned

    const aliceIds = db.listSessions(20, 'alice').map((e) => e.sessionId);
    expect(aliceIds.sort()).toEqual([a1, a2].sort());
    db.close();
  });

  test('returns all sessions when no owner is passed (back-compat)', () => {
    const db = open();
    db.createSession({ model: 'm', provider: 'p', owner: 'alice' });
    db.createSession({ model: 'm', provider: 'p', owner: 'bob' });
    db.createSession({ model: 'm', provider: 'p' });
    expect(db.listSessions(20)).toHaveLength(3);
    db.close();
  });

  test('a no-owner session has ownerId: null in the list entry', () => {
    const db = open();
    db.createSession({ model: 'm', provider: 'p' });
    const entry = db.listSessions(20)[0];
    expect(entry?.ownerId).toBeNull();
    db.close();
  });

  test('an owned session surfaces its ownerId in the list entry', () => {
    const db = open();
    db.createSession({ model: 'm', provider: 'p', owner: 'alice' });
    const entry = db.listSessions(20, 'alice')[0];
    expect(entry?.ownerId).toBe('alice');
    db.close();
  });

  test('the owner filter respects the limit', () => {
    const db = open();
    for (let i = 0; i < 5; i++) {
      db.createSession({ model: 'm', provider: 'p', owner: 'alice' });
    }
    db.createSession({ model: 'm', provider: 'p', owner: 'bob' });
    expect(db.listSessions(3, 'alice')).toHaveLength(3);
    expect(db.listSessions(20, 'alice')).toHaveLength(5);
    db.close();
  });
});

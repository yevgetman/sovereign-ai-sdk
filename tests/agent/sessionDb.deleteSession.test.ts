// deleteSession — Phase D session-lifecycle: FK-safe permanent removal of a
// session row and every dependent child-table row. Distinct from idle
// eviction (which only reclaims memory and keeps the row). Backs the new
// DELETE /sessions/:id gateway route.

import { describe, expect, test } from 'bun:test';
import { SessionDb } from '../../src/agent/sessionDb.js';

function open(): SessionDb {
  return SessionDb.open({ path: ':memory:' });
}

/** Count rows in a child table for a given session id, via the raw handle. */
function countMessages(db: SessionDb, sessionId: string): number {
  const row = db.handle
    .query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?')
    .get(sessionId);
  return row?.n ?? 0;
}

describe('SessionDb.deleteSession', () => {
  test('removes the session row and all dependent rows', () => {
    const db = open();
    const id = db.createSession({ model: 'm', provider: 'p' });
    db.saveMessage(id, { role: 'user', content: [{ type: 'text', text: 'hi' }] });
    db.saveMessage(id, { role: 'assistant', content: [{ type: 'text', text: 'hello' }] });
    db.recordTokenUsage(id, { inputTokens: 100, outputTokens: 50 }, 0.0042);

    expect(countMessages(db, id)).toBe(2);

    const deleted = db.deleteSession(id);

    expect(deleted).toBeTruthy();
    expect(db.getSession(id)).toBeNull();
    expect(db.loadMessages(id)).toEqual([]);
    expect(countMessages(db, id)).toBe(0);
    db.close();
  });

  test('removes session_compactions lineage rows referencing the session', () => {
    const db = open();
    const parent = db.createSession({ model: 'm', provider: 'p' });
    const child = db.createSession({ model: 'm', provider: 'p' });
    db.recordCompactionLineage(parent, child);

    // sanity: lineage row exists
    const before = db.handle
      .query<{ n: number }, [string, string]>(
        'SELECT COUNT(*) AS n FROM session_compactions WHERE parent_session_id = ? OR child_session_id = ?',
      )
      .get(parent, parent);
    expect(before?.n).toBe(1);

    db.deleteSession(parent);

    const after = db.handle
      .query<{ n: number }, [string, string]>(
        'SELECT COUNT(*) AS n FROM session_compactions WHERE parent_session_id = ? OR child_session_id = ?',
      )
      .get(parent, parent);
    expect(after?.n).toBe(0);
    db.close();
  });

  test('is idempotent: deleting a non-existent id does not throw and is falsy', () => {
    const db = open();
    expect(() => db.deleteSession('does-not-exist')).not.toThrow();
    expect(db.deleteSession('does-not-exist')).toBeFalsy();
    db.close();
  });

  test('a second delete on an already-deleted id is a no-op (falsy)', () => {
    const db = open();
    const id = db.createSession({ model: 'm', provider: 'p' });
    expect(db.deleteSession(id)).toBeTruthy();
    expect(db.deleteSession(id)).toBeFalsy();
    db.close();
  });

  test('child sessions are detached (parent_session_id nulled), not deleted', () => {
    const db = open();
    const parent = db.createSession({ model: 'm', provider: 'p' });
    const child = db.createSession({
      model: 'm',
      provider: 'p',
      parentSessionId: parent,
    });

    // sanity: the link exists
    expect(db.getSession(child)?.parentSessionId).toBe(parent);

    expect(() => db.deleteSession(parent)).not.toThrow();

    // parent row is gone
    expect(db.getSession(parent)).toBeNull();
    // child still exists, but its parent pointer is nulled (independent row)
    const childRow = db.getSession(child);
    expect(childRow).not.toBeNull();
    expect(childRow?.parentSessionId).toBeNull();
    db.close();
  });

  test('resume path sees a deleted session as gone', () => {
    const db = open();
    const id = db.createSession({ model: 'm', provider: 'p' });
    db.saveMessage(id, { role: 'user', content: [{ type: 'text', text: 'hi' }] });
    db.deleteSession(id);
    expect(db.getSession(id)).toBeNull();
    db.close();
  });
});

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

/** Insert a raw `tasks` row, matching the migration-3→4 schema. The
 *  `parent_session_id` FK is `ON DELETE CASCADE`; `child_session_id` is
 *  `ON DELETE SET NULL`. No public insert helper sets `child_session_id`, so
 *  the test writes through the same `db.handle` the other cases use. */
function insertTask(
  db: SessionDb,
  taskId: string,
  parentSessionId: string,
  childSessionId: string | null,
): void {
  const now = Date.now() / 1000;
  db.handle.run(
    `INSERT INTO tasks (
       task_id, parent_session_id, child_session_id, agent, prompt,
       state, created_at, updated_at
     ) VALUES (?, ?, ?, 'agent', 'prompt', 'queued', ?, ?)`,
    [taskId, parentSessionId, childSessionId, now, now],
  );
}

/** Read a single task row's `child_session_id` (null when SET NULL fired). */
function taskChildSessionId(db: SessionDb, taskId: string): string | null | undefined {
  const row = db.handle
    .query<{ child_session_id: string | null }, [string]>(
      'SELECT child_session_id FROM tasks WHERE task_id = ?',
    )
    .get(taskId);
  return row === null ? undefined : row.child_session_id;
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

  test('tasks rows CASCADE on parent_session_id and SET NULL on child_session_id', () => {
    const db = open();
    const target = db.createSession({ model: 'm', provider: 'p' });
    // A surviving session that owns the SET-NULL task as its parent.
    const survivor = db.createSession({ model: 'm', provider: 'p' });

    // Task A: target is the parent → must CASCADE-delete with the target.
    insertTask(db, 'task-cascade', target, null);
    // Task B: survivor is the parent (so the row survives), target is the
    // child → its child_session_id must be SET NULL, leaving the row intact.
    insertTask(db, 'task-setnull', survivor, target);

    // sanity: both rows + both FK links exist before the delete.
    expect(taskChildSessionId(db, 'task-cascade')).toBeNull();
    expect(taskChildSessionId(db, 'task-setnull')).toBe(target);

    db.deleteSession(target);

    // CASCADE: the task parented by the deleted session is gone (undefined).
    expect(taskChildSessionId(db, 'task-cascade')).toBeUndefined();
    // SET NULL: the survivor-parented task still exists, child pointer nulled.
    expect(taskChildSessionId(db, 'task-setnull')).toBeNull();
    // The survivor session itself is untouched.
    expect(db.getSession(survivor)).not.toBeNull();
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

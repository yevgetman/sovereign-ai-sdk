// deleteSession — Phase D session-lifecycle: FK-safe permanent removal of a
// session row and every dependent child-table row. Distinct from idle
// eviction (which only reclaims memory and keeps the row). Backs the new
// DELETE /sessions/:id gateway route.

import { describe, expect, test } from 'bun:test';
import type { LogicalTurnRecord } from '@yevgetman/sov-sdk/agent/logicalTurn';
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

const TURN_COUNTERS: LogicalTurnRecord['counters'] = {
  segments: 1,
  modelCalls: 1,
  toolCalls: 0,
  providerRetries: 0,
  contextRecoveries: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  estimatedCostUsd: 0,
};

/** Stored shape `finish()` writes: `finalReply` plus absolute `binding.cwd`. */
function finishedTurn(
  id: string,
  sessionId: string,
  opts: {
    activeSessionId?: string;
    compactedSessionIds?: string[];
    finalReply: string;
    cwd: string;
  },
): LogicalTurnRecord {
  return {
    version: 1,
    logicalTurnId: id,
    sessionId,
    activeSessionId: opts.activeSessionId ?? sessionId,
    compactedSessionIds: opts.compactedSessionIds ?? [],
    binding: { provider: 'p', model: 'm', cwd: opts.cwd },
    bindingDigest: 'digest',
    logicalModelCallLimit: 10,
    status: 'completed',
    repeatedNoProgress: 0,
    runtimeContinuationIds: [],
    finalReply: opts.finalReply,
    finishReason: 'completed',
    counters: { ...TURN_COUNTERS },
    createdAt: 1,
    updatedAt: 2,
  };
}

function logicalTurnIds(db: SessionDb): string[] {
  return db.handle
    .query<{ logical_turn_id: string }, []>('SELECT logical_turn_id FROM logical_turns')
    .all()
    .map((row) => row.logical_turn_id);
}

function logicalTurnBlob(db: SessionDb): string {
  return db.handle
    .query<{ record: string }, []>('SELECT record FROM logical_turns')
    .all()
    .map((row) => row.record)
    .join('\n');
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

  test('removes logical turns for the session and its compacted children', () => {
    const db = open();
    const parent = db.createSession({ model: 'm', provider: 'p' });
    const child = db.createSession({ model: 'm', provider: 'p', parentSessionId: parent });
    const grandchild = db.createSession({ model: 'm', provider: 'p', parentSessionId: child });
    // Ordinary child (subagent), not a compaction. Its turn must stay.
    const subagent = db.createSession({ model: 'm', provider: 'p', parentSessionId: parent });
    const other = db.createSession({ model: 'm', provider: 'p' });
    db.recordCompactionLineage(parent, child);
    db.recordCompactionLineage(child, grandchild);

    const reply = 'secret final reply';
    const cwd = '/Users/secret/absolute-cwd';
    db.createLogicalTurn(finishedTurn('turn-parent', parent, { finalReply: reply, cwd }));
    // Admitted on the compacted child only — still part of the parent's lineage.
    db.createLogicalTurn(finishedTurn('turn-child', child, { finalReply: reply, cwd }));
    db.createLogicalTurn(
      finishedTurn('turn-span', parent, {
        activeSessionId: child,
        compactedSessionIds: [parent],
        finalReply: reply,
        cwd,
      }),
    );
    db.createLogicalTurn(
      finishedTurn('turn-grandchild', grandchild, {
        finalReply: 'grandchild reply',
        cwd: '/tmp/grandchild-cwd',
      }),
    );
    db.createLogicalTurn(
      finishedTurn('turn-subagent', subagent, {
        finalReply: 'subagent reply',
        cwd: '/tmp/subagent-cwd',
      }),
    );
    db.createLogicalTurn(
      finishedTurn('turn-other', other, { finalReply: 'keep this reply', cwd: '/tmp/keep-cwd' }),
    );
    // Malformed recovery JSON must not abort the session delete.
    db.handle.run('INSERT INTO logical_turns (logical_turn_id, record) VALUES (?, ?)', [
      'turn-corrupt',
      'not-json',
    ]);

    expect(db.deleteSession(parent)).toBe(true);

    expect(logicalTurnIds(db).sort()).toEqual(
      ['turn-corrupt', 'turn-grandchild', 'turn-other', 'turn-subagent'].sort(),
    );
    const blob = logicalTurnBlob(db);
    expect(blob).not.toContain(reply);
    expect(blob).not.toContain(cwd);
    expect(blob).toContain('keep this reply');
    expect(blob).toContain('/tmp/keep-cwd');
    // Compaction children are detached, not deleted. Their turns are still gone.
    expect(db.getSession(child)?.parentSessionId).toBeNull();
    expect(db.getSession(grandchild)).not.toBeNull();
    expect(db.getSession(subagent)?.parentSessionId).toBeNull();
    expect(db.getSession(other)).not.toBeNull();
    db.close();
  });

  test('deleting a compacted child removes that child turn but not the parent turn', () => {
    const db = open();
    const parent = db.createSession({ model: 'm', provider: 'p' });
    const child = db.createSession({ model: 'm', provider: 'p', parentSessionId: parent });
    db.recordCompactionLineage(parent, child);
    db.createLogicalTurn(
      finishedTurn('turn-parent', parent, {
        finalReply: 'parent reply',
        cwd: '/tmp/parent-cwd',
      }),
    );
    db.createLogicalTurn(
      finishedTurn('turn-child', child, {
        finalReply: 'child reply',
        cwd: '/tmp/child-cwd',
      }),
    );

    expect(db.deleteSession(child)).toBe(true);

    expect(logicalTurnIds(db)).toEqual(['turn-parent']);
    const blob = logicalTurnBlob(db);
    expect(blob).not.toContain('child reply');
    expect(blob).not.toContain('/tmp/child-cwd');
    expect(blob).toContain('parent reply');
    expect(blob).toContain('/tmp/parent-cwd');
    expect(db.getSession(parent)).not.toBeNull();
    db.close();
  });
});

describe('SessionDb kind sweeps delete logical turns', () => {
  const sweeps = [
    {
      kind: 'cron' as const,
      ageColumn: 'created_at',
      cleanup: (db: SessionDb) => db.cleanupOldCronSessions(),
    },
    {
      kind: 'channel' as const,
      ageColumn: 'last_updated',
      cleanup: (db: SessionDb) => db.cleanupOldChannelSessions(),
    },
  ];

  for (const sweep of sweeps) {
    test(`cleanup of stale ${sweep.kind} sessions removes their logical turns and compacted-child turns`, () => {
      const db = open();
      const parent = db.createSession({
        model: 'm',
        provider: 'p',
        metadata: { kind: sweep.kind },
      });
      // Fresh compacted child: the session row survives the sweep, the turn must not.
      const child = db.createSession({
        model: 'm',
        provider: 'p',
        parentSessionId: parent,
        metadata: { kind: sweep.kind },
      });
      const subagent = db.createSession({
        model: 'm',
        provider: 'p',
        parentSessionId: parent,
        metadata: { kind: sweep.kind },
      });
      const fresh = db.createSession({
        model: 'm',
        provider: 'p',
        metadata: { kind: sweep.kind },
      });
      db.recordCompactionLineage(parent, child);

      const reply = `stale ${sweep.kind} reply`;
      const cwd = `/Users/secret/${sweep.kind}-cwd`;
      db.createLogicalTurn(finishedTurn('turn-parent', parent, { finalReply: reply, cwd }));
      db.createLogicalTurn(finishedTurn('turn-child', child, { finalReply: reply, cwd }));
      db.createLogicalTurn(
        finishedTurn('turn-subagent', subagent, {
          finalReply: `${sweep.kind} subagent reply`,
          cwd: `/tmp/${sweep.kind}-subagent-cwd`,
        }),
      );
      db.createLogicalTurn(
        finishedTurn('turn-fresh', fresh, {
          finalReply: `fresh ${sweep.kind} reply`,
          cwd: `/tmp/${sweep.kind}-fresh-cwd`,
        }),
      );

      const staleSec = (Date.now() - 31 * 24 * 3_600_000) / 1000;
      db.handle
        .prepare(`UPDATE sessions SET ${sweep.ageColumn} = ? WHERE session_id = ?`)
        .run(staleSec, parent);

      expect(sweep.cleanup(db)).toBe(1);

      expect(db.getSession(parent)).toBeNull();
      expect(db.getSession(child)).not.toBeNull();
      expect(db.getSession(subagent)).not.toBeNull();
      expect(db.getSession(fresh)).not.toBeNull();
      expect(logicalTurnIds(db).sort()).toEqual(['turn-fresh', 'turn-subagent'].sort());
      const blob = logicalTurnBlob(db);
      expect(blob).not.toContain(reply);
      expect(blob).not.toContain(cwd);
      expect(blob).toContain(`fresh ${sweep.kind} reply`);
      expect(blob).toContain(`/tmp/${sweep.kind}-fresh-cwd`);
      db.close();
    });
  }
});

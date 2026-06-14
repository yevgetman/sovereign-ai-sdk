// Regression — audit H14 / findings #10 + #11.
//
// cleanupOldCronSessions and cleanupOldChannelSessions used to SELECT every
// stale session id, then DELETE FROM messages/session_compactions/sessions
// WHERE session_id IN (?,?,?,...) with one bound parameter per id. Once enough
// stale rows accrue, the placeholder list crosses SQLite's bound-parameter
// ceiling (SQLITE_MAX_VARIABLE_NUMBER — 999 on older builds, ~32766 on modern
// ones; the session_compactions clause doubles it via [...ids, ...ids]) and the
// statement throws `too many SQL variables`. These sweeps run UNCONDITIONALLY
// at every runtime / gateway boot, so the throw crashes boot in a loop — and
// the cleanup that would shrink the backlog can never run.
//
// The fix deletes via a correlated subquery (mirroring cleanupPhantomReviews),
// binding ONE parameter (the cutoff) regardless of row count, so the limit can
// never be hit. These tests assert (a) correctness at scale — only stale rows
// deleted, fresh kept — and (b) that the implementation builds NO growing
// IN(?,?,...) placeholder list (the load-bearing invariant the audit named).

import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { SessionDb } from '../../src/agent/sessionDb.js';

function openMem(): SessionDb {
  return SessionDb.open({ path: ':memory:' });
}

const STALE_OFFSET_SEC = (31 * 24 * 3_600_000) / 1000; // 31 days, past the 30-day default.

/** Insert `count` sessions of the given kind, half stale (past the window),
 *  half fresh, with one message each so the FK-dependent delete path is
 *  exercised. Ages cron rows by created_at, channel rows by last_updated
 *  (matching each sweep's own scoping). Returns the stale + fresh id lists. */
function seedSessions(
  db: SessionDb,
  kind: 'cron' | 'channel',
  count: number,
): { staleIds: string[]; freshIds: string[] } {
  const ageColumn = kind === 'cron' ? 'created_at' : 'last_updated';
  const nowSec = Date.now() / 1000;
  const staleSec = nowSec - STALE_OFFSET_SEC;
  const staleIds: string[] = [];
  const freshIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = db.createSession({ model: 'm', provider: 'p', metadata: { kind } });
    db.saveMessage(id, { role: 'user', content: [{ type: 'text', text: `hi ${i}` }] });
    const isStale = i % 2 === 0;
    db.handle
      .prepare(`UPDATE sessions SET ${ageColumn} = ? WHERE session_id = ?`)
      .run(isStale ? staleSec : nowSec, id);
    (isStale ? staleIds : freshIds).push(id);
  }
  return { staleIds, freshIds };
}

// Spy that records every SQL string passed to the live handle's run/query, so a
// test can assert no statement ever contains a multi-placeholder IN(?,?,...).
type SqlSpy = { sql: string[]; restore: () => void };
function spyOnSql(handle: Database): SqlSpy {
  const sql: string[] = [];
  const origRun = handle.run.bind(handle);
  const origQuery = handle.query.bind(handle);
  // biome-ignore lint/suspicious/noExplicitAny: test shim mirrors bun:sqlite signatures.
  (handle as any).run = (text: string, ...rest: any[]) => {
    sql.push(text);
    return origRun(text, ...(rest as []));
  };
  // biome-ignore lint/suspicious/noExplicitAny: test shim mirrors bun:sqlite signatures.
  (handle as any).query = (text: string, ...rest: any[]) => {
    sql.push(text);
    // biome-ignore lint/suspicious/noExplicitAny: pass-through.
    return (origQuery as any)(text, ...rest);
  };
  return {
    sql,
    restore: () => {
      // biome-ignore lint/suspicious/noExplicitAny: undo the shim.
      (handle as any).run = origRun;
      // biome-ignore lint/suspicious/noExplicitAny: undo the shim.
      (handle as any).query = origQuery;
    },
  };
}

// A multi-placeholder IN-list: `IN (?,?` or `IN (?, ?` — the unbounded pattern.
const GROWING_IN_LIST_RE = /IN\s*\(\s*\?\s*,\s*\?/i;

describe('cleanup sweeps avoid the bound-parameter limit (H14 / #10 #11)', () => {
  let db: SessionDb;

  beforeEach(() => {
    db = openMem();
  });

  afterEach(() => {
    db.close();
  });

  test('cleanupOldCronSessions deletes all stale rows at scale, keeps fresh', () => {
    const { staleIds, freshIds } = seedSessions(db, 'cron', 600);

    const cleaned = db.cleanupOldCronSessions();

    expect(cleaned).toBe(staleIds.length);
    for (const id of staleIds) expect(db.getSession(id)).toBeNull();
    for (const id of freshIds) expect(db.getSession(id)).not.toBeNull();
  });

  test('cleanupOldChannelSessions deletes all stale rows at scale, keeps fresh', () => {
    const { staleIds, freshIds } = seedSessions(db, 'channel', 600);

    const cleaned = db.cleanupOldChannelSessions();

    expect(cleaned).toBe(staleIds.length);
    for (const id of staleIds) expect(db.getSession(id)).toBeNull();
    for (const id of freshIds) expect(db.getSession(id)).not.toBeNull();
  });

  test('cleanupOldCronSessions builds NO growing IN(?,?,...) placeholder list', () => {
    seedSessions(db, 'cron', 200);
    const spy = spyOnSql(db.handle);
    try {
      db.cleanupOldCronSessions();
    } finally {
      spy.restore();
    }
    const offenders = spy.sql.filter((s) => GROWING_IN_LIST_RE.test(s));
    expect(offenders).toEqual([]);
  });

  test('cleanupOldChannelSessions builds NO growing IN(?,?,...) placeholder list', () => {
    seedSessions(db, 'channel', 200);
    const spy = spyOnSql(db.handle);
    try {
      db.cleanupOldChannelSessions();
    } finally {
      spy.restore();
    }
    const offenders = spy.sql.filter((s) => GROWING_IN_LIST_RE.test(s));
    expect(offenders).toEqual([]);
  });

  test('cleanupOldCronSessions also clears session_compactions for stale rows', () => {
    const parent = db.createSession({ model: 'm', provider: 'p', metadata: { kind: 'cron' } });
    const child = db.createSession({ model: 'm', provider: 'p', metadata: { kind: 'cron' } });
    db.recordCompactionLineage(parent, child);
    const staleSec = Date.now() / 1000 - STALE_OFFSET_SEC;
    db.handle.prepare('UPDATE sessions SET created_at = ?').run(staleSec);

    db.cleanupOldCronSessions();

    const remaining = db.handle.prepare('SELECT COUNT(*) AS n FROM session_compactions').get() as {
      n: number;
    };
    expect(remaining.n).toBe(0);
  });

  test('cleanupOldChannelSessions also clears session_compactions for stale rows', () => {
    const parent = db.createSession({ model: 'm', provider: 'p', metadata: { kind: 'channel' } });
    const child = db.createSession({ model: 'm', provider: 'p', metadata: { kind: 'channel' } });
    db.recordCompactionLineage(parent, child);
    const staleSec = Date.now() / 1000 - STALE_OFFSET_SEC;
    db.handle.prepare('UPDATE sessions SET last_updated = ?').run(staleSec);

    db.cleanupOldChannelSessions();

    const remaining = db.handle.prepare('SELECT COUNT(*) AS n FROM session_compactions').get() as {
      n: number;
    };
    expect(remaining.n).toBe(0);
  });
});

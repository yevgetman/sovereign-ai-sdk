// Persistent session store — bun:sqlite with WAL mode, FTS5 search,
// schema-versioned migrations, and a jittered retry wrapper for future
// multi-writer contention (CLI + cron + gateway in Phases 16/17).
//
// Phase 3.5 scope: schema v1 (sessions + messages + FTS + triggers).
// Phase 8: schema v2 adds session-level token/cost accounting for /cost.
// Phase 10: schema v3 adds immutable compaction lineage and separate compaction cost lanes.
// Storage-side of Invariant #4 — the `sessions.system_prompt` column
// holds the frozen prompt verbatim; Phase 6 enforces the actually-reuse-it
// behavior (cache-hit discipline).
//
// Explicit non-goals for Phase 3.5:
//   • retention / cleanup — sessions grow unbounded in v0.x
//   • per-tenant scoping — Phase 15 profile system + $HARNESS_HOME
//
// bun:sqlite is synchronous by design — no async wrapping. The retry
// wrapper uses Bun.sleepSync between attempts. Phase 16 may add an async
// mirror of writeWithRetry when the gateway lands.
//
// Source of pattern: Hermes hermes_state.py:164–200 (WAL + jittered retry
// + checkpoint-every-N). Structurally parallel to Claude Code's session
// persistence layer.

import { Database, SQLiteError } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  LogicalTurnLeaseError,
  type LogicalTurnRecord,
  type LogicalTurnStore,
  assertLogicalTurnWriteLease,
} from '@yevgetman/sov-sdk/agent/logicalTurn';
import { resolveHarnessHome } from '@yevgetman/sov-sdk/config/paths';
import type {
  CreateSessionInput,
  SaveMessageInput,
  Session,
  SessionCost,
  SessionListEntry,
  StoredMessage,
} from '@yevgetman/sov-sdk/core/sessionPort';
import type { ContentBlock, SystemSegment, TokenUsage } from '@yevgetman/sov-sdk/core/types';
import type { SessionStore, ToolExecution } from '@yevgetman/sov-sdk/persistence/sessionStore';
import { type CostEstimate, estimateUsageCost } from '@yevgetman/sov-sdk/providers/pricing';

/** The row exists, but its JSON is not a logical-turn record. */
export class LogicalTurnRecordError extends Error {
  readonly code = 'recovery_state_invalid' as const;

  constructor() {
    super('logical turn recovery state is invalid');
    this.name = 'LogicalTurnRecordError';
  }
}

/** Default DB path. Resolved at call time so a profile-aware
 *  HARNESS_HOME (set by `sov -p name` before imports) lands the DB
 *  under the right profile root. Phase 10.7 — Invariant #11. */
export function getDefaultDbPath(): string {
  return join(resolveHarnessHome(), 'sessions.db');
}

/** @deprecated Eager const captured in import-order; profile-aware
 *  callers should use `getDefaultDbPath()` instead. Retained as a
 *  back-compat shim for tests that reference it directly. */
export const DEFAULT_DB_PATH = join(resolveHarnessHome(), 'sessions.db');

const CURRENT_SCHEMA_VERSION = 9;

type Migration = { from: number; to: number; sql: string };

const MIGRATIONS: Migration[] = [
  {
    from: 8,
    to: 9,
    sql: `CREATE TABLE IF NOT EXISTS logical_turns (
      logical_turn_id TEXT PRIMARY KEY,
      record TEXT NOT NULL,
      lease_owner TEXT,
      lease_expires_at REAL
    );`,
  },
  {
    from: 7,
    to: 8,
    sql: `CREATE TABLE tool_executions (
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      assistant_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      tool_use_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('started', 'completed', 'interrupted', 'unknown')),
      receipt TEXT NOT NULL,
      PRIMARY KEY (session_id, assistant_message_id, tool_use_id)
    );`,
  },
  {
    from: 6,
    to: 7,
    sql: `CREATE TABLE skill_continuity (
      profile TEXT NOT NULL,
      owner TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      records TEXT NOT NULL CHECK (length(CAST(records AS BLOB)) <= 524288),
      PRIMARY KEY (profile, owner, session_id)
    );`,
  },
  {
    from: 5,
    to: 6,
    sql: `ALTER TABLE sessions ADD COLUMN cost_complete INTEGER NOT NULL DEFAULT 1;
      UPDATE sessions SET cost_complete = 0 WHERE input_tokens + output_tokens +
        cache_creation_input_tokens + cache_read_input_tokens +
        compaction_input_tokens + compaction_output_tokens > 0 OR
        EXISTS (SELECT 1 FROM messages WHERE messages.session_id = sessions.session_id);
      CREATE TABLE usage_estimates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        usage TEXT NOT NULL, estimate TEXT NOT NULL
      );`,
  },
  {
    from: 0,
    to: 1,
    sql: `
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        parent_session_id TEXT,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        platform TEXT NOT NULL,
        created_at REAL NOT NULL,
        last_updated REAL NOT NULL,
        title TEXT,
        system_prompt TEXT,
        schema_version INTEGER NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_sessions_last_updated ON sessions(last_updated DESC);

      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_call_id TEXT,
        tool_calls TEXT,
        token_count INTEGER DEFAULT 0,
        created_at REAL NOT NULL
      );
      CREATE INDEX idx_messages_session ON messages(session_id, id);

      CREATE VIRTUAL TABLE messages_fts USING fts5(
        content,
        content='messages',
        content_rowid='id'
      );

      CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
      END;
      CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `,
  },
  {
    from: 1,
    to: 2,
    sql: `
      ALTER TABLE sessions ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN cache_read_input_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN estimated_cost_usd REAL NOT NULL DEFAULT 0;
    `,
  },
  {
    from: 2,
    to: 3,
    sql: `
      ALTER TABLE sessions ADD COLUMN compaction_input_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN compaction_output_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN estimated_compaction_cost_usd REAL NOT NULL DEFAULT 0;

      CREATE TABLE session_compactions (
        parent_session_id TEXT NOT NULL REFERENCES sessions(session_id),
        child_session_id TEXT NOT NULL REFERENCES sessions(session_id),
        created_at REAL NOT NULL,
        PRIMARY KEY (parent_session_id, child_session_id)
      );
      CREATE INDEX idx_session_compactions_parent ON session_compactions(parent_session_id, created_at);
    `,
  },
  {
    from: 3,
    to: 4,
    sql: `
      CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        child_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
        agent TEXT NOT NULL,
        prompt TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued','running','completed','failed','cancelled','timed_out')),
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        trace_id TEXT,
        result_preview TEXT
      );
      CREATE INDEX idx_tasks_parent_session ON tasks(parent_session_id, created_at);
      CREATE INDEX idx_tasks_state ON tasks(state);
    `,
  },
  {
    // Phase E — per-principal session ownership for the multi-user gateway.
    // Nullable: pre-existing rows + non-gateway surfaces (CLI/cron) leave it
    // null. The composite index backs owner-scoped newest-first listing.
    from: 4,
    to: 5,
    sql: `
      ALTER TABLE sessions ADD COLUMN owner_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_id, last_updated DESC);
    `,
  },
];

// Retry + checkpoint tuning. Match Hermes within reason; tune under load
// if the gateway/cron contention surfaces convoy sleep in the wild.
const BUSY_TIMEOUT_MS = 1000;
const MAX_RETRIES = 15;
const JITTER_MIN_MS = 20;
const JITTER_MAX_MS = 150;
const WAL_CHECKPOINT_EVERY = 50;

/** Options for opening the SQLite session database. */
export type OpenDbOpts = {
  /** Filesystem path; ':memory:' for tests. Default DEFAULT_DB_PATH. */
  path?: string;
};

// `CreateSessionInput`, `SaveMessageInput`, `StoredMessage`, `Session`,
// `SessionCost`, and `SessionListEntry` now live in open core
// (`core/sessionPort.js`) so the open command contract (`CommandContext`) and
// the open `SessionStore` port (`persistence/sessionStore.js`) can reference
// them without importing this proprietary bun:sqlite store. Re-exported here for
// existing importers (single source of truth).
export type {
  CreateSessionInput,
  SaveMessageInput,
  Session,
  SessionCost,
  SessionListEntry,
  StoredMessage,
};

/** M8 T7 — snapshot for the `session_summary` SSE event's extended payload.
 *  Token fields fold chat + compaction lanes into the single goodbye-card
 *  view; tool counts come from a scan of persisted message content (v1
 *  trade-off — no JSON1 dependency). Returned by `getSessionMetrics`. */
export type SessionMetricsSnapshot = {
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    estimatedCostUsd: number;
  };
  toolCalls: number;
  toolOk: number;
  toolErr: number;
};

export type SessionCompaction = {
  parentSessionId: string;
  childSessionId: string;
  createdAt: number;
};

export type SearchOpts = {
  sessionId?: string;
  limit?: number;
};

// `SessionDb implements SessionStore` (Task 2.1) declares structural
// conformance to the open turn/history-persistence port — the narrow subset the
// open SDK persists through (lifecycle + save/load messages + recordTokenUsage).
// The admin/search/routing/cleanup surface and the raw `handle` getter stay on
// the concrete class, off the port. The `implements` clause makes a future drift
// (a port method's signature changing on SessionDb) a typecheck failure.
export class SessionDb implements SessionStore, LogicalTurnStore {
  private writeCount = 0;

  constructor(private readonly db: Database) {}

  static open(opts: OpenDbOpts = {}): SessionDb {
    const path = opts.path ?? getDefaultDbPath();
    if (path !== ':memory:') ensureParentDir(path);
    const db = new Database(path, { create: true });
    // WAL doesn't apply to :memory: (no journal file), but set anyway — SQLite
    // silently ignores when inapplicable. busy_timeout is a short hint; the
    // application-level retry does the heavy lifting.
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
    db.exec('PRAGMA foreign_keys = ON;');
    applyPendingMigrations(db);
    return new SessionDb(db);
  }

  /** Underlying SQLite handle. Exposed so colocated tables (Phase 13.2
   *  tasks, future Phase 13.3 review pending rows) can share the same
   *  connection — bun:sqlite is single-writer per file with WAL, and
   *  reusing the WAL/busy_timeout/foreign_keys PRAGMAs the constructor
   *  already set is cheaper than opening a parallel handle. Callers
   *  MUST treat the handle as borrowed: do not close it; SessionDb.close()
   *  owns lifecycle. */
  get handle(): Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  createLogicalTurn(record: LogicalTurnRecord): void {
    this.writeWithRetry(() =>
      this.db.run('INSERT INTO logical_turns (logical_turn_id, record) VALUES (?, ?)', [
        record.logicalTurnId,
        JSON.stringify(record),
      ]),
    );
  }

  loadLogicalTurn(logicalTurnId: string): LogicalTurnRecord | null {
    const row = this.db
      .query<{ record: string }, [string]>(
        'SELECT record FROM logical_turns WHERE logical_turn_id = ?',
      )
      .get(logicalTurnId);
    // A missing row stays null. Corrupt JSON is invalid recovery state, not a provider failure.
    if (!row) return null;
    return parseLogicalTurnRecord(row.record, logicalTurnId);
  }

  saveLogicalTurn(record: LogicalTurnRecord, owner: string): void {
    const changes = this.writeWithRetry(
      () =>
        this.db.run(
          'UPDATE logical_turns SET record = ? WHERE logical_turn_id = ? AND lease_owner = ?',
          [JSON.stringify(record), record.logicalTurnId, owner],
        ).changes ?? 0,
    );
    if (changes === 1) return;
    const existing = this.db
      .query<{ logical_turn_id: string }, [string]>(
        'SELECT logical_turn_id FROM logical_turns WHERE logical_turn_id = ?',
      )
      .get(record.logicalTurnId);
    if (!existing) throw new Error('logical turn does not exist');
    throw new LogicalTurnLeaseError();
  }

  readLogicalTurnLease(id: string): { owner: string | null; expiresAt: number | null } | null {
    const row = this.db
      .query<{ lease_owner: string | null; lease_expires_at: number | null }, [string]>(
        'SELECT lease_owner, lease_expires_at FROM logical_turns WHERE logical_turn_id = ?',
      )
      .get(id);
    if (!row) return null;
    return { owner: row.lease_owner, expiresAt: row.lease_expires_at };
  }

  acquireLogicalTurnLease(id: string, owner: string, expiresAt: number, now: number): boolean {
    const changes = this.writeWithRetry(
      () =>
        this.db.run(
          `UPDATE logical_turns SET lease_owner = ?, lease_expires_at = ?
           WHERE logical_turn_id = ? AND
             (lease_owner IS NULL OR lease_owner = ? OR lease_expires_at <= ?)`,
          [owner, expiresAt, id, owner, now],
        ).changes ?? 0,
    );
    return changes === 1;
  }

  renewLogicalTurnLease(id: string, owner: string, expiresAt: number): boolean {
    const changes = this.writeWithRetry(
      () =>
        this.db.run(
          `UPDATE logical_turns SET lease_owner = ?, lease_expires_at = ?
           WHERE logical_turn_id = ? AND lease_owner = ?`,
          [owner, expiresAt, id, owner],
        ).changes ?? 0,
    );
    return changes === 1;
  }

  releaseLogicalTurnLease(id: string, owner: string): void {
    this.writeWithRetry(() =>
      this.db.run(
        `UPDATE logical_turns SET lease_owner = NULL, lease_expires_at = NULL
         WHERE logical_turn_id = ? AND lease_owner = ?`,
        [id, owner],
      ),
    );
  }

  /** Phase 13.3 follow-up — delete phantom review-fork session rows.
   *  Phantom = subagent:review-* with zero tokens, zero messages, older
   *  than maxAgeMs. These come from B4 aborting reviews mid-dispatch
   *  before the AgentRunner streams. Returns count of deleted rows.
   *
   *  Called during session boot so the DB doesn't grow indefinitely.
   *  The 1-hour default leaves any still-active review alone.
   *
   *  created_at is stored as Unix epoch seconds (Date.now() / 1000). */
  cleanupPhantomReviews(maxAgeMs = 3_600_000): number {
    const cutoffSec = (Date.now() - maxAgeMs) / 1000;
    // Runs unconditionally at runtime boot; cron + the OpenAI server now share
    // this DB file, so a concurrent writer can hold the WAL lock past the
    // busy_timeout. Wrap in writeWithRetry (matching cleanupOldCronSessions) so
    // a transient SQLITE_BUSY/SQLITE_LOCKED is retried instead of aborting boot.
    return this.writeWithRetry(() => {
      const result = this.db
        .prepare(
          `DELETE FROM sessions
           WHERE title LIKE 'subagent:review-%'
             AND (input_tokens + output_tokens) = 0
             AND (SELECT COUNT(*) FROM messages WHERE session_id = sessions.session_id) = 0
             AND created_at < ?`,
        )
        .run(cutoffSec);
      return result.changes ?? 0;
    });
  }

  /** Phase 17 follow-up — sweep cron-job sessions older than maxAgeMs.
   *  Each cron run creates a fresh session row (see src/cron/wiring.ts:98);
   *  a job firing every minute adds ~43k rows/month. The 30-day default
   *  keeps the last month of runs available for debugging while preventing
   *  unbounded growth.
   *
   *  Uses json_extract on metadata.kind — strict (no false positives from
   *  titles that happen to contain "cron"). messages and session_compactions
   *  reference sessions without ON DELETE CASCADE (PRAGMA foreign_keys = ON
   *  is enabled), so dependent rows must be removed first. tasks already
   *  CASCADE / SET NULL via migration 3→4.
   *
   *  Deletes via a CORRELATED SUBQUERY (mirroring cleanupPhantomReviews) — each
   *  DELETE binds ONE parameter (the cutoff), never a per-id placeholder list,
   *  so SQLite's bound-parameter ceiling (audit H14) can never be hit no matter
   *  how many stale rows have accrued. Returns the number of session rows
   *  deleted. Called during runtime boot. */
  cleanupOldCronSessions(maxAgeMs = 30 * 24 * 3_600_000): number {
    return this.deleteSessionsByKind('cron', 'created_at', maxAgeMs);
  }

  /** Fix F6 — sweep channel sessions whose LAST ACTIVITY is older than maxAgeMs.
   *  Channel sessions (kind:'channel') are created per-(channel,sender) with
   *  deterministic colon-ids that are REUSED forever and are NOT REST-deletable
   *  (a colon-id fails isValidSessionId), so without this sweep their rows +
   *  messages + trajectories grow unbounded over months of real channel use.
   *
   *  Ages by `last_updated` (NOT created_at like the cron sweep): a channel
   *  session is touched on every turn, so a long-lived chat that was active
   *  recently must NOT be reaped — only one idle past the window is. The 30-day
   *  default keeps a month of inactive conversations recoverable.
   *
   *  Strictly scoped via json_extract(metadata,'$.kind') = 'channel' (no false
   *  positives from titles). messages + session_compactions reference sessions
   *  WITHOUT ON DELETE CASCADE (PRAGMA foreign_keys = ON), so dependent rows are
   *  removed first; tasks CASCADE / SET NULL via migration 3→4. Wrapped in
   *  writeWithRetry (matching the cron sweep) so a transient SQLITE_BUSY from a
   *  concurrent writer is retried.
   *
   *  Deletes via a CORRELATED SUBQUERY (mirroring cleanupPhantomReviews) — each
   *  DELETE binds ONE parameter (the cutoff), never a per-id placeholder list,
   *  so a flood of untrusted channel senders can never push the sweep past
   *  SQLite's bound-parameter ceiling (audit H14). Returns the number of
   *  session rows deleted. */
  cleanupOldChannelSessions(maxAgeMs = 30 * 24 * 3_600_000): number {
    return this.deleteSessionsByKind('channel', 'last_updated', maxAgeMs);
  }

  /** Shared sweep for kind-tagged sessions older than maxAgeMs. Deletes the
   *  dependent rows (messages, session_compactions) then the session rows, all
   *  via a CORRELATED SUBQUERY keyed on a single cutoff parameter — so the
   *  number of stale rows is irrelevant to the bound-parameter budget (audit
   *  H14 / findings #10, #11). `ageColumn` is a fixed internal literal (never
   *  caller input): 'created_at' for cron (each run is a fresh row) or
   *  'last_updated' for channels (touched on every turn, so a recently-active
   *  chat survives). Wrapped in writeWithRetry for SQLITE_BUSY resilience. */
  private deleteSessionsByKind(
    kind: 'cron' | 'channel',
    ageColumn: 'created_at' | 'last_updated',
    maxAgeMs: number,
  ): number {
    const cutoffSec = (Date.now() - maxAgeMs) / 1000;
    const staleSelect = `SELECT session_id FROM sessions
       WHERE json_extract(metadata, '$.kind') = '${kind}'
         AND ${ageColumn} < ?`;
    return this.writeWithRetry(() => {
      const run = this.db.transaction((): number => {
        this.db.run(`DELETE FROM messages WHERE session_id IN (${staleSelect})`, [cutoffSec]);
        this.db.run(
          `DELETE FROM session_compactions
           WHERE parent_session_id IN (${staleSelect})
              OR child_session_id IN (${staleSelect})`,
          [cutoffSec, cutoffSec],
        );
        const result = this.db.run(`DELETE FROM sessions WHERE session_id IN (${staleSelect})`, [
          cutoffSec,
        ]);
        return result.changes ?? 0;
      });
      return run();
    });
  }

  /** Phase D — permanently remove a single session and every dependent row.
   *  FK policy: `messages` + `session_compactions` reference sessions WITHOUT
   *  ON DELETE CASCADE (PRAGMA foreign_keys = ON), so their rows are deleted
   *  manually first; `tasks` CASCADEs / SET NULLs automatically (migration
   *  3→4); child sessions (`sessions.parent_session_id` — an undeclared FK
   *  column) are DETACHED (set NULL), never recursively deleted — they are
   *  independent rows. Wrapped in a transaction so a partial delete can't
   *  leave a FK violation. Returns true iff the session row existed and was
   *  removed (idempotent: a missing or already-deleted id returns false). */
  deleteSession(sessionId: string): boolean {
    return this.writeWithRetry(() => {
      const run = this.db.transaction((): boolean => {
        // Detach child sessions first: null their parent pointer so the
        // forthcoming parent-row delete leaves no dangling lineage.
        this.db.run('UPDATE sessions SET parent_session_id = NULL WHERE parent_session_id = ?', [
          sessionId,
        ]);
        // Dependent rows without ON DELETE CASCADE — remove before the parent.
        // The messages AFTER DELETE trigger keeps messages_fts in sync.
        this.db.run('DELETE FROM messages WHERE session_id = ?', [sessionId]);
        this.db.run(
          'DELETE FROM session_compactions WHERE parent_session_id = ? OR child_session_id = ?',
          [sessionId, sessionId],
        );
        // tasks CASCADE (parent) / SET NULL (child) automatically.
        const result = this.db.run('DELETE FROM sessions WHERE session_id = ?', [sessionId]);
        return (result.changes ?? 0) > 0;
      });
      return run();
    });
  }

  /**
   * Returns the routing-atom session rows belonging to the smart-router
   * delegation that originated from `parentSessionId`. Walks: root → its
   * `routing-delegator` child → atoms whose `parentDelegatorSessionId`
   * matches that delegator.
   *
   * Returns rows in created_at ascending order (atom dispatch order).
   *
   * Phase 2 T8 for `/routing-stats`.
   */
  listRoutingAtomsByParent(parentSessionId: string): Session[] {
    const rows = this.db
      .query<SessionRow, [string]>(
        `SELECT session_id, parent_session_id, model, provider, platform,
                created_at, last_updated, title, system_prompt,
                schema_version, metadata, owner_id,
                input_tokens, output_tokens, cache_creation_input_tokens,
                cache_read_input_tokens, estimated_cost_usd,
                compaction_input_tokens, compaction_output_tokens,
                estimated_compaction_cost_usd
         FROM sessions
         WHERE json_extract(metadata, '$.kind') = 'routing-atom'
           AND json_extract(metadata, '$.parentDelegatorSessionId') IN (
             SELECT session_id FROM sessions
             WHERE parent_session_id = ?
               AND json_extract(metadata, '$.kind') = 'routing-delegator'
           )
         ORDER BY created_at ASC`,
      )
      .all(parentSessionId);
    return rows.map((r) => rowToSession(r));
  }

  /**
   * Returns ALL routing-atom rows across the database in created_at ascending
   * order. Used by `/routing-stats --all`.
   *
   * Phase 2 T8 for `/routing-stats`.
   */
  listRoutingAtomsAll(): Session[] {
    const rows = this.db
      .query<SessionRow, []>(
        `SELECT session_id, parent_session_id, model, provider, platform,
                created_at, last_updated, title, system_prompt,
                schema_version, metadata, owner_id,
                input_tokens, output_tokens, cache_creation_input_tokens,
                cache_read_input_tokens, estimated_cost_usd,
                compaction_input_tokens, compaction_output_tokens,
                estimated_compaction_cost_usd
         FROM sessions
         WHERE json_extract(metadata, '$.kind') = 'routing-atom'
         ORDER BY created_at ASC`,
      )
      .all();
    return rows.map((r) => rowToSession(r));
  }

  /**
   * Returns routing-atom rows whose OWNING principal is `owner`, in created_at
   * ascending order. Phase E owner-scoped variant of {@link listRoutingAtomsAll}:
   * `/routing-stats --all` on the multi-user gateway must aggregate only the
   * calling principal's atoms, never every principal's. Single-user / legacy
   * callers keep using {@link listRoutingAtomsAll} (no owner to scope by).
   */
  listRoutingAtomsAllByOwner(owner: string): Session[] {
    const rows = this.db
      .query<SessionRow, [string]>(
        `SELECT session_id, parent_session_id, model, provider, platform,
                created_at, last_updated, title, system_prompt,
                schema_version, metadata, owner_id,
                input_tokens, output_tokens, cache_creation_input_tokens,
                cache_read_input_tokens, estimated_cost_usd,
                compaction_input_tokens, compaction_output_tokens,
                estimated_compaction_cost_usd
         FROM sessions
         WHERE json_extract(metadata, '$.kind') = 'routing-atom'
           AND owner_id = ?
         ORDER BY created_at ASC`,
      )
      .all(owner);
    return rows.map((r) => rowToSession(r));
  }

  createSession(input: CreateSessionInput): string {
    const sessionId = input.sessionId ?? randomUUID();
    const now = Date.now() / 1000;
    const systemPromptJson =
      input.systemPrompt !== undefined ? JSON.stringify(input.systemPrompt) : null;
    const metadataJson = JSON.stringify(input.metadata ?? {});
    this.writeWithRetry(() =>
      this.db.transaction(() => {
        this.db.run(
          `INSERT INTO sessions (
          session_id, parent_session_id, model, provider, platform,
          created_at, last_updated, title, system_prompt,
          schema_version, metadata, owner_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            sessionId,
            input.parentSessionId ?? null,
            input.model,
            input.provider,
            input.platform ?? 'cli',
            now,
            now,
            input.title ?? null,
            systemPromptJson,
            CURRENT_SCHEMA_VERSION,
            metadataJson,
            input.owner ?? null,
          ],
        );
        // Freeze private guidance with the child's creation, before a parent
        // activation can change. Turn lifetimes and tool authority do not transfer.
        if (input.parentSessionId !== undefined) {
          const parent = this.getSession(input.parentSessionId);
          if (parent !== null && parent.ownerId === (input.owner ?? null)) {
            const snapshots = this.db
              .query<{ profile: string; owner: string; records: string }, [string]>(
                'SELECT profile, owner, records FROM skill_continuity WHERE session_id = ?',
              )
              .all(parent.sessionId);
            for (const snapshot of snapshots) {
              if (snapshot.owner !== skillContinuityOwnerKey(parent.ownerId)) continue;
              const inherited = nonTurnSkillContinuitySnapshot(snapshot.records);
              this.db.run(
                'INSERT INTO skill_continuity (profile, owner, session_id, records) VALUES (?, ?, ?, ?)',
                [snapshot.profile, snapshot.owner, sessionId, inherited],
              );
            }
          }
        }
      })(),
    );
    return sessionId;
  }

  /** Private bounded workflow state, deliberately absent from Session.metadata,
   *  public session projections and transcript search. Ownership comes from the
   *  persisted row and is checked again at every read/write boundary. */
  loadSkillContinuity(profile: string, owner: string, sessionId: string): string | null {
    if (profile.length === 0 || profile.length > 512)
      throw new Error('invalid skill continuity scope');
    this.assertSkillContinuityOwner(owner, sessionId);
    return (
      this.db
        .query<{ records: string }, [string, string, string]>(
          'SELECT records FROM skill_continuity WHERE profile = ? AND owner = ? AND session_id = ?',
        )
        .get(profile, owner, sessionId)?.records ?? null
    );
  }

  saveSkillContinuity(profile: string, owner: string, sessionId: string, records: string): void {
    if (
      profile.length === 0 ||
      profile.length > 512 ||
      Buffer.byteLength(records, 'utf8') > 524288
    ) {
      throw new Error('invalid skill continuity snapshot');
    }
    this.writeWithRetry(() =>
      this.db.transaction(() => {
        this.assertSkillContinuityOwner(owner, sessionId);
        this.db.run(
          `INSERT INTO skill_continuity (profile, owner, session_id, records) VALUES (?, ?, ?, ?)
        ON CONFLICT(profile, owner, session_id) DO UPDATE SET records = excluded.records`,
          [profile, owner, sessionId, records],
        );
      })(),
    );
  }

  private assertSkillContinuityOwner(owner: string, sessionId: string): void {
    const session = this.getSession(sessionId);
    if (session === null || skillContinuityOwnerKey(session.ownerId) !== owner) {
      throw new Error('skill continuity session unavailable');
    }
  }

  /** Phase 18 T8 — idempotent session creation. Returns the row's
   *  session_id; if `input.sessionId` is supplied and already present in
   *  the DB, this is a no-op and the existing id is returned. Otherwise
   *  the row is created (with the supplied id, or a fresh UUID).
   *
   *  Used by the OpenAI-compatible /v1/chat/completions surface to honor
   *  client-supplied X-Session-Id without crashing on the second use of
   *  the same id. The metadata + system prompt from the FIRST call are
   *  preserved on subsequent calls — we don't overwrite the row's
   *  configuration once it's been seeded. */
  upsertSession(input: CreateSessionInput): string {
    if (input.sessionId !== undefined) {
      const existing = this.getSession(input.sessionId);
      if (existing !== null) {
        return existing.sessionId;
      }
    }
    return this.createSession(input);
  }

  saveMessage(sessionId: string, msg: SaveMessageInput): number {
    assertLogicalTurnWriteLease();
    const now = Date.now() / 1000;
    const contentJson = JSON.stringify(msg.content);
    const toolCallsJson = msg.toolCalls !== undefined ? JSON.stringify(msg.toolCalls) : null;
    return this.writeWithRetry(() => {
      const insert = this.db.prepare(
        `INSERT INTO messages (
          session_id, role, content, tool_call_id, tool_calls, token_count, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      );
      const row = insert.get(
        sessionId,
        msg.role,
        contentJson,
        msg.toolCallId ?? null,
        toolCallsJson,
        msg.tokenCount ?? 0,
        now,
      ) as { id: number } | null;
      this.db.run('UPDATE sessions SET last_updated = ? WHERE session_id = ?', [now, sessionId]);
      return row?.id ?? -1;
    });
  }

  loadMessages(sessionId: string): StoredMessage[] {
    const rows = this.db
      .query<StoredRow, [string]>(
        `SELECT id, session_id, role, content, tool_call_id, tool_calls, token_count, created_at
         FROM messages
         WHERE session_id = ?
         ORDER BY id ASC`,
      )
      .all(sessionId);
    return rows.map(rowToMessage);
  }

  /** Keep the first `keep` messages and drop the rest. The messages DELETE
   *  trigger keeps the search index in step. */
  saveToolExecution(sessionId: string, execution: ToolExecution): void {
    assertLogicalTurnWriteLease();
    this.writeWithRetry(() => {
      this.db.run(
        `INSERT INTO tool_executions (session_id, assistant_message_id, tool_use_id, state, receipt)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id, assistant_message_id, tool_use_id)
        DO UPDATE SET state = excluded.state, receipt = excluded.receipt
        WHERE tool_executions.state != 'completed' OR excluded.state = 'completed'`,
        [
          sessionId,
          execution.assistantMessageId,
          execution.toolUseId,
          execution.state,
          JSON.stringify(execution),
        ],
      );
    });
  }

  loadToolExecutions(sessionId: string): ToolExecution[] {
    return this.db
      .query<{ receipt: string }, [string]>(
        'SELECT receipt FROM tool_executions WHERE session_id = ? ORDER BY assistant_message_id, rowid',
      )
      .all(sessionId)
      .map((row) => JSON.parse(row.receipt) as ToolExecution);
  }

  truncateMessages(sessionId: string, keep: number): void {
    assertLogicalTurnWriteLease();
    const retain = keep > 0 ? Math.floor(keep) : 0;
    this.writeWithRetry(() => {
      this.db.run(
        `DELETE FROM messages
         WHERE session_id = ?
           AND id NOT IN (
             SELECT id FROM (
               SELECT id FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT ?
             )
           )`,
        [sessionId, sessionId, retain],
      );
    });
  }

  /** Recent sessions for the `/resume` picker. Ordered newest-first by
   *  `last_updated`. Title falls back to the first user message body
   *  (truncated) when the row's `title` column is null — matches what
   *  Claude Code shows in its session picker. msgCount and totalCost
   *  come from cheap aggregates. */
  listSessions(limit = 20, owner?: string): SessionListEntry[] {
    const ownerClause = owner !== undefined ? 'WHERE s.owner_id = ?' : '';
    // Param order mirrors the placeholder order: owner (if filtering) before limit.
    const params: (string | number)[] = owner !== undefined ? [owner, limit] : [limit];
    const rows = this.db
      .query<SessionListRow, (string | number)[]>(
        `SELECT s.session_id, s.parent_session_id, s.model, s.provider, s.platform,
                s.created_at, s.last_updated, s.title, s.owner_id,
                s.input_tokens + s.output_tokens + s.cache_creation_input_tokens
                  + s.cache_read_input_tokens + s.compaction_input_tokens
                  + s.compaction_output_tokens AS total_tokens,
                s.estimated_cost_usd + s.estimated_compaction_cost_usd AS total_cost_usd, s.cost_complete,
                (SELECT COUNT(*) FROM messages WHERE session_id = s.session_id) AS msg_count,
                (SELECT content FROM messages
                  WHERE session_id = s.session_id AND role = 'user'
                  ORDER BY id ASC LIMIT 1) AS first_user_content
         FROM sessions s
         ${ownerClause}
         ORDER BY s.last_updated DESC
         LIMIT ?`,
      )
      .all(...params);
    return rows.map(rowToListEntry);
  }

  /** Persist a model change so /model picks survive --resume. The
   *  updated row keeps its provider, parent lineage, and system prompt;
   *  only the `model` field changes. */
  updateSessionModel(sessionId: string, model: string): void {
    const now = Date.now() / 1000;
    this.writeWithRetry(() => {
      this.db.run('UPDATE sessions SET model = ?, last_updated = ? WHERE session_id = ?', [
        model,
        now,
        sessionId,
      ]);
    });
  }

  /** Load a single session by id. When `owner` is supplied the row is only
   *  returned if its `owner_id` matches (Phase E per-principal scoping);
   *  an unowned row never matches an owner. Omitting `owner` returns the
   *  row regardless of ownership — the single-user / internal back-compat
   *  path. */
  getSession(sessionId: string, owner?: string): Session | null {
    const ownerClause = owner !== undefined ? ' AND owner_id = ?' : '';
    const params: string[] = owner !== undefined ? [sessionId, owner] : [sessionId];
    const row = this.db
      .query<SessionRow, string[]>(
        `SELECT session_id, parent_session_id, model, provider, platform,
                created_at, last_updated, title, system_prompt,
                schema_version, metadata, owner_id,
                input_tokens, output_tokens, cache_creation_input_tokens,
                cache_read_input_tokens, estimated_cost_usd,
                compaction_input_tokens, compaction_output_tokens,
                estimated_compaction_cost_usd
         FROM sessions WHERE session_id = ?${ownerClause}`,
      )
      .get(...params);
    if (!row) return null;
    return rowToSession(row);
  }

  recordTokenUsage(
    sessionId: string,
    usage: TokenUsage,
    estimatedCostUsd: number | undefined,
  ): void {
    const session = this.getSession(sessionId);
    const estimate = estimateUsageCost(
      session?.provider ?? 'unknown',
      session?.model ?? 'unknown',
      usage,
    );
    const supplied =
      estimatedCostUsd !== undefined && Number.isFinite(estimatedCostUsd) && estimatedCostUsd >= 0;
    this.recordUsageEstimate(
      sessionId,
      usage,
      supplied
        ? {
            ...estimate,
            amountUsd: estimatedCostUsd,
            complete: true,
            state: estimatedCostUsd === 0 ? 'free' : 'paid',
            source: 'legacy-caller',
          }
        : { ...estimate, state: 'unknown', complete: false },
    );
  }

  recordUsageEstimate(sessionId: string, usage: TokenUsage, estimate: CostEstimate): void {
    const known =
      estimate.complete &&
      estimate.amountUsd !== undefined &&
      Number.isFinite(estimate.amountUsd) &&
      estimate.amountUsd >= 0;
    const estimatedCostUsd = known ? (estimate.amountUsd ?? 0) : 0;
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    const cacheCreation = usage.cacheCreationInputTokens ?? 0;
    const cacheRead = usage.cacheReadInputTokens ?? 0;
    const now = Date.now() / 1000;
    this.writeWithRetry(
      this.db.transaction(() => {
        this.db.run(
          `UPDATE sessions
         SET input_tokens = input_tokens + ?,
             output_tokens = output_tokens + ?,
             cache_creation_input_tokens = cache_creation_input_tokens + ?,
             cache_read_input_tokens = cache_read_input_tokens + ?,
             estimated_cost_usd = estimated_cost_usd + ?,
             cost_complete = MIN(cost_complete, ?),
             last_updated = ?
         WHERE session_id = ?`,
          [
            input,
            output,
            cacheCreation,
            cacheRead,
            estimatedCostUsd,
            known ? 1 : 0,
            now,
            sessionId,
          ],
        );
        this.db.run('INSERT INTO usage_estimates(session_id, usage, estimate) VALUES (?, ?, ?)', [
          sessionId,
          JSON.stringify(usage),
          JSON.stringify(estimate),
        ]);
      }),
    );
  }

  /** Immutable per-call pricing receipts; refresh never mutates these rows. */
  getUsageEstimates(sessionId: string): CostEstimate[] {
    return this.db
      .query<{ estimate: string }, [string]>(
        'SELECT estimate FROM usage_estimates WHERE session_id = ? ORDER BY id',
      )
      .all(sessionId)
      .map((row) => JSON.parse(row.estimate) as CostEstimate);
  }

  recordCompactionUsage(
    sessionId: string,
    usage: TokenUsage,
    estimatedCostUsd: number | undefined,
    receipt?: CostEstimate,
  ): void {
    const session = this.getSession(sessionId);
    const supplied =
      estimatedCostUsd !== undefined && Number.isFinite(estimatedCostUsd) && estimatedCostUsd >= 0;
    const estimate: CostEstimate = receipt ?? {
      provider: session?.provider ?? 'unknown',
      model: session?.model ?? 'unknown',
      state: supplied ? (estimatedCostUsd === 0 ? 'free' : 'paid') : 'unknown',
      complete: supplied,
      source: 'legacy-caller',
      version: 0,
      pricedAt: new Date().toISOString(),
      ...(supplied ? { amountUsd: estimatedCostUsd } : {}),
    };
    const known =
      estimate.complete &&
      estimate.amountUsd !== undefined &&
      Number.isFinite(estimate.amountUsd) &&
      estimate.amountUsd >= 0;
    const { amountUsd: _amount, ...provenance } = estimate;
    const recordedEstimate: CostEstimate = known
      ? estimate
      : {
          ...provenance,
          complete: false,
          state: estimate.state === 'subscription' ? 'subscription' : 'unknown',
        };
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    const now = Date.now() / 1000;
    this.writeWithRetry(
      this.db.transaction(() => {
        this.db.run(
          `UPDATE sessions
         SET compaction_input_tokens = compaction_input_tokens + ?,
             compaction_output_tokens = compaction_output_tokens + ?,
             estimated_compaction_cost_usd = estimated_compaction_cost_usd + ?,
             cost_complete = MIN(cost_complete, ?),
             last_updated = ?
         WHERE session_id = ?`,
          [input, output, known ? (estimate.amountUsd ?? 0) : 0, known ? 1 : 0, now, sessionId],
        );
        this.db.run('INSERT INTO usage_estimates(session_id, usage, estimate) VALUES (?, ?, ?)', [
          sessionId,
          JSON.stringify(usage),
          JSON.stringify(recordedEstimate),
        ]);
      }),
    );
  }

  recordCompactionLineage(parentSessionId: string, childSessionId: string): void {
    const now = Date.now() / 1000;
    this.writeWithRetry(() => {
      this.db.run(
        `INSERT INTO session_compactions (parent_session_id, child_session_id, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(parent_session_id, child_session_id) DO NOTHING`,
        [parentSessionId, childSessionId, now],
      );
    });
  }

  getCompactionsForParent(parentSessionId: string): SessionCompaction[] {
    const rows = this.db
      .query<CompactionRow, [string]>(
        `SELECT parent_session_id, child_session_id, created_at
         FROM session_compactions
         WHERE parent_session_id = ?
         ORDER BY created_at ASC`,
      )
      .all(parentSessionId);
    return rows.map(rowToCompaction);
  }

  getSessionCost(sessionId: string): SessionCost {
    const row = this.db
      .query<CostRow, [string]>(
        `SELECT input_tokens, output_tokens, cache_creation_input_tokens,
                cache_read_input_tokens, estimated_cost_usd,
                compaction_input_tokens, compaction_output_tokens,
                estimated_compaction_cost_usd
         FROM sessions WHERE session_id = ?`,
      )
      .get(sessionId);
    if (!row) {
      return {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        estimatedCostUsd: 0,
        compactionInputTokens: 0,
        compactionOutputTokens: 0,
        estimatedCompactionCostUsd: 0,
      };
    }
    const complete = this.db
      .query<{ cost_complete: number }, [string]>(
        'SELECT cost_complete FROM sessions WHERE session_id = ?',
      )
      .get(sessionId)?.cost_complete;
    return { ...rowToCost(row), ...(complete === 0 ? { costComplete: false } : {}) };
  }

  /** M8 T7 — session-end metrics for the rich `session_summary` SSE event.
   *
   *  Returns aggregated token usage from the `sessions` columns the M7 cost
   *  fix populates plus a tool-call breakdown derived by scanning persisted
   *  message content for `tool_use` blocks (assistant messages) and the
   *  matching `tool_result` blocks (user messages, `is_error=true` for the
   *  err split).
   *
   *  Token totals fold the chat lane (input_tokens, output_tokens) into
   *  `input` / `output` and surface the cache lanes alongside. The
   *  compaction lane is folded into estimatedCostUsd so the goodbye-card
   *  consumer sees the full session cost. Returns zeros for an unknown
   *  session id so a freshly created session still produces a parseable
   *  payload. Pragmatic v1 — durations are not tracked DB-side yet; the
   *  disposer surfaces them as undefined and the M9 renderer falls back
   *  to an "n/a" cell. */
  getSessionMetrics(sessionId: string): SessionMetricsSnapshot {
    const cost = this.getSessionCost(sessionId);
    // tool_use blocks live inside assistant message content; tool_result
    // blocks (with optional is_error) live inside user messages. The JSON
    // content column is stringified at write time (saveMessage:350), so
    // LIKE patterns over the substring are the cheapest scan that works
    // without a JSON1 dependency.
    const toolUseRow = this.db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n
         FROM messages
         WHERE session_id = ?
           AND role = 'assistant'
           AND content LIKE '%"type":"tool_use"%'`,
      )
      .get(sessionId);
    const toolErrRow = this.db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n
         FROM messages
         WHERE session_id = ?
           AND role = 'user'
           AND content LIKE '%"type":"tool_result"%'
           AND content LIKE '%"is_error":true%'`,
      )
      .get(sessionId);
    // A single assistant message may pack N tool_use blocks; the LIKE
    // counts MESSAGES with at least one. The exact-N answer requires
    // parsing JSON, which we accept as a v1 trade-off — the metric is
    // for a goodbye card, not billing. A future renderer that
    // accumulates from the tool_start event stream would report per
    // tool call, so the counts diverge slightly on multi-call turns.
    // Documented for M9.
    const toolCalls = toolUseRow?.n ?? 0;
    const toolErr = toolErrRow?.n ?? 0;
    const toolOk = Math.max(0, toolCalls - toolErr);
    return {
      tokens: {
        input: cost.inputTokens,
        output: cost.outputTokens,
        cacheRead: cost.cacheReadInputTokens,
        cacheWrite: cost.cacheCreationInputTokens,
        estimatedCostUsd: cost.estimatedCostUsd + cost.estimatedCompactionCostUsd,
        ...(cost.costComplete === false ? { costComplete: false } : {}),
      },
      toolCalls,
      toolOk,
      toolErr,
    };
  }

  getSystemPrompt(sessionId: string): SystemSegment[] | null {
    const row = this.db
      .query<{ system_prompt: string | null }, [string]>(
        'SELECT system_prompt FROM sessions WHERE session_id = ?',
      )
      .get(sessionId);
    if (!row || row.system_prompt === null) return null;
    return JSON.parse(row.system_prompt) as SystemSegment[];
  }

  search(query: string, opts: SearchOpts = {}): StoredMessage[] {
    const limit = opts.limit ?? 20;
    if (opts.sessionId !== undefined) {
      const rows = this.db
        .query<StoredRow, [string, string, number]>(
          `SELECT m.id, m.session_id, m.role, m.content, m.tool_call_id,
                  m.tool_calls, m.token_count, m.created_at
           FROM messages_fts f
           JOIN messages m ON m.id = f.rowid
           WHERE messages_fts MATCH ? AND m.session_id = ?
           ORDER BY rank LIMIT ?`,
        )
        .all(query, opts.sessionId, limit);
      return rows.map(rowToMessage);
    }
    const rows = this.db
      .query<StoredRow, [string, number]>(
        `SELECT m.id, m.session_id, m.role, m.content, m.tool_call_id,
                m.tool_calls, m.token_count, m.created_at
         FROM messages_fts f
         JOIN messages m ON m.id = f.rowid
         WHERE messages_fts MATCH ?
         ORDER BY rank LIMIT ?`,
      )
      .all(query, limit);
    return rows.map(rowToMessage);
  }

  /**
   * Wrap a mutating DB call with busy-retry + WAL checkpoint discipline.
   * SQLITE_BUSY / SQLITE_LOCKED → sleep a uniform 20-150ms and retry up to
   * 15 times before giving up. Every 50 successful writes we TRUNCATE the
   * WAL to keep the sidecar file bounded.
   */
  private writeWithRetry<T>(fn: () => T): T {
    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        const out = fn();
        this.writeCount++;
        if (this.writeCount % WAL_CHECKPOINT_EVERY === 0) {
          try {
            this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
          } catch {
            // Non-fatal — checkpoint can fail if readers are active.
          }
        }
        return out;
      } catch (err) {
        if (!isBusyError(err) || i === MAX_RETRIES - 1) throw err;
        Bun.sleepSync(JITTER_MIN_MS + Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS));
      }
    }
    throw new Error('unreachable');
  }
}

const LOGICAL_TURN_STATUSES = new Set<string>([
  'admitted',
  'running',
  'continuing',
  'completed',
  'waiting_user',
  'cancelled',
  'failed',
  'exhausted',
  'stalled',
]);

const LOGICAL_TURN_COUNTERS = [
  'segments',
  'modelCalls',
  'toolCalls',
  'providerRetries',
  'contextRecoveries',
  'inputTokens',
  'outputTokens',
  'cacheCreationInputTokens',
  'cacheReadInputTokens',
  'estimatedCostUsd',
] as const;

function parseLogicalTurnRecord(serialized: string, logicalTurnId: string): LogicalTurnRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new LogicalTurnRecordError();
  }
  if (!isLogicalTurnRecord(parsed, logicalTurnId)) throw new LogicalTurnRecordError();
  return parsed;
}

function isLogicalTurnRecord(value: unknown, logicalTurnId: string): value is LogicalTurnRecord {
  if (!isPlainRecord(value)) return false;
  if (value.version !== 1 || value.logicalTurnId !== logicalTurnId) return false;
  if (typeof value.sessionId !== 'string' || typeof value.activeSessionId !== 'string')
    return false;
  if (!isStringArray(value.compactedSessionIds) || !isPlainRecord(value.binding)) return false;
  const binding = value.binding;
  if (
    typeof binding.provider !== 'string' ||
    typeof binding.model !== 'string' ||
    typeof binding.cwd !== 'string'
  ) {
    return false;
  }
  if (
    !optionalString(binding, 'route') ||
    !optionalString(binding, 'authKind') ||
    !optionalString(binding, 'effort') ||
    !optionalString(binding, 'toolset') ||
    !optionalString(binding, 'permissionMode') ||
    !optionalString(binding, 'policyDigest') ||
    !optionalString(binding, 'skillApprovalDigest') ||
    !optionalString(binding, 'mcpIdentityDigest') ||
    !optionalString(binding, 'hookScopeDigest') ||
    !optionalString(binding, 'bundleIdentity')
  ) {
    return false;
  }
  if (typeof value.bindingDigest !== 'string') return false;
  if (!isFiniteNumber(value.segmentLimit) || !isFiniteNumber(value.logicalModelCallLimit)) {
    return false;
  }
  if (value.deadlineAt !== undefined && !isFiniteNumber(value.deadlineAt)) return false;
  if (!isLogicalTurnStatus(value.status)) return false;
  if (value.lastCause !== undefined && typeof value.lastCause !== 'string') return false;
  if (value.progressFingerprint !== undefined && typeof value.progressFingerprint !== 'string') {
    return false;
  }
  if (!isFiniteNumber(value.repeatedNoProgress) || !isStringArray(value.runtimeContinuationIds)) {
    return false;
  }
  if (value.finalReply !== undefined && typeof value.finalReply !== 'string') return false;
  if (value.finishReason !== undefined && typeof value.finishReason !== 'string') return false;
  if (value.originalUserMessageId !== undefined && !isFiniteNumber(value.originalUserMessageId)) {
    return false;
  }
  if (!isPlainRecord(value.counters)) return false;
  const counters = value.counters;
  if (!LOGICAL_TURN_COUNTERS.every((key) => isFiniteNumber(counters[key]))) return false;
  return isFiniteNumber(value.createdAt) && isFiniteNumber(value.updatedAt);
}

function isLogicalTurnStatus(value: unknown): value is LogicalTurnRecord['status'] {
  return typeof value === 'string' && LOGICAL_TURN_STATUSES.has(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function optionalString(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return value === undefined || typeof value === 'string';
}

function nonTurnSkillContinuitySnapshot(serialized: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('invalid skill continuity snapshot');
  }
  if (
    Buffer.byteLength(serialized, 'utf8') > 524288 ||
    !Array.isArray(parsed) ||
    parsed.length > 1024
  ) {
    throw new Error('invalid skill continuity snapshot');
  }
  return JSON.stringify(parsed.filter((record) => record && record.lifetime !== 'turn'));
}

/** Distinct local/user namespaces, even when a user's ID is literally "local". */
export function skillContinuityOwnerKey(ownerId: string | null): string {
  return ownerId === null ? 'local' : `user:${ownerId}`;
}

// ------------------------------------------------------------------
// Internals
// ------------------------------------------------------------------

type StoredRow = {
  id: number;
  session_id: string;
  role: string;
  content: string;
  tool_call_id: string | null;
  tool_calls: string | null;
  token_count: number;
  created_at: number;
};

type SessionRow = {
  session_id: string;
  parent_session_id: string | null;
  model: string;
  provider: string;
  platform: string;
  created_at: number;
  last_updated: number;
  title: string | null;
  system_prompt: string | null;
  schema_version: number;
  metadata: string;
  owner_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  estimated_cost_usd: number;
  compaction_input_tokens: number;
  compaction_output_tokens: number;
  estimated_compaction_cost_usd: number;
};

type CostRow = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  estimated_cost_usd: number;
  compaction_input_tokens: number;
  compaction_output_tokens: number;
  estimated_compaction_cost_usd: number;
};

type CompactionRow = {
  parent_session_id: string;
  child_session_id: string;
  created_at: number;
};

type SessionListRow = {
  session_id: string;
  parent_session_id: string | null;
  model: string;
  provider: string;
  platform: string;
  created_at: number;
  last_updated: number;
  title: string | null;
  owner_id: string | null;
  total_tokens: number;
  total_cost_usd: number;
  cost_complete: number;
  msg_count: number;
  first_user_content: string | null;
};

/** Pull a short, scannable label out of a stored user message. Tries
 *  the first text block; falls back to "(no text)" for tool-only or
 *  image-only messages. Truncates to ~60 chars. */
function deriveTitleFromContent(jsonContent: string | null): string | null {
  if (!jsonContent) return null;
  let blocks: ContentBlock[];
  try {
    blocks = JSON.parse(jsonContent) as ContentBlock[];
  } catch {
    return null;
  }
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      const collapsed = block.text.replace(/\s+/g, ' ').trim();
      if (collapsed.length === 0) continue;
      return collapsed.length > 60 ? `${collapsed.slice(0, 57)}...` : collapsed;
    }
  }
  return null;
}

function rowToListEntry(row: SessionListRow): SessionListEntry {
  return {
    sessionId: row.session_id,
    parentSessionId: row.parent_session_id,
    model: row.model,
    provider: row.provider,
    platform: row.platform,
    createdAt: row.created_at,
    lastUpdated: row.last_updated,
    title: row.title ?? deriveTitleFromContent(row.first_user_content),
    ownerId: row.owner_id ?? null,
    msgCount: row.msg_count,
    totalTokens: row.total_tokens,
    totalCostUsd: row.total_cost_usd,
    ...(row.cost_complete === 0 ? { costComplete: false } : {}),
  };
}

function rowToMessage(row: StoredRow): StoredMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: JSON.parse(row.content) as ContentBlock[],
    toolCallId: row.tool_call_id,
    toolCalls: row.tool_calls === null ? null : JSON.parse(row.tool_calls),
    tokenCount: row.token_count,
    createdAt: row.created_at,
  };
}

function rowToSession(row: SessionRow): Session {
  return {
    sessionId: row.session_id,
    parentSessionId: row.parent_session_id,
    model: row.model,
    provider: row.provider,
    platform: row.platform,
    createdAt: row.created_at,
    lastUpdated: row.last_updated,
    title: row.title,
    systemPrompt:
      row.system_prompt === null ? null : (JSON.parse(row.system_prompt) as SystemSegment[]),
    schemaVersion: row.schema_version,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    ownerId: row.owner_id ?? null,
    ...rowToCost(row),
  };
}

function rowToCost(row: CostRow): SessionCost {
  return {
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheCreationInputTokens: row.cache_creation_input_tokens,
    cacheReadInputTokens: row.cache_read_input_tokens,
    estimatedCostUsd: row.estimated_cost_usd,
    compactionInputTokens: row.compaction_input_tokens,
    compactionOutputTokens: row.compaction_output_tokens,
    estimatedCompactionCostUsd: row.estimated_compaction_cost_usd,
  };
}

function rowToCompaction(row: CompactionRow): SessionCompaction {
  return {
    parentSessionId: row.parent_session_id,
    childSessionId: row.child_session_id,
    createdAt: row.created_at,
  };
}

function ensureParentDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function getSchemaVersion(db: Database): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS state_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL
    );
  `);
  const row = db
    .query<{ schema_version: number }, []>('SELECT schema_version FROM state_meta WHERE id = 1')
    .get();
  if (!row) {
    db.run('INSERT INTO state_meta (id, schema_version) VALUES (1, 0)');
    return 0;
  }
  return row.schema_version;
}

function applyPendingMigrations(db: Database): void {
  const current = getSchemaVersion(db);
  const pending = MIGRATIONS.filter((m) => m.from >= current).sort((a, b) => a.from - b.from);
  if (pending.length === 0) return;
  const runAll = db.transaction(() => {
    for (const m of pending) {
      db.exec(m.sql);
      db.run('UPDATE state_meta SET schema_version = ? WHERE id = 1', [m.to]);
    }
  });
  runAll();
}

function isBusyError(err: unknown): boolean {
  if (err instanceof SQLiteError) {
    return err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_LOCKED';
  }
  // Fallback — some environments surface busy errors as plain Error objects.
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return msg.includes('database is locked') || msg.includes('database is busy');
}

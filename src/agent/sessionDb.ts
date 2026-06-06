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
import { resolveHarnessHome } from '../config/paths.js';
import type { ContentBlock, SystemSegment, TokenUsage } from '../core/types.js';

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

const CURRENT_SCHEMA_VERSION = 5;

type Migration = { from: number; to: number; sql: string };

const MIGRATIONS: Migration[] = [
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

/** Required fields for creating a persisted session row. */
export type CreateSessionInput = {
  model: string;
  provider: string;
  /** Default 'cli'. Phase 16 adds 'telegram' / 'slack' / etc. */
  platform?: string;
  parentSessionId?: string;
  title?: string;
  systemPrompt?: SystemSegment[];
  metadata?: Record<string, unknown>;
  /** Phase 18 T8 — optional pre-supplied session id. When omitted, a
   *  UUID is generated. When supplied (e.g. via X-Session-Id header on
   *  the OpenAI-compatible surface), it becomes the row's primary key
   *  so client-side conversation ids can drive both the wire response
   *  id and the DB row. Callers must use {@link upsertSession} to
   *  idempotently land a row when reuse is expected. */
  sessionId?: string;
  /** Phase E — owning principal id for the multi-user gateway. When
   *  omitted the row is unowned (owner_id null) — the back-compat path
   *  for the single-user CLI / cron / OpenAI surfaces. */
  owner?: string;
};

/** Message payload persisted into the session transcript. */
export type SaveMessageInput = {
  role: 'user' | 'assistant';
  content: ContentBlock[];
  toolCallId?: string;
  toolCalls?: unknown;
  tokenCount?: number;
};

/** Message row loaded from SQLite and decoded into runtime content blocks. */
export type StoredMessage = {
  id: number;
  sessionId: string;
  role: 'user' | 'assistant';
  content: ContentBlock[];
  toolCallId: string | null;
  toolCalls: unknown;
  tokenCount: number;
  createdAt: number;
};

/** Session row loaded from SQLite, including usage and compaction counters. */
export type Session = {
  sessionId: string;
  parentSessionId: string | null;
  model: string;
  provider: string;
  platform: string;
  createdAt: number;
  lastUpdated: number;
  title: string | null;
  systemPrompt: SystemSegment[] | null;
  schemaVersion: number;
  metadata: Record<string, unknown>;
  /** Phase E — owning principal id, or null for unowned rows. */
  ownerId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  estimatedCostUsd: number;
  compactionInputTokens: number;
  compactionOutputTokens: number;
  estimatedCompactionCostUsd: number;
};

export type SessionCost = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  estimatedCostUsd: number;
  compactionInputTokens: number;
  compactionOutputTokens: number;
  estimatedCompactionCostUsd: number;
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

/** Lightweight session row for the `/resume` picker. Excludes the
 *  full system prompt and metadata blob — those are loaded on demand
 *  when the user picks a session, not when the list renders. */
export type SessionListEntry = {
  sessionId: string;
  parentSessionId: string | null;
  model: string;
  provider: string;
  platform: string;
  createdAt: number;
  lastUpdated: number;
  /** Stored title if present, else the first user message (truncated). */
  title: string | null;
  /** Phase E — owning principal id, or null for unowned rows. */
  ownerId: string | null;
  /** Number of messages in the session. */
  msgCount: number;
  /** Total tokens (chat + cache + compaction lanes summed). */
  totalTokens: number;
  /** Total estimated cost (chat + compaction lanes summed). */
  totalCostUsd: number;
};

export type SearchOpts = {
  sessionId?: string;
  limit?: number;
};

export class SessionDb {
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
   *  Returns the number of session rows deleted. Called during runtime boot. */
  cleanupOldCronSessions(maxAgeMs = 30 * 24 * 3_600_000): number {
    const cutoffSec = (Date.now() - maxAgeMs) / 1000;
    return this.writeWithRetry(() => {
      const ids = this.db
        .query<{ session_id: string }, [number]>(
          `SELECT session_id FROM sessions
           WHERE json_extract(metadata, '$.kind') = 'cron'
             AND created_at < ?`,
        )
        .all(cutoffSec)
        .map((row) => row.session_id);
      if (ids.length === 0) return 0;
      const placeholders = ids.map(() => '?').join(',');
      this.db.run(`DELETE FROM messages WHERE session_id IN (${placeholders})`, ids);
      this.db.run(
        `DELETE FROM session_compactions
         WHERE parent_session_id IN (${placeholders})
            OR child_session_id IN (${placeholders})`,
        [...ids, ...ids],
      );
      const result = this.db.run(`DELETE FROM sessions WHERE session_id IN (${placeholders})`, ids);
      return result.changes ?? 0;
    });
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
   *  concurrent writer is retried. Returns the number of session rows deleted. */
  cleanupOldChannelSessions(maxAgeMs = 30 * 24 * 3_600_000): number {
    const cutoffSec = (Date.now() - maxAgeMs) / 1000;
    return this.writeWithRetry(() => {
      const ids = this.db
        .query<{ session_id: string }, [number]>(
          `SELECT session_id FROM sessions
           WHERE json_extract(metadata, '$.kind') = 'channel'
             AND last_updated < ?`,
        )
        .all(cutoffSec)
        .map((row) => row.session_id);
      if (ids.length === 0) return 0;
      const placeholders = ids.map(() => '?').join(',');
      this.db.run(`DELETE FROM messages WHERE session_id IN (${placeholders})`, ids);
      this.db.run(
        `DELETE FROM session_compactions
         WHERE parent_session_id IN (${placeholders})
            OR child_session_id IN (${placeholders})`,
        [...ids, ...ids],
      );
      const result = this.db.run(`DELETE FROM sessions WHERE session_id IN (${placeholders})`, ids);
      return result.changes ?? 0;
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

  createSession(input: CreateSessionInput): string {
    const sessionId = input.sessionId ?? randomUUID();
    const now = Date.now() / 1000;
    const systemPromptJson =
      input.systemPrompt !== undefined ? JSON.stringify(input.systemPrompt) : null;
    const metadataJson = JSON.stringify(input.metadata ?? {});
    this.writeWithRetry(() => {
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
    });
    return sessionId;
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
                s.estimated_cost_usd + s.estimated_compaction_cost_usd AS total_cost_usd,
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

  recordTokenUsage(sessionId: string, usage: TokenUsage, estimatedCostUsd: number): void {
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    const cacheCreation = usage.cacheCreationInputTokens ?? 0;
    const cacheRead = usage.cacheReadInputTokens ?? 0;
    const now = Date.now() / 1000;
    this.writeWithRetry(() => {
      this.db.run(
        `UPDATE sessions
         SET input_tokens = input_tokens + ?,
             output_tokens = output_tokens + ?,
             cache_creation_input_tokens = cache_creation_input_tokens + ?,
             cache_read_input_tokens = cache_read_input_tokens + ?,
             estimated_cost_usd = estimated_cost_usd + ?,
             last_updated = ?
         WHERE session_id = ?`,
        [input, output, cacheCreation, cacheRead, estimatedCostUsd, now, sessionId],
      );
    });
  }

  recordCompactionUsage(sessionId: string, usage: TokenUsage, estimatedCostUsd: number): void {
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    const now = Date.now() / 1000;
    this.writeWithRetry(() => {
      this.db.run(
        `UPDATE sessions
         SET compaction_input_tokens = compaction_input_tokens + ?,
             compaction_output_tokens = compaction_output_tokens + ?,
             estimated_compaction_cost_usd = estimated_compaction_cost_usd + ?,
             last_updated = ?
         WHERE session_id = ?`,
        [input, output, estimatedCostUsd, now, sessionId],
      );
    });
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
    return rowToCost(row);
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

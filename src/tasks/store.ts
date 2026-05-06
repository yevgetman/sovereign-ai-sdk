// Phase 13.2 — TaskStore. CRUD over the `tasks` table introduced in schema
// v4. Shares the SessionDb's underlying SQLite connection (single-writer
// per file with WAL); the writes here implicitly compete with session and
// message writes, which is fine because bun:sqlite serializes them and the
// SessionDb's busy_timeout + retry envelope already covers contention.
//
// Boundary translation: the row stores created_at/updated_at as REAL epoch
// seconds (matching the rest of the schema); the in-memory TaskRecord uses
// ISO strings so callers — and especially the tools' JSON output — render
// human-readable timestamps without further work.

import type { SessionDb } from '../agent/sessionDb.js';
import type { TaskRecord, TaskState } from './types.js';

type TaskRow = {
  task_id: string;
  parent_session_id: string;
  child_session_id: string | null;
  agent: string;
  prompt: string;
  state: TaskState;
  created_at: number;
  updated_at: number;
  trace_id: string | null;
  result_preview: string | null;
};

const ACTIVE_STATES: ReadonlySet<TaskState> = new Set(['queued', 'running']);

export type InsertTaskInput = {
  id: string;
  parentSessionId: string;
  agent: string;
  prompt: string;
};

export type UpdateOnCompleteInput = {
  state: TaskState;
  childSessionId?: string;
  traceId?: string;
  resultPreview?: string;
};

export type ListByParentOpts = {
  /** When true, returns all states. Default false → only queued + running. */
  includeAll?: boolean;
};

export class TaskStore {
  constructor(private readonly sessionDb: SessionDb) {}

  insert(input: InsertTaskInput): TaskRecord {
    const now = Date.now() / 1000;
    this.sessionDb.handle.run(
      `INSERT INTO tasks (
        task_id, parent_session_id, agent, prompt,
        state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
      [input.id, input.parentSessionId, input.agent, input.prompt, now, now],
    );
    return {
      id: input.id,
      parentSessionId: input.parentSessionId,
      agent: input.agent,
      prompt: input.prompt,
      state: 'queued',
      createdAt: toIso(now),
      updatedAt: toIso(now),
    };
  }

  get(id: string): TaskRecord | null {
    const row = this.sessionDb.handle
      .query<TaskRow, [string]>('SELECT * FROM tasks WHERE task_id = ?')
      .get(id);
    return row ? rowToRecord(row) : null;
  }

  /** Transition state; bumps updated_at. Throws when the row is missing. */
  updateState(id: string, state: TaskState): void {
    const now = Date.now() / 1000;
    const result = this.sessionDb.handle.run(
      'UPDATE tasks SET state = ?, updated_at = ? WHERE task_id = ?',
      [state, now, id],
    );
    if (result.changes === 0) {
      throw new Error(`TaskStore.updateState: no task with id '${id}'`);
    }
  }

  /** Terminal-state transition. Optional fields preserve null when unset. */
  updateOnComplete(id: string, input: UpdateOnCompleteInput): void {
    const now = Date.now() / 1000;
    const result = this.sessionDb.handle.run(
      `UPDATE tasks SET
        state = ?, updated_at = ?,
        child_session_id = COALESCE(?, child_session_id),
        trace_id = COALESCE(?, trace_id),
        result_preview = COALESCE(?, result_preview)
      WHERE task_id = ?`,
      [
        input.state,
        now,
        input.childSessionId ?? null,
        input.traceId ?? null,
        input.resultPreview ?? null,
        id,
      ],
    );
    if (result.changes === 0) {
      throw new Error(`TaskStore.updateOnComplete: no task with id '${id}'`);
    }
  }

  /** Newest-first by created_at. Default filter: only active states (queued/running). */
  listByParent(parentSessionId: string, opts: ListByParentOpts = {}): TaskRecord[] {
    const rows = this.sessionDb.handle
      .query<TaskRow, [string]>(
        'SELECT * FROM tasks WHERE parent_session_id = ? ORDER BY created_at DESC',
      )
      .all(parentSessionId);
    const records = rows.map(rowToRecord);
    if (opts.includeAll) return records;
    return records.filter((r) => ACTIVE_STATES.has(r.state));
  }
}

function toIso(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

function rowToRecord(row: TaskRow): TaskRecord {
  return {
    id: row.task_id,
    parentSessionId: row.parent_session_id,
    agent: row.agent,
    prompt: row.prompt,
    state: row.state,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    ...(row.child_session_id !== null ? { childSessionId: row.child_session_id } : {}),
    ...(row.trace_id !== null ? { traceId: row.trace_id } : {}),
    ...(row.result_preview !== null ? { resultPreview: row.result_preview } : {}),
  };
}

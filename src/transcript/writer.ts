// Append-only per-session transcript writer (2026-06-15 — see
// docs/specs/2026-06-15-session-transcripts-design.md). One JSONL file per
// session at `<base>[/users/<owner>]/projects/<slug(cwd)>/<sessionId>.jsonl`,
// the Claude-Code ergonomic. The authoritative store is still `sessions.db`;
// this file is an always-on, human-readable, portable MIRROR.
//
// Best-effort, exactly like TraceWriter: `appendMessage()` queues a redacted
// JSON-line append on a sequential write chain and returns immediately. A
// file-system error is logged (or swallowed) and NEVER blocks a turn.

import { existsSync, mkdirSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ContentBlock, Role } from '../core/types.js';
import { redact } from '../trajectory/redact.js';
import { VERSION } from '../version.js';
import { resolveTranscriptPath, transcriptsRoot } from './paths.js';

export type TranscriptWriterOpts = {
  sessionId: string;
  /** The session's working directory — derives the human-readable project slug. */
  cwd: string;
  /** Base dir under which transcripts live (configured `transcripts.dir`, else
   *  `$HARNESS_HOME`). */
  base: string;
  /** Owner principal id → Phase-E per-user scoping (`users/<id>/projects/...`).
   *  Undefined → the legacy top-level `projects/...`. */
  ownerId?: string;
  /** Redact secrets before writing (default true). Off only when the operator
   *  explicitly sets `transcripts.redactSecrets: false`. */
  redactSecrets?: boolean;
  /** Lineage + descriptive metadata for the leading `session_meta` line. */
  parentSessionId?: string | null;
  meta?: { model?: string; provider?: string; kind?: string };
  /** Sink for write errors. Omitted → swallowed (matches TraceWriter). */
  log?: (message: string) => void;
};

type SessionMetaRecord = {
  type: 'session_meta';
  sessionId: string;
  parentSessionId: string | null;
  cwd: string;
  version: string;
  startedAt: string;
  model?: string;
  provider?: string;
  kind?: string;
};

type TranscriptMessageRecord = {
  type: Role;
  seq: number;
  sessionId: string;
  parentSessionId: string | null;
  cwd: string;
  version: string;
  timestamp: string;
  message: { role: Role; content: ContentBlock[] };
};

/** Append-only transcript recorder. Construct one per session, call
 *  `appendMessage()` per persisted message, and `await close()` at session end. */
export class TranscriptWriter {
  readonly path: string;
  private readonly opts: TranscriptWriterOpts;
  private readonly redactOn: boolean;
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;
  private wroteMeta = false;
  private appended = 0;

  constructor(opts: TranscriptWriterOpts) {
    this.opts = opts;
    this.redactOn = opts.redactSecrets !== false;
    const root = transcriptsRoot(opts.base, opts.ownerId);
    this.path = resolveTranscriptPath(root, opts.cwd, opts.sessionId);
  }

  /** Queue a redacted message append (writing the leading `session_meta` line
   *  lazily before the first message, so empty sessions never create a file).
   *  Returns immediately; failures route to `opts.log` (or are swallowed). */
  appendMessage(role: Role, content: ContentBlock[], seq: number): void {
    if (this.closed) return;
    if (!this.wroteMeta) {
      this.wroteMeta = true;
      const meta: SessionMetaRecord = {
        type: 'session_meta',
        sessionId: this.opts.sessionId,
        parentSessionId: this.opts.parentSessionId ?? null,
        cwd: this.opts.cwd,
        version: VERSION,
        startedAt: new Date().toISOString(),
        ...(this.opts.meta?.model !== undefined ? { model: this.opts.meta.model } : {}),
        ...(this.opts.meta?.provider !== undefined ? { provider: this.opts.meta.provider } : {}),
        ...(this.opts.meta?.kind !== undefined ? { kind: this.opts.meta.kind } : {}),
      };
      this.enqueue(meta);
    }
    const record: TranscriptMessageRecord = {
      type: role,
      seq,
      sessionId: this.opts.sessionId,
      parentSessionId: this.opts.parentSessionId ?? null,
      cwd: this.opts.cwd,
      version: VERSION,
      timestamp: new Date().toISOString(),
      message: { role, content },
    };
    this.enqueue(record);
  }

  private enqueue(record: SessionMetaRecord | TranscriptMessageRecord): void {
    const json = JSON.stringify(record);
    const line = `${this.redactOn ? redact(json) : json}\n`;
    this.writeChain = this.writeChain.then(async () => {
      try {
        if (!existsSync(this.path)) {
          mkdirSync(dirname(this.path), { recursive: true });
        }
        await appendFile(this.path, line, 'utf8');
        this.appended++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.opts.log?.(`[transcript] append failed at ${this.path}: ${msg}`);
      }
    });
  }

  /** Drain the write queue. Safe to call multiple times. */
  async close(): Promise<void> {
    this.closed = true;
    await this.writeChain;
  }

  /** Records successfully written so far (incl. the meta line). For assertions. */
  get count(): number {
    return this.appended;
  }
}

// Phase 10.5 — append-only JSONL trace writer. One file per session at
// `<harness-home>/traces/<sessionId>.jsonl`. Records flow through the same
// allowlist redactor used by trajectories (Invariant #15 — secrets must
// not surface in any persistent artifact).
//
// The writer is best-effort: a file-system error never blocks the
// session (Invariant #10). `record()` queues a write and returns once
// queued; callers should `await close()` at session end so the queue
// drains before process exit.

import { existsSync, mkdirSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveHarnessHome } from '../config/paths.js';
import { redact } from '../trajectory/redact.js';
import type { TraceEvent } from './types.js';

const TRACES_DIR_NAME = 'traces';

export type TraceWriterOpts = {
  sessionId: string;
  /** Override the on-disk path. When omitted, falls back to
   *  `<harness-home>/traces/<sessionId>.jsonl`. */
  path?: string;
  /** Override the harness-home root used for the default path. Mostly a
   *  test seam — production callers leave this unset. */
  harnessHome?: string;
  /** Sink for write errors. When omitted, errors are swallowed silently
   *  (matches the trajectory writer's posture). */
  log?: (message: string) => void;
};

/** Append-only trace recorder. Construct one per session, call `record()`
 *  for each event, and `await close()` at session end. */
export class TraceWriter {
  readonly path: string;
  private readonly log: ((message: string) => void) | undefined;
  private readonly sessionId: string;
  /** Sequential write chain so concurrent `record()` calls land in order. */
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;
  /** Number of events successfully appended (post-redaction). */
  private appended = 0;

  constructor(opts: TraceWriterOpts) {
    this.path = resolvePath(opts);
    this.log = opts.log;
    this.sessionId = opts.sessionId;
  }

  /** Queue a redacted JSON-line append. Returns immediately; failures are
   *  routed to `opts.log` (or swallowed) so the session is never blocked
   *  on a stuck disk. */
  record(event: TraceEvent): void {
    if (this.closed) return;
    // Phase 13.3 follow-up — inject sessionId on events that don't carry
    // one so the consolidated trace remains programmatically filterable.
    // The B1 child-recorder wrapper already injects childSessionId; this
    // only fills in parent events that omit the field.
    const tagged = (event as { sessionId?: string | null }).sessionId
      ? event
      : ({ ...event, sessionId: this.sessionId } as TraceEvent);
    const line = `${redact(JSON.stringify(tagged))}\n`;
    this.writeChain = this.writeChain.then(async () => {
      try {
        if (!existsSync(this.path)) {
          mkdirSync(dirname(this.path), { recursive: true });
        }
        await appendFile(this.path, line, 'utf8');
        this.appended++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log?.(`[trace] append failed at ${this.path}: ${msg}`);
      }
    });
  }

  /** Drain the write queue. Safe to call multiple times. */
  async close(): Promise<void> {
    this.closed = true;
    await this.writeChain;
  }

  /** Number of events successfully written so far. Useful for assertions. */
  get count(): number {
    return this.appended;
  }
}

/** Open the trace file for `sessionId` for read-only consumption (e.g. by
 *  `sov trace show`). Returns the absolute path when present, null when not.
 */
export function findTracePath(sessionId: string, harnessHome?: string): string | null {
  const root = harnessHome ?? resolveHarnessHome();
  const path = join(root, TRACES_DIR_NAME, `${sessionId}.jsonl`);
  return existsSync(path) ? path : null;
}

function resolvePath(opts: TraceWriterOpts): string {
  if (opts.path) return opts.path;
  const root = opts.harnessHome ?? resolveHarnessHome();
  return join(root, TRACES_DIR_NAME, `${opts.sessionId}.jsonl`);
}

function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  if (idx <= 0) return '.';
  return path.slice(0, idx);
}

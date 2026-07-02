// Phase 10.5 — append-only JSONL trace writer. One file per session at
// `<harness-home>/traces/<sessionId>.jsonl`. Records flow through the same
// allowlist redactor used by trajectories (Invariant #15 — secrets must
// not surface in any persistent artifact).
//
// The writer is best-effort: a file-system error never blocks the
// session (Invariant #10). `record()` queues a write and returns once
// queued; callers should `await close()` at session end so the queue
// drains before process exit.

import { existsSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join, dirname as pathDirname, resolve, sep } from 'node:path';
import { resolveHarnessHome } from '../config/paths.js';
import { redact } from '../trajectory/redact.js';
import { SECURE_FILE_MODE, chmodSafe, secureMkdir } from '../util/secureFs.js';
import type { TraceEvent } from './types.js';

const TRACES_DIR_NAME = 'traces';

/** Sanitize a sessionId into a trace FILENAME stem that can never traverse the
 *  filesystem. The channel session id is the colon-delimited conversation key
 *  `agent:main:<channel>:<chatType>:<chatId>` — so `:` is a LEGITIMATE delimiter
 *  and is preserved. Everything outside the safe set (notably `/`, `\`, and the
 *  path-segment `.` runs that form `..`) is replaced with `_`. This is the SINK
 *  boundary of the defense-in-depth against path traversal; the webhook adapter's
 *  inbound-id allowlist is the SOURCE boundary. Defense in depth: even a future
 *  sessionId source that skips the source guard cannot escape the traces dir. */
function safeTraceFilenameStem(sessionId: string): string {
  return (
    sessionId
      // Collapse any `..` run first so it can't survive as a parent ref. Done
      // before the char-class pass so e.g. `..` → `__` rather than `.` + `.`.
      .replace(/\.\.+/g, (m) => '_'.repeat(m.length))
      // Allowlist: keep word chars, `.`, `-`, and the `:` channel-key delimiter.
      // Replace anything else (path separators, control chars, …) with `_`.
      .replace(/[^A-Za-z0-9_.:-]/g, '_')
  );
}

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
        // Trace JSONL carries full (redacted) event payloads incl. tool I/O.
        // Create the traces dir 0700 and the file 0600 so other local uids
        // cannot read it on a shared host (audit F10).
        const creating = !existsSync(this.path);
        if (creating) {
          secureMkdir(dirname(this.path));
        }
        await appendFile(this.path, line, { encoding: 'utf8', mode: SECURE_FILE_MODE });
        // `mode` applies only on create; tighten once on first append.
        if (creating) chmodSafe(this.path, SECURE_FILE_MODE);
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
  // Resolve against the SAME sanitized + contained filename the writer uses, so
  // a read for a colon/dirty sessionId finds the file the writer actually wrote.
  const path = resolveTracePath(root, sessionId);
  return existsSync(path) ? path : null;
}

/** Build the contained traces-dir path for `sessionId` under `root`. Sanitizes
 *  the filename stem ({@link safeTraceFilenameStem}) AND asserts the resolved
 *  absolute path stays under `<root>/traces/` — throwing if it would escape (it
 *  cannot, post-sanitize, but the assertion is a belt-and-suspenders invariant
 *  that future refactors must preserve). */
function resolveTracePath(root: string, sessionId: string): string {
  const tracesDir = resolve(join(root, TRACES_DIR_NAME));
  const candidate = resolve(join(tracesDir, `${safeTraceFilenameStem(sessionId)}.jsonl`));
  // Containment assertion: the file must live directly under the traces dir.
  if (candidate !== tracesDir && !candidate.startsWith(tracesDir + sep)) {
    throw new Error(`[trace] refused to write outside traces dir: ${sessionId}`);
  }
  return candidate;
}

function resolvePath(opts: TraceWriterOpts): string {
  // An explicit `path` is a trusted in-process override (test seam / internal
  // callers), NOT untrusted input — used verbatim. The sessionId-derived path
  // is the untrusted surface and is sanitized + containment-checked.
  if (opts.path) return opts.path;
  const root = opts.harnessHome ?? resolveHarnessHome();
  return resolveTracePath(root, opts.sessionId);
}

function dirname(path: string): string {
  return pathDirname(path);
}

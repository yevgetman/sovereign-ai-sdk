// Phase 10.6 — append-only routing audit log. Every per-turn decision
// produces one JSONL record at `<harness-home>/router/audit.jsonl` so
// the user can prove after the fact that data only left the box on
// turns where they expected it to. Schema mirrors the build-plan spec:
// timestamp, session id, lane, provider/model, reason, prompt hash,
// context byte count.
//
// Raw prompt text is NEVER recorded by default — only a SHA-256 of it.
// Build-plan §10.6 keeps raw-prompt logging opt-in; that opt-in is
// deferred to a later commit (probably a per-profile setting).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveHarnessHome } from '../config/paths.js';
import { redact } from '../trajectory/redact.js';
import type { Lane } from './types.js';

const ROUTER_DIR_NAME = 'router';
const AUDIT_FILE_NAME = 'audit.jsonl';

export type AuditEntry = {
  /** Unix epoch milliseconds when the decision was recorded. */
  timestampMs: number;
  /** ISO8601 form of `timestampMs` for human consumption. */
  iso: string;
  sessionId: string;
  lane: Lane;
  /** Raw classifier output, including 'local-with-escalation'. */
  classifierLane: Lane | 'local-with-escalation';
  reason: string;
  provider: string;
  model: string;
  /** SHA-256 of the prompt text. Sized for cheap diffing without leaking
   *  any of the prompt contents. */
  promptHash: string;
  /** Total context byte count (system + history + this prompt). */
  contextByteCount: number;
  /** Whether the user supplied an explicit override (lane). Used for
   *  separating user-driven escalations from rule-driven ones. */
  userOverride?: Lane;
};

export type AuditLoggerOpts = {
  /** Override the on-disk path. When omitted, falls back to
   *  `<harness-home>/router/audit.jsonl`. */
  path?: string;
  /** Override the harness-home root used for the default path. */
  harnessHome?: string;
  /** Sink for write errors. Errors are best-effort; a write failure
   *  must not block the session (Invariant #10). */
  log?: (message: string) => void;
};

/** Append-only router audit logger. Each `record(entry)` adds one JSONL
 *  line to the audit file. Sequential write chain so concurrent record
 *  calls land in order. */
export class RouterAuditLogger {
  readonly path: string;
  private readonly logSink: ((message: string) => void) | undefined;
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;
  private appended = 0;

  constructor(opts: AuditLoggerOpts = {}) {
    this.path = resolvePath(opts);
    this.logSink = opts.log;
  }

  record(entry: AuditEntry): void {
    if (this.closed) return;
    const line = `${redact(JSON.stringify(entry))}\n`;
    this.writeChain = this.writeChain.then(async () => {
      try {
        if (!existsSync(this.path)) {
          mkdirSync(dirname(this.path), { recursive: true });
        }
        await appendFile(this.path, line, 'utf8');
        this.appended++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logSink?.(`[router-audit] append failed at ${this.path}: ${msg}`);
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.writeChain;
  }

  get count(): number {
    return this.appended;
  }
}

/** Hash a prompt string for the audit log. SHA-256 hex; never logged
 *  raw. Exported so callers can check the hash from the audit file
 *  matches a known prompt. */
export function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}

function resolvePath(opts: AuditLoggerOpts): string {
  if (opts.path) return opts.path;
  const root = opts.harnessHome ?? resolveHarnessHome();
  return join(root, ROUTER_DIR_NAME, AUDIT_FILE_NAME);
}

function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  if (idx <= 0) return '.';
  return path.slice(0, idx);
}

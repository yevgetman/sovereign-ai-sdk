// Trajectory writer (Phase 13.1). On session close, writes a
// ShareGPT-compatible JSONL record to `<state-root>/artifacts/trajectories/`
// — `samples.jsonl` for completed sessions, `failed.jsonl` for sessions
// that ended via interrupt / error / max-turns / max-tokens.
//
// Storage location: when a bundle is loaded, writes to
// `<bundle>/state/artifacts/trajectories/`. In generic-agent mode (no
// bundle), writes to `<harness-home>/trajectories/`. Either way, the
// record is redacted via `redact()` (Invariant #15) before append.
//
// The whole module is best-effort. A failure to write a trajectory
// record never blocks the user-facing session — Invariant #10
// (learning loop is additive and non-blocking).

import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Message, Terminal } from '../core/types.js';
import { SECURE_FILE_MODE, chmodSafe, secureMkdir } from '../util/secureFs.js';
import { redact } from './redact.js';
import { type ShareGPTRecord, transcriptToShareGPT } from './shareGpt.js';

export type SessionMetadata = {
  sessionId: string;
  provider: string;
  model: string;
  /** Total tool calls made over the session. */
  toolCallCount: number;
  /** Iterations the run loop completed. */
  iterationsUsed: number;
  /** Estimated USD cost for the session (provider + compaction lanes
   *  combined). */
  estimatedCostUsd: number;
};

export type TrajectoryRecord = {
  conversations: ShareGPTRecord[];
  timestamp: string;
  sessionId: string;
  provider: string;
  model: string;
  completed: boolean;
  terminalReason: Terminal['reason'];
  toolCallCount: number;
  iterationsUsed: number;
  estimatedCostUsd: number;
};

export type WriteOpts = {
  messages: readonly Message[];
  terminal: Terminal;
  metadata: SessionMetadata;
  /** Root directory for artifacts. Bundle.state if a bundle is loaded;
   *  otherwise harness-home. The writer creates
   *  `<root>/trajectories/{samples,failed}.jsonl` under whichever you
   *  pass in. */
  artifactsRoot: string;
};

export type WriteResult = {
  /** Absolute path of the JSONL file the record was appended to. */
  path: string;
  /** Whether the record went to samples.jsonl (completed) or failed.jsonl. */
  bucket: 'samples' | 'failed';
  /** Bytes written (post-redaction, including the trailing newline). */
  bytes: number;
};

const COMPLETED_REASONS: ReadonlySet<Terminal['reason']> = new Set(['completed', 'max_turns']);

/** Build the JSON record for a session without writing it. Pure;
 *  used by tests to inspect the shape. */
export function buildTrajectoryRecord(opts: WriteOpts): TrajectoryRecord {
  const { messages, terminal, metadata } = opts;
  return {
    conversations: transcriptToShareGPT(messages),
    timestamp: new Date().toISOString(),
    sessionId: metadata.sessionId,
    provider: metadata.provider,
    model: metadata.model,
    completed: COMPLETED_REASONS.has(terminal.reason),
    terminalReason: terminal.reason,
    toolCallCount: metadata.toolCallCount,
    iterationsUsed: metadata.iterationsUsed,
    estimatedCostUsd: metadata.estimatedCostUsd,
  };
}

/** Append the record to the right bucket. Creates the trajectories
 *  directory if needed. Best-effort: returns the WriteResult on success;
 *  throws on filesystem error so the caller can decide whether to
 *  surface it (we recommend swallowing — Invariant #10). */
export async function writeTrajectory(opts: WriteOpts): Promise<WriteResult> {
  const record = buildTrajectoryRecord(opts);
  const bucket: 'samples' | 'failed' = record.completed ? 'samples' : 'failed';
  // samples.jsonl / failed.jsonl hold the full ShareGPT transcript. Create the
  // trajectories dir 0700 and the file 0600 so other local uids cannot read it
  // (audit F10). These files accumulate across sessions, so chmod on every
  // session close (cheap — once per session) also tightens a file an older
  // version left 0644.
  const dir = join(opts.artifactsRoot, 'trajectories');
  secureMkdir(dir);
  const path = join(dir, `${bucket}.jsonl`);
  const line = `${redact(JSON.stringify(record))}\n`;
  await appendFile(path, line, { encoding: 'utf8', mode: SECURE_FILE_MODE });
  chmodSafe(path, SECURE_FILE_MODE);
  return { path, bucket, bytes: Buffer.byteLength(line, 'utf8') };
}

/** Drop-in for callers that want fire-and-forget semantics: log on
 *  failure, never throw. */
export async function tryWriteTrajectory(
  opts: WriteOpts,
  log?: (message: string) => void,
): Promise<WriteResult | null> {
  try {
    return await writeTrajectory(opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.(`[trajectory] write failed: ${msg}`);
    return null;
  }
}

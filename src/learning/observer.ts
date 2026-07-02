// src/learning/observer.ts
// Phase 13.4 — async fire-and-forget observation writer. Bounded buffer;
// on overflow, drops the newest record (silently, with a counter for
// diagnostics). Disk writes serialize via a write chain (mirrors
// TraceWriter pattern). Invariant #10 — never blocks the turn.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { appendFile, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ObserveInput } from '@yevgetman/sov-sdk/core/observePort';
import { redact } from '@yevgetman/sov-sdk/trajectory/redact';
import { ensureLearningDirs, observationsPath } from './paths.js';
import { getProjectId } from './project.js';
import type { Observation } from './types.js';

// `ObserveInput` now lives in the open core (`core/observePort.js`). Re-exported
// so existing importers (runtime/subprocessExecutor, tests) keep their path.
export type { ObserveInput };

export interface LearningObserverOpts {
  harnessHome: string;
  cwd: string;
  sessionId: string;
  bufferSize?: number;
  enabled?: boolean;
  /** Phase E T6 — owning principal. When set, observations land under
   *  `<harnessHome>/users/{userId}/learning/…`; undefined keeps the legacy
   *  top-level paths (byte-identical to pre-Phase-E behavior). Sourced from
   *  the session's ownerId, never from caller input; validated at the path
   *  boundary in paths.ts. */
  userId?: string;
}

const DEFAULT_BUFFER = 200;
const SUMMARY_MAX = 256;

/** observations.jsonl is append-only; the instinct-synthesizer reads it WHOLE
 *  via FileReadTool, which HARD-ERRORS at its 1 MiB cap (MAX_BYTES in
 *  FileReadTool.ts). Without rotation a busy project crosses 1 MiB and
 *  synthesis silently wedges — the learning loop stops paying off. We keep the
 *  file readable by capping it to a recent tail on append.
 *
 *  ROTATE_THRESHOLD_BYTES sits well under the 1 MiB FileReadTool cap so the
 *  file is always readable with comfortable headroom; RETAIN_BYTES is the most
 *  recent slice we keep when we rotate. Retaining a generous tail preserves
 *  learning depth (recency is what synthesis clusters over). This changes the
 *  on-disk WINDOW only — recall/synthesis semantics and learning defaults are
 *  untouched. */
const ROTATE_THRESHOLD_BYTES = 800 * 1024;
const RETAIN_BYTES = 600 * 1024;

export class LearningObserver {
  private writeChain: Promise<void> = Promise.resolve();
  private buffered = 0;
  private dropped = 0;
  private readonly harnessHome: string;
  private readonly cwd: string;
  private readonly sessionId: string;
  private readonly enabled: boolean;
  private readonly bufferSize: number;
  private readonly userId: string | undefined;

  constructor(opts: LearningObserverOpts) {
    this.harnessHome = opts.harnessHome;
    this.cwd = opts.cwd;
    this.sessionId = opts.sessionId;
    this.enabled = opts.enabled ?? true;
    this.bufferSize = opts.bufferSize ?? DEFAULT_BUFFER;
    this.userId = opts.userId;
  }

  observe(input: ObserveInput): void {
    if (!this.enabled) return;
    if (this.buffered >= this.bufferSize) {
      this.dropped += 1;
      return; // backpressure — drop silently
    }
    const observation = this.buildObservation(input);
    if (observation === null) {
      // Unserializable input (circular ref, BigInt edge case). Drop silently
      // rather than poisoning the corpus with a sentinel hash collision.
      this.dropped += 1;
      return;
    }
    this.buffered += 1;
    this.writeChain = this.writeChain.then(async () => {
      try {
        const project = getProjectId(this.cwd);
        const path = observationsPath(this.harnessHome, project.id, this.userId);
        if (!existsSync(dirname(path))) {
          mkdirSync(dirname(path), { recursive: true });
          ensureLearningDirs(this.harnessHome, project.id, this.userId);
        }
        await appendFile(path, `${JSON.stringify(observation)}\n`, 'utf-8');
        await capObservationsFile(path);
      } catch {
        // Invariant #10: never block. Swallow disk failures.
      } finally {
        this.buffered -= 1;
      }
    });
  }

  /** Drain the buffer. Best-effort; safe to call multiple times.
   *  Bounded by `timeoutMs` (default 2000) so a slow disk cannot hang
   *  shutdown paths like `/quit`. */
  async drain(timeoutMs = 2000): Promise<void> {
    await Promise.race([
      this.writeChain,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  /** Diagnostic: count of records dropped due to buffer overflow or
   *  unserializable input. */
  getDroppedCount(): number {
    return this.dropped;
  }

  private buildObservation(input: ObserveInput): Observation | null {
    const inputJson = this.trySerializeInput(input.toolInput);
    if (inputJson === null) return null;
    const project = getProjectId(this.cwd);
    const id = `obs-${new Date().toISOString().slice(0, 10)}-${randomBytes(4).toString('hex')}`;
    // Hash the raw input (stable identity), but redact anything that reaches the
    // corpus on disk: the summary is read back verbatim into the synthesizer's
    // LLM request, so an inline token / URL key / credential in a tool input or
    // its envelope summary would otherwise be sent to a provider (audit 2026-06-10;
    // matches the trace/trajectory/audit writers per Invariant #15).
    const tool_input_hash = `sha256:${createHash('sha256').update(inputJson).digest('hex')}`;
    const redactedJson = redact(inputJson);
    const tool_input_summary =
      redactedJson.length > SUMMARY_MAX
        ? `${redactedJson.slice(0, SUMMARY_MAX - 3)}...`
        : redactedJson;
    const observation_envelope =
      input.observationEnvelope !== undefined
        ? { ...input.observationEnvelope, summary: redact(input.observationEnvelope.summary) }
        : undefined;
    return {
      id,
      ts: new Date().toISOString(),
      project_id: project.id,
      project_name: project.name,
      session_id: this.sessionId,
      tool_name: input.toolName,
      tool_input_hash,
      tool_input_summary,
      status: input.status,
      duration_ms: input.durationMs,
      ...(observation_envelope !== undefined ? { observation_envelope } : {}),
      ...(input.traceId !== undefined ? { trace_id: input.traceId } : {}),
    };
  }

  /** Test-only — synchronously enforce the size cap on an observations file.
   *  Production rotation runs inside the serialized write chain; this exposes
   *  the same logic for deterministic tests. */
  static async __test_capObservationsFile(path: string): Promise<void> {
    await capObservationsFile(path);
  }

  // Returns null when input cannot be serialized; caller drops the
  // observation rather than poisoning the corpus with a sentinel hash.
  private trySerializeInput(input: unknown): string | null {
    try {
      const result = JSON.stringify(input, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      );
      return result ?? null;
    } catch {
      return null;
    }
  }
}

/** Cap observations.jsonl to a recent tail so the synthesizer's whole-file
 *  Read never trips FileReadTool's 1 MiB hard cap. No-op until the file
 *  exceeds ROTATE_THRESHOLD_BYTES; then it rewrites the file to the most
 *  recent ~RETAIN_BYTES, keeping only WHOLE JSON lines (a truncated leading
 *  line would poison the synthesizer's JSON parse). Best-effort: any disk
 *  error is swallowed by the caller's try/catch (Invariant #10). */
async function capObservationsFile(path: string): Promise<void> {
  const info = await stat(path);
  if (info.size <= ROTATE_THRESHOLD_BYTES) return;

  const content = await readFile(path, 'utf-8');
  // Keep the most recent RETAIN_BYTES, then drop the (likely partial) first
  // surviving line so every retained line is a complete JSON record.
  const tail = content.slice(content.length - RETAIN_BYTES);
  const firstNewline = tail.indexOf('\n');
  const whole = firstNewline === -1 ? '' : tail.slice(firstNewline + 1);
  await writeFile(path, whole, 'utf-8');
}

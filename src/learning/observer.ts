// src/learning/observer.ts
// Phase 13.4 — async fire-and-forget observation writer. Bounded buffer;
// on overflow, drops the newest record (silently, with a counter for
// diagnostics). Disk writes serialize via a write chain (mirrors
// TraceWriter pattern). Invariant #10 — never blocks the turn.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ensureLearningDirs, observationsPath } from './paths.js';
import { getProjectId } from './project.js';
import type { Observation, ObservationStatus } from './types.js';

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

export interface ObserveInput {
  toolName: string;
  toolInput: unknown;
  status: ObservationStatus;
  durationMs: number;
  observationEnvelope?: { status: 'success' | 'warning' | 'error'; summary: string };
  traceId?: string;
}

const DEFAULT_BUFFER = 200;
const SUMMARY_MAX = 256;

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
    const tool_input_hash = `sha256:${createHash('sha256').update(inputJson).digest('hex')}`;
    const tool_input_summary =
      inputJson.length > SUMMARY_MAX ? `${inputJson.slice(0, SUMMARY_MAX - 3)}...` : inputJson;
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
      ...(input.observationEnvelope !== undefined
        ? { observation_envelope: input.observationEnvelope }
        : {}),
      ...(input.traceId !== undefined ? { trace_id: input.traceId } : {}),
    };
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

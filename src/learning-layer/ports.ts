// src/learning-layer/ports.ts — the four-port contract between the learning layer and any host harness.

/** Host-neutral transcript turn. The adapter maps the host's message shape onto this. */
export interface TranscriptTurn {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly text: string;
}

/** A completed session handed to the layer for ingestion (Observe). */
export interface CapturedSession {
  readonly sessionId: string;
  readonly projectId: string;
  readonly turns: readonly TranscriptTurn[];
  readonly terminalReason: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** A single tool action, optionally streamed as it happens (Observe). */
export interface ToolEvent {
  readonly sessionId: string;
  readonly projectId: string;
  readonly toolName: string;
  readonly status: 'success' | 'error' | 'denied' | 'cancelled';
  readonly inputSummary: string;
  readonly durationMs: number;
}

/** What the host knows about the turn that is about to run (Recall input). */
export interface RecallContext {
  readonly projectId: string;
  readonly latestUserText: string | undefined;
  readonly tokenBudget: number;
  readonly maxLessons: number;
  /** Phase E T6 — the owning principal for this turn. When set, recall reads
   *  only that user's corpus (`<harnessHome>/users/{userId}/learning/…`);
   *  undefined reads the legacy top-level corpus (byte-identical to
   *  pre-Phase-E behavior). This rides the PER-TURN context — the layer is a
   *  shared singleton, so the userId must never be stored on it; it travels
   *  with each recall call exactly like `projectId` does. */
  readonly userId?: string;
}

// `RecalledLesson` + `RecallResult` (Recall output) now live in the open core
// (`core/recallPort.ts`) — they're the return type of `RecallTurn`. Imported for
// local use (RecallApi below) and re-exported so existing learning-layer
// importers keep their import path unchanged.
import type { RecallResult, RecalledLesson } from '@yevgetman/sov-sdk/core/recallPort';
export type { RecallResult, RecalledLesson };

/** Options for a single model call (Reason). */
export interface ReasonOptions {
  readonly system?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

// --- The layer's PUBLIC API (host calls these; the layer implements them) ---

/** Port 1 — Observe (host -> layer). */
export interface ObserveApi {
  observeSession(session: CapturedSession): Promise<void>;
  observeToolEvent(event: ToolEvent): void; // fire-and-forget
}

/** Port 2 — Recall (layer -> host). The missing link. */
export interface RecallApi {
  recall(ctx: RecallContext): Promise<RecallResult>;
}

// --- The layer's DEPENDENCIES (adapter implements these; the layer calls them) ---

/** Port 3 — Reason (layer -> model). Minimal "prompt in, text out". */
export interface ReasonPort {
  complete(prompt: string, opts?: ReasonOptions): Promise<string>;
}

/** Port 4 — Persist (layer <-> storage). Minimal named-blob store. */
export interface PersistPort {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  list(prefix: string): Promise<readonly string[]>;
  remove(key: string): Promise<void>;
}

/** What the adapter provides to construct the layer. */
export interface LearningHostDeps {
  readonly reason: ReasonPort;
  readonly persist: PersistPort;
}

/** The layer instance the host holds. */
export interface LearningLayer extends ObserveApi, RecallApi {}

// Runtime-level transcript store (2026-06-15). Owns one TranscriptWriter per
// live session, lazily created on the first persisted message (resolving the
// session's owner + lineage + descriptive metadata from the session row). The
// store is the seam every message-persistence call site reaches through
// `persistMessage`, so the JSONL transcript stays in lock-step with the DB
// across every surface (turns / channels / OpenAI API / compaction).

import type { ContentBlock, Role } from '../core/types.js';
import { transcriptsRoot } from './paths.js';
import { TranscriptWriter } from './writer.js';

/** The slice of a session row the store needs to stamp a transcript. */
export type TranscriptSessionInfo = {
  ownerId: string | null;
  parentSessionId: string | null;
  model: string;
  provider: string;
  metadata: Record<string, unknown>;
};

export type TranscriptStoreOpts = {
  /** Master switch (resolved from `transcripts.enabled`, default true). */
  enabled: boolean;
  /** Base dir for transcripts (`transcripts.dir` ?? `$HARNESS_HOME`). */
  base: string;
  /** Redact secrets before writing (default true). */
  redactSecrets: boolean;
  /** The runtime's working directory — the project-slug source. */
  cwd: string;
  /** Resolve a session's row (owner/lineage/model/provider/kind). */
  getSession: (sessionId: string) => TranscriptSessionInfo | null;
  /** Sink for writer errors. */
  log?: (message: string) => void;
};

export class TranscriptStore {
  private readonly writers = new Map<string, TranscriptWriter | null>();

  constructor(private readonly opts: TranscriptStoreOpts) {}

  /** Append a persisted message to its session's transcript. Lazily creates the
   *  per-session writer on first use. No-op when transcripts are disabled. A
   *  writer that fails to construct is cached as `null` so we don't retry every
   *  message. Never throws — transcript failures must not break a turn. */
  recordMessage(sessionId: string, role: Role, content: ContentBlock[], seq: number): void {
    if (!this.opts.enabled) return;
    let writer = this.writers.get(sessionId);
    if (writer === undefined) {
      writer = this.createWriter(sessionId);
      this.writers.set(sessionId, writer);
    }
    writer?.appendMessage(role, content, seq);
  }

  private createWriter(sessionId: string): TranscriptWriter | null {
    try {
      const session = this.opts.getSession(sessionId);
      const ownerId = session?.ownerId ?? undefined;
      const kind = typeof session?.metadata?.kind === 'string' ? session.metadata.kind : undefined;
      return new TranscriptWriter({
        sessionId,
        cwd: this.opts.cwd,
        base: this.opts.base,
        redactSecrets: this.opts.redactSecrets,
        parentSessionId: session?.parentSessionId ?? null,
        ...(ownerId !== undefined ? { ownerId } : {}),
        meta: {
          ...(session?.model !== undefined ? { model: session.model } : {}),
          ...(session?.provider !== undefined ? { provider: session.provider } : {}),
          ...(kind !== undefined ? { kind } : {}),
        },
        ...(this.opts.log !== undefined ? { log: this.opts.log } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.log?.(`[transcript] writer init failed for ${sessionId}: ${msg}`);
      return null;
    }
  }

  /** Drain + drop the writer for one session (called on disposeSession). */
  async closeSession(sessionId: string): Promise<void> {
    const writer = this.writers.get(sessionId);
    this.writers.delete(sessionId);
    if (writer) await writer.close();
  }

  /** Drain + drop every writer (called on runtime dispose). */
  async closeAll(): Promise<void> {
    const writers = [...this.writers.values()];
    this.writers.clear();
    await Promise.all(writers.map((w) => w?.close()));
  }

  /** The active top-level projects dir (for surfacing the location to the
   *  user). `null` when transcripts are disabled. Per-user sessions live under
   *  `<base>/users/<owner>/projects/...`; this returns the unowned root. */
  get projectsDir(): string | null {
    return this.opts.enabled ? transcriptsRoot(this.opts.base) : null;
  }
}

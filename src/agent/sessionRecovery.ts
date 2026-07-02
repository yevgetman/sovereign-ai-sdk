// Session recovery helpers for durable local escape hatches such as /clear.

import type { SystemSegment } from '@yevgetman/sov-sdk/core/types';
import type { CreateSessionInput, SessionDb } from './sessionDb.js';

export type CreateClearedChildSessionInput = {
  parentSessionId: string;
  model?: string;
  provider?: string;
  systemPrompt?: SystemSegment[];
  metadata?: Record<string, unknown>;
  /** Phase E — the owning principal for the cleared child. When omitted it
   *  falls back to the parent's owner. SECURITY-LOAD-BEARING on the multi-user
   *  gateway: without an owner the child row is unowned (owner_id null), so the
   *  owning principal's next /turns hits loadOwnedSession → 404 and the
   *  conversation dies. Mirrors the owner-stamping on the compaction child
   *  (src/compact/compactor.ts) and the sub-agent child (src/server/runtime.ts).
   *  Null/undefined (single-user CLI / cron / OpenAI surfaces) keeps the child
   *  unowned, byte-identical to pre-Phase-E behavior. */
  owner?: string;
  now?: Date;
};

export type ClearedChildSession = {
  parentSessionId: string;
  newSessionId: string;
};

export function createClearedChildSession(
  db: SessionDb,
  input: CreateClearedChildSessionInput,
): ClearedChildSession {
  const parent = db.getSession(input.parentSessionId);
  if (parent === null) {
    throw new Error(`cannot clear: session ${input.parentSessionId} was not found`);
  }

  const systemPrompt = input.systemPrompt ?? parent.systemPrompt ?? undefined;
  // Phase E — explicit owner wins; otherwise inherit the parent's owner so the
  // cleared child stays in the same principal's namespace. Null/undefined keeps
  // the child unowned (single-user back-compat).
  const owner = input.owner ?? parent.ownerId ?? undefined;
  const createInput: CreateSessionInput = {
    model: input.model ?? parent.model,
    provider: input.provider ?? parent.provider,
    platform: parent.platform,
    parentSessionId: parent.sessionId,
    ...(parent.title !== null ? { title: parent.title } : {}),
    ...(owner != null ? { owner } : {}),
    metadata: {
      ...parent.metadata,
      ...input.metadata,
      recoveryKind: 'clear',
      clearedFromSessionId: parent.sessionId,
      clearedAt: (input.now ?? new Date()).toISOString(),
    },
  };
  if (systemPrompt !== undefined) createInput.systemPrompt = systemPrompt;

  const newSessionId = db.createSession(createInput);

  return { parentSessionId: parent.sessionId, newSessionId };
}

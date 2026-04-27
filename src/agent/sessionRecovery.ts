// Session recovery helpers for durable local escape hatches such as /clear.

import type { SystemSegment } from '../core/types.js';
import type { CreateSessionInput, SessionDb } from './sessionDb.js';

export type CreateClearedChildSessionInput = {
  parentSessionId: string;
  model?: string;
  provider?: string;
  systemPrompt?: SystemSegment[];
  metadata?: Record<string, unknown>;
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
  const createInput: CreateSessionInput = {
    model: input.model ?? parent.model,
    provider: input.provider ?? parent.provider,
    platform: parent.platform,
    parentSessionId: parent.sessionId,
    ...(parent.title !== null ? { title: parent.title } : {}),
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

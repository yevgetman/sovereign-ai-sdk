// src/persistence/inMemoryStore.ts — the in-memory `SessionStore` default
// (Phase 2 / Task 2.1).
//
// A pure in-process implementation of the open `SessionStore` port backed by
// `Map`s — no SQLite, no disk. This is what `createAgent` (Phase 3)
// defaults to so an embedded agent persists turn/history state with zero
// external dependencies. It mirrors the OBSERVABLE behavior of
// `SessionDb.open({ path: ':memory:' })` for the port's narrow surface:
//   • createSession applies the same defaults (platform 'cli', null
//     parent/owner/title, '{}' metadata, zeroed usage counters).
//   • saveMessage assigns a fresh ascending id and normalizes optional fields to
//     null/0 the way the SQLite columns do; loadMessages returns them in
//     insertion order.
//   • recordTokenUsage ACCUMULATES (mirrors SQL `SET col = col + ?`).
//   • getSession(id, owner) scopes by owner (an unowned row never matches a real
//     principal; a missing/mismatched owner yields null — existence-hiding).
//
// Immutability discipline: stored sessions are replaced (never mutated in
// place); message content is deep-copied on save (a JSON round-trip, mirroring
// SQLite's serialize/deserialize) so a caller mutating its input can't corrupt
// stored state.

import { randomUUID } from 'node:crypto';
import type {
  CreateSessionInput,
  SaveMessageInput,
  Session,
  StoredMessage,
} from '../core/sessionPort.js';
import type { TokenUsage } from '../core/types.js';
import type { SessionStore } from './sessionStore.js';

/** Mirrors `SessionDb`'s current schema version so getSession reports the same
 *  `schemaVersion` an in-memory SQLite open would. The in-memory store has no
 *  migrations; this is the reported value only. */
const SCHEMA_VERSION = 5;

/** Deep-copy via a JSON round-trip — mirrors how SQLite serializes content on
 *  write and decodes it on read (strips `undefined`, severs shared references).
 *  Used so loaded messages never alias the caller's input objects. */
function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A pure in-process `SessionStore` (no disk, no SQLite). */
export function createInMemorySessionStore(): SessionStore {
  const sessions = new Map<string, Session>();
  const messagesBySession = new Map<string, StoredMessage[]>();
  let nextMessageId = 1;

  function createSession(input: CreateSessionInput): string {
    const sessionId = input.sessionId ?? randomUUID();
    const now = Date.now() / 1000;
    const session: Session = {
      sessionId,
      parentSessionId: input.parentSessionId ?? null,
      model: input.model,
      provider: input.provider,
      platform: input.platform ?? 'cli',
      createdAt: now,
      lastUpdated: now,
      title: input.title ?? null,
      systemPrompt: input.systemPrompt !== undefined ? deepCopy(input.systemPrompt) : null,
      schemaVersion: SCHEMA_VERSION,
      metadata: input.metadata !== undefined ? deepCopy(input.metadata) : {},
      ownerId: input.owner ?? null,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      estimatedCostUsd: 0,
      compactionInputTokens: 0,
      compactionOutputTokens: 0,
      estimatedCompactionCostUsd: 0,
    };
    sessions.set(sessionId, session);
    return sessionId;
  }

  function upsertSession(input: CreateSessionInput): string {
    // Mirror SessionDb: probe by id WITHOUT owner scoping; preserve the existing
    // row's configuration on a repeat call.
    if (input.sessionId !== undefined) {
      const existing = sessions.get(input.sessionId);
      if (existing !== undefined) return existing.sessionId;
    }
    return createSession(input);
  }

  function getSession(sessionId: string, owner?: string): Session | null {
    const session = sessions.get(sessionId);
    if (session === undefined) return null;
    // Owner scoping: a real principal only sees its own rows (and never an
    // unowned one); omitting `owner` returns the row regardless.
    if (owner !== undefined && session.ownerId !== owner) return null;
    return session;
  }

  function updateSessionModel(sessionId: string, model: string): void {
    const session = sessions.get(sessionId);
    // SQL UPDATE no-ops on a missing row — mirror that (guard, don't throw).
    if (session === undefined) return;
    sessions.set(sessionId, { ...session, model, lastUpdated: Date.now() / 1000 });
  }

  function saveMessage(sessionId: string, msg: SaveMessageInput): number {
    const now = Date.now() / 1000;
    const id = nextMessageId++;
    const stored: StoredMessage = {
      id,
      sessionId,
      role: msg.role,
      content: deepCopy(msg.content),
      toolCallId: msg.toolCallId ?? null,
      toolCalls: msg.toolCalls !== undefined ? deepCopy(msg.toolCalls) : null,
      tokenCount: msg.tokenCount ?? 0,
      createdAt: now,
    };
    const list = messagesBySession.get(sessionId);
    if (list === undefined) messagesBySession.set(sessionId, [stored]);
    else list.push(stored);
    // Mirror saveMessage's `UPDATE sessions SET last_updated` (guarded on row
    // existence — saveMessage against a missing session still returns the id).
    const session = sessions.get(sessionId);
    if (session !== undefined) sessions.set(sessionId, { ...session, lastUpdated: now });
    return id;
  }

  function loadMessages(sessionId: string): StoredMessage[] {
    // Fresh array (id-ascending by construction); empty when the session has none.
    return [...(messagesBySession.get(sessionId) ?? [])];
  }

  function recordTokenUsage(sessionId: string, usage: TokenUsage, estimatedCostUsd: number): void {
    const session = sessions.get(sessionId);
    if (session === undefined) return;
    // Accumulate — mirrors SQL `SET col = col + ?`.
    sessions.set(sessionId, {
      ...session,
      inputTokens: session.inputTokens + (usage.inputTokens ?? 0),
      outputTokens: session.outputTokens + (usage.outputTokens ?? 0),
      cacheCreationInputTokens:
        session.cacheCreationInputTokens + (usage.cacheCreationInputTokens ?? 0),
      cacheReadInputTokens: session.cacheReadInputTokens + (usage.cacheReadInputTokens ?? 0),
      estimatedCostUsd: session.estimatedCostUsd + estimatedCostUsd,
      lastUpdated: Date.now() / 1000,
    });
  }

  return {
    createSession,
    upsertSession,
    getSession,
    updateSessionModel,
    saveMessage,
    loadMessages,
    recordTokenUsage,
  };
}

// In-memory SessionStore tests — exercise createInMemorySessionStore() purely
// through the open `SessionStore` port (no bun:sqlite, no disk). The store must
// round-trip a session + its messages + token usage with the same observable
// behavior as SessionDb.open({ path: ':memory:' }) for the port's narrow
// turn/history surface.
//
// The final `satisfies`-style assignment is a TYPE-LEVEL conformance check: it
// fails the typecheck (not this runtime test) if SessionDb ever drifts away from
// the SessionStore port — the future-proofing guard the brief asks for.

import { describe, expect, test } from 'bun:test';
import type { SessionDb } from '../../src/agent/sessionDb.js';
import type { ContentBlock, TokenUsage } from '../../src/core/types.js';
import { createInMemorySessionStore } from '../../src/persistence/inMemoryStore.js';
import type { SessionStore } from '../../src/persistence/sessionStore.js';

const textBlock = (t: string): ContentBlock => ({ type: 'text', text: t });

describe('createInMemorySessionStore', () => {
  test('createSession + getSession round-trips every field with defaults', () => {
    const store: SessionStore = createInMemorySessionStore();
    const id = store.createSession({
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      title: 'pilot session',
      systemPrompt: [{ text: 'system a', cacheable: true }],
      metadata: { bundleRoot: '/tmp/bundle', note: 42 },
    });
    expect(id.length).toBeGreaterThan(0);

    const session = store.getSession(id);
    expect(session).not.toBeNull();
    expect(session?.sessionId).toBe(id);
    expect(session?.model).toBe('claude-sonnet-4-6');
    expect(session?.provider).toBe('anthropic');
    // Defaults mirror SessionDb: platform 'cli', null parent/owner, zeroed usage.
    expect(session?.platform).toBe('cli');
    expect(session?.title).toBe('pilot session');
    expect(session?.systemPrompt).toEqual([{ text: 'system a', cacheable: true }]);
    expect(session?.metadata).toEqual({ bundleRoot: '/tmp/bundle', note: 42 });
    expect(session?.parentSessionId).toBeNull();
    expect(session?.ownerId).toBeNull();
    expect(session?.inputTokens).toBe(0);
    expect(session?.outputTokens).toBe(0);
    expect(session?.estimatedCostUsd).toBe(0);
    expect(session?.compactionInputTokens).toBe(0);
    expect(session?.estimatedCompactionCostUsd).toBe(0);
  });

  test('getSession returns null for an unknown id', () => {
    const store = createInMemorySessionStore();
    expect(store.getSession('no-such-id')).toBeNull();
  });

  test('createSession honors a caller-supplied sessionId', () => {
    const store = createInMemorySessionStore();
    const id = store.createSession({ model: 'm', provider: 'p', sessionId: 'fixed-id' });
    expect(id).toBe('fixed-id');
    expect(store.getSession('fixed-id')?.model).toBe('m');
  });

  test('default platform is cli and metadata defaults to empty object', () => {
    const store = createInMemorySessionStore();
    const id = store.createSession({ model: 'm', provider: 'p' });
    const session = store.getSession(id);
    expect(session?.platform).toBe('cli');
    expect(session?.metadata).toEqual({});
  });

  test('saveMessage + loadMessages round-trips content in insertion order', () => {
    const store = createInMemorySessionStore();
    const id = store.createSession({ model: 'm', provider: 'p' });
    const id1 = store.saveMessage(id, { role: 'user', content: [textBlock('first')] });
    const id2 = store.saveMessage(id, { role: 'assistant', content: [textBlock('second')] });
    // Each saved message gets a fresh ascending id.
    expect(id2).toBeGreaterThan(id1);

    const messages = store.loadMessages(id);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.content).toEqual([textBlock('first')]);
    expect(messages[1]?.role).toBe('assistant');
    expect(messages[1]?.content).toEqual([textBlock('second')]);
    // Defaults for optional fields mirror SessionDb's null/0 normalization.
    expect(messages[0]?.toolCallId).toBeNull();
    expect(messages[0]?.toolCalls).toBeNull();
    expect(messages[0]?.tokenCount).toBe(0);
    expect(messages[0]?.sessionId).toBe(id);
  });

  test('loadMessages returns an empty array for a session with no messages', () => {
    const store = createInMemorySessionStore();
    const id = store.createSession({ model: 'm', provider: 'p' });
    expect(store.loadMessages(id)).toEqual([]);
  });

  test('loadMessages isolates messages per session', () => {
    const store = createInMemorySessionStore();
    const a = store.createSession({ model: 'm', provider: 'p' });
    const b = store.createSession({ model: 'm', provider: 'p' });
    store.saveMessage(a, { role: 'user', content: [textBlock('a-only')] });
    expect(store.loadMessages(a)).toHaveLength(1);
    expect(store.loadMessages(b)).toEqual([]);
  });

  test('recordTokenUsage accumulates usage + cost readable via getSession', () => {
    const store = createInMemorySessionStore();
    const id = store.createSession({ model: 'm', provider: 'p' });
    const usage: TokenUsage = {
      inputTokens: 100,
      outputTokens: 40,
      cacheCreationInputTokens: 7,
      cacheReadInputTokens: 3,
    };
    store.recordTokenUsage(id, usage, 0.0125);
    let session = store.getSession(id);
    expect(session?.inputTokens).toBe(100);
    expect(session?.outputTokens).toBe(40);
    expect(session?.cacheCreationInputTokens).toBe(7);
    expect(session?.cacheReadInputTokens).toBe(3);
    expect(session?.estimatedCostUsd).toBeCloseTo(0.0125, 6);

    // Second record accumulates (mirrors SQL `SET x = x + ?`).
    store.recordTokenUsage(id, { inputTokens: 50 }, 0.005);
    session = store.getSession(id);
    expect(session?.inputTokens).toBe(150);
    expect(session?.estimatedCostUsd).toBeCloseTo(0.0175, 6);
  });

  test('upsertSession is idempotent for a supplied id and creates otherwise', () => {
    const store = createInMemorySessionStore();
    const first = store.upsertSession({ model: 'm', provider: 'p', sessionId: 'same' });
    const second = store.upsertSession({ model: 'other', provider: 'p', sessionId: 'same' });
    expect(first).toBe('same');
    expect(second).toBe('same');
    // First call seeds the row; the second is a no-op (config not overwritten).
    expect(store.getSession('same')?.model).toBe('m');

    const fresh = store.upsertSession({ model: 'm', provider: 'p' });
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh).not.toBe('same');
  });

  test('updateSessionModel persists a model change', () => {
    const store = createInMemorySessionStore();
    const id = store.createSession({ model: 'old', provider: 'p' });
    store.updateSessionModel(id, 'new');
    expect(store.getSession(id)?.model).toBe('new');
  });

  test('getSession with an owner scopes by owner_id', () => {
    const store = createInMemorySessionStore();
    const owned = store.createSession({ model: 'm', provider: 'p', owner: 'alice' });
    // Matching owner sees the row; a different owner sees nothing (existence-hiding).
    expect(store.getSession(owned, 'alice')?.ownerId).toBe('alice');
    expect(store.getSession(owned, 'bob')).toBeNull();
    // An unowned row never matches a real principal.
    const unowned = store.createSession({ model: 'm', provider: 'p' });
    expect(store.getSession(unowned, 'alice')).toBeNull();
    expect(store.getSession(unowned)?.ownerId).toBeNull();
  });
});

describe('SessionDb structurally satisfies SessionStore', () => {
  test('type-level conformance (compile-time guard)', () => {
    // If SessionDb ever drifts from the port, this assignment fails `tsc`
    // (the build), not this runtime assertion. Kept as a live test so the
    // file documents the contract; the real enforcement is the typecheck.
    const check: SessionStore = {} as SessionDb;
    expect(check).toBeDefined();
  });
});

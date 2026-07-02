import { describe, expect, test } from 'bun:test';
import type { SystemSegment } from '@yevgetman/sov-sdk/core/types';
import { SessionDb } from '../../src/agent/sessionDb.js';
import { createClearedChildSession } from '../../src/agent/sessionRecovery.js';

function openMem(): SessionDb {
  return SessionDb.open({ path: ':memory:' });
}

describe('createClearedChildSession', () => {
  test('creates an empty child session and preserves parent transcript for debugging', () => {
    const db = openMem();
    const systemPrompt: SystemSegment[] = [{ text: 'system', cacheable: true }];
    const parent = db.createSession({
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      platform: 'cli',
      systemPrompt,
      metadata: { bundleRoot: '/bundle' },
    });
    db.saveMessage(parent, {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }],
    });

    const result = createClearedChildSession(db, {
      parentSessionId: parent,
      model: 'claude-opus-4-7',
      metadata: { contextLength: 200000 },
      now: new Date('2026-04-27T12:00:00.000Z'),
    });

    const child = db.getSession(result.newSessionId);
    expect(result.parentSessionId).toBe(parent);
    expect(child?.parentSessionId).toBe(parent);
    expect(child?.model).toBe('claude-opus-4-7');
    expect(child?.provider).toBe('anthropic');
    expect(child?.systemPrompt).toEqual(systemPrompt);
    expect(child?.metadata).toMatchObject({
      bundleRoot: '/bundle',
      contextLength: 200000,
      recoveryKind: 'clear',
      clearedFromSessionId: parent,
      clearedAt: '2026-04-27T12:00:00.000Z',
    });
    expect(db.loadMessages(result.newSessionId)).toHaveLength(0);
    expect(db.loadMessages(parent)).toHaveLength(1);
    db.close();
  });

  test('carries the explicit owner onto the cleared child (Phase E multi-user)', () => {
    // Phase E regression: on the multi-user gateway a principal's /clear must
    // mint a child OWNED by that principal. Without the owner, the child row is
    // unowned (owner_id null) and the principal's next /turns hits
    // loadOwnedSession → 404, killing the conversation.
    const db = openMem();
    const parent = db.createSession({
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      platform: 'cli',
      owner: 'alice',
    });

    const result = createClearedChildSession(db, {
      parentSessionId: parent,
      owner: 'alice',
    });

    const child = db.getSession(result.newSessionId);
    expect(child?.ownerId).toBe('alice');
    db.close();
  });

  test('falls back to the parent owner when no explicit owner is passed', () => {
    // Defense-in-depth: even if a caller forgets to thread the owner, the
    // child still inherits the parent's owner so it never silently leaks into
    // the unowned namespace.
    const db = openMem();
    const parent = db.createSession({
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      platform: 'cli',
      owner: 'bob',
    });

    const result = createClearedChildSession(db, { parentSessionId: parent });

    const child = db.getSession(result.newSessionId);
    expect(child?.ownerId).toBe('bob');
    db.close();
  });

  test('child stays unowned when the parent is unowned (single-user back-compat)', () => {
    const db = openMem();
    const parent = db.createSession({
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      platform: 'cli',
    });

    const result = createClearedChildSession(db, { parentSessionId: parent });

    const child = db.getSession(result.newSessionId);
    expect(child?.ownerId).toBeNull();
    db.close();
  });
});

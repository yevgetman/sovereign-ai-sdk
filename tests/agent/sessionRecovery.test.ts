import { describe, expect, test } from 'bun:test';
import { SessionDb } from '../../src/agent/sessionDb.js';
import { createClearedChildSession } from '../../src/agent/sessionRecovery.js';
import type { SystemSegment } from '../../src/core/types.js';

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
});

// listSessions + updateSessionModel — Wave 2 additions used by the
// /resume picker and the persisted /model change.

import { describe, expect, test } from 'bun:test';
import { SessionDb } from '../../src/agent/sessionDb.js';

function open(): SessionDb {
  return SessionDb.open({ path: ':memory:' });
}

describe('SessionDb.listSessions', () => {
  test('returns sessions newest-first by last_updated', async () => {
    const db = open();
    const a = db.createSession({ model: 'haiku', provider: 'anthropic' });
    await Bun.sleep(2);
    const b = db.createSession({ model: 'opus', provider: 'anthropic' });
    await Bun.sleep(2);
    db.saveMessage(a, { role: 'user', content: [{ type: 'text', text: 'hello A' }] });
    const list = db.listSessions(10);
    expect(list[0]?.sessionId).toBe(a); // a was just touched by saveMessage
    expect(list[1]?.sessionId).toBe(b);
    db.close();
  });

  test('limit caps the result count', () => {
    const db = open();
    for (let i = 0; i < 5; i++) {
      db.createSession({ model: 'm', provider: 'p' });
    }
    expect(db.listSessions(3)).toHaveLength(3);
    expect(db.listSessions(10)).toHaveLength(5);
    db.close();
  });

  test('title falls back to first user message text, truncated', () => {
    const db = open();
    const id = db.createSession({ model: 'm', provider: 'p' });
    const longText = 'a'.repeat(200);
    db.saveMessage(id, { role: 'user', content: [{ type: 'text', text: longText }] });
    const entry = db.listSessions(10)[0];
    expect(entry?.title).not.toBeNull();
    expect((entry?.title ?? '').length).toBeLessThanOrEqual(60);
    expect((entry?.title ?? '').endsWith('...')).toBe(true);
    db.close();
  });

  test('msgCount and totalTokens reflect activity', () => {
    const db = open();
    const id = db.createSession({ model: 'm', provider: 'p' });
    db.saveMessage(id, { role: 'user', content: [{ type: 'text', text: 'hi' }] });
    db.saveMessage(id, { role: 'assistant', content: [{ type: 'text', text: 'hello' }] });
    db.recordTokenUsage(id, { inputTokens: 100, outputTokens: 50 }, 0.0042);
    const entry = db.listSessions(10)[0];
    expect(entry?.msgCount).toBe(2);
    expect(entry?.totalTokens).toBe(150);
    expect(entry?.totalCostUsd).toBeCloseTo(0.0042, 5);
    db.close();
  });

  test('returns empty array when no sessions exist', () => {
    const db = open();
    expect(db.listSessions()).toEqual([]);
    db.close();
  });
});

describe('SessionDb.updateSessionModel', () => {
  test('persists a model change and bumps last_updated', async () => {
    const db = open();
    const id = db.createSession({ model: 'haiku', provider: 'anthropic' });
    const before = db.getSession(id)?.lastUpdated ?? 0;
    await Bun.sleep(2);
    db.updateSessionModel(id, 'sonnet-4-6');
    const after = db.getSession(id);
    expect(after?.model).toBe('sonnet-4-6');
    expect(after?.lastUpdated).toBeGreaterThan(before);
    db.close();
  });

  test('no-op for unknown session id', () => {
    const db = open();
    // Should not throw. The UPDATE simply matches no rows.
    db.updateSessionModel('does-not-exist', 'foo');
    db.close();
  });
});

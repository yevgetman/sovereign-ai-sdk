// sessionDb tests — everything runs in-memory (`path: ':memory:'`) so we
// never touch the filesystem. Each test opens its own DB to keep state
// isolated.

import { describe, expect, test } from 'bun:test';
import { SessionDb } from '../../src/agent/sessionDb.js';
import type { ContentBlock, SystemSegment } from '../../src/core/types.js';

function openMem(): SessionDb {
  return SessionDb.open({ path: ':memory:' });
}

const textBlock = (t: string): ContentBlock => ({ type: 'text', text: t });

describe('SessionDb.open', () => {
  test('applies schema on first open', () => {
    const db = openMem();
    // If schema were not applied, createSession would throw on missing table.
    const id = db.createSession({ model: 'm', provider: 'p' });
    expect(id.length).toBeGreaterThan(0);
    db.close();
  });

  test('reopening against same in-memory handle would reset — expected; each test opens fresh', () => {
    const a = openMem();
    a.createSession({ model: 'm', provider: 'p' });
    a.close();
    const b = openMem();
    // Fresh in-memory DB — no sessions from the previous handle leak through.
    expect(b.getSession('nonexistent')).toBeNull();
    b.close();
  });
});

describe('createSession + getSession', () => {
  test('returns a UUID and stores every field', () => {
    const db = openMem();
    const sysPrompt: SystemSegment[] = [
      { text: 'system a', cacheable: true },
      { text: 'system b', cacheable: false },
    ];
    const id = db.createSession({
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      platform: 'cli',
      title: 'pilot session',
      systemPrompt: sysPrompt,
      metadata: { bundleRoot: '/tmp/bundle', note: 42 },
    });
    const session = db.getSession(id);
    expect(session).not.toBeNull();
    expect(session?.model).toBe('claude-sonnet-4-6');
    expect(session?.provider).toBe('anthropic');
    expect(session?.platform).toBe('cli');
    expect(session?.title).toBe('pilot session');
    expect(session?.systemPrompt).toEqual(sysPrompt);
    expect(session?.metadata).toEqual({ bundleRoot: '/tmp/bundle', note: 42 });
    expect(session?.schemaVersion).toBe(4);
    expect(session?.parentSessionId).toBeNull();
    expect(session?.inputTokens).toBe(0);
    expect(session?.estimatedCostUsd).toBe(0);
    expect(session?.compactionInputTokens).toBe(0);
    expect(session?.estimatedCompactionCostUsd).toBe(0);
    db.close();
  });

  test("default platform is 'cli' and metadata defaults to empty object", () => {
    const db = openMem();
    const id = db.createSession({ model: 'm', provider: 'p' });
    const session = db.getSession(id);
    expect(session?.platform).toBe('cli');
    expect(session?.metadata).toEqual({});
    db.close();
  });

  test('getSession returns null for an unknown id', () => {
    const db = openMem();
    expect(db.getSession('no-such-id')).toBeNull();
    db.close();
  });
});

describe('saveMessage + loadMessages', () => {
  test('roundtrips content blocks in insertion order', () => {
    const db = openMem();
    const id = db.createSession({ model: 'm', provider: 'p' });
    db.saveMessage(id, { role: 'user', content: [textBlock('first')] });
    db.saveMessage(id, { role: 'assistant', content: [textBlock('second')] });
    db.saveMessage(id, { role: 'user', content: [textBlock('third')] });
    const loaded = db.loadMessages(id);
    expect(loaded).toHaveLength(3);
    expect(loaded[0]?.role).toBe('user');
    expect(loaded[1]?.role).toBe('assistant');
    expect(loaded[2]?.role).toBe('user');
    expect((loaded[0]?.content[0] as { text: string }).text).toBe('first');
    expect((loaded[1]?.content[0] as { text: string }).text).toBe('second');
    expect((loaded[2]?.content[0] as { text: string }).text).toBe('third');
    db.close();
  });

  test('preserves complex content (tool_use + tool_result blocks)', () => {
    const db = openMem();
    const id = db.createSession({ model: 'm', provider: 'p' });
    const mixed: ContentBlock[] = [
      { type: 'text', text: 'checking' },
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
    ];
    db.saveMessage(id, { role: 'assistant', content: mixed });
    db.saveMessage(id, {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: 'exit_code: 0\n--- stdout ---\nfile1',
        },
      ],
    });
    const loaded = db.loadMessages(id);
    expect(loaded[0]?.content).toEqual(mixed);
    const resultBlock = loaded[1]?.content[0] as { type: string; tool_use_id: string };
    expect(resultBlock.type).toBe('tool_result');
    expect(resultBlock.tool_use_id).toBe('toolu_1');
    db.close();
  });

  test('messages from different sessions do not cross-pollute', () => {
    const db = openMem();
    const a = db.createSession({ model: 'm', provider: 'p' });
    const b = db.createSession({ model: 'm', provider: 'p' });
    db.saveMessage(a, { role: 'user', content: [textBlock('for-a')] });
    db.saveMessage(b, { role: 'user', content: [textBlock('for-b')] });
    expect(db.loadMessages(a)).toHaveLength(1);
    expect(db.loadMessages(b)).toHaveLength(1);
    expect((db.loadMessages(a)[0]?.content[0] as { text: string }).text).toBe('for-a');
    db.close();
  });

  test('saveMessage bumps sessions.last_updated', async () => {
    const db = openMem();
    const id = db.createSession({ model: 'm', provider: 'p' });
    const before = db.getSession(id)?.lastUpdated ?? 0;
    // Tiny delay so Date.now() advances on coarse clocks.
    await new Promise((r) => setTimeout(r, 5));
    db.saveMessage(id, { role: 'user', content: [textBlock('ping')] });
    const after = db.getSession(id)?.lastUpdated ?? 0;
    expect(after).toBeGreaterThan(before);
    db.close();
  });
});

describe('getSystemPrompt', () => {
  test('returns what was stored verbatim (Invariant #4 storage guarantee)', () => {
    const db = openMem();
    const sys: SystemSegment[] = [
      { text: 'segment-one with "quotes" and \n newlines', cacheable: true },
      { text: 'segment-two', cacheable: false },
    ];
    const id = db.createSession({ model: 'm', provider: 'p', systemPrompt: sys });
    expect(db.getSystemPrompt(id)).toEqual(sys);
    db.close();
  });

  test('returns null when no system prompt was provided', () => {
    const db = openMem();
    const id = db.createSession({ model: 'm', provider: 'p' });
    expect(db.getSystemPrompt(id)).toBeNull();
    db.close();
  });
});

describe('search (FTS5)', () => {
  test('finds messages whose content contains the query term', () => {
    const db = openMem();
    const id = db.createSession({ model: 'm', provider: 'p' });
    db.saveMessage(id, { role: 'user', content: [textBlock('the quick brown fox')] });
    db.saveMessage(id, { role: 'assistant', content: [textBlock('jumped over lazy dog')] });
    db.saveMessage(id, { role: 'user', content: [textBlock('totally unrelated coffee')] });

    const foxHits = db.search('fox');
    expect(foxHits).toHaveLength(1);
    expect((foxHits[0]?.content[0] as { text: string }).text).toContain('fox');

    const coffeeHits = db.search('coffee');
    expect(coffeeHits).toHaveLength(1);
    db.close();
  });

  test('scopes by sessionId when provided', () => {
    const db = openMem();
    const a = db.createSession({ model: 'm', provider: 'p' });
    const b = db.createSession({ model: 'm', provider: 'p' });
    db.saveMessage(a, { role: 'user', content: [textBlock('cerulean sky')] });
    db.saveMessage(b, { role: 'user', content: [textBlock('cerulean sea')] });

    const scoped = db.search('cerulean', { sessionId: a });
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.sessionId).toBe(a);

    const all = db.search('cerulean');
    expect(all).toHaveLength(2);
    db.close();
  });

  test('respects the limit option', () => {
    const db = openMem();
    const id = db.createSession({ model: 'm', provider: 'p' });
    for (let i = 0; i < 5; i++) {
      db.saveMessage(id, { role: 'user', content: [textBlock(`needle line ${i}`)] });
    }
    const hits = db.search('needle', { limit: 2 });
    expect(hits).toHaveLength(2);
    db.close();
  });
});

describe('cost accounting', () => {
  test('recordTokenUsage accumulates token lanes and estimated cost', () => {
    const db = openMem();
    const id = db.createSession({ model: 'm', provider: 'p' });
    db.recordTokenUsage(
      id,
      {
        inputTokens: 10,
        outputTokens: 20,
        cacheCreationInputTokens: 30,
        cacheReadInputTokens: 40,
      },
      0.001,
    );
    db.recordTokenUsage(id, { inputTokens: 1, outputTokens: 2 }, 0.002);

    const cost = db.getSessionCost(id);
    expect(cost).toEqual({
      inputTokens: 11,
      outputTokens: 22,
      cacheCreationInputTokens: 30,
      cacheReadInputTokens: 40,
      estimatedCostUsd: 0.003,
      compactionInputTokens: 0,
      compactionOutputTokens: 0,
      estimatedCompactionCostUsd: 0,
    });
    const session = db.getSession(id);
    expect(session?.inputTokens).toBe(11);
    expect(session?.estimatedCostUsd).toBe(0.003);
    db.close();
  });

  test('recordCompactionUsage accumulates separate compaction lanes', () => {
    const db = openMem();
    const id = db.createSession({ model: 'm', provider: 'p' });
    db.recordCompactionUsage(id, { inputTokens: 100, outputTokens: 20 }, 0.004);
    db.recordCompactionUsage(id, { inputTokens: 10 }, 0.001);

    const cost = db.getSessionCost(id);
    expect(cost.compactionInputTokens).toBe(110);
    expect(cost.compactionOutputTokens).toBe(20);
    expect(cost.estimatedCompactionCostUsd).toBe(0.005);
    const session = db.getSession(id);
    expect(session?.compactionInputTokens).toBe(110);
    expect(session?.estimatedCompactionCostUsd).toBe(0.005);
    db.close();
  });

  test('recordCompactionLineage records child links without mutating parent session', () => {
    const db = openMem();
    const parent = db.createSession({ model: 'm', provider: 'p' });
    const child = db.createSession({ model: 'm', provider: 'p', parentSessionId: parent });
    db.saveMessage(parent, { role: 'user', content: [textBlock('keep me')] });
    const before = db.getSession(parent)?.lastUpdated;
    db.recordCompactionLineage(parent, child);

    const session = db.getSession(parent);
    expect(session?.lastUpdated).toBe(before);
    const links = db.getCompactionsForParent(parent);
    expect(links).toHaveLength(1);
    expect(links[0]?.childSessionId).toBe(child);
    expect(links[0]?.createdAt).toBeGreaterThan(0);
    expect(db.loadMessages(parent)).toHaveLength(1);
    expect(db.getSession(child)?.parentSessionId).toBe(parent);
    db.close();
  });
});

describe('schema versioning', () => {
  test('new DB reports schema_version = 4 via sessions.schemaVersion', () => {
    const db = openMem();
    const id = db.createSession({ model: 'm', provider: 'p' });
    expect(db.getSession(id)?.schemaVersion).toBe(4);
    db.close();
  });
});

describe('schema v4 — tasks table', () => {
  test('tasks table exists after migration and supports a basic insert', () => {
    const db = openMem();
    const sessionId = db.createSession({ model: 'm', provider: 'p' });
    // The Database getter is exposed so the new TaskStore can share this
    // connection. Reaching into it from a test is acceptable here — the
    // test exercises the migration directly, not store APIs.
    const handle = db.handle;
    handle.run(
      `INSERT INTO tasks (
        task_id, parent_session_id, agent, prompt,
        state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['t-1', sessionId, 'explore', 'find auth', 'queued', 1, 1],
    );
    const row = handle
      .query<{ task_id: string; state: string }, []>(
        `SELECT task_id, state FROM tasks WHERE task_id = 't-1'`,
      )
      .get();
    expect(row?.task_id).toBe('t-1');
    expect(row?.state).toBe('queued');
    db.close();
  });

  test('tasks.state CHECK constraint rejects unknown states', () => {
    const db = openMem();
    const sessionId = db.createSession({ model: 'm', provider: 'p' });
    expect(() =>
      db.handle.run(
        `INSERT INTO tasks (
          task_id, parent_session_id, agent, prompt,
          state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['t-bad', sessionId, 'explore', 'x', 'wat', 1, 1],
      ),
    ).toThrow();
    db.close();
  });

  test('newly created sessions report schema_version 4', () => {
    const db = openMem();
    const id = db.createSession({ model: 'm', provider: 'p' });
    expect(db.getSession(id)?.schemaVersion).toBe(4);
    db.close();
  });
});

// Phase 13.3 follow-up — cleanupPhantomReviews
describe('SessionDb.cleanupPhantomReviews', () => {
  test('removes zero-token review rows older than threshold', () => {
    const db = openMem();
    // Insert a phantom: title matches, zero tokens (default), no messages, backdated 2h.
    const id = db.createSession({
      model: 'm',
      provider: 'p',
      title: 'subagent:review-memory',
    });
    const oldSec = (Date.now() - 7_200_000) / 1000; // 2 hours ago
    db.handle.prepare('UPDATE sessions SET created_at = ? WHERE session_id = ?').run(oldSec, id);

    const deleted = db.cleanupPhantomReviews();
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(
      db.handle.prepare('SELECT count(*) AS n FROM sessions WHERE session_id = ?').get(id),
    ).toEqual({ n: 0 });
    db.close();
  });

  test('preserves productive review rows (has tokens)', () => {
    const db = openMem();
    const id = db.createSession({
      model: 'm',
      provider: 'p',
      title: 'subagent:review-memory',
    });
    const oldSec = (Date.now() - 7_200_000) / 1000;
    db.handle
      .prepare(
        'UPDATE sessions SET created_at = ?, input_tokens = 100, output_tokens = 50 WHERE session_id = ?',
      )
      .run(oldSec, id);

    const deleted = db.cleanupPhantomReviews();
    expect(deleted).toBe(0);
    db.close();
  });

  test('preserves recent phantoms (within 1h threshold)', () => {
    const db = openMem();
    // No backdate — created_at is now-ish, well within the default 1-hour window.
    db.createSession({
      model: 'm',
      provider: 'p',
      title: 'subagent:review-memory',
    });

    const deleted = db.cleanupPhantomReviews();
    expect(deleted).toBe(0);
    db.close();
  });

  test('preserves non-review subagent rows (title mismatch)', () => {
    const db = openMem();
    const id = db.createSession({
      model: 'm',
      provider: 'p',
      title: 'subagent:explore',
    });
    const oldSec = (Date.now() - 7_200_000) / 1000;
    db.handle.prepare('UPDATE sessions SET created_at = ? WHERE session_id = ?').run(oldSec, id);

    const deleted = db.cleanupPhantomReviews();
    expect(deleted).toBe(0);
    db.close();
  });

  test('respects custom maxAgeMs threshold', () => {
    const db = openMem();
    const id = db.createSession({
      model: 'm',
      provider: 'p',
      title: 'subagent:review-skill',
    });
    // Backdate by 30 minutes — older than a 15-minute threshold, newer than 1h.
    const thirtyMinAgoSec = (Date.now() - 1_800_000) / 1000;
    db.handle
      .prepare('UPDATE sessions SET created_at = ? WHERE session_id = ?')
      .run(thirtyMinAgoSec, id);

    // Default 1h threshold — should not delete (row is 30min old).
    expect(db.cleanupPhantomReviews()).toBe(0);

    // Custom 15-minute threshold — should now delete.
    const deleted = db.cleanupPhantomReviews(900_000); // 15 min
    expect(deleted).toBe(1);
    db.close();
  });
});

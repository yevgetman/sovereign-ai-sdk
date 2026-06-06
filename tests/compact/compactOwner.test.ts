// Phase E H1 (High) — the compaction child must inherit the parent's owner.
//
// Before the fix, compactSession copied model/provider/platform/parent/
// systemPrompt/metadata/title onto the child but NOT `owner`. After a
// compaction pivot, turns.ts rebuilds context via getSessionContext(childId)
// and finds ownerId=null → the rest of the turn writes memory/learning under
// the SHARED legacy namespace instead of users/{owner}/… (cross-user leak).
//
// This test creates an owned session, runs compaction directly, and asserts the
// child row's ownerId matches the parent's owner.

import { describe, expect, test } from 'bun:test';
import { SessionDb } from '../../src/agent/sessionDb.js';
import { compactSession } from '../../src/compact/compactor.js';
import type { Message, SystemSegment } from '../../src/core/types.js';

const text = (value: string) => ({ type: 'text' as const, text: value });

function openDb(): SessionDb {
  return SessionDb.open({ path: ':memory:' });
}

describe('compactSession — owner inheritance (Phase E H1)', () => {
  test('compaction child inherits the parent session owner', async () => {
    const db = openDb();
    const systemPrompt: SystemSegment[] = [{ text: 'system rules', cacheable: true }];
    const parent = db.createSession({
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      platform: 'cli',
      systemPrompt,
      metadata: { bundleRoot: '/tmp/bundle', contextLength: 1000 },
      owner: 'alice',
    });
    const history: Message[] = [
      { role: 'user', content: [text('old decision: keep alpha')] },
      { role: 'assistant', content: [text('resolved: alpha is keep')] },
      { role: 'user', content: [text('current task: continue')] },
    ];
    for (const message of history) {
      db.saveMessage(parent, { role: message.role, content: message.content });
    }

    const result = await compactSession({
      db,
      sessionId: parent,
      model: 'claude-sonnet-4-6',
      providerName: 'anthropic',
      systemPrompt,
      history,
      tailTokenBudget: 1,
      minTailMessages: 1,
      summarize: async () => '## Active Task\n- Continue.',
    });

    // The compaction must have actually produced a child (not a no-op).
    expect(result.newSessionId).not.toBe(parent);
    const child = db.getSession(result.newSessionId);
    expect(child?.ownerId).toBe('alice');
    db.close();
  });

  test('unowned parent yields an unowned child (back-compat)', async () => {
    const db = openDb();
    const systemPrompt: SystemSegment[] = [{ text: 'system rules', cacheable: true }];
    const parent = db.createSession({
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      platform: 'cli',
      systemPrompt,
      metadata: { contextLength: 1000 },
    });
    const history: Message[] = [
      { role: 'user', content: [text('a')] },
      { role: 'assistant', content: [text('b')] },
      { role: 'user', content: [text('c')] },
    ];
    for (const message of history) {
      db.saveMessage(parent, { role: message.role, content: message.content });
    }

    const result = await compactSession({
      db,
      sessionId: parent,
      model: 'claude-sonnet-4-6',
      providerName: 'anthropic',
      systemPrompt,
      history,
      tailTokenBudget: 1,
      minTailMessages: 1,
      summarize: async () => '## Active Task\n- Continue.',
    });

    expect(result.newSessionId).not.toBe(parent);
    const child = db.getSession(result.newSessionId);
    expect(child?.ownerId).toBeNull();
    db.close();
  });
});

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repairMissingToolResults } from '@yevgetman/sov-sdk/core/transcriptRepair';
import type { Message } from '@yevgetman/sov-sdk/core/types';
import { createInMemorySessionStore } from '@yevgetman/sov-sdk/persistence/inMemoryStore';
import type {
  ToolExecution,
  ToolExecutionStore,
} from '@yevgetman/sov-sdk/persistence/sessionStore';
import { SessionDb } from '../../src/agent/sessionDb.js';

for (const kind of ['sqlite', 'memory']) {
  test(`${kind} completed receipts resist interruption and truncate with their assistant row`, () => {
    const db = kind === 'sqlite' ? SessionDb.open({ path: ':memory:' }) : undefined;
    const store = db ?? createInMemorySessionStore();
    const sessionId = store.upsertSession({ model: 'fixture', provider: 'fixture' });
    const assistantMessageId = store.saveMessage(sessionId, {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call', name: 'Effect', input: {} }],
    });
    const journal = store as ToolExecutionStore;
    const receipt: ToolExecution = {
      assistantMessageId,
      toolUseId: 'call',
      state: 'completed',
      result: { type: 'tool_result', tool_use_id: 'call', content: 'exact receipt' },
      newMessages: [{ role: 'user', content: [{ type: 'text', text: 'extra' }] }],
    };
    journal.saveToolExecution(sessionId, receipt);
    journal.saveToolExecution(sessionId, {
      assistantMessageId,
      toolUseId: 'call',
      state: 'interrupted',
    });
    expect(journal.loadToolExecutions(sessionId)).toEqual([receipt]);
    store.truncateMessages?.(sessionId, 0);
    expect(journal.loadToolExecutions(sessionId)).toEqual([]);
    db?.close();
  });
}

test('SQLite schema 7 migrates without changing raw history; old orphan stays unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sov-journal-migration-'));
  const path = join(dir, 'sessions.db');
  try {
    const current = SessionDb.open({ path });
    const sessionId = current.upsertSession({ model: 'fixture', provider: 'fixture' });
    current.saveMessage(sessionId, {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'old', name: 'Effect', input: {} }],
    });
    const before = current.loadMessages(sessionId);
    current.close();
    const v7 = new Database(path);
    v7.run('DROP TABLE tool_executions');
    // logical_turns is v9. Leaving the already-migrated table makes v9→v10
    // ADD COLUMN fail because CREATE TABLE IF NOT EXISTS will not rebuild it.
    v7.run('DROP TABLE logical_turns');
    v7.run('UPDATE state_meta SET schema_version = 7');
    v7.close();
    const migrated = SessionDb.open({ path });
    expect(migrated.loadMessages(sessionId)).toEqual(before);
    expect(migrated.loadToolExecutions(sessionId)).toEqual([]);
    const raw: Message[] = before.map(({ role, content }) => ({ role, content }));
    const repaired = repairMissingToolResults(
      raw,
      migrated.loadToolExecutions(sessionId),
      before.map((row) => row.id),
    );
    expect(repaired.messages[1]?.content[0]).toMatchObject({
      type: 'tool_result',
      is_error: true,
      content: expect.stringContaining('outcome unknown'),
    });
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('duplicate tool IDs bind to their own assistant row; ambiguous lookup stays unknown', () => {
  const raw: Message[] = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'same', name: 'Effect', input: {} }] },
  ];
  const executions: ToolExecution[] = [1, 2].map((id) => ({
    assistantMessageId: id,
    toolUseId: 'same',
    state: 'completed',
    result: { type: 'tool_result', tool_use_id: 'same', content: `receipt-${id}` },
  }));
  expect(repairMissingToolResults(raw, executions, [2]).messages[1]?.content[0]).toMatchObject({
    type: 'tool_result',
    content: 'receipt-2',
  });
  expect(repairMissingToolResults(raw, executions).messages[1]?.content[0]).toMatchObject({
    type: 'tool_result',
    content: expect.stringContaining('outcome unknown'),
  });
});

test('native and gateway loaders restore journal receipts without duplicating repaired rows', async () => {
  const { hydrateSessionHistory, loadStoredMessages } = await import(
    '../../src/server/turnComposition.js'
  );
  const { createAgent } = await import('@yevgetman/sov-sdk');
  const db = SessionDb.open({ path: ':memory:' });
  try {
    const sessionId = db.upsertSession({ model: 'fixture', provider: 'fixture' });
    db.saveMessage(sessionId, { role: 'user', content: [{ type: 'text', text: 'initial' }] });
    const assistantMessageId = db.saveMessage(sessionId, {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call', name: 'Effect', input: {} }],
    });
    db.saveToolExecution(sessionId, {
      assistantMessageId,
      toolUseId: 'call',
      state: 'completed',
      result: { type: 'tool_result', tool_use_id: 'call', content: 'known receipt' },
    });
    const before = db.loadMessages(sessionId);
    const persistence = { mode: 'sdk-store' as const, sessionStore: db };
    const view = hydrateSessionHistory(loadStoredMessages(persistence, sessionId), sessionId);
    expect(view).toHaveLength(3);
    const agent = createAgent({
      provider: {
        name: 'fixture',
        async *stream(request) {
          expect(request.messages).toEqual(view);
          const message = {
            role: 'assistant' as const,
            content: [{ type: 'text' as const, text: 'continued' }],
          };
          yield { type: 'message_stop' as const, stop_reason: 'end_turn' as const };
          yield { type: 'assistant_message' as const, message };
          return message;
        },
      },
      model: 'fixture',
      sessionStore: db,
    });
    const gen = agent.run(view, { sessionId, storedPrefixLength: view.length });
    for (;;) {
      if ((await gen.next()).done) break;
    }
    expect(db.loadMessages(sessionId)).toHaveLength(before.length + 1);
    expect(db.loadMessages(sessionId).slice(0, before.length)).toEqual(before);
    // Gateway callback loading uses exactly the same view and journal. The
    // SDK does not own canonical writes in that mode (covered by journal-only test).
    const gateway = { mode: 'gateway-callbacks' as const, host: { sessionDb: db } };
    expect(
      hydrateSessionHistory(
        loadStoredMessages(gateway as Parameters<typeof loadStoredMessages>[0], sessionId),
        sessionId,
      )[2]?.content[0],
    ).toMatchObject({ type: 'tool_result', content: 'known receipt' });
  } finally {
    db.close();
  }
});

test('explicit unknown imports and recovered started records stay unknown without rewriting raw evidence', () => {
  const raw: Message[] = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'Effect', input: {} }] },
  ];
  for (const state of ['started', 'unknown'] as const) {
    const execution: ToolExecution = { assistantMessageId: 1, toolUseId: 'call', state };
    const records = [execution];
    const recovered = repairMissingToolResults(raw, records, [1]);
    expect(recovered.messages[1]?.content[0]).toMatchObject({
      type: 'tool_result',
      is_error: true,
      content: expect.stringContaining('outcome unknown'),
    });
    expect(records).toEqual([{ assistantMessageId: 1, toolUseId: 'call', state }]);
    expect(raw).toHaveLength(1);
  }
});

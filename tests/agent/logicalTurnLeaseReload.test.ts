import { expect, test } from 'bun:test';
import { type RunResult, createAgent } from '@yevgetman/sov-sdk/agent/createAgent';
import {
  LOGICAL_TURN_LEASE_MS,
  LOGICAL_TURN_LEASE_RENEW_MS,
  LOGICAL_TURN_READ_PAGE,
  LogicalTurnLeaseError,
  logicalTurnCursor,
  superviseLogicalTurn,
} from '@yevgetman/sov-sdk/agent/logicalTurn';
import type { AssistantMessage, Message, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import { z } from 'zod';
import { SessionDb } from '../../src/agent/sessionDb.js';

const binding = {
  provider: 'fixture',
  model: 'fixture-model',
  cwd: '/tmp/project',
};

const STORED_MESSAGES = LOGICAL_TURN_READ_PAGE * 32 + 1;

function textMessage(role: 'user' | 'assistant', text: string): Message {
  return { role, content: [{ type: 'text', text }] };
}

function segmentResult(sessionId: string, reason: RunResult['terminal']['reason']): RunResult {
  return {
    sessionId,
    terminal: { reason },
    iterationsUsed: 1,
    toolCallCount: 0,
    distinctToolNames: [],
    messages: [],
  };
}

function seedTranscript(db: SessionDb, sessionId: string, count: number): void {
  const now = Date.now() / 1000;
  const insert = db.handle.prepare(
    `INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, token_count, created_at)
     VALUES (?, ?, ?, NULL, NULL, 0, ?)`,
  );
  const write = db.handle.transaction(() => {
    for (let i = 0; i < count; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant';
      insert.run(sessionId, role, JSON.stringify([{ type: 'text', text: `row-${i}` }]), now);
    }
  });
  write();
  const first = db.handle
    .query<{ id: number }, [string]>(
      'SELECT id FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 1',
    )
    .get(sessionId);
  if (!first) throw new Error('seed failed');
  const insertExec = db.handle.prepare(
    `INSERT INTO tool_executions (session_id, assistant_message_id, tool_use_id, state, receipt)
     VALUES (?, ?, ?, 'completed', ?)`,
  );
  const writeExec = db.handle.transaction(() => {
    for (let i = 0; i < count; i++) {
      insertExec.run(
        sessionId,
        first.id,
        `tool-${i}`,
        JSON.stringify({
          assistantMessageId: first.id,
          toolUseId: `tool-${i}`,
          state: 'completed',
        }),
      );
    }
  });
  writeExec();
}

test('a resumed logical turn does not rewrite the lease once per transcript page', async () => {
  const db = SessionDb.open({ path: ':memory:' });
  try {
    const sessionId = db.createSession({ model: 'fixture-model', provider: 'fixture' });
    seedTranscript(db, sessionId, STORED_MESSAGES);
    const pages = Math.ceil(STORED_MESSAGES / LOGICAL_TURN_READ_PAGE);
    let renews = 0;
    let checkpoints = 0;
    const renew = db.renewLogicalTurnLease.bind(db);
    db.renewLogicalTurnLease = (id, owner, expiresAt, countCheckpoint) => {
      renews += 1;
      return renew(id, owner, expiresAt, countCheckpoint);
    };
    const exec = db.handle.exec.bind(db.handle);
    db.handle.exec = (sql: string) => {
      if (sql.includes('wal_checkpoint')) checkpoints += 1;
      return exec(sql);
    };
    const load = db.loadMessages.bind(db);
    let loads = 0;
    db.loadMessages = (id: string) => {
      loads += 1;
      return load(id);
    };

    let boundaryRenews = 0;
    let gapRenews = 0;
    let roundRenews = 0;
    let roundLoads = 0;
    let roundCheckpoints = 0;
    let renewsAtBoundaryReturn = 0;
    const outcome = await superviseLogicalTurn({
      store: db,
      binding,
      sessionId,
      initialMessages: [textMessage('user', 'do the work')],
      rehydrate: () => [textMessage('user', 'do the work')],
      recoverySafe: () => true,
      readBoundary: () => {
        const start = renews;
        const rows = db.loadMessages(sessionId);
        db.loadToolExecutions(sessionId);
        logicalTurnCursor(rows);
        boundaryRenews = renews - start;
        renewsAtBoundaryReturn = renews;
        return {
          safe: true,
          progress: {
            transcriptIds: rows.map((row) => row.id),
            transcriptCount: rows.length,
            receipts: [],
            cursor: logicalTurnCursor(rows) ?? null,
            compactionChildId: sessionId,
          },
          messages: () => rows.map((row) => textMessage(row.role, String(row.id))),
        };
      },
      runSegment: async (segment) => {
        if (!segment.continuation) return segmentResult(sessionId, 'max_turns');
        gapRenews = renews - renewsAtBoundaryReturn;
        const startRenews = renews;
        const startLoads = loads;
        const startCheckpoints = checkpoints;
        let calls = 0;
        const agent = createAgent({
          provider: {
            name: 'fixture',
            async *stream(): AsyncGenerator<StreamEvent, AssistantMessage> {
              calls += 1;
              const message: AssistantMessage =
                calls === 1
                  ? {
                      role: 'assistant',
                      content: [{ type: 'tool_use', id: 'echo-1', name: 'Echo', input: {} }],
                    }
                  : { role: 'assistant', content: [{ type: 'text', text: 'done' }] };
              yield { type: 'message_start' };
              yield {
                type: 'message_stop',
                stop_reason: message.content.some((block) => block.type === 'tool_use')
                  ? 'tool_use'
                  : 'end_turn',
              };
              yield { type: 'assistant_message', message };
              return message;
            },
          },
          model: 'fixture-model',
          sessionStore: db,
          tools: [
            buildTool({
              name: 'Echo',
              description: () => 'Echo',
              inputSchema: z.object({}),
              async call() {
                return { data: 'ok' };
              },
            }),
          ],
        });
        const gen = agent.run(segment.messages, {
          sessionId,
          storedPrefixLength: segment.messages.length,
        });
        let completed: RunResult | undefined;
        for (;;) {
          const step = await gen.next();
          if (step.done) {
            completed = step.value;
            break;
          }
        }
        expect(completed?.terminal.reason).toBe('completed');
        roundRenews = renews - startRenews;
        roundLoads = loads - startLoads;
        roundCheckpoints = checkpoints - startCheckpoints;
        return completed ?? segmentResult(sessionId, 'completed');
      },
    });

    expect(outcome.status).toBe('completed');
    expect(pages).toBeGreaterThan(2);
    expect(boundaryRenews).toBe(0);
    // Supervisor renews around the boundary. A per-page walk would be `pages - 1`.
    expect(gapRenews).toBeLessThanOrEqual(8);
    expect(gapRenews).toBeLessThan(pages - 1);
    expect(roundRenews).toBe(0);
    expect(roundLoads).toBe(1);
    expect(roundCheckpoints).toBe(0);
  } finally {
    db.close();
  }
});

test('an already-expired lease fails a transcript read, including a single page', async () => {
  const db = SessionDb.open({ path: ':memory:' });
  try {
    const sessionId = db.createSession({ model: 'fixture-model', provider: 'fixture' });
    seedTranscript(db, sessionId, 1);
    const wideId = db.createSession({ model: 'fixture-model', provider: 'fixture' });
    seedTranscript(db, wideId, LOGICAL_TURN_READ_PAGE + 1);
    let nowMs = 8_000_000;
    let expired = false;
    await expect(
      superviseLogicalTurn({
        store: db,
        binding,
        sessionId,
        now: () => nowMs,
        initialMessages: [textMessage('user', 'do the work')],
        rehydrate: () => [textMessage('user', 'do the work')],
        recoverySafe: () => true,
        runSegment: async () => {
          nowMs += LOGICAL_TURN_LEASE_MS + 1;
          expect(() => db.loadMessages(sessionId)).toThrow(LogicalTurnLeaseError);
          expect(() => db.loadLatestMessage(sessionId)).toThrow(LogicalTurnLeaseError);
          expect(() => db.loadMessages(wideId)).toThrow(LogicalTurnLeaseError);
          expect(() => db.loadToolExecutions(wideId)).toThrow(LogicalTurnLeaseError);
          expect(() => logicalTurnCursor([{ content: [] }])).toThrow(LogicalTurnLeaseError);
          expired = true;
          return segmentResult(sessionId, 'completed');
        },
      }),
    ).rejects.toBeInstanceOf(LogicalTurnLeaseError);
    expect(expired).toBe(true);
  } finally {
    db.close();
  }
});

test('a paged read renews on the heartbeat gap and does not checkpoint', async () => {
  const db = SessionDb.open({ path: ':memory:' });
  try {
    const sessionId = db.createSession({ model: 'fixture-model', provider: 'fixture' });
    seedTranscript(db, sessionId, LOGICAL_TURN_READ_PAGE * 3);
    let nowMs = 9_000_000;
    let renews = 0;
    let checkpoints = 0;
    const renew = db.renewLogicalTurnLease.bind(db);
    db.renewLogicalTurnLease = (id, owner, expiresAt, countCheckpoint) => {
      renews += 1;
      return renew(id, owner, expiresAt, countCheckpoint);
    };
    const exec = db.handle.exec.bind(db.handle);
    db.handle.exec = (sql: string) => {
      if (sql.includes('wal_checkpoint')) checkpoints += 1;
      return exec(sql);
    };
    let readRenews = 0;
    let readCheckpoints = 0;
    const outcome = await superviseLogicalTurn({
      store: db,
      binding,
      sessionId,
      now: () => nowMs,
      initialMessages: [textMessage('user', 'do the work')],
      rehydrate: () => [textMessage('user', 'do the work')],
      recoverySafe: () => true,
      runSegment: async () => {
        const beforePad = checkpoints;
        let guard = 0;
        while (checkpoints === beforePad) {
          db.updateSessionModel(sessionId, `pad-${guard}`);
          guard += 1;
          if (guard > 60) throw new Error('checkpoint did not fire');
        }
        for (let i = 0; i < 49; i++) db.updateSessionModel(sessionId, `near-${i}`);
        nowMs += LOGICAL_TURN_LEASE_RENEW_MS;
        const startRenews = renews;
        const startCheckpoints = checkpoints;
        db.loadMessages(sessionId);
        db.loadToolExecutions(sessionId);
        logicalTurnCursor(db.loadMessages(sessionId));
        readRenews = renews - startRenews;
        readCheckpoints = checkpoints - startCheckpoints;
        db.updateSessionModel(sessionId, 'counted');
        expect(checkpoints).toBe(startCheckpoints + 1);
        return segmentResult(sessionId, 'completed');
      },
    });
    expect(outcome.status).toBe('completed');
    expect(readRenews).toBe(1);
    expect(readCheckpoints).toBe(0);
  } finally {
    db.close();
  }
});

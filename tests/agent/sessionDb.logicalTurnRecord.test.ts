import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LogicalTurnRecord } from '@yevgetman/sov-sdk/agent/logicalTurn';
import { LogicalTurnRecordError, SessionDb } from '../../src/agent/sessionDb.js';
import { runSdkRunCommand } from '../../src/cli/sdkRunCommand.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fileDb(): string {
  const root = mkdtempSync(join(tmpdir(), 'logical-turn-record-'));
  roots.push(root);
  return join(root, 'sessions.db');
}

function stored(id: string): LogicalTurnRecord {
  return {
    version: 1,
    logicalTurnId: id,
    sessionId: 'session-1',
    activeSessionId: 'session-1',
    compactedSessionIds: ['session-0'],
    binding: {
      route: 'openai-api',
      provider: 'openai',
      model: 'gpt-4.1',
      cwd: '/tmp/project',
    },
    bindingDigest: 'digest',
    segmentLimit: 10,
    logicalModelCallLimit: 100,
    status: 'running',
    repeatedNoProgress: 0,
    runtimeContinuationIds: [],
    counters: {
      segments: 1,
      modelCalls: 1,
      toolCalls: 0,
      providerRetries: 0,
      contextRecoveries: 0,
      inputTokens: 2,
      outputTokens: 3,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      estimatedCostUsd: 0.01,
    },
    createdAt: 1,
    updatedAt: 2,
  };
}

function insert(path: string, id: string, record: string): void {
  const db = SessionDb.open({ path });
  try {
    db.handle.run('INSERT INTO logical_turns (logical_turn_id, record) VALUES (?, ?)', [
      id,
      record,
    ]);
  } finally {
    db.close();
  }
}

async function continueTurn(path: string, id: string) {
  const events: Record<string, unknown>[] = [];
  const exitCode = await runSdkRunCommand(
    { json: true, sdk: true, db: path, continueLogicalTurn: id },
    {
      readStdin: async () => '',
      writeStdout: (line) => {
        events.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  return { exitCode, terminal: events.at(-1) };
}

test('loadLogicalTurn round-trips a version-1 record and misses an unknown id', () => {
  const db = SessionDb.open({ path: ':memory:' });
  try {
    const record = stored('lt-ok');
    record.originalUserMessageId = 4;
    record.deadlineAt = 50;
    record.lastCause = 'max_turns';
    record.finalReply = 'partial';
    record.finishReason = 'max_turns';
    db.createLogicalTurn(record);
    expect(db.loadLogicalTurn('lt-ok')).toEqual(record);
    expect(db.loadLogicalTurn('lt-missing')).toBeNull();
    const extra = stored('lt-extra');
    db.handle.run('INSERT INTO logical_turns (logical_turn_id, record) VALUES (?, ?)', [
      extra.logicalTurnId,
      JSON.stringify({ ...extra, note: 'ignored' }),
    ]);
    expect(db.loadLogicalTurn('lt-extra')).toMatchObject({
      logicalTurnId: 'lt-extra',
      status: 'running',
    });
    for (const [id, payload] of [
      ['lt-text', 'not-json'],
      ['lt-shape', JSON.stringify({ version: 1, logicalTurnId: 'lt-shape' })],
      ['lt-null', 'null'],
      ['lt-array', '[]'],
      ['lt-version', JSON.stringify({ ...stored('lt-version'), version: 2 })],
      ['lt-mismatch', JSON.stringify(stored('lt-other'))],
    ] as const) {
      db.handle.run('INSERT INTO logical_turns (logical_turn_id, record) VALUES (?, ?)', [
        id,
        payload,
      ]);
      expect(() => db.loadLogicalTurn(id)).toThrow(LogicalTurnRecordError);
    }
  } finally {
    db.close();
  }
});

for (const [id, record] of [
  ['lt-text', 'not-json'],
  ['lt-shape', JSON.stringify({ version: 1, logicalTurnId: 'lt-shape' })],
] as const) {
  test(`continuing ${id} reports recovery_state_invalid`, async () => {
    const path = fileDb();
    insert(path, id, record);
    const { exitCode, terminal } = await continueTurn(path, id);
    expect(exitCode).toBe(3);
    expect(terminal).toMatchObject({
      type: 'turn.error',
      outcome: 'failed',
      code: 'recovery_state_invalid',
      recoverable: false,
      logicalTurnId: id,
    });
    expect(terminal?.code).not.toBe('provider_failed');
    expect(String(terminal?.error)).not.toContain('provider');
  });
}

test('continuing a missing logical turn stays invalid_input', async () => {
  const path = fileDb();
  const db = SessionDb.open({ path });
  db.close();
  const { exitCode, terminal } = await continueTurn(path, 'lt-missing');
  expect(exitCode).toBe(2);
  expect(terminal).toMatchObject({
    type: 'turn.error',
    code: 'invalid_input',
  });
});

import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RunResult, createAgent } from '@yevgetman/sov-sdk/agent/createAgent';
import {
  LOGICAL_TURN_CURSOR_PARSE_CAP,
  LOGICAL_TURN_LEASE_MS,
  LogicalTurnLeaseError,
  type LogicalTurnRecord,
  type LogicalTurnStore,
  type LogicalTurnSupervisorOptions,
  logicalTurnCursor,
  superviseLogicalTurn,
} from '@yevgetman/sov-sdk/agent/logicalTurn';
import { query } from '@yevgetman/sov-sdk/core/query';
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  Terminal,
} from '@yevgetman/sov-sdk/core/types';
import { buildHookRunner } from '@yevgetman/sov-sdk/hooks/runner';
import type { HookRunner } from '@yevgetman/sov-sdk/hooks/types';
import {
  type InMemorySessionStore,
  createInMemorySessionStore,
} from '@yevgetman/sov-sdk/persistence/inMemoryStore';
import { ChatGptSubscriptionProvider } from '@yevgetman/sov-sdk/providers/chatgpt';
import {
  ProviderHttpError,
  ProviderStreamError,
  SubscriptionHttpError,
  SubscriptionStreamError,
} from '@yevgetman/sov-sdk/providers/errors';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import type { Tool, ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { z } from 'zod';
import { SessionDb } from '../../src/agent/sessionDb.js';

const binding = {
  route: 'fixture',
  provider: 'fixture',
  model: 'fixture-model',
  toolset: 'coding',
  cwd: '/tmp/project',
};

function result(reason: RunResult['terminal']['reason'], text = ''): RunResult {
  return {
    sessionId: 'session-1',
    terminal: { reason },
    finalAssistant: { role: 'assistant', content: [{ type: 'text', text }] },
    iterationsUsed: 1,
    toolCallCount: 0,
    distinctToolNames: [],
    messages: [],
    usage: { inputTokens: 2, outputTokens: 3 },
    estimatedCostUsd: 0.01,
  };
}

function setup(
  runSegment: LogicalTurnSupervisorOptions['runSegment'],
  extra: Partial<LogicalTurnSupervisorOptions> = {},
) {
  const store = createInMemorySessionStore();
  store.createSession({ sessionId: 'session-1', provider: 'fixture', model: 'fixture-model' });
  store.saveMessage('session-1', {
    role: 'user',
    content: [{ type: 'text', text: 'do the work' }],
  });
  return {
    store,
    options: {
      store,
      binding,
      sessionId: 'session-1',
      initialMessages: [
        { role: 'user' as const, content: [{ type: 'text' as const, text: 'do the work' }] },
      ],
      rehydrate: () => [
        { role: 'user' as const, content: [{ type: 'text' as const, text: 'do the work' }] },
      ],
      recoverySafe: () => true,
      runSegment,
      ...extra,
    } satisfies LogicalTurnSupervisorOptions,
  };
}

describe('logical-turn supervisor', () => {
  test('continues max_turns internally and emits one cumulative result', async () => {
    const calls: Array<{ continuation: boolean; remainingModelCalls: number }> = [];
    const continuing: unknown[] = [];
    const { store, options } = setup(
      async (segment) => {
        calls.push(segment);
        return calls.length === 1 ? result('max_turns', 'partial') : result('completed', 'done');
      },
      { onContinuing: (event) => continuing.push(event) },
    );

    const outcome = await superviseLogicalTurn(options);
    expect(outcome.status).toBe('completed');
    expect(outcome.counters).toMatchObject({
      segments: 2,
      modelCalls: 2,
      inputTokens: 4,
      outputTokens: 6,
    });
    expect(calls.map((call) => call.continuation)).toEqual([false, true]);
    expect(continuing).toHaveLength(1);
    expect(store.loadLogicalTurn(outcome.logicalTurnId)?.status).toBe('completed');
  });

  test('a stored segmentLimit does not cap max_tokens continuation', async () => {
    let calls = 0;
    const fixture = setup(
      async () => {
        calls += 1;
        return calls < 4 ? result('max_tokens', `part-${calls}`) : result('completed', 'done');
      },
      {
        logicalModelCallLimit: 100,
        progressSnapshot: () => ({
          transcriptIds: [calls],
          transcriptCount: calls,
          receipts: [],
          cursor: null,
          compactionChildId: 'session-1',
        }),
      },
    );
    const create = fixture.store.createLogicalTurn.bind(fixture.store);
    fixture.store.createLogicalTurn = (record) => {
      create({ ...record, segmentLimit: 1 } as LogicalTurnRecord);
    };
    const outcome = await superviseLogicalTurn(fixture.options);
    expect(calls).toBe(4);
    expect(outcome.status).toBe('completed');
    expect(outcome.counters.segments).toBe(4);
    expect(outcome.counters.modelCalls).toBe(4);
    const stored = fixture.store.loadLogicalTurn(outcome.logicalTurnId);
    expect(stored?.logicalModelCallLimit).toBe(100);
    expect(stored).not.toHaveProperty('segmentLimit');
  });

  test('stops after two identical continuation attempts', async () => {
    const { options } = setup(async () => result('max_turns'));
    const outcome = await superviseLogicalTurn({
      ...options,
      progressSnapshot: () => ({ messages: ['same'], receipts: [] }),
    });
    expect(outcome.status).toBe('stalled');
    expect(outcome.code).toBe('continuation_stalled');
    expect(outcome.counters.segments).toBe(3);
    expect(outcome.finishReason).toBe('repeated:max_turns');
  });

  test('one unchanged continuation does not stall', async () => {
    let calls = 0;
    const { store, options } = setup(async () => {
      calls += 1;
      return calls < 3 ? result('max_turns') : result('completed', 'done');
    });
    const outcome = await superviseLogicalTurn({
      ...options,
      progressSnapshot: () => ({
        transcriptIds: [1],
        transcriptCount: 1,
        receipts: [],
        cursor: null,
        compactionChildId: 'session-1',
      }),
    });
    expect(calls).toBe(3);
    expect(outcome.status).toBe('completed');
    expect(outcome.code).toBeUndefined();
    expect(store.loadLogicalTurn(outcome.logicalTurnId)?.repeatedNoProgress).toBe(1);
  });

  test('two identical continuation attempts stall and name what repeated', async () => {
    const { store, options } = setup(async () => result('max_turns', 'partial'));
    const outcome = await superviseLogicalTurn({
      ...options,
      progressSnapshot: () => ({
        transcriptIds: [1],
        transcriptCount: 1,
        receipts: [['page', 'completed']],
        cursor: 'same',
        compactionChildId: 'session-1',
      }),
    });
    expect(outcome.status).toBe('stalled');
    expect(outcome.code).toBe('continuation_stalled');
    expect(outcome.counters.segments).toBe(3);
    expect(outcome.finishReason).toBe('repeated:max_turns');
    expect(store.loadLogicalTurn(outcome.logicalTurnId)?.finishReason).toBe('repeated:max_turns');
    expect(store.loadLogicalTurn(outcome.logicalTurnId)?.repeatedNoProgress).toBe(2);
  });

  test('a segment boundary reads the transcript once', async () => {
    let reads = 0;
    let safety = 0;
    let snapshots = 0;
    let rehydrates = 0;
    let calls = 0;
    const seen: Message[][] = [];
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'do the work' }] },
    ];
    const progress = {
      transcriptIds: [1],
      transcriptCount: 1,
      receipts: [] as unknown[],
      cursor: null,
      compactionChildId: 'session-1',
    };
    const { options } = setup(
      async (segment) => {
        calls += 1;
        seen.push(segment.messages);
        return calls < 2 ? result('max_turns') : result('completed', 'done');
      },
      {
        recoverySafe: () => {
          safety += 1;
          reads += 1;
          return true;
        },
        progressSnapshot: () => {
          snapshots += 1;
          reads += 1;
          return progress;
        },
        rehydrate: () => {
          rehydrates += 1;
          reads += 1;
          return messages;
        },
        readBoundary: () => {
          reads += 1;
          return { safe: true, progress, messages: () => messages };
        },
      },
    );
    const outcome = await superviseLogicalTurn(options);
    expect(outcome.status).toBe('completed');
    expect(calls).toBe(2);
    expect(reads).toBe(1);
    expect(safety).toBe(0);
    expect(snapshots).toBe(0);
    expect(rehydrates).toBe(0);
    expect(seen[1]).toEqual(messages);
  });

  test('an old tool-result byte does not change the fingerprint', async () => {
    let calls = 0;
    const note = { text: 'alpha' };
    const messages = (): Message[] => [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'list',
            content: JSON.stringify({ data: { nextCursor: 'page-1', note: note.text } }),
          },
        ],
      },
    ];
    const progress = {
      transcriptIds: [1],
      transcriptCount: 1,
      receipts: [['list', 'completed']],
      cursor: 'page-1',
      compactionChildId: 'session-1',
    };
    const { options } = setup(
      async () => {
        calls += 1;
        if (calls === 2) note.text = 'beta';
        return result('max_turns');
      },
      {
        readBoundary: () => ({ safe: true, progress, messages }),
        rehydrate: () => {
          throw new Error('boundary reloaded the transcript');
        },
      },
    );
    const outcome = await superviseLogicalTurn(options);
    expect(outcome.status).toBe('stalled');
    expect(outcome.code).toBe('continuation_stalled');
    expect(outcome.counters.segments).toBe(3);
    expect(outcome.finishReason).toBe('repeated:max_turns');
    expect(calls).toBe(3);
  });

  test('a max_tokens boundary keeps the continuation marker without a second read', async () => {
    let reads = 0;
    let calls = 0;
    const seen: Message[][] = [];
    const base: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'do the work' }] }];
    let marked = false;
    const progress = {
      transcriptIds: [1],
      transcriptCount: 1,
      receipts: [] as unknown[],
      cursor: null,
      compactionChildId: 'session-1',
    };
    const { options } = setup(
      async (segment) => {
        calls += 1;
        seen.push(segment.messages);
        return calls < 2 ? result('max_tokens', 'partial') : result('completed', 'done');
      },
      {
        readBoundary: () => {
          reads += 1;
          return {
            safe: true,
            progress,
            messages: () =>
              marked
                ? [
                    ...base,
                    {
                      role: 'user' as const,
                      content: [{ type: 'text' as const, text: 'continue' }],
                      origin: 'runtime' as const,
                      id: 'marker',
                    },
                  ]
                : base,
          };
        },
        persistRuntimeContinuation: () => {
          marked = true;
        },
        rehydrate: () => {
          reads += 1;
          return base;
        },
      },
    );
    const outcome = await superviseLogicalTurn(options);
    expect(outcome.status).toBe('completed');
    expect(reads).toBe(1);
    expect(calls).toBe(2);
    expect(
      seen[1]?.some((message) => message.role === 'user' && message.origin === 'runtime'),
    ).toBe(true);
  });

  test('a new cursor changes the fingerprint', async () => {
    let calls = 0;
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'list',
            content: JSON.stringify({ data: { nextCursor: 'page-1' } }),
          },
        ],
      },
    ];
    const { options } = setup(
      async () => {
        calls += 1;
        if (calls === 2) {
          messages[0] = {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'list',
                content: JSON.stringify({ data: { nextCursor: 'page-2' } }),
              },
            ],
          };
        }
        return calls < 4 ? result('max_turns') : result('completed', 'done');
      },
      {
        rehydrate: () => messages,
        progressSnapshot: () => ({ receipts: [['list', 'completed']] }),
      },
    );
    const outcome = await superviseLogicalTurn(options);
    expect(outcome.status).toBe('completed');
    expect(calls).toBe(4);
  });

  test('the newest cursor wins without parsing older oversized tool bodies', () => {
    const oversized = `{"nextCursor":"hidden","pad":"${'x'.repeat(LOGICAL_TURN_CURSOR_PARSE_CAP)}"}`;
    expect(oversized.length).toBeGreaterThan(LOGICAL_TURN_CURSOR_PARSE_CAP);
    const trailing = JSON.stringify({ nextCursor: 'page-9' });
    const olderDump = `not-json-${'y'.repeat(LOGICAL_TURN_CURSOR_PARSE_CAP)}`;
    expect(
      logicalTurnCursor([
        { content: [{ type: 'tool_result', content: trailing }] },
        { content: [{ type: 'tool_result', content: oversized }] },
      ]),
    ).toBe('page-9');
    expect(
      logicalTurnCursor([
        { content: [{ type: 'tool_result', content: olderDump }] },
        { content: [{ type: 'tool_result', content: `${olderDump}more` }] },
        { content: [{ type: 'tool_result', content: trailing }] },
      ]),
    ).toBe('page-9');
    expect(
      logicalTurnCursor([
        {
          content: [
            { type: 'tool_use', input: { cursor: 'from-request' } },
            {
              type: 'tool_result',
              content: JSON.stringify({ data: { nextCursor: 'from-result' } }),
            },
          ],
        },
      ]),
    ).toBe('from-result');
  });

  test('an older tool body that does not change nextCursor still stalls', async () => {
    let calls = 0;
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'old',
            content: `not-json-${'x'.repeat(LOGICAL_TURN_CURSOR_PARSE_CAP)}`,
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'list',
            content: JSON.stringify({ nextCursor: 'page-1' }),
          },
        ],
      },
    ];
    const { options } = setup(
      async () => {
        calls += 1;
        if (calls === 2) {
          const older = messages[0]?.content[0];
          if (older && older.type === 'tool_result')
            older.content = `not-json-${'y'.repeat(LOGICAL_TURN_CURSOR_PARSE_CAP)}`;
        }
        return result('max_turns');
      },
      {
        rehydrate: () => messages,
        progressSnapshot: () => ({
          receipts: [
            ['old', 'completed'],
            ['list', 'completed'],
          ],
        }),
      },
    );
    const outcome = await superviseLogicalTurn(options);
    expect(outcome.status).toBe('stalled');
    expect(outcome.code).toBe('continuation_stalled');
    expect(calls).toBe(3);
  });

  test('the boundary read renews the lease after the segment returns', async () => {
    let calls = 0;
    let segmentReturned = false;
    let boundarySeen = false;
    let renewedAfterReturnBeforeBoundary = false;
    const progress = {
      transcriptIds: [1],
      transcriptCount: 1,
      receipts: [] as unknown[],
      cursor: null,
      compactionChildId: 'session-1',
    };
    const { store, options } = setup(
      async () => {
        calls += 1;
        segmentReturned = false;
        const value = calls < 2 ? result('max_turns') : result('completed', 'done');
        segmentReturned = true;
        return value;
      },
      {
        readBoundary: () => {
          boundarySeen = true;
          return {
            safe: true,
            progress,
            messages: () => [
              { role: 'user' as const, content: [{ type: 'text' as const, text: 'do the work' }] },
            ],
          };
        },
      },
    );
    const renew = store.renewLogicalTurnLease.bind(store);
    store.renewLogicalTurnLease = (id, owner, expiresAt) => {
      if (segmentReturned && !boundarySeen) renewedAfterReturnBeforeBoundary = true;
      return renew(id, owner, expiresAt);
    };
    const outcome = await superviseLogicalTurn(options);
    expect(outcome.status).toBe('completed');
    expect(renewedAfterReturnBeforeBoundary).toBe(true);
    expect(calls).toBe(2);
  });

  test('a new transcript row changes the fingerprint', async () => {
    let calls = 0;
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'do the work' }] },
    ];
    const { options } = setup(
      async () => {
        calls += 1;
        if (calls === 2) {
          messages.push({ role: 'assistant', content: [{ type: 'text', text: 'page' }] });
        }
        return calls < 4 ? result('max_turns') : result('completed', 'done');
      },
      {
        rehydrate: () => messages,
        progressSnapshot: () => ({ receipts: [] }),
      },
    );
    const outcome = await superviseLogicalTurn(options);
    expect(outcome.status).toBe('completed');
    expect(calls).toBe(4);
  });

  test('a new completed receipt is progress and a started receipt is not', async () => {
    let startedCalls = 0;
    const started = setup(
      async () => {
        startedCalls += 1;
        return result('max_turns');
      },
      {
        progressSnapshot: () => ({
          transcriptIds: [1],
          transcriptCount: 1,
          receipts: [[`pending-${startedCalls}`, 'started']],
          cursor: null,
          compactionChildId: 'session-1',
        }),
      },
    );
    const stalled = await superviseLogicalTurn(started.options);
    expect(stalled.status).toBe('stalled');
    expect(stalled.counters.segments).toBe(3);

    let calls = 0;
    const { options } = setup(
      async () => {
        calls += 1;
        return calls < 4 ? result('max_turns') : result('completed', 'done');
      },
      {
        progressSnapshot: () => ({
          transcriptIds: [1],
          transcriptCount: 1,
          receipts: calls >= 2 ? [['page', 'completed']] : [],
          cursor: null,
          compactionChildId: 'session-1',
        }),
      },
    );
    const outcome = await superviseLogicalTurn(options);
    expect(outcome.status).toBe('completed');
    expect(calls).toBe(4);
  });

  test('a new compaction child changes the fingerprint', async () => {
    let calls = 0;
    const { options } = setup(
      async () => {
        calls += 1;
        const sessionId = calls === 1 ? 'session-1' : 'child-1';
        return {
          ...result(calls < 4 ? 'max_turns' : 'completed', calls < 4 ? '' : 'done'),
          sessionId,
        };
      },
      {
        progressSnapshot: () => ({
          transcriptIds: [1],
          transcriptCount: 1,
          receipts: [],
          cursor: null,
        }),
      },
    );
    const outcome = await superviseLogicalTurn(options);
    expect(outcome.status).toBe('completed');
    expect(outcome.activeSessionId).toBe('child-1');
    expect(calls).toBe(4);
  });

  test('does not recover across unsafe tool receipts', async () => {
    const { options } = setup(async () => result('max_turns'), { recoverySafe: () => false });
    const outcome = await superviseLogicalTurn(options);
    expect(outcome.status).toBe('failed');
    expect(outcome.code).toBe('recovery_unsafe');
  });

  test('persists a runtime-owned marker for max_tokens only once', async () => {
    let call = 0;
    const persisted: string[] = [];
    const { options } = setup(
      async () => (++call === 1 ? result('max_tokens') : result('completed')),
      { persistRuntimeContinuation: ({ id }) => persisted.push(id) },
    );
    const outcome = await superviseLogicalTurn(options);
    expect(outcome.status).toBe('completed');
    expect(persisted).toEqual([`${outcome.logicalTurnId}:output:1`]);
  });

  test('returns waiting_user for a deliberate checkin', async () => {
    const { options } = setup(async () => result('checkin'));
    expect((await superviseLogicalTurn(options)).status).toBe('waiting_user');
  });

  test('rejects binding drift when a stored logical turn is continued', async () => {
    const first = setup(async () => result('completed'));
    const completed = await superviseLogicalTurn(first.options);
    const outcome = await superviseLogicalTurn({
      ...first.options,
      logicalTurnId: completed.logicalTurnId,
      binding: { ...binding, model: 'different-model' },
    });
    expect(outcome.code).toBe('recovery_state_invalid');
  });

  test('an aborted segment stays cancelled and is not continued', async () => {
    const controller = new AbortController();
    let calls = 0;
    const fixture = setup(
      async () => {
        calls++;
        controller.abort();
        throw new Error('interrupted');
      },
      { signal: controller.signal },
    );
    const ids: string[] = [];
    const create = fixture.store.createLogicalTurn.bind(fixture.store);
    fixture.store.createLogicalTurn = (record) => {
      ids.push(record.logicalTurnId);
      create(record);
    };
    await expect(superviseLogicalTurn(fixture.options)).rejects.toThrow('interrupted');
    const logicalTurnId = ids[0];
    if (!logicalTurnId) throw new Error('missing logical turn');
    expect(fixture.store.loadLogicalTurn(logicalTurnId)?.status).toBe('cancelled');
    const { signal: _stop, ...resume } = fixture.options;
    const continued = await superviseLogicalTurn({
      ...resume,
      logicalTurnId,
    });
    expect(calls).toBe(1);
    expect(continued).toMatchObject({ status: 'failed', code: 'recovery_state_invalid' });
  });

  test('a deadline abort during a segment is continuation_exhausted', async () => {
    const controller = new AbortController();
    let nowMs = 0;
    const fixture = setup(
      async () => {
        nowMs = 10;
        controller.abort();
        throw new Error('interrupted');
      },
      { signal: controller.signal, deadlineAt: 10, now: () => nowMs },
    );
    const outcome = await superviseLogicalTurn(fixture.options);
    expect(outcome).toMatchObject({
      status: 'exhausted',
      code: 'continuation_exhausted',
      finishReason: 'deadline',
    });
    const stored = fixture.store.loadLogicalTurn(outcome.logicalTurnId);
    expect(stored?.status).toBe('exhausted');
    expect(stored?.finishReason).toBe('deadline');
    expect(stored?.status).not.toBe('running');
    expect(stored?.status).not.toBe('cancelled');
  });

  test('a past stored deadline does not prepare or run another segment', async () => {
    let calls = 0;
    let prepared = 0;
    const fixture = setup(
      async () => {
        calls++;
        return result('completed', 'durable answer');
      },
      {
        prepare: () => {
          prepared++;
        },
      },
    );
    const first = await superviseLogicalTurn(fixture.options);
    expect(calls).toBe(1);
    expect(prepared).toBe(1);
    const stored = fixture.store.loadLogicalTurn(first.logicalTurnId);
    if (!stored) throw new Error('logical turn row missing');
    stored.status = 'running';
    stored.deadlineAt = 1;
    const { finishReason: _completedReason, ...running } = stored;
    fixture.store.loadLogicalTurn = (id) =>
      id === running.logicalTurnId ? structuredClone(running) : null;
    const resumed = await superviseLogicalTurn({
      ...fixture.options,
      logicalTurnId: first.logicalTurnId,
      now: () => 10_000,
    });
    expect(calls).toBe(1);
    expect(prepared).toBe(1);
    expect(resumed).toMatchObject({
      status: 'exhausted',
      code: 'continuation_exhausted',
      finishReason: 'deadline',
      logicalTurnId: first.logicalTurnId,
    });
  });

  test('a user abort before the deadline stays cancelled', async () => {
    const controller = new AbortController();
    const nowMs = Date.now();
    const fixture = setup(
      async () => {
        controller.abort();
        throw new Error('interrupted');
      },
      { signal: controller.signal, deadlineAt: nowMs + 60_000, now: () => nowMs },
    );
    const ids: string[] = [];
    const create = fixture.store.createLogicalTurn.bind(fixture.store);
    fixture.store.createLogicalTurn = (record) => {
      ids.push(record.logicalTurnId);
      create(record);
    };
    await expect(superviseLogicalTurn(fixture.options)).rejects.toThrow('interrupted');
    const logicalTurnId = ids[0];
    if (!logicalTurnId) throw new Error('missing logical turn');
    expect(fixture.store.loadLogicalTurn(logicalTurnId)?.status).toBe('cancelled');
    expect(fixture.store.loadLogicalTurn(logicalTurnId)?.finishReason).toBe('cancelled');
  });

  test('reuses a completed receipt without another model call', async () => {
    let calls = 0;
    const fixture = setup(async () => {
      calls++;
      return result('completed', 'durable answer');
    });
    const first = await superviseLogicalTurn(fixture.options);
    const reused = await superviseLogicalTurn({
      ...fixture.options,
      logicalTurnId: first.logicalTurnId,
    });
    expect(calls).toBe(1);
    expect(reused).toMatchObject({ status: 'completed', reply: 'durable answer' });
  });

  test('a failed logical turn resumes only when the stored cause is a safe transient', async () => {
    let calls = 0;
    let prepared = 0;
    const fixture = setup(
      async () => {
        calls++;
        return result('completed', calls === 1 ? 'durable answer' : 'retried answer');
      },
      {
        prepare: () => {
          prepared++;
        },
      },
    );
    const first = await superviseLogicalTurn(fixture.options);
    expect(calls).toBe(1);
    expect(prepared).toBe(1);
    const stored = fixture.store.loadLogicalTurn(first.logicalTurnId);
    if (!stored) throw new Error('logical turn row missing');
    stored.status = 'failed';
    stored.finishReason = 'failed';
    stored.lastCause = 'error';
    fixture.store.loadLogicalTurn = (id) =>
      id === stored.logicalTurnId ? structuredClone(stored) : null;
    const blocked = await superviseLogicalTurn({
      ...fixture.options,
      logicalTurnId: first.logicalTurnId,
    });
    expect(calls).toBe(1);
    expect(prepared).toBe(1);
    expect(blocked).toMatchObject({
      status: 'failed',
      finishReason: 'failed',
      reply: 'durable answer',
      logicalTurnId: first.logicalTurnId,
    });
    expect(blocked.code).toBeUndefined();
    expect(blocked.finalSegment).toBeUndefined();

    stored.finishReason = 'transient_provider';
    const unsafe = await superviseLogicalTurn({
      ...fixture.options,
      logicalTurnId: first.logicalTurnId,
      recoverySafe: () => false,
    });
    expect(calls).toBe(1);
    expect(prepared).toBe(1);
    expect(unsafe).toMatchObject({ status: 'failed', code: 'recovery_unsafe' });

    const resumed = await superviseLogicalTurn({
      ...fixture.options,
      logicalTurnId: first.logicalTurnId,
    });
    expect(calls).toBe(2);
    expect(prepared).toBe(2);
    expect(resumed).toMatchObject({ status: 'completed', reply: 'retried answer' });

    for (const cause of ['rate_limited', 'provider_unavailable', 'provider_timeout'] as const) {
      stored.finishReason = cause;
      stored.lastCause = 'error';
      const outcome = await superviseLogicalTurn({
        ...fixture.options,
        logicalTurnId: first.logicalTurnId,
      });
      expect(outcome.status).toBe('completed');
    }
    expect(calls).toBe(5);

    stored.finishReason = 'failed';
    (stored as { lastCause: string }).lastCause = 'rate_limited';
    const fromCause = await superviseLogicalTurn({
      ...fixture.options,
      logicalTurnId: first.logicalTurnId,
    });
    expect(calls).toBe(6);
    expect(fromCause.status).toBe('completed');

    stored.finishReason = 'provider_response_invalid';
    stored.lastCause = 'error';
    const denied = await superviseLogicalTurn({
      ...fixture.options,
      logicalTurnId: first.logicalTurnId,
    });
    expect(calls).toBe(6);
    expect(prepared).toBe(6);
    expect(denied).toMatchObject({ status: 'failed', finishReason: 'provider_response_invalid' });
  });

  test('checks recovery receipts before a resumed model call', async () => {
    let calls = 0;
    const fixture = setup(
      async () => {
        calls++;
        return result('max_turns');
      },
      { progressSnapshot: () => ({ changed: calls }) },
    );
    const first = await superviseLogicalTurn({ ...fixture.options, logicalModelCallLimit: 1 });
    const resumed = await superviseLogicalTurn({
      ...fixture.options,
      logicalTurnId: first.logicalTurnId,
      recoverySafe: () => false,
    });
    expect(calls).toBe(1);
    expect(resumed.code).toBe('recovery_unsafe');
  });

  test('bounds typed transient retries and applies increasing backoff', async () => {
    let calls = 0;
    const delays: number[] = [];
    const fixture = setup(
      async () => {
        calls++;
        if (calls < 3) {
          const failed = result('error');
          failed.terminal.error = new ProviderHttpError('fixture', 503, 'unavailable');
          return failed;
        }
        return result('completed');
      },
      {
        sleep: async (ms) => {
          if (ms === 10_000) return;
          delays.push(ms);
        },
      },
    );
    const outcome = await superviseLogicalTurn(fixture.options);
    expect(outcome.status).toBe('completed');
    expect(outcome.counters.providerRetries).toBe(2);
    expect(calls).toBe(3);
    expect(delays[0]).toBeGreaterThanOrEqual(100);
    expect(delays[1]).toBeGreaterThanOrEqual(200);
  });
});

function connectionReset(): Error {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
  });
}

describe('pre-delivery transport retries', () => {
  test('a pre-delivery connection reset then success uses two provider calls', async () => {
    let calls = 0;
    const provider: LLMProvider = {
      name: 'fixture',
      async *stream(): AsyncGenerator<StreamEvent, AssistantMessage> {
        calls += 1;
        if (calls === 1) throw connectionReset();
        yield { type: 'message_start' };
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'message_stop', stop_reason: 'end_turn' };
        yield { type: 'assistant_message', message: textAnswer };
        return textAnswer;
      },
    };
    const { options } = setup(
      async (segment) => {
        const terminal = await drainQuery(
          query({
            provider,
            model: 'fixture-model',
            messages: segment.messages,
            systemPrompt: [],
            maxTokens: 32,
            logicalTurn: true,
            sessionId: 'session-1',
            cwd: '/tmp/project',
          }),
        );
        return {
          sessionId: 'session-1',
          terminal,
          iterationsUsed: 1,
          toolCallCount: 0,
          distinctToolNames: [],
          messages: segment.messages,
          ...(terminal.reason === 'completed' ? { finalAssistant: textAnswer } : {}),
        };
      },
      { sleep: async () => {} },
    );
    const outcome = await superviseLogicalTurn(options);
    expect(calls).toBe(2);
    expect(outcome.status).toBe('completed');
    expect(outcome.counters.providerRetries).toBe(1);
  });

  test('abort during backoff sends no further provider call', async () => {
    const controller = new AbortController();
    let calls = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fixture = setup(
      async () => {
        calls += 1;
        const failed = result('error');
        failed.terminal.error = connectionReset();
        return failed;
      },
      {
        signal: controller.signal,
        sleep: (ms) => {
          if (ms === 10_000) return new Promise((resolve) => setTimeout(resolve, 0));
          controller.abort();
          return new Promise(() => {});
        },
      },
    );
    const outcome = await Promise.race([
      superviseLogicalTurn(fixture.options).finally(() => {
        if (timer) clearTimeout(timer);
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('backoff ignored abort')), 1000);
      }),
    ]);
    expect(calls).toBe(1);
    expect(outcome.status).toBe('cancelled');
    expect(outcome.counters.providerRetries).toBe(1);
  });

  test('a pre-delivery timeout then success uses two provider calls', async () => {
    let calls = 0;
    const fixture = setup(
      async () => {
        calls += 1;
        if (calls === 1) {
          const failed = result('error');
          failed.terminal.error = new DOMException('timed out', 'TimeoutError');
          return failed;
        }
        return result('completed', 'done');
      },
      { sleep: async () => {} },
    );
    const outcome = await superviseLogicalTurn(fixture.options);
    expect(calls).toBe(2);
    expect(outcome.status).toBe('completed');
    expect(outcome.counters.providerRetries).toBe(1);
  });

  test('a pre-delivery connection reset stops after three attempts', async () => {
    let calls = 0;
    const fixture = setup(
      async () => {
        calls += 1;
        const failed = result('error');
        failed.terminal.error = connectionReset();
        return failed;
      },
      { sleep: async () => {} },
    );
    const outcome = await superviseLogicalTurn(fixture.options);
    expect(calls).toBe(3);
    expect(outcome.status).toBe('failed');
    expect(outcome.code).toBeUndefined();
    expect(outcome.counters.providerRetries).toBe(2);
  });

  test('a connection reset after committed output is not retried', async () => {
    let calls = 0;
    const fixture = setup(
      async () => {
        calls += 1;
        const failed = result('error', 'partial answer');
        failed.terminal.error = connectionReset();
        return failed;
      },
      { sleep: async () => {} },
    );
    const outcome = await superviseLogicalTurn(fixture.options);
    expect(calls).toBe(1);
    expect(outcome.status).toBe('failed');
    expect(outcome.counters.providerRetries).toBe(0);
  });

  test('a connection reset with an ambiguous effect is not retried', async () => {
    let calls = 0;
    const fixture = setup(
      async () => {
        calls += 1;
        const failed = result('error');
        failed.terminal.error = connectionReset();
        return failed;
      },
      { recoverySafe: () => false, sleep: async () => {} },
    );
    const outcome = await superviseLogicalTurn(fixture.options);
    expect(calls).toBe(1);
    expect(outcome).toMatchObject({ status: 'failed', code: 'recovery_unsafe' });
    expect(outcome.counters.providerRetries).toBe(0);
  });

  test('an incomplete stream is not retried', async () => {
    let calls = 0;
    const fixture = setup(
      async () => {
        calls += 1;
        const failed = result('error');
        failed.terminal.error = new ProviderStreamError('missing_completion');
        return failed;
      },
      { sleep: async () => {} },
    );
    const outcome = await superviseLogicalTurn(fixture.options);
    expect(calls).toBe(1);
    expect(outcome.status).toBe('failed');
    expect(outcome.counters.providerRetries).toBe(0);
  });

  test('a subscription pre-delivery connection reset does not open another segment', async () => {
    let calls = 0;
    const fixture = setup(
      async () => {
        calls += 1;
        const failed = result('error');
        failed.terminal.error = new SubscriptionStreamError(
          'chatgpt',
          'before_delivery',
          'connection_reset',
          true,
        );
        return failed;
      },
      { sleep: async () => {} },
    );
    const outcome = await superviseLogicalTurn(fixture.options);
    expect(calls).toBe(1);
    expect(outcome.status).toBe('failed');
    expect(outcome.counters.providerRetries).toBe(0);
    expect(outcome.finalSegment?.terminal.error).toBeInstanceOf(SubscriptionStreamError);
  });

  test('a deadline abort during backoff is continuation_exhausted', async () => {
    const controller = new AbortController();
    let calls = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fixture = setup(
      async () => {
        calls += 1;
        const failed = result('error');
        failed.terminal.error = new ProviderHttpError('fixture', 503, 'unavailable');
        return failed;
      },
      {
        signal: controller.signal,
        deadlineAt: 10,
        now: () => 0,
        sleep: (ms) => {
          if (ms === 10_000) return new Promise((resolve) => setTimeout(resolve, 0));
          controller.abort('deadline');
          return new Promise(() => {});
        },
      },
    );
    const outcome = await Promise.race([
      superviseLogicalTurn(fixture.options).finally(() => {
        if (timer) clearTimeout(timer);
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('backoff ignored deadline')), 1000);
      }),
    ]);
    expect(calls).toBe(1);
    expect(outcome).toMatchObject({
      status: 'exhausted',
      code: 'continuation_exhausted',
      finishReason: 'deadline',
    });
  });
});

async function runSubscriptionStatuses(status: number, retryAfter?: string) {
  let sends = 0;
  let segments = 0;
  const transportWaits: number[] = [];
  const supervisorWaits: number[] = [];
  const provider = new ChatGptSubscriptionProvider({
    port: {
      async read() {
        return {
          accessToken: 'fake-access',
          refreshToken: 'fake-refresh',
          expiresAt: 1e15,
          accountBinding: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        };
      },
      async write() {},
      async delete() {},
    },
    fetchImpl: async () => {
      sends += 1;
      return new Response('busy', {
        status,
        ...(retryAfter !== undefined ? { headers: { 'retry-after': retryAfter } } : {}),
      });
    },
    deps: {
      sleep: async (ms) => {
        transportWaits.push(ms);
      },
      random: () => 0,
      now: () => 0,
    },
  });
  const { options } = setup(
    async (segment) => {
      segments += 1;
      const terminal = await drainQuery(
        query({
          provider,
          model: 'gpt-5.3-codex',
          messages: segment.messages,
          systemPrompt: [],
          maxTokens: 32,
          logicalTurn: true,
          sessionId: 'session-1',
          cwd: '/tmp/project',
        }),
      );
      return {
        sessionId: 'session-1',
        terminal,
        iterationsUsed: 0,
        toolCallCount: 0,
        distinctToolNames: [],
        messages: segment.messages,
      };
    },
    {
      sleep: async (ms) => {
        if (ms === 10_000) return;
        supervisorWaits.push(ms);
      },
    },
  );
  const outcome = await superviseLogicalTurn(options);
  return { sends, segments, transportWaits, supervisorWaits, outcome };
}

describe('subscription status retries', () => {
  test('three subscription 503s send three times and do not start another segment', async () => {
    const seen = await runSubscriptionStatuses(503);
    expect(seen.segments).toBe(1);
    expect(seen.sends).toBe(3);
    expect(seen.transportWaits).toEqual([500, 1500]);
    expect(seen.supervisorWaits).toEqual([]);
    expect(seen.outcome.status).toBe('failed');
    expect(seen.outcome.counters.segments).toBe(1);
    expect(seen.outcome.counters.providerRetries).toBe(0);
    expect(seen.outcome.finalSegment?.terminal.error).toBeInstanceOf(SubscriptionHttpError);
    expect((seen.outcome.finalSegment?.terminal.error as SubscriptionHttpError).status).toBe(503);
  });

  test('Retry-After is honored inside the three sends and does not open a segment', async () => {
    const seen = await runSubscriptionStatuses(503, '2');
    expect(seen.segments).toBe(1);
    expect(seen.sends).toBe(3);
    expect(seen.transportWaits).toEqual([2_000, 2_000]);
    expect(seen.supervisorWaits).toEqual([]);
    expect(seen.outcome.counters.providerRetries).toBe(0);
  });

  test('Retry-After over 10 seconds does not add a segment attempt', async () => {
    const seen = await runSubscriptionStatuses(429, '30');
    expect(seen.segments).toBe(1);
    expect(seen.sends).toBe(1);
    expect(seen.transportWaits).toEqual([]);
    expect(seen.supervisorWaits).toEqual([]);
    expect(seen.outcome.status).toBe('failed');
  });
});

const echoTool = buildTool({
  name: 'Echo',
  description: () => 'echo input',
  inputSchema: z.object({ text: z.string() }),
  async call(input) {
    return { data: { echoed: input.text } };
  },
}) as unknown as Tool<unknown, unknown>;

const stopToolContext: ToolContext = {
  cwd: '/tmp/project',
  bundleRoot: '/tmp/project',
  sessionId: 'session-1',
};

const toolUseAnswer: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 'tool-1', name: 'Echo', input: { text: 'hello' } }],
};

const textAnswer: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'ok' }],
};

function toolUseProvider(): LLMProvider {
  return {
    name: 'tool-use',
    async *stream(): AsyncGenerator<StreamEvent, AssistantMessage> {
      yield { type: 'message_start' };
      yield { type: 'message_stop', stop_reason: 'tool_use' };
      yield { type: 'assistant_message', message: toolUseAnswer };
      return toolUseAnswer;
    },
  };
}

function flakyThenOkProvider(): LLMProvider {
  let calls = 0;
  return {
    name: 'flaky',
    async *stream(): AsyncGenerator<StreamEvent, AssistantMessage> {
      calls += 1;
      if (calls === 1) throw new ProviderHttpError('flaky', 503, 'unavailable');
      yield { type: 'message_start' };
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'message_stop', stop_reason: 'end_turn' };
      yield { type: 'assistant_message', message: textAnswer };
      return textAnswer;
    },
  };
}

async function drainQuery(gen: AsyncGenerator<StreamEvent | Message, Terminal>): Promise<Terminal> {
  while (true) {
    const step = await gen.next();
    if (step.done) return step.value;
  }
}

function stopRecorder(): { hookRunner: HookRunner; stops: string[]; prompts: number } {
  const stops: string[] = [];
  let prompts = 0;
  const hookRunner: HookRunner = async (event, payload) => {
    if (event === 'UserPromptSubmit') prompts += 1;
    if (event === 'Stop') {
      if (payload.hookEventName !== 'Stop') throw new Error('expected Stop payload');
      stops.push((payload as { reason: string }).reason);
    }
    return { block: false };
  };
  return {
    hookRunner,
    stops,
    get prompts() {
      return prompts;
    },
  };
}

async function runObservedSegment(
  segment: {
    messages: Message[];
    continuation: boolean;
    remainingModelCalls: number;
  },
  observed: {
    hookRunner: HookRunner;
    recall?: () => Promise<{ injectionText: string; lessons: [] }>;
  },
  mode: 'max_turns' | 'checkin' | 'text' | 'error-then-text',
  provider: LLMProvider,
): Promise<RunResult> {
  const terminal = await drainQuery(
    query({
      provider,
      model: 'fixture-model',
      messages: segment.messages,
      systemPrompt: [{ text: 'system', cacheable: true }],
      maxTokens: 32,
      maxTurns: mode === 'max_turns' ? 1 : segment.remainingModelCalls,
      continuation: segment.continuation,
      logicalTurn: true,
      hookRunner: observed.hookRunner,
      sessionId: 'session-1',
      cwd: '/tmp/project',
      ...(observed.recall ? { recall: observed.recall } : {}),
      ...(mode === 'max_turns' || mode === 'checkin'
        ? { tools: [echoTool], toolContext: stopToolContext }
        : {}),
      ...(mode === 'checkin' ? { maxToolCallsBeforeCheckin: 1 } : {}),
    }),
  );
  return {
    sessionId: 'session-1',
    terminal,
    iterationsUsed: 1,
    toolCallCount: mode === 'max_turns' || mode === 'checkin' ? 1 : 0,
    distinctToolNames: [],
    messages: segment.messages,
    ...(terminal.reason === 'completed' ? { finalAssistant: textAnswer } : {}),
  };
}

describe('logical turn Stop hooks', () => {
  test('a 503 then success records one Stop and does not rerun user-turn hooks', async () => {
    const observed = stopRecorder();
    let recalls = 0;
    const provider = flakyThenOkProvider();
    const { options } = setup(
      (segment) =>
        runObservedSegment(
          segment,
          {
            hookRunner: observed.hookRunner,
            recall: async () => {
              recalls += 1;
              return { injectionText: 'RECALL_MARKER', lessons: [] };
            },
          },
          'error-then-text',
          provider,
        ),
      { sleep: async () => {} },
    );
    const outcome = await superviseLogicalTurn(options);
    expect(outcome.status).toBe('completed');
    expect(outcome.counters.providerRetries).toBe(1);
    expect(observed.stops).toEqual(['completed']);
    expect(observed.prompts).toBe(1);
    expect(recalls).toBe(1);
  });

  test('a stall after max_turns records one Stop', async () => {
    const observed = stopRecorder();
    const provider = toolUseProvider();
    const { options } = setup(
      (segment) => runObservedSegment(segment, observed, 'max_turns', provider),
      { progressSnapshot: () => ({ same: true }) },
    );
    const outcome = await superviseLogicalTurn(options);
    expect(outcome.status).toBe('stalled');
    expect(observed.stops).toEqual(['max_turns']);
  });

  test('a check-in after max_turns records one Stop', async () => {
    const observed = stopRecorder();
    const provider = toolUseProvider();
    let segments = 0;
    const { options } = setup((segment) => {
      segments += 1;
      return runObservedSegment(
        segment,
        observed,
        segments === 1 ? 'max_turns' : 'checkin',
        provider,
      );
    });
    const outcome = await superviseLogicalTurn(options);
    expect(outcome.status).toBe('waiting_user');
    expect(segments).toBe(2);
    expect(observed.stops).toEqual(['checkin']);
  });

  test('model-call exhaustion after max_turns records one Stop', async () => {
    const observed = stopRecorder();
    const provider = toolUseProvider();
    const { options } = setup(
      (segment) => runObservedSegment(segment, observed, 'max_turns', provider),
      { logicalModelCallLimit: 1 },
    );
    const outcome = await superviseLogicalTurn(options);
    expect(outcome.status).toBe('exhausted');
    expect(outcome.finishReason).toBe('model_call_limit');
    expect(outcome.counters.segments).toBe(1);
    expect(observed.stops).toEqual(['max_turns']);
  });

  test('a deadline abort during a segment runs the Stop command once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'logical-stop-'));
    const marker = join(dir, 'stops.txt');
    const script = join(dir, 'stop.sh');
    writeFileSync(script, `#!/usr/bin/env bash\nprintf 'ran\\n' >> ${JSON.stringify(marker)}\n`);
    chmodSync(script, 0o755);
    const hookRunner = buildHookRunner({
      hooksByEvent: {
        PreToolUse: [],
        PostToolUse: [],
        UserPromptSubmit: [],
        Stop: [{ hooks: [{ type: 'command', command: script }] }],
      },
      consent: async () => 'allow',
      logStderr: () => {},
    });
    const stopLines = (): string[] => {
      try {
        return readFileSync(marker, 'utf8')
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
      } catch {
        return [];
      }
    };
    const controller = new AbortController();
    let nowMs = 0;
    let segments = 0;
    const deadlineProvider: LLMProvider = {
      name: 'deadline',
      async *stream(request): AsyncGenerator<StreamEvent, AssistantMessage> {
        yield { type: 'message_start' };
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            nowMs = 100;
            controller.abort('deadline');
            resolve();
          }, 20);
          const done = (): void => {
            clearTimeout(timer);
            resolve();
          };
          if (request.signal?.aborted) done();
          else request.signal?.addEventListener('abort', done, { once: true });
        });
        throw new Error('deadline');
      },
    };
    const { options } = setup(
      async (segment) => {
        segments += 1;
        if (segments === 1) {
          const terminal = await drainQuery(
            query({
              provider: toolUseProvider(),
              model: 'fixture-model',
              messages: segment.messages,
              systemPrompt: [{ text: 'system', cacheable: true }],
              maxTokens: 32,
              maxTurns: 1,
              continuation: segment.continuation,
              logicalTurn: true,
              hookRunner,
              sessionId: 'session-1',
              cwd: dir,
              tools: [echoTool],
              toolContext: stopToolContext,
              signal: segment.signal,
            }),
          );
          expect(terminal.reason).toBe('max_turns');
          return {
            sessionId: 'session-1',
            terminal,
            iterationsUsed: 1,
            toolCallCount: 1,
            distinctToolNames: ['Echo'],
            messages: segment.messages,
          };
        }
        // The first segment is not the logical terminal. Its Stop must not run.
        expect(stopLines()).toEqual([]);
        const terminal = await drainQuery(
          query({
            provider: deadlineProvider,
            model: 'fixture-model',
            messages: segment.messages,
            systemPrompt: [{ text: 'system', cacheable: true }],
            maxTokens: 32,
            maxTurns: segment.remainingModelCalls,
            continuation: segment.continuation,
            logicalTurn: true,
            hookRunner,
            sessionId: 'session-1',
            cwd: dir,
            signal: segment.signal,
          }),
        );
        return {
          sessionId: 'session-1',
          terminal,
          iterationsUsed: 1,
          toolCallCount: 0,
          distinctToolNames: [],
          messages: segment.messages,
        };
      },
      { signal: controller.signal, deadlineAt: 100, now: () => nowMs },
    );
    try {
      const outcome = await superviseLogicalTurn(options);
      expect(segments).toBe(2);
      expect(outcome.status).toBe('exhausted');
      expect(outcome.finishReason).toBe('deadline');
      expect(outcome.code).toBe('continuation_exhausted');
      expect(stopLines()).toEqual(['ran']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a user abort after max_turns does not run the previous Stop reason', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'logical-stop-cancel-'));
    const marker = join(dir, 'stops.txt');
    const script = join(dir, 'stop.cjs');
    writeFileSync(
      script,
      `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const payload = JSON.parse(readFileSync(0, 'utf8'));
appendFileSync(${JSON.stringify(marker)}, String(payload.reason) + '\\n');
`,
    );
    chmodSync(script, 0o755);
    const hookRunner = buildHookRunner({
      hooksByEvent: {
        PreToolUse: [],
        PostToolUse: [],
        UserPromptSubmit: [],
        Stop: [{ hooks: [{ type: 'command', command: script }] }],
      },
      consent: async () => 'allow',
      logStderr: () => {},
    });
    const stopLines = (): string[] => {
      try {
        return readFileSync(marker, 'utf8')
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
      } catch {
        return [];
      }
    };
    const controller = new AbortController();
    let segments = 0;
    const { store, options } = setup(
      async (segment) => {
        segments += 1;
        const terminal = await drainQuery(
          query({
            provider: toolUseProvider(),
            model: 'fixture-model',
            messages: segment.messages,
            systemPrompt: [{ text: 'system', cacheable: true }],
            maxTokens: 32,
            maxTurns: 1,
            continuation: segment.continuation,
            logicalTurn: true,
            hookRunner,
            sessionId: 'session-1',
            cwd: dir,
            tools: [echoTool],
            toolContext: stopToolContext,
            signal: segment.signal,
          }),
        );
        expect(terminal.reason).toBe('max_turns');
        // Neither segment is a logical ending. The command must stay idle.
        expect(stopLines()).toEqual([]);
        if (segments === 1) {
          return {
            sessionId: 'session-1',
            terminal,
            iterationsUsed: 1,
            toolCallCount: 1,
            distinctToolNames: ['Echo'],
            messages: segment.messages,
          };
        }
        controller.abort();
        throw new Error('interrupted');
      },
      { signal: controller.signal },
    );
    const ids: string[] = [];
    const create = store.createLogicalTurn.bind(store);
    store.createLogicalTurn = (record) => {
      ids.push(record.logicalTurnId);
      create(record);
    };
    try {
      await expect(superviseLogicalTurn(options)).rejects.toThrow('interrupted');
      expect(segments).toBe(2);
      const logicalTurnId = ids[0];
      if (!logicalTurnId) throw new Error('missing logical turn');
      const stored = store.loadLogicalTurn(logicalTurnId);
      expect(stored?.status).toBe('cancelled');
      expect(stored?.finishReason).toBe('cancelled');
      expect(stopLines()).toEqual(['interrupted']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a deadline after max_turns records one Stop', async () => {
    const observed = stopRecorder();
    const provider = toolUseProvider();
    let nowMs = 0;
    const { options } = setup(
      async (segment) => {
        const result = await runObservedSegment(segment, observed, 'max_turns', provider);
        nowMs = 5;
        return result;
      },
      { deadlineAt: 5, now: () => nowMs },
    );
    const outcome = await superviseLogicalTurn(options);
    expect(outcome.status).toBe('exhausted');
    expect(outcome.finishReason).toBe('deadline');
    expect(observed.stops).toEqual(['max_turns']);
  });

  test('recovery_unsafe after max_turns records one Stop', async () => {
    const observed = stopRecorder();
    const provider = toolUseProvider();
    const { options } = setup(
      (segment) => runObservedSegment(segment, observed, 'max_turns', provider),
      { recoverySafe: () => false },
    );
    const outcome = await superviseLogicalTurn(options);
    expect(outcome.status).toBe('failed');
    expect(outcome.code).toBe('recovery_unsafe');
    expect(observed.stops).toEqual(['max_turns']);
  });

  test('a non-retryable provider error records one Stop', async () => {
    const observed = stopRecorder();
    const { options } = setup((segment) =>
      runObservedSegment(segment, observed, 'text', {
        name: 'denied',
        async *stream(): AsyncGenerator<StreamEvent, AssistantMessage> {
          yield { type: 'message_start' };
          throw new ProviderHttpError('denied', 400, 'bad request');
        },
      }),
    );
    const outcome = await superviseLogicalTurn(options);
    expect(outcome.status).toBe('failed');
    expect(observed.stops).toEqual(['error']);
  });

  test('a provider error outside a logical turn still records Stop', async () => {
    const observed = stopRecorder();
    const terminal = await drainQuery(
      query({
        provider: {
          name: 'down',
          async *stream(): AsyncGenerator<StreamEvent, AssistantMessage> {
            yield { type: 'message_start' };
            throw new ProviderHttpError('down', 503, 'unavailable');
          },
        },
        model: 'fixture-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'do the work' }] }],
        systemPrompt: [],
        maxTokens: 32,
        hookRunner: observed.hookRunner,
        sessionId: 'session-1',
        cwd: '/tmp/project',
      }),
    );
    expect(terminal.reason).toBe('error');
    expect(observed.stops).toEqual(['error']);
  });
});

const LEASE_COUNTERS: LogicalTurnRecord['counters'] = {
  segments: 1,
  modelCalls: 1,
  toolCalls: 0,
  providerRetries: 0,
  contextRecoveries: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  estimatedCostUsd: 0,
};

function storedTurn(id: string): LogicalTurnRecord {
  return {
    version: 1,
    logicalTurnId: id,
    sessionId: 'session-1',
    activeSessionId: 'session-1',
    compactedSessionIds: [],
    binding,
    bindingDigest: 'digest',
    logicalModelCallLimit: 100,
    status: 'running',
    repeatedNoProgress: 0,
    runtimeContinuationIds: [],
    counters: { ...LEASE_COUNTERS },
    createdAt: 1,
    updatedAt: 1,
  };
}

function expectShortFencedLease(store: LogicalTurnStore): void {
  const now = 50_000;
  const record = storedTurn('lt-fence');
  store.createLogicalTurn(record);
  expect(store.acquireLogicalTurnLease(record.logicalTurnId, 'owner-a', now + 30_000, now)).toBe(
    true,
  );
  expect(
    store.acquireLogicalTurnLease(record.logicalTurnId, 'owner-b', now + 30_000, now + 1_000),
  ).toBe(false);
  expect(
    store.acquireLogicalTurnLease(record.logicalTurnId, 'owner-b', now + 30_000, now + 30_000),
  ).toBe(true);
  store.saveLogicalTurn({ ...record, finalReply: 'kept' }, 'owner-b');
  expect(() => store.saveLogicalTurn({ ...record, finalReply: 'lost' }, 'owner-a')).toThrow(
    LogicalTurnLeaseError,
  );
  expect(store.loadLogicalTurn(record.logicalTurnId)?.finalReply).toBe('kept');
  expect(store.renewLogicalTurnLease(record.logicalTurnId, 'owner-a', now + 90_000)).toBe(false);
  store.releaseLogicalTurnLease(record.logicalTurnId, 'owner-b');
  expect(store.renewLogicalTurnLease(record.logicalTurnId, 'owner-b', now + 120_000)).toBe(false);
  expect(store.loadLogicalTurn(record.logicalTurnId)?.finalReply).toBe('kept');
  expect(
    store.acquireLogicalTurnLease(record.logicalTurnId, 'owner-c', now + 120_000, now + 30_000),
  ).toBe(true);
}

describe('logical-turn lease stores', () => {
  test('in-memory leases follow supervisor time and fence the owner', () => {
    expectShortFencedLease(createInMemorySessionStore());
  });

  test('sqlite leases follow supervisor time and fence the owner', () => {
    const db = SessionDb.open({ path: ':memory:' });
    try {
      expectShortFencedLease(db);
    } finally {
      db.close();
    }
  });
});

describe('logical-turn lease lifetime', () => {
  test('a live model call past five minutes keeps the short lease', async () => {
    let nowMs = 1_700_000_000_000;
    const startedAt = nowMs;
    const waiters: Array<(advanced: boolean) => void> = [];
    const expiries: Array<{ expiresAt: number; at: number }> = [];
    let releaseSegment: (() => void) | undefined;
    const segmentGate = new Promise<void>((resolve) => {
      releaseSegment = resolve;
    });
    let segmentStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      segmentStarted = resolve;
    });
    const fixture = setup(
      async () => {
        segmentStarted?.();
        await segmentGate;
        return result('completed', 'done');
      },
      {
        now: () => nowMs,
        sleep: (ms) =>
          new Promise((resolve) => {
            waiters.push((advanced) => {
              if (advanced) nowMs += ms;
              resolve();
            });
          }),
      },
    );
    const acquire = fixture.store.acquireLogicalTurnLease.bind(fixture.store);
    fixture.store.acquireLogicalTurnLease = (id, owner, expiresAt, at) => {
      expiries.push({ expiresAt, at });
      return acquire(id, owner, expiresAt, at);
    };
    const renew = fixture.store.renewLogicalTurnLease?.bind(fixture.store);
    fixture.store.renewLogicalTurnLease = (id, owner, expiresAt) => {
      expiries.push({ expiresAt, at: nowMs });
      return renew ? renew(id, owner, expiresAt) : false;
    };
    let logicalTurnId = '';
    const create = fixture.store.createLogicalTurn.bind(fixture.store);
    fixture.store.createLogicalTurn = (record) => {
      logicalTurnId = record.logicalTurnId;
      create(record);
    };

    const first = superviseLogicalTurn(fixture.options);
    try {
      await started;
      for (let i = 0; i < 10; i++) await Promise.resolve();
      const target = nowMs + 6 * 60_000;
      while (nowMs < target) {
        const waiter = waiters.shift();
        if (!waiter) {
          await Promise.resolve();
          if (waiters.length === 0) {
            nowMs = target;
            break;
          }
          continue;
        }
        waiter(true);
        for (let i = 0; i < 12; i++) await Promise.resolve();
      }

      let secondCalls = 0;
      const continued = superviseLogicalTurn({
        ...fixture.options,
        logicalTurnId,
        runSegment: async () => {
          secondCalls++;
          return result('completed', 'other');
        },
      });
      await expect(continued).rejects.toBeInstanceOf(LogicalTurnLeaseError);
      expect(secondCalls).toBe(0);
      expect(expiries.length).toBeGreaterThan(0);
      expect(expiries.every((row) => row.expiresAt - row.at <= 30_000)).toBe(true);
      expect(Math.max(...expiries.map((row) => row.expiresAt))).toBeGreaterThan(
        startedAt + 5 * 60_000,
      );
    } finally {
      releaseSegment?.();
      for (const waiter of waiters.splice(0)) waiter(false);
    }
    await expect(first).resolves.toMatchObject({ status: 'completed', reply: 'done' });
  });

  test('an expired lease is reclaimed after a crash only when recovery is safe', async () => {
    let nowMs = Date.now();
    let releaseSegment: (() => void) | undefined;
    const segmentGate = new Promise<void>((resolve) => {
      releaseSegment = resolve;
    });
    let segmentStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      segmentStarted = resolve;
    });
    const fixture = setup(
      async () => {
        segmentStarted?.();
        await segmentGate;
        return result('completed', 'stale');
      },
      {
        deadlineAt: nowMs + 60 * 60_000,
        now: () => nowMs,
        sleep: () => new Promise(() => {}),
      },
    );
    let logicalTurnId = '';
    const create = fixture.store.createLogicalTurn.bind(fixture.store);
    fixture.store.createLogicalTurn = (record) => {
      logicalTurnId = record.logicalTurnId;
      create(record);
    };
    const first = superviseLogicalTurn(fixture.options).then(
      () => new Error('stale owner overwrote the turn'),
      (error: unknown) => error,
    );
    try {
      await started;
      nowMs += 31_000;

      let secondCalls = 0;
      const resumed = await superviseLogicalTurn({
        ...fixture.options,
        logicalTurnId,
        runSegment: async () => {
          secondCalls++;
          return result('completed', 'resumed');
        },
      });
      expect(secondCalls).toBe(1);
      expect(resumed).toMatchObject({ status: 'completed', reply: 'resumed' });
    } finally {
      releaseSegment?.();
    }
    await expect(first).resolves.toBeInstanceOf(LogicalTurnLeaseError);
    expect(fixture.store.loadLogicalTurn(logicalTurnId)?.finalReply).toBe('resumed');
  });

  test('does not reclaim an expired lease when recovery is unsafe', async () => {
    let nowMs = Date.now();
    let releaseSegment: (() => void) | undefined;
    const segmentGate = new Promise<void>((resolve) => {
      releaseSegment = resolve;
    });
    let segmentStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      segmentStarted = resolve;
    });
    const fixture = setup(
      async () => {
        segmentStarted?.();
        await segmentGate;
        return result('completed', 'stale');
      },
      {
        deadlineAt: nowMs + 60 * 60_000,
        now: () => nowMs,
        sleep: () => new Promise(() => {}),
      },
    );
    let logicalTurnId = '';
    const create = fixture.store.createLogicalTurn.bind(fixture.store);
    fixture.store.createLogicalTurn = (record) => {
      logicalTurnId = record.logicalTurnId;
      create(record);
    };
    const first = superviseLogicalTurn(fixture.options).catch((error: unknown) => error);
    try {
      await started;
      nowMs += 31_000;
      let calls = 0;
      const probe = { freeDuringCheck: false };
      const blocked = await superviseLogicalTurn({
        ...fixture.options,
        logicalTurnId,
        recoverySafe: () => {
          probe.freeDuringCheck = fixture.store.acquireLogicalTurnLease(
            logicalTurnId,
            'probe',
            nowMs + 1_000,
            nowMs,
          );
          if (probe.freeDuringCheck) fixture.store.releaseLogicalTurnLease(logicalTurnId, 'probe');
          return false;
        },
        runSegment: async () => {
          calls++;
          return result('completed', 'unsafe');
        },
      });
      expect(blocked).toMatchObject({ status: 'failed', code: 'recovery_unsafe' });
      expect(probe.freeDuringCheck).toBe(true);
      expect(calls).toBe(0);
      expect(
        fixture.store.acquireLogicalTurnLease(logicalTurnId, 'later', nowMs + 30_000, nowMs),
      ).toBe(true);
    } finally {
      releaseSegment?.();
    }
    await first;
  });

  test('a second supervisor aborts the blocked tool before its effect or row', async () => {
    await expectDispossessedToolStops(createInMemorySessionStore(), 'resume');
  });

  test('a stolen sqlite lease aborts the blocked tool when renew fails', async () => {
    const db = SessionDb.open({ path: ':memory:' });
    try {
      await expectDispossessedToolStops(db, 'renew');
    } finally {
      db.close();
    }
  });
});

/** Block inside a tool, move the lease, then let the tool return. */
async function expectDispossessedToolStops(
  store: InMemorySessionStore | SessionDb,
  handoff: 'resume' | 'renew',
): Promise<void> {
  let nowMs = 1_000_000;
  const effects: string[] = [];
  const waiters: Array<() => void> = [];
  let releaseTool: (() => void) | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let providerSignal: AbortSignal | undefined;
  const sessionId = 'session-hold';
  const prompt = {
    role: 'user' as const,
    content: [{ type: 'text' as const, text: 'do the work' }],
  };
  const toolUse: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tool-hold', name: 'Hold', input: {} }],
  };
  const hold = buildTool({
    name: 'Hold',
    description: () => 'wait until the caller releases the gate',
    inputSchema: z.object({}),
    async call(_input: unknown, ctx: ToolContext) {
      await new Promise<void>((resolve, reject) => {
        const fail = () => reject(ctx.signal?.reason ?? new Error('aborted'));
        if (ctx.signal?.aborted) {
          fail();
          return;
        }
        const onAbort = () => fail();
        ctx.signal?.addEventListener('abort', onAbort, { once: true });
        releaseTool = () => {
          ctx.signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        markStarted?.();
      });
      effects.push('ran');
      store.saveMessage(sessionId, {
        role: 'user',
        content: [{ type: 'text', text: 'late row' }],
      });
      return { data: { held: true } };
    },
  });
  const provider: LLMProvider = {
    name: 'hold',
    async *stream(request: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      providerSignal = request.signal;
      yield { type: 'message_start' };
      yield { type: 'message_stop', stop_reason: 'tool_use' };
      yield { type: 'assistant_message', message: toolUse };
      return toolUse;
    },
  };
  const agent = createAgent({
    provider,
    model: 'fixture-model',
    tools: [hold],
    cwd: '/tmp/project',
    sessionStore: store,
  });
  store.createSession({ sessionId, provider: 'fixture', model: 'fixture-model' });
  store.saveMessage(sessionId, prompt);
  let logicalTurnId = '';
  const create = store.createLogicalTurn.bind(store);
  store.createLogicalTurn = (record) => {
    logicalTurnId = record.logicalTurnId;
    create(record);
  };
  const first = superviseLogicalTurn({
    store,
    binding,
    sessionId,
    initialMessages: [prompt],
    rehydrate: () => [prompt],
    recoverySafe: () => true,
    now: () => nowMs,
    deadlineAt: nowMs + 60 * 60_000,
    sleep: () =>
      new Promise<void>((resolve) => {
        waiters.push(resolve);
      }),
    runSegment: async (segment) =>
      drainRun(
        agent.run(segment.messages, {
          sessionId,
          logicalTurn: true,
          maxTurns: 1,
        }),
      ),
  }).then(
    () => new Error('dispossessed worker finished the turn'),
    (error: unknown) => error,
  );
  try {
    await started;
    nowMs += LOGICAL_TURN_LEASE_MS + 1;
    if (handoff === 'resume') {
      const resumed = await superviseLogicalTurn({
        store,
        binding,
        sessionId,
        logicalTurnId,
        initialMessages: [prompt],
        rehydrate: () => [prompt],
        recoverySafe: () => true,
        now: () => nowMs,
        deadlineAt: nowMs + 60 * 60_000,
        sleep: () => new Promise<void>(() => {}),
        runSegment: async () => result('completed', 'resumed'),
      });
      expect(resumed).toMatchObject({ status: 'completed', reply: 'resumed' });
    } else {
      expect(
        store.acquireLogicalTurnLease(logicalTurnId, 'other-process', nowMs + 30_000, nowMs),
      ).toBe(true);
      const waiter = waiters.shift();
      if (!waiter) throw new Error('heartbeat did not wait');
      waiter();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }
    expect(providerSignal?.aborted).toBe(true);
    expect(effects).toEqual([]);
    releaseTool?.();
    expect(await first).toBeInstanceOf(LogicalTurnLeaseError);
    expect(effects).toEqual([]);
    const rows = store.loadMessages(sessionId);
    expect(rows.some((row) => row.content.some((block) => block.type === 'tool_use'))).toBe(true);
    expect(rows.some((row) => row.content.some((block) => block.type === 'tool_result'))).toBe(
      false,
    );
    expect(JSON.stringify(rows)).not.toContain('late row');
    expect(store.loadToolExecutions(sessionId).every((row) => row.state !== 'completed')).toBe(
      true,
    );
    if (handoff === 'resume') {
      expect(store.loadLogicalTurn(logicalTurnId)?.finalReply).toBe('resumed');
    }
  } finally {
    releaseTool?.();
    for (const waiter of waiters.splice(0)) waiter();
  }
}

async function drainRun(gen: AsyncGenerator<StreamEvent | Message, RunResult>): Promise<RunResult> {
  while (true) {
    const step = await gen.next();
    if (step.done) return step.value;
  }
}

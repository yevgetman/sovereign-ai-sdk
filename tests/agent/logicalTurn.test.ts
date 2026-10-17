import { describe, expect, test } from 'bun:test';
import type { RunResult } from '@yevgetman/sov-sdk/agent/createAgent';
import {
  type LogicalTurnSupervisorOptions,
  superviseLogicalTurn,
} from '@yevgetman/sov-sdk/agent/logicalTurn';
import { createInMemorySessionStore } from '@yevgetman/sov-sdk/persistence/inMemoryStore';
import { ProviderHttpError } from '@yevgetman/sov-sdk/providers/errors';

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

  test('stops after two equal no-progress segment outcomes', async () => {
    const { options } = setup(async () => result('max_turns'));
    const outcome = await superviseLogicalTurn({
      ...options,
      progressSnapshot: () => ({ messages: ['same'], receipts: [] }),
    });
    expect(outcome.status).toBe('stalled');
    expect(outcome.code).toBe('continuation_stalled');
    expect(outcome.counters.segments).toBe(2);
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

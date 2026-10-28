import { expect, test } from 'bun:test';
import {
  type LogicalTurnSupervisorOptions,
  migrateLogicalTurnPolicy,
  superviseLogicalTurn,
} from '@yevgetman/sov-sdk/agent/logicalTurn';
import { createInMemorySessionStore } from '@yevgetman/sov-sdk/persistence/inMemoryStore';

function fixture(limit?: number | null) {
  const store = createInMemorySessionStore();
  const binding = { provider: 'fixture', model: 'fixture', cwd: '/tmp' };
  let calls = 0;
  const options: LogicalTurnSupervisorOptions = {
    store,
    binding,
    sessionId: 'continuous',
    initialMessages: [],
    ...(limit !== undefined ? { logicalModelCallLimit: limit } : {}),
    recoverySafe: () => true,
    rehydrate: () => [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'page', content: `page ${calls}` }],
      },
    ],
    runSegment: async () => {
      calls++;
      return {
        sessionId: 'continuous',
        terminal: { reason: calls > 1001 ? 'completed' : 'max_turns' },
        iterationsUsed: 1,
        toolCallCount: 1,
        distinctToolNames: ['page'],
        messages: [],
      };
    },
  };
  return { store, binding, options, calls: () => calls };
}

test('continuous slices cross 1000 changing read-only pages with null limits on record and events', async () => {
  const f = fixture(null);
  let events = 0;
  f.options.onContinuing = (event) => {
    expect(event.limits.modelCalls).toBeNull();
    events++;
  };
  const result = await superviseLogicalTurn(f.options);
  expect(result.status).toBe('completed');
  expect(result.counters.modelCalls).toBe(1002);
  expect(events).toBe(1001);
  expect(f.store.loadLogicalTurn(result.logicalTurnId)).toMatchObject({
    version: 2,
    policyOrigin: 'owner',
    logicalModelCallLimit: null,
  });
});

test('omitted policy is unlimited and finite policy stops exactly', async () => {
  const unlimited = fixture();
  const complete = await superviseLogicalTurn(unlimited.options);
  expect(complete.status).toBe('completed');
  const bounded = fixture(8);
  const result = await superviseLogicalTurn(bounded.options);
  expect(result.status).toBe('exhausted');
  expect(bounded.calls()).toBe(8);
  expect(result.reply).toContain('explicit');
});

for (const invalid of [
  0,
  -1,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  1.5,
]) {
  test(`reject invalid cumulative limit ${invalid}`, async () => {
    const f = fixture(invalid);
    await expect(superviseLogicalTurn(f.options)).rejects.toThrow('positive safe integer');
    expect(f.calls()).toBe(0);
  });
}

test('legacy ceiling survives null resume override; explicit migration records policy without changing pins/deadline', async () => {
  const f = fixture(2);
  const create = f.store.createLogicalTurn;
  f.store.createLogicalTurn = (row) => {
    const { policyOrigin: _origin, ...legacy } = row;
    create({ ...legacy, version: 1, deadlineAt: Date.now() + 100000 });
  };
  const first = await superviseLogicalTurn(f.options);
  const resumed = await superviseLogicalTurn({
    ...f.options,
    logicalTurnId: first.logicalTurnId,
    logicalModelCallLimit: null,
  });
  expect(resumed.status).toBe('exhausted');
  expect(f.calls()).toBe(2);
  const migrated = migrateLogicalTurnPolicy({
    store: f.store,
    binding: f.binding,
    logicalTurnId: first.logicalTurnId,
    logicalModelCallLimit: null,
    policyOrigin: 'owner',
    reason: 'Owner explicitly adopts continuous policy',
    recoverySafe: () => true,
  });
  expect(migrated).toMatchObject({
    version: 2,
    logicalModelCallLimit: null,
    policyOrigin: 'owner',
    policyMigrations: [{ fromVersion: 1, previousLimit: 2 }],
  });
  expect(migrated.deadlineAt).toBeGreaterThan(Date.now());
  expect(
    (await superviseLogicalTurn({ ...f.options, logicalTurnId: first.logicalTurnId })).status,
  ).toBe('completed');
});

test('cancel records source and cannot be migrated or resurrected', async () => {
  const f = fixture(null);
  const abort = new AbortController();
  f.options.signal = abort.signal;
  f.options.runSegment = async () => {
    abort.abort('owner_stop');
    return {
      sessionId: 'continuous',
      terminal: { reason: 'max_turns' },
      iterationsUsed: 8,
      toolCallCount: 10,
      distinctToolNames: [],
      messages: [],
    };
  };
  const result = await superviseLogicalTurn(f.options);
  expect(result.status).toBe('cancelled');
  expect(f.store.loadLogicalTurn(result.logicalTurnId)).toMatchObject({
    lastCause: 'max_turns',
    cancellationSource: 'owner_stop',
  });
  expect(() =>
    migrateLogicalTurnPolicy({
      store: f.store,
      binding: f.binding,
      logicalTurnId: result.logicalTurnId,
      logicalModelCallLimit: null,
      policyOrigin: 'owner',
      reason: 'migration',
      recoverySafe: () => true,
    }),
  ).toThrow('cancelled');
  expect(
    (await superviseLogicalTurn({ ...f.options, logicalTurnId: result.logicalTurnId }))
      .finishReason,
  ).toBe('recovery_state_invalid');
});

test('slice request cleanup does not abort shared logical signal; shared detector and budget survive slices', async () => {
  const f = fixture(null);
  const signals = new Set<AbortSignal>();
  const states = new Set<unknown>();
  let slices = 0;
  f.options.runSegment = async (segment) => {
    signals.add(segment.signal);
    states.add(segment.loopState);
    const request = new AbortController();
    request.abort('request_cleanup');
    expect(segment.signal.aborted).toBe(false);
    slices++;
    segment.modelCallBudget.used++;
    return {
      sessionId: 'continuous',
      terminal: { reason: slices === 2 ? 'completed' : 'max_turns' },
      iterationsUsed: 1,
      toolCallCount: 0,
      distinctToolNames: [],
      messages: [],
    };
  };
  const result = await superviseLogicalTurn(f.options);
  expect(result.status).toBe('completed');
  expect(result.counters.modelCalls).toBe(2);
  expect(signals.size).toBe(1);
  expect(states.size).toBe(1);
});

test('child consumption charged to shared root is not lost at slice boundary', async () => {
  const f = fixture(4);
  f.options.runSegment = async (segment) => {
    segment.modelCallBudget.used += 4;
    return {
      sessionId: 'continuous',
      terminal: { reason: 'max_turns' },
      iterationsUsed: 1,
      toolCallCount: 1,
      distinctToolNames: [],
      messages: [],
    };
  };
  const result = await superviseLogicalTurn(f.options);
  expect(result.status).toBe('exhausted');
  expect(result.counters.modelCalls).toBe(4);
});

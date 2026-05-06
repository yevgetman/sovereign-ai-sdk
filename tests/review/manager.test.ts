import { describe, expect, test } from 'bun:test';
import { ReviewManager } from '../../src/review/manager.js';
import type { SubagentScheduler } from '../../src/runtime/scheduler.js';
import type { Tool, ToolContext } from '../../src/tool/types.js';

function emptyParent() {
  return {
    parentToolPool: [] as Tool<unknown, unknown>[],
    parentToolContext: { cwd: '/tmp', sessionId: 'p' } as ToolContext,
  };
}

function fakeScheduler(record: Array<Record<string, unknown>>): SubagentScheduler {
  return {
    delegate: async (input: Record<string, unknown>) => {
      record.push(input);
      return {
        childSessionId: 'c',
        agentName: input.agentName,
        resolvedProvider: 'fake',
        resolvedModel: 'fake-1',
        terminal: { reason: 'completed' as const },
        summary: 'ok',
        iterationsUsed: 1,
        toolCallCount: 0,
        durationMs: 1,
      };
    },
  } as unknown as SubagentScheduler;
}

describe('ReviewManager triggers', () => {
  test('memory review fires every N user turns and resets the counter', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'p',
      signal: new AbortController().signal,
      thresholds: { userTurnsForMemoryReview: 3, toolIterationsForSkillReview: 9999 },
      pathsResolver: () => ({ trajectoryPath: '/t/samples.jsonl', tracePath: '/t/trace.jsonl' }),
      ...emptyParent(),
    });

    mgr.onUserTurn('p');
    mgr.onUserTurn('p');
    expect(calls.length).toBe(0);

    mgr.onUserTurn('p'); // hits 3 → fires
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(1);
    expect(calls[0]?.agentName).toBe('review-memory');

    // counter reset
    mgr.onUserTurn('p');
    mgr.onUserTurn('p');
    expect(calls.length).toBe(1);
  });

  test('skill review fires every M tool iterations independently of user turns', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'p',
      signal: new AbortController().signal,
      thresholds: { userTurnsForMemoryReview: 9999, toolIterationsForSkillReview: 2 },
      pathsResolver: () => ({ trajectoryPath: '/t/x', tracePath: '/t/y' }),
      ...emptyParent(),
    });

    mgr.onToolIteration('p');
    expect(calls.length).toBe(0);
    mgr.onToolIteration('p');
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(1);
    expect(calls[0]?.agentName).toBe('review-skill');
  });

  test('onChildCompletion fires every Nth qualifying call (default 3)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'p',
      signal: new AbortController().signal,
      thresholds: { userTurnsForMemoryReview: 9999, toolIterationsForSkillReview: 9999 },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      ...emptyParent(),
    });

    // First two non-trivial completions: counter accumulates, no dispatch
    mgr.onChildCompletion({
      childSessionId: 'c1',
      taskId: 't1',
      traceId: 'tr1',
      iterationsUsed: 5,
      toolCallCount: 3,
    });
    mgr.onChildCompletion({
      childSessionId: 'c2',
      taskId: 't2',
      traceId: 'tr2',
      iterationsUsed: 4,
      toolCallCount: 2,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(0);

    // Third fires
    mgr.onChildCompletion({
      childSessionId: 'c3',
      taskId: 't3',
      traceId: 'tr3',
      iterationsUsed: 3,
      toolCallCount: 2,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(1);
    expect(calls[0]?.agentName).toBe('review-memory');
  });

  test('onChildCompletion respects custom childReviewEveryN', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'p',
      signal: new AbortController().signal,
      thresholds: {
        userTurnsForMemoryReview: 9999,
        toolIterationsForSkillReview: 9999,
        childReviewEveryN: 1,
      },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      ...emptyParent(),
    });

    mgr.onChildCompletion({
      childSessionId: 'c1',
      taskId: 't',
      traceId: 'tr',
      iterationsUsed: 5,
      toolCallCount: 3,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(1);
    expect(calls[0]?.agentName).toBe('review-memory');
  });

  test('onChildCompletion skips trivial children (low iterations or zero tool calls)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'p',
      signal: new AbortController().signal,
      thresholds: {
        userTurnsForMemoryReview: 9999,
        toolIterationsForSkillReview: 9999,
        childReviewEveryN: 1,
      },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      ...emptyParent(),
    });

    // iterationsUsed < 2 → skip
    mgr.onChildCompletion({
      childSessionId: 'c1',
      taskId: 't',
      traceId: 'tr',
      iterationsUsed: 1,
      toolCallCount: 5,
    });
    // toolCallCount === 0 → skip
    mgr.onChildCompletion({
      childSessionId: 'c2',
      taskId: 't',
      traceId: 'tr',
      iterationsUsed: 5,
      toolCallCount: 0,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(0);

    // Non-trivial → fires (childReviewEveryN=1)
    mgr.onChildCompletion({
      childSessionId: 'c3',
      taskId: 't',
      traceId: 'tr',
      iterationsUsed: 5,
      toolCallCount: 5,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(1);
    expect(calls[0]?.agentName).toBe('review-memory');
  });

  test('onChildCompletion without iterationsUsed/toolCallCount falls through to counter (back-compat)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'p',
      signal: new AbortController().signal,
      thresholds: {
        userTurnsForMemoryReview: 9999,
        toolIterationsForSkillReview: 9999,
        childReviewEveryN: 1,
      },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      ...emptyParent(),
    });

    // No metrics → trivial-skip can't trigger; counter fires
    mgr.onChildCompletion({ childSessionId: 'c', taskId: 't', traceId: 'tr' });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(1);
    expect(calls[0]?.agentName).toBe('review-memory');
  });

  test('disabled flag suppresses every dispatch', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'p',
      signal: new AbortController().signal,
      thresholds: { userTurnsForMemoryReview: 1, toolIterationsForSkillReview: 1 },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      enabled: false,
      ...emptyParent(),
    });
    mgr.onUserTurn('p');
    mgr.onToolIteration('p');
    mgr.onChildCompletion({ childSessionId: 'c', taskId: 't', traceId: 'tr' });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(0);
  });

  test('runConsolidationPass dispatches review-consolidate agent', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'p',
      signal: new AbortController().signal,
      thresholds: { userTurnsForMemoryReview: 9999, toolIterationsForSkillReview: 9999 },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      ...emptyParent(),
    });

    mgr.runConsolidationPass('/tmp/home');
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(1);
    expect(calls[0]?.agentName).toBe('review-consolidate');
  });

  test('A3 temporal lockout: rapid same-agent dispatches are deduped', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'p',
      signal: new AbortController().signal,
      thresholds: {
        userTurnsForMemoryReview: 9999,
        toolIterationsForSkillReview: 9999,
        childReviewEveryN: 1,
        minIntervalMs: 1000, // 1s lockout for the test
      },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      ...emptyParent(),
    });

    // First non-trivial completion fires (counter=1, no prior dispatch)
    mgr.onChildCompletion({
      childSessionId: 'c1',
      taskId: 't',
      traceId: 'tr',
      iterationsUsed: 5,
      toolCallCount: 3,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(1);

    // Second non-trivial completion 50ms later — counter=1 again (childReviewEveryN=1),
    // but lockout is 1s → dispatch deduped
    mgr.onChildCompletion({
      childSessionId: 'c2',
      taskId: 't',
      traceId: 'tr',
      iterationsUsed: 5,
      toolCallCount: 3,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(1); // still 1 — second was deduped
  });

  test('A3 temporal lockout: dispatch fires again after minIntervalMs elapses', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'p',
      signal: new AbortController().signal,
      thresholds: {
        userTurnsForMemoryReview: 9999,
        toolIterationsForSkillReview: 9999,
        childReviewEveryN: 1,
        minIntervalMs: 100, // 100ms lockout for the test
      },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      ...emptyParent(),
    });

    mgr.onChildCompletion({
      childSessionId: 'c1',
      taskId: 't',
      traceId: 'tr',
      iterationsUsed: 5,
      toolCallCount: 3,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(1);

    // Wait past lockout
    await new Promise((r) => setTimeout(r, 150));

    mgr.onChildCompletion({
      childSessionId: 'c2',
      taskId: 't',
      traceId: 'tr',
      iterationsUsed: 5,
      toolCallCount: 3,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(2);
  });

  test('A3 temporal lockout: review-memory and review-skill have independent timers', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'p',
      signal: new AbortController().signal,
      thresholds: {
        userTurnsForMemoryReview: 1,
        toolIterationsForSkillReview: 1,
        childReviewEveryN: 1,
        minIntervalMs: 60_000, // 60s
      },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      ...emptyParent(),
    });

    // memory + skill within ms of each other — both fire (different agents)
    mgr.onUserTurn('p');
    mgr.onToolIteration('p');
    await new Promise((r) => setTimeout(r, 20));
    const names = calls.map((c) => c.agentName).sort();
    expect(names).toEqual(['review-memory', 'review-skill']);
  });

  test('A3 temporal lockout does NOT apply to runConsolidationPass', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'p',
      signal: new AbortController().signal,
      thresholds: {
        userTurnsForMemoryReview: 9999,
        toolIterationsForSkillReview: 9999,
        childReviewEveryN: 9999,
        minIntervalMs: 60_000, // huge lockout
      },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      ...emptyParent(),
    });

    mgr.runConsolidationPass('/tmp/home');
    mgr.runConsolidationPass('/tmp/home');
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBe(2); // consolidation is user-invoked; no throttle
  });
});

describe('ReviewManager getDispatchSummary (B3)', () => {
  test('returns empty summary when nothing has been dispatched', () => {
    const mgr = new ReviewManager({
      scheduler: fakeScheduler([]),
      sessionId: 'p',
      signal: new AbortController().signal,
      thresholds: { userTurnsForMemoryReview: 9999, toolIterationsForSkillReview: 9999 },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      ...emptyParent(),
    });

    expect(mgr.getDispatchSummary()).toEqual({ totalDispatched: 0, byAgent: {} });
  });

  test('tracks dispatches per agent type', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'p',
      signal: new AbortController().signal,
      thresholds: {
        userTurnsForMemoryReview: 1,
        toolIterationsForSkillReview: 1,
        minIntervalMs: 0,
      },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      ...emptyParent(),
    });

    mgr.onUserTurn('p');
    mgr.onToolIteration('p');
    await new Promise((r) => setTimeout(r, 30));

    const summary = mgr.getDispatchSummary();
    expect(summary.totalDispatched).toBe(2);
    expect(summary.byAgent['review-memory']).toBe(1);
    expect(summary.byAgent['review-skill']).toBe(1);
  });

  test('runConsolidationPass increments review-consolidate count', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'p',
      signal: new AbortController().signal,
      thresholds: { userTurnsForMemoryReview: 9999, toolIterationsForSkillReview: 9999 },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      ...emptyParent(),
    });

    mgr.runConsolidationPass('/tmp/home');
    await new Promise((r) => setTimeout(r, 30));
    expect(mgr.getDispatchSummary().byAgent['review-consolidate']).toBe(1);
    expect(mgr.getDispatchSummary().totalDispatched).toBe(1);
  });

  test('multiple consolidation passes accumulate correctly', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'p',
      signal: new AbortController().signal,
      thresholds: { userTurnsForMemoryReview: 9999, toolIterationsForSkillReview: 9999 },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      ...emptyParent(),
    });

    mgr.runConsolidationPass('/tmp/home');
    mgr.runConsolidationPass('/tmp/home');
    await new Promise((r) => setTimeout(r, 30));
    expect(mgr.getDispatchSummary().byAgent['review-consolidate']).toBe(2);
    expect(mgr.getDispatchSummary().totalDispatched).toBe(2);
  });

  test('lockout does not increment count for suppressed dispatches', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'p',
      signal: new AbortController().signal,
      thresholds: {
        userTurnsForMemoryReview: 1,
        toolIterationsForSkillReview: 9999,
        minIntervalMs: 60_000, // long lockout
      },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      ...emptyParent(),
    });

    mgr.onUserTurn('p'); // fires
    mgr.onUserTurn('p'); // locked out — NOT counted
    await new Promise((r) => setTimeout(r, 30));

    const summary = mgr.getDispatchSummary();
    expect(summary.byAgent['review-memory']).toBe(1);
    expect(summary.totalDispatched).toBe(1);
  });
});

describe('ReviewManager abort signal (B4 follow-up)', () => {
  test('all triggers no-op when signal is aborted', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const ac = new AbortController();
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'p',
      signal: ac.signal,
      thresholds: {
        userTurnsForMemoryReview: 1,
        toolIterationsForSkillReview: 1,
        childReviewEveryN: 1,
        minIntervalMs: 0,
      },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      ...emptyParent(),
    });

    ac.abort();

    mgr.onUserTurn('p');
    mgr.onToolIteration('p');
    mgr.onChildCompletion({
      childSessionId: 'c',
      taskId: 't',
      traceId: 'tr',
      iterationsUsed: 5,
      toolCallCount: 3,
    });
    mgr.runConsolidationPass('/tmp');
    await new Promise((r) => setTimeout(r, 30));

    expect(calls.length).toBe(0);
    expect(mgr.getDispatchSummary().totalDispatched).toBe(0);
  });
});

describe('ReviewManager triggers', () => {
  test('foreign sessionId is no-op (sub-agent tool calls do not increment counters)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'parent-1',
      signal: new AbortController().signal,
      thresholds: { userTurnsForMemoryReview: 1, toolIterationsForSkillReview: 1 },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      ...emptyParent(),
    });
    mgr.onUserTurn('child-99'); // foreign session
    mgr.onToolIteration('child-99'); // foreign session
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(0);
    // matching session still works
    mgr.onUserTurn('parent-1');
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(1);
  });
});

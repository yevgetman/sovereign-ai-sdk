import { describe, expect, test } from 'bun:test';
import {
  ReviewManager,
  SKILL_SHAPED_MIN_DISTINCT_TOOLS,
  SKILL_SHAPED_MIN_TOOL_CALLS,
  isSkillShaped,
} from '../../src/review/manager.js';
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

  test('synthesizer fires every Nth user turn (default 20)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'p',
      signal: new AbortController().signal,
      thresholds: {
        userTurnsForMemoryReview: 9999,
        toolIterationsForSkillReview: 9999,
        synthesizerEveryN: 3,
      },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      projectIdentity: () => ({ id: 'proj-abc', name: 'sovereign' }),
      harnessHome: '/tmp/h',
      ...emptyParent(),
    });

    mgr.onUserTurn('p');
    mgr.onUserTurn('p');
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBe(0); // 2 turns, threshold 3 — counter not yet hit

    mgr.onUserTurn('p'); // 3rd → fires
    await new Promise((r) => setTimeout(r, 30));
    const synthCalls = calls.filter((c) => c.agentName === 'instinct-synthesizer');
    expect(synthCalls.length).toBe(1);
  });

  test('synthesizer does not fire when projectIdentity is absent', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'p',
      signal: new AbortController().signal,
      thresholds: {
        userTurnsForMemoryReview: 9999,
        toolIterationsForSkillReview: 9999,
        synthesizerEveryN: 1,
      },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      // intentionally NOT setting projectIdentity / harnessHome
      ...emptyParent(),
    });

    mgr.onUserTurn('p');
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.filter((c) => c.agentName === 'instinct-synthesizer').length).toBe(0);
  });

  test('getDispatchSummary counts synthesizer dispatches', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'p',
      signal: new AbortController().signal,
      thresholds: {
        userTurnsForMemoryReview: 9999,
        toolIterationsForSkillReview: 9999,
        synthesizerEveryN: 1,
        minIntervalMs: 0,
      },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      projectIdentity: () => ({ id: 'proj', name: 'p' }),
      harnessHome: '/tmp',
      ...emptyParent(),
    });
    mgr.onUserTurn('p');
    mgr.onUserTurn('p');
    await new Promise((r) => setTimeout(r, 30));
    const summary = mgr.getDispatchSummary();
    expect(summary.byAgent['instinct-synthesizer']).toBe(2);
  });

  test('signal-aborted blocks synthesizer dispatch', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const ac = new AbortController();
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'p',
      signal: ac.signal,
      thresholds: {
        userTurnsForMemoryReview: 9999,
        toolIterationsForSkillReview: 9999,
        synthesizerEveryN: 1,
      },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      projectIdentity: () => ({ id: 'proj', name: 'p' }),
      harnessHome: '/tmp',
      ...emptyParent(),
    });
    ac.abort();
    mgr.onUserTurn('p');
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.filter((c) => c.agentName === 'instinct-synthesizer').length).toBe(0);
  });

  test('synthesizer fires on Nth tool iteration even without user turn', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'p',
      signal: new AbortController().signal,
      thresholds: {
        userTurnsForMemoryReview: 9999,
        toolIterationsForSkillReview: 9999,
        childReviewEveryN: 9999,
        minIntervalMs: 0,
        synthesizerEveryN: 9999,
        synthesizerEveryNToolIterations: 5,
      },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      projectIdentity: () => ({ id: 'proj', name: 'sov' }),
      harnessHome: '/tmp',
      ...emptyParent(),
    });

    for (let i = 0; i < 4; i++) mgr.onToolIteration('p');
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.filter((c) => c.agentName === 'instinct-synthesizer').length).toBe(0);

    mgr.onToolIteration('p'); // 5th — fires
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.filter((c) => c.agentName === 'instinct-synthesizer').length).toBe(1);
  });

  test('user-turn and tool-iteration synthesizer counters are independent', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'p',
      signal: new AbortController().signal,
      thresholds: {
        userTurnsForMemoryReview: 9999,
        toolIterationsForSkillReview: 9999,
        childReviewEveryN: 9999,
        minIntervalMs: 0,
        synthesizerEveryN: 3,
        synthesizerEveryNToolIterations: 5,
      },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      projectIdentity: () => ({ id: 'proj', name: 'sov' }),
      harnessHome: '/tmp',
      ...emptyParent(),
    });

    // 3 tool iterations — doesn't trip the tool-iteration counter (5 needed)
    // and doesn't trip the user-turn counter (no user turns)
    for (let i = 0; i < 3; i++) mgr.onToolIteration('p');
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.filter((c) => c.agentName === 'instinct-synthesizer').length).toBe(0);

    // 3 user turns — trips the user-turn counter
    for (let i = 0; i < 3; i++) mgr.onUserTurn('p');
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.filter((c) => c.agentName === 'instinct-synthesizer').length).toBe(1);

    // 2 more tool iterations — counter now at 5; trips
    mgr.onToolIteration('p');
    mgr.onToolIteration('p');
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.filter((c) => c.agentName === 'instinct-synthesizer').length).toBe(2);
  });

  test('signal-aborted blocks synthesizer dispatch on tool-iteration path too', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const ac = new AbortController();
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'p',
      signal: ac.signal,
      thresholds: {
        userTurnsForMemoryReview: 9999,
        toolIterationsForSkillReview: 9999,
        childReviewEveryN: 9999,
        minIntervalMs: 0,
        synthesizerEveryN: 9999,
        synthesizerEveryNToolIterations: 1,
      },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      projectIdentity: () => ({ id: 'proj', name: 'sov' }),
      harnessHome: '/tmp',
      ...emptyParent(),
    });
    ac.abort();
    mgr.onToolIteration('p');
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.filter((c) => c.agentName === 'instinct-synthesizer').length).toBe(0);
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

describe('onChildCompletion — skill-shaped triage (Item 7)', () => {
  test('skill-shaped child fires review-memory AND review-skill', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'p',
      signal: new AbortController().signal,
      thresholds: {
        userTurnsForMemoryReview: 9999,
        toolIterationsForSkillReview: 9999,
        childReviewEveryN: 1,
        minIntervalMs: 0,
      },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      ...emptyParent(),
    });

    mgr.onChildCompletion({
      childSessionId: 'c1',
      taskId: 't1',
      traceId: 'tr1',
      iterationsUsed: 5,
      toolCallCount: 6,
      distinctToolCount: 4,
    });
    await new Promise((r) => setTimeout(r, 30));

    const memoryDispatches = calls.filter((c) => c.agentName === 'review-memory');
    const skillDispatches = calls.filter((c) => c.agentName === 'review-skill');
    expect(memoryDispatches.length).toBe(1);
    expect(skillDispatches.length).toBe(1);
  });

  test('memory-shaped child fires review-memory only (not review-skill)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'p',
      signal: new AbortController().signal,
      thresholds: {
        userTurnsForMemoryReview: 9999,
        toolIterationsForSkillReview: 9999,
        childReviewEveryN: 1,
        minIntervalMs: 0,
      },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      ...emptyParent(),
    });

    // Six calls but only one distinct tool — repeated invocation, not a
    // procedural workflow; below distinct-tool threshold.
    mgr.onChildCompletion({
      childSessionId: 'c1',
      taskId: 't1',
      traceId: 'tr1',
      iterationsUsed: 5,
      toolCallCount: 6,
      distinctToolCount: 1,
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(calls.filter((c) => c.agentName === 'review-memory').length).toBe(1);
    expect(calls.filter((c) => c.agentName === 'review-skill').length).toBe(0);
  });

  test('threshold edge: tools=4 distinct=3 IS skill-shaped (boundary inclusive)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'p',
      signal: new AbortController().signal,
      thresholds: {
        userTurnsForMemoryReview: 9999,
        toolIterationsForSkillReview: 9999,
        childReviewEveryN: 1,
        minIntervalMs: 0,
      },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      ...emptyParent(),
    });

    mgr.onChildCompletion({
      childSessionId: 'c1',
      taskId: 't1',
      traceId: 'tr1',
      iterationsUsed: 5,
      toolCallCount: 4,
      distinctToolCount: 3,
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(calls.filter((c) => c.agentName === 'review-memory').length).toBe(1);
    expect(calls.filter((c) => c.agentName === 'review-skill').length).toBe(1);
  });

  test('threshold edge: tools=3 distinct=3 is NOT skill-shaped (calls below threshold)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'p',
      signal: new AbortController().signal,
      thresholds: {
        userTurnsForMemoryReview: 9999,
        toolIterationsForSkillReview: 9999,
        childReviewEveryN: 1,
        minIntervalMs: 0,
      },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      ...emptyParent(),
    });

    mgr.onChildCompletion({
      childSessionId: 'c1',
      taskId: 't1',
      traceId: 'tr1',
      iterationsUsed: 5,
      toolCallCount: 3,
      distinctToolCount: 3,
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(calls.filter((c) => c.agentName === 'review-memory').length).toBe(1);
    expect(calls.filter((c) => c.agentName === 'review-skill').length).toBe(0);
  });

  test('threshold edge: tools=4 distinct=2 is NOT skill-shaped (distinct below threshold)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'p',
      signal: new AbortController().signal,
      thresholds: {
        userTurnsForMemoryReview: 9999,
        toolIterationsForSkillReview: 9999,
        childReviewEveryN: 1,
        minIntervalMs: 0,
      },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      ...emptyParent(),
    });

    mgr.onChildCompletion({
      childSessionId: 'c1',
      taskId: 't1',
      traceId: 'tr1',
      iterationsUsed: 5,
      toolCallCount: 4,
      distinctToolCount: 2,
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(calls.filter((c) => c.agentName === 'review-memory').length).toBe(1);
    expect(calls.filter((c) => c.agentName === 'review-skill').length).toBe(0);
  });

  test('missing distinctToolCount falls back to memory-only (back-compat)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'p',
      signal: new AbortController().signal,
      thresholds: {
        userTurnsForMemoryReview: 9999,
        toolIterationsForSkillReview: 9999,
        childReviewEveryN: 1,
        minIntervalMs: 0,
      },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      ...emptyParent(),
    });

    // No distinctToolCount — caller hasn't been updated to thread it. The
    // back-compat path skips the skill dispatch entirely.
    mgr.onChildCompletion({
      childSessionId: 'c1',
      taskId: 't1',
      traceId: 'tr1',
      iterationsUsed: 5,
      toolCallCount: 6,
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(calls.filter((c) => c.agentName === 'review-memory').length).toBe(1);
    expect(calls.filter((c) => c.agentName === 'review-skill').length).toBe(0);
  });

  test('back-to-back skill-shaped children respect minIntervalMs throttle', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'p',
      signal: new AbortController().signal,
      thresholds: {
        userTurnsForMemoryReview: 9999,
        toolIterationsForSkillReview: 9999,
        childReviewEveryN: 1,
        minIntervalMs: 60_000, // long lockout — both agents throttled on second call
      },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      ...emptyParent(),
    });

    mgr.onChildCompletion({
      childSessionId: 'c1',
      taskId: 't1',
      traceId: 'tr1',
      iterationsUsed: 5,
      toolCallCount: 6,
      distinctToolCount: 4,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.agentName === 'review-memory').length).toBe(1);
    expect(calls.filter((c) => c.agentName === 'review-skill').length).toBe(1);

    // Second skill-shaped child within the 60s lockout: per-agent throttle
    // suppresses BOTH dispatches.
    mgr.onChildCompletion({
      childSessionId: 'c2',
      taskId: 't2',
      traceId: 'tr2',
      iterationsUsed: 5,
      toolCallCount: 6,
      distinctToolCount: 4,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.agentName === 'review-memory').length).toBe(1); // still 1
    expect(calls.filter((c) => c.agentName === 'review-skill').length).toBe(1); // still 1
  });
});

describe('isSkillShaped() pure function', () => {
  test('exported thresholds match the documented heuristic', () => {
    expect(SKILL_SHAPED_MIN_TOOL_CALLS).toBe(4);
    expect(SKILL_SHAPED_MIN_DISTINCT_TOOLS).toBe(3);
  });

  test('returns true when tools >= 4 AND distinct >= 3', () => {
    expect(
      isSkillShaped({
        childSessionId: 'a',
        taskId: 't',
        traceId: 'tr',
        toolCallCount: 4,
        distinctToolCount: 3,
      }),
    ).toBe(true);
    expect(
      isSkillShaped({
        childSessionId: 'a',
        taskId: 't',
        traceId: 'tr',
        toolCallCount: 10,
        distinctToolCount: 5,
      }),
    ).toBe(true);
  });

  test('returns false when below either threshold', () => {
    expect(
      isSkillShaped({
        childSessionId: 'a',
        taskId: 't',
        traceId: 'tr',
        toolCallCount: 3,
        distinctToolCount: 3,
      }),
    ).toBe(false);
    expect(
      isSkillShaped({
        childSessionId: 'a',
        taskId: 't',
        traceId: 'tr',
        toolCallCount: 4,
        distinctToolCount: 2,
      }),
    ).toBe(false);
    expect(
      isSkillShaped({
        childSessionId: 'a',
        taskId: 't',
        traceId: 'tr',
        toolCallCount: 1,
        distinctToolCount: 1,
      }),
    ).toBe(false);
  });

  test('returns false when fields are missing', () => {
    expect(isSkillShaped({ childSessionId: 'a', taskId: 't', traceId: 'tr' })).toBe(false);
    expect(
      isSkillShaped({ childSessionId: 'a', taskId: 't', traceId: 'tr', toolCallCount: 5 }),
    ).toBe(false);
    expect(
      isSkillShaped({ childSessionId: 'a', taskId: 't', traceId: 'tr', distinctToolCount: 5 }),
    ).toBe(false);
  });
});

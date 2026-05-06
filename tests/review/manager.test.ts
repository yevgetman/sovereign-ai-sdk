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

  test('onChildCompletion always fires once per call (review-memory)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mgr = new ReviewManager({
      scheduler: fakeScheduler(calls),
      sessionId: 'p',
      signal: new AbortController().signal,
      thresholds: { userTurnsForMemoryReview: 9999, toolIterationsForSkillReview: 9999 },
      pathsResolver: () => ({ trajectoryPath: '/t/x', tracePath: '/t/y' }),
      ...emptyParent(),
    });

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

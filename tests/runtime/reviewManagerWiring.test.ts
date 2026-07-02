import { describe, expect, test } from 'bun:test';
import type { SubagentScheduler } from '@yevgetman/sov-sdk/runtime/scheduler';
import type { Tool, ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { ReviewManager } from '../../src/review/manager.js';

describe('ReviewManager wiring contract', () => {
  test('foreign sessionId guard prevents child-session contamination', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fakeScheduler = {
      delegate: async (input: Record<string, unknown>) => {
        calls.push(input);
        return {
          childSessionId: 'c',
          agentName: input.agentName,
          resolvedProvider: 'fake',
          resolvedModel: 'fake-1',
          terminal: { reason: 'completed' as const },
          summary: '',
          iterationsUsed: 1,
          toolCallCount: 0,
          durationMs: 1,
        };
      },
    } as unknown as SubagentScheduler;
    const mgr = new ReviewManager({
      scheduler: fakeScheduler,
      sessionId: 'parent-1',
      signal: new AbortController().signal,
      thresholds: { userTurnsForMemoryReview: 1, toolIterationsForSkillReview: 1 },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      parentToolPool: [] as Tool<unknown, unknown>[],
      parentToolContext: { cwd: '/tmp', sessionId: 'parent-1' } as ToolContext,
    });

    // sub-agent (child sessionId) tries to trigger — should no-op
    mgr.onToolIteration('child-1');
    mgr.onUserTurn('child-1');
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(0);

    // user-session call fires
    mgr.onToolIteration('parent-1');
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(1);
  });
});

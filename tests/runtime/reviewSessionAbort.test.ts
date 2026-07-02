// Phase 13.3 (B4) — verify the AbortController pattern propagates abort
// through ReviewManager → runReviewFork → scheduler.delegate.

import { describe, expect, test } from 'bun:test';
import type { SubagentScheduler } from '@yevgetman/sov-sdk/runtime/scheduler';
import type { Tool, ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { ReviewManager } from '../../src/review/manager.js';

describe('ReviewManager abort propagation (B4)', () => {
  test('signal passed at construction is the same one observed by scheduler.delegate', async () => {
    const ac = new AbortController();
    const seenSignals: AbortSignal[] = [];
    const fakeScheduler = {
      delegate: async (input: { parentSignal?: AbortSignal }) => {
        if (input.parentSignal) seenSignals.push(input.parentSignal);
        return {
          childSessionId: 'c',
          agentName: 'review-memory',
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
      sessionId: 'p',
      signal: ac.signal,
      thresholds: {
        userTurnsForMemoryReview: 1,
        toolIterationsForSkillReview: 9999,
        childReviewEveryN: 9999,
        minIntervalMs: 0,
      },
      pathsResolver: () => ({ trajectoryPath: '/x', tracePath: '/y' }),
      parentToolPool: [] as Tool<unknown, unknown>[],
      parentToolContext: { cwd: '/tmp', sessionId: 'p' } as ToolContext,
    });

    mgr.onUserTurn('p');
    await new Promise((r) => setTimeout(r, 30));

    expect(seenSignals.length).toBe(1);
    // The signal observed by delegate is the same controller instance.
    // Abort it; the captured signal should now be aborted too.
    expect(seenSignals[0]?.aborted).toBe(false);
    ac.abort();
    expect(seenSignals[0]?.aborted).toBe(true);
  });
});

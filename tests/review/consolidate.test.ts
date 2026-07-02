import { describe, expect, test } from 'bun:test';
import type { SubagentScheduler } from '@yevgetman/sov-sdk/runtime/scheduler';
import type { Tool, ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { runConsolidation } from '../../src/review/consolidate.js';

function emptyParent() {
  return {
    parentToolPool: [] as Tool<unknown, unknown>[],
    parentToolContext: { cwd: '/tmp', sessionId: 'p' } as ToolContext,
  };
}

describe('runConsolidation', () => {
  test('dispatches review-consolidate agent with both MEMORY.md and USER.md paths in prompt', async () => {
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
          summary: 'done',
          iterationsUsed: 1,
          toolCallCount: 0,
          durationMs: 1,
        };
      },
    } as unknown as SubagentScheduler;

    await runConsolidation({
      scheduler: fakeScheduler,
      parentSessionId: 'p',
      parentSignal: new AbortController().signal,
      harnessHome: '/tmp/h',
      ...emptyParent(),
    });

    expect(calls.length).toBe(1);
    const call = calls[0];
    expect(call?.agentName).toBe('review-consolidate');
    const prompt = call?.prompt as string;
    expect(prompt).toContain('MEMORY.md');
    expect(prompt).toContain('USER.md');
  });

  test('swallows scheduler errors silently', async () => {
    const fakeScheduler = {
      delegate: async () => {
        throw new Error('boom');
      },
    } as unknown as SubagentScheduler;

    // must not throw
    await runConsolidation({
      scheduler: fakeScheduler,
      parentSessionId: 'p',
      parentSignal: new AbortController().signal,
      harnessHome: '/tmp/h',
      ...emptyParent(),
    });
  });
});

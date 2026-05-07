// Phase 13.4 Task 7 — synthesizer dispatcher tests. Mirrors the
// runReviewFork tests; verifies the augmented tool pool, prompt
// content, and silent failure mode.

import { describe, expect, test } from 'bun:test';
import { runSynthesizer } from '../../src/learning/synthesizer.js';
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

describe('runSynthesizer', () => {
  test('dispatches instinct-synthesizer with project context in prompt', async () => {
    const calls: Array<Record<string, unknown>> = [];
    await runSynthesizer({
      scheduler: fakeScheduler(calls),
      parentSessionId: 'p',
      parentSignal: new AbortController().signal,
      ...emptyParent(),
      harnessHome: '/tmp/h',
      projectId: 'proj-abc',
      projectName: 'sovereign',
      recentObservationCount: 50,
    });
    expect(calls.length).toBe(1);
    const call = calls[0];
    expect(call?.agentName).toBe('instinct-synthesizer');
    const prompt = call?.prompt as string;
    expect(prompt).toContain('proj-abc');
    expect(prompt).toContain('sovereign');
    expect(prompt).toContain('observations.jsonl');
    expect(prompt).toContain('50');
  });

  test('augments parentToolPool with LEARNING_ONLY_TOOLS', async () => {
    const calls: Array<Record<string, unknown>> = [];
    await runSynthesizer({
      scheduler: fakeScheduler(calls),
      parentSessionId: 'p',
      parentSignal: new AbortController().signal,
      ...emptyParent(),
      harnessHome: '/tmp/h',
      projectId: 'proj',
      projectName: 'p',
      recentObservationCount: 10,
    });
    const augmented = calls[0]?.parentToolPool as Array<{ name: string }>;
    const names = new Set(augmented.map((t) => t.name));
    expect(names.has('instinct_list')).toBe(true);
    expect(names.has('instinct_view')).toBe(true);
    expect(names.has('instinct_propose')).toBe(true);
    expect(names.has('instinct_update_confidence')).toBe(true);
  });

  test('swallows scheduler errors silently', async () => {
    const fakeBoom = {
      delegate: async () => {
        throw new Error('boom');
      },
    } as unknown as SubagentScheduler;
    // must not throw
    await runSynthesizer({
      scheduler: fakeBoom,
      parentSessionId: 'p',
      parentSignal: new AbortController().signal,
      ...emptyParent(),
      harnessHome: '/tmp/h',
      projectId: 'proj',
      projectName: 'p',
      recentObservationCount: 5,
    });
  });
});

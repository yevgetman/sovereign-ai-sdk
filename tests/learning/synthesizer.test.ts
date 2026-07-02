// Phase 13.4 Task 7 — synthesizer dispatcher tests. Mirrors the
// runReviewFork tests; verifies the augmented tool pool, prompt
// content, and silent failure mode.

import { describe, expect, test } from 'bun:test';
import type { SubagentScheduler } from '@yevgetman/sov-sdk/runtime/scheduler';
import type { Tool, ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { runSynthesizer } from '../../src/learning/synthesizer.js';

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

  test('does not throw on scheduler error (non-blocking)', async () => {
    const fakeBoom = {
      delegate: async () => {
        throw new Error('boom');
      },
    } as unknown as SubagentScheduler;
    // must not throw — failures stay non-blocking for the user turn
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

  // Task 14 — synthesis failures must be OBSERVABLE, not swallowed. The
  // dispatcher returns a small status object so callers and tests can
  // assert on the outcome without making the dispatch block the turn.
  test('returns { ok: true } when the delegation completes', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const status = await runSynthesizer({
      scheduler: fakeScheduler(calls),
      parentSessionId: 'p',
      parentSignal: new AbortController().signal,
      ...emptyParent(),
      harnessHome: '/tmp/h',
      projectId: 'proj',
      projectName: 'p',
      recentObservationCount: 5,
    });
    expect(status.ok).toBe(true);
  });

  test('returns { ok: false, reason } when the scheduler throws', async () => {
    const fakeBoom = {
      delegate: async () => {
        throw new Error('boom');
      },
    } as unknown as SubagentScheduler;
    const status = await runSynthesizer({
      scheduler: fakeBoom,
      parentSessionId: 'p',
      parentSignal: new AbortController().signal,
      ...emptyParent(),
      harnessHome: '/tmp/h',
      projectId: 'proj',
      projectName: 'p',
      recentObservationCount: 5,
    });
    expect(status.ok).toBe(false);
    if (!status.ok) {
      expect(status.reason).toContain('boom');
    }
  });

  test('logs a clear warning on failure via the injected log sink', async () => {
    const fakeBoom = {
      delegate: async () => {
        throw new Error('disk full');
      },
    } as unknown as SubagentScheduler;
    const logged: string[] = [];
    await runSynthesizer({
      scheduler: fakeBoom,
      parentSessionId: 'p',
      parentSignal: new AbortController().signal,
      ...emptyParent(),
      harnessHome: '/tmp/h',
      projectId: 'proj',
      projectName: 'p',
      recentObservationCount: 5,
      log: (m) => logged.push(m),
    });
    expect(logged.some((m) => m.includes('disk full'))).toBe(true);
    expect(logged.some((m) => m.includes('synthesizer'))).toBe(true);
  });

  // Fix E1 — for an OWNED principal the synthesizer must be told the
  // user-scoped observations file (users/{userId}/learning/{projectId}/…),
  // otherwise it reads the legacy corpus and synthesizes nothing.
  test('prompt observations path is user-scoped when userId is supplied', async () => {
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
      userId: 'alice',
    });
    const prompt = calls[0]?.prompt as string;
    expect(prompt).toContain('users/alice/learning/proj-abc/observations.jsonl');
    expect(prompt).not.toContain('/h/learning/proj-abc/observations.jsonl');
  });

  test('prompt observations path is the legacy path when no userId', async () => {
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
    const prompt = calls[0]?.prompt as string;
    expect(prompt).toContain('/h/learning/proj-abc/observations.jsonl');
    expect(prompt).not.toContain('users/');
  });

  test('reports { ok: false } when the delegation returns a non-success terminal', async () => {
    const fakeFail = {
      delegate: async (input: Record<string, unknown>) => ({
        childSessionId: 'c',
        agentName: input.agentName,
        resolvedProvider: 'fake',
        resolvedModel: 'fake-1',
        terminal: { reason: 'error' as const, error: new Error('child blew up') },
        summary: 'failed',
        iterationsUsed: 1,
        toolCallCount: 0,
        durationMs: 1,
      }),
    } as unknown as SubagentScheduler;
    const status = await runSynthesizer({
      scheduler: fakeFail,
      parentSessionId: 'p',
      parentSignal: new AbortController().signal,
      ...emptyParent(),
      harnessHome: '/tmp/h',
      projectId: 'proj',
      projectName: 'p',
      recentObservationCount: 5,
    });
    expect(status.ok).toBe(false);
  });
});

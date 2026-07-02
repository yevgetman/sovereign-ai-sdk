import { describe, expect, test } from 'bun:test';
import type { SubagentScheduler } from '@yevgetman/sov-sdk/runtime/scheduler';
import type { Tool, ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { runReviewFork } from '../../src/review/fork.js';

function fakeCtx(): ToolContext {
  return { cwd: '/tmp', sessionId: 'parent-1' } as ToolContext;
}

describe('runReviewFork', () => {
  test('dispatches via scheduler.delegate with canonical inputs (path-aware prompt)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fakeScheduler = {
      delegate: async (input: Record<string, unknown>) => {
        calls.push(input);
        return {
          childSessionId: 'child-1',
          agentName: 'review-memory',
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

    await runReviewFork({
      scheduler: fakeScheduler,
      agentName: 'review-memory',
      parentSessionId: 'parent-1',
      parentSignal: new AbortController().signal,
      parentToolPool: [] as Tool<unknown, unknown>[],
      parentToolContext: fakeCtx(),
      promptContext: {
        primaryFile: '/tmp/samples.jsonl',
        secondaryFile: '/tmp/trace.jsonl',
        recentTurnCount: 10,
      },
    });

    expect(calls.length).toBe(1);
    const call = calls[0];
    if (!call) throw new Error('expected a delegate call');
    expect(call.agentName).toBe('review-memory');
    expect(call.prompt as string).toContain('/tmp/samples.jsonl');
    expect(call.prompt as string).toContain('/tmp/trace.jsonl');
    expect(call.prompt as string).toContain('10');
  });

  test('augments parentToolPool with REVIEW_ONLY_TOOLS so child agents can use propose tools', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fakeScheduler = {
      delegate: async (input: Record<string, unknown>) => {
        calls.push(input);
        return {
          childSessionId: 'child-1',
          agentName: 'review-memory',
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

    await runReviewFork({
      scheduler: fakeScheduler,
      agentName: 'review-memory',
      parentSessionId: 'parent-1',
      parentSignal: new AbortController().signal,
      parentToolPool: [] as Tool<unknown, unknown>[],
      parentToolContext: fakeCtx(),
      promptContext: { primaryFile: '/x', secondaryFile: '/y', recentTurnCount: 5 },
    });

    expect(calls.length).toBe(1);
    const augmented = calls[0]?.parentToolPool as Array<{ name: string }>;
    const names = new Set(augmented.map((t) => t.name));
    expect(names.has('memory_propose')).toBe(true);
    expect(names.has('skill_propose')).toBe(true);
  });

  test('augments parentToolPool with LEARNING_ONLY_TOOLS so review agents can call instinct_list/view', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fakeScheduler = {
      delegate: async (input: Record<string, unknown>) => {
        calls.push(input);
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

    await runReviewFork({
      scheduler: fakeScheduler,
      agentName: 'review-memory',
      parentSessionId: 'p',
      parentSignal: new AbortController().signal,
      parentToolPool: [] as Tool<unknown, unknown>[],
      parentToolContext: { cwd: '/tmp', sessionId: 'p' } as ToolContext,
      promptContext: {
        primaryFile: '/x',
        secondaryFile: '/y',
        instinctsDir: '/learning/proj/instincts',
        recentTurnCount: 5,
      },
    });

    const augmented = calls[0]?.parentToolPool as Array<{ name: string }>;
    const names = new Set(augmented.map((t) => t.name));
    expect(names.has('instinct_list')).toBe(true);
    expect(names.has('instinct_view')).toBe(true);
    // Writers are present in the pool but filtered out by agent.allowedTools.
    expect(names.has('instinct_propose')).toBe(true);
    expect(names.has('instinct_update_confidence')).toBe(true);
  });

  test('prompt mentions instincts directory when provided + says "preferred input"', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fakeScheduler = {
      delegate: async (input: Record<string, unknown>) => {
        calls.push(input);
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

    await runReviewFork({
      scheduler: fakeScheduler,
      agentName: 'review-memory',
      parentSessionId: 'p',
      parentSignal: new AbortController().signal,
      parentToolPool: [],
      parentToolContext: { cwd: '/tmp', sessionId: 'p' } as ToolContext,
      promptContext: {
        primaryFile: '/traj',
        secondaryFile: '/trace',
        instinctsDir: '/learning/proj/instincts',
        recentTurnCount: 5,
      },
    });

    const prompt = calls[0]?.prompt as string;
    expect(prompt).toContain('/learning/proj/instincts');
    expect(prompt.toLowerCase()).toContain('preferred input');
  });

  test('prompt omits instincts mention when instinctsDir absent (back-compat)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fakeScheduler = {
      delegate: async (input: Record<string, unknown>) => {
        calls.push(input);
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

    await runReviewFork({
      scheduler: fakeScheduler,
      agentName: 'review-memory',
      parentSessionId: 'p',
      parentSignal: new AbortController().signal,
      parentToolPool: [],
      parentToolContext: { cwd: '/tmp', sessionId: 'p' } as ToolContext,
      promptContext: { primaryFile: '/traj', secondaryFile: '/trace', recentTurnCount: 5 },
    });

    const prompt = calls[0]?.prompt as string;
    expect(prompt.toLowerCase()).not.toContain('preferred input');
    expect(prompt.toLowerCase()).not.toContain('instincts directory');
  });

  test('swallows scheduler errors silently — review never fails the parent', async () => {
    const fakeScheduler = {
      delegate: async () => {
        throw new Error('boom');
      },
    } as unknown as SubagentScheduler;

    // must not throw
    await runReviewFork({
      scheduler: fakeScheduler,
      agentName: 'review-skill',
      parentSessionId: 'parent-2',
      parentSignal: new AbortController().signal,
      parentToolPool: [],
      parentToolContext: fakeCtx(),
      promptContext: {
        primaryFile: '/tmp/x',
        secondaryFile: '/tmp/y',
        recentTurnCount: 5,
      },
    });
  });
});

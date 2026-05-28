// runTools orchestrator tests. Uses fake tools built via buildTool() so
// we exercise the real dispatch path without relying on BashTool's
// subprocess infrastructure. Phase 4 sections cover partitioning,
// concurrent execution within a partition, path-overlap sub-batching,
// order-preserving result re-insertion, and the per-tool renderResult.

import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { z } from 'zod';
import {
  CONCURRENT_CAP,
  notifyLearningObserver,
  partitionToolCalls,
  runTools,
  splitByPathOverlap,
} from '../../src/core/orchestrator.js';
import type { ContentBlock } from '../../src/core/types.js';
import type { LearningObserver, ObserveInput } from '../../src/learning/observer.js';
import type { ObservationStatus } from '../../src/learning/types.js';
import type { CanUseTool } from '../../src/permissions/types.js';
import { buildTool } from '../../src/tool/buildTool.js';
import type { Tool, ToolContext } from '../../src/tool/types.js';

const ctx: ToolContext = {
  cwd: '/tmp',
  bundleRoot: '/tmp',
  sessionId: 'test',
};

type UseBlock = Extract<ContentBlock, { type: 'tool_use' }>;
type ResultBlock = Extract<ContentBlock, { type: 'tool_result' }>;

function makeEchoTool(): Tool<unknown, unknown> {
  return buildTool({
    name: 'Echo',
    description: () => 'echo input text',
    inputSchema: z.object({ text: z.string() }),
    async call(input) {
      return { data: { echoed: input.text } };
    },
  }) as unknown as Tool<unknown, unknown>;
}

function makeThrowingTool(): Tool<unknown, unknown> {
  return buildTool({
    name: 'Broken',
    description: () => 'throws always',
    inputSchema: z.object({}),
    async call() {
      throw new Error('boom');
    },
  }) as unknown as Tool<unknown, unknown>;
}

async function collectResults(
  blocks: UseBlock[],
  tools: Tool<unknown, unknown>[],
  canUseTool?: CanUseTool,
): Promise<ResultBlock[]> {
  const out: ResultBlock[] = [];
  for await (const msg of runTools(blocks, ctx, tools, canUseTool)) {
    if (msg.role === 'user') {
      for (const b of msg.content) {
        if (b.type === 'tool_result') out.push(b);
      }
    }
  }
  return out;
}

describe('runTools', () => {
  test('happy path: single tool call returns tool_result in a user message', async () => {
    const blocks: UseBlock[] = [
      { type: 'tool_use', id: 'a1', name: 'Echo', input: { text: 'ping' } },
    ];
    const results = await collectResults(blocks, [makeEchoTool()]);
    expect(results).toHaveLength(1);
    expect(results[0]?.tool_use_id).toBe('a1');
    expect(results[0]?.is_error).toBeUndefined();
    expect(results[0]?.content).toContain('ping');
  });

  test('unknown tool produces is_error tool_result', async () => {
    const blocks: UseBlock[] = [{ type: 'tool_use', id: 'a1', name: 'DoesNotExist', input: {} }];
    const results = await collectResults(blocks, [makeEchoTool()]);
    expect(results).toHaveLength(1);
    expect(results[0]?.is_error).toBe(true);
    expect(results[0]?.content).toContain('unknown tool');
  });

  test('thrown tool errors are captured as is_error', async () => {
    const blocks: UseBlock[] = [{ type: 'tool_use', id: 'a1', name: 'Broken', input: {} }];
    const results = await collectResults(blocks, [makeThrowingTool()]);
    expect(results).toHaveLength(1);
    expect(results[0]?.is_error).toBe(true);
    expect(results[0]?.content).toContain('boom');
  });

  test('input validation failure surfaces as is_error without calling the tool', async () => {
    let called = false;
    const echo = buildTool({
      name: 'Echo',
      description: () => 'echo',
      inputSchema: z.object({ text: z.string() }),
      async call() {
        called = true;
        return { data: 'nope' };
      },
    }) as unknown as Tool<unknown, unknown>;

    const blocks: UseBlock[] = [{ type: 'tool_use', id: 'a1', name: 'Echo', input: { text: 42 } }];
    const results = await collectResults(blocks, [echo]);
    expect(called).toBe(false);
    expect(results[0]?.is_error).toBe(true);
    expect(results[0]?.content).toContain('validation');
  });

  test('permission deny produces is_error tool_result and skips call()', async () => {
    let called = false;
    const tool = buildTool({
      name: 'Echo',
      description: () => 'echo',
      inputSchema: z.object({ text: z.string() }),
      async call() {
        called = true;
        return { data: 'nope' };
      },
    }) as unknown as Tool<unknown, unknown>;

    const denyAll: CanUseTool = async () => ({ behavior: 'deny', reason: 'policy' });
    const blocks: UseBlock[] = [{ type: 'tool_use', id: 'a1', name: 'Echo', input: { text: 'x' } }];
    const results = await collectResults(blocks, [tool], denyAll);

    expect(called).toBe(false);
    expect(results[0]?.is_error).toBe(true);
    expect(results[0]?.content).toContain('permission denied');
    expect(results[0]?.content).toContain('policy');
  });

  test('permission allow passes through to tool.call()', async () => {
    const allowAll: CanUseTool = async () => ({ behavior: 'allow' });
    const blocks: UseBlock[] = [
      { type: 'tool_use', id: 'a1', name: 'Echo', input: { text: 'go' } },
    ];
    const results = await collectResults(blocks, [makeEchoTool()], allowAll);
    expect(results[0]?.is_error).toBeUndefined();
    expect(results[0]?.content).toContain('go');
  });

  test('permission updatedInput is revalidated and passed to tool.call()', async () => {
    const rewrite: CanUseTool = async () => ({
      behavior: 'allow',
      updatedInput: { text: 'rewritten' },
    });
    const blocks: UseBlock[] = [
      { type: 'tool_use', id: 'a1', name: 'Echo', input: { text: 'original' } },
    ];
    const results = await collectResults(blocks, [makeEchoTool()], rewrite);
    expect(results[0]?.is_error).toBeUndefined();
    expect(results[0]?.content).toContain('rewritten');
    expect(results[0]?.content).not.toContain('original');
  });

  test('invalid permission updatedInput surfaces as validation error and skips call()', async () => {
    let called = false;
    const tool = buildTool({
      name: 'Echo',
      description: () => 'echo',
      inputSchema: z.object({ text: z.string() }),
      async call() {
        called = true;
        return { data: 'nope' };
      },
    }) as unknown as Tool<unknown, unknown>;
    const rewriteBadly: CanUseTool = async () => ({
      behavior: 'allow',
      updatedInput: { text: 42 },
    });
    const blocks: UseBlock[] = [{ type: 'tool_use', id: 'a1', name: 'Echo', input: { text: 'x' } }];
    const results = await collectResults(blocks, [tool], rewriteBadly);
    expect(called).toBe(false);
    expect(results[0]?.is_error).toBe(true);
    expect(results[0]?.content).toContain('permission-updated input validation failed');
  });

  test('preserves ordering across multiple tool_use blocks', async () => {
    const blocks: UseBlock[] = [
      { type: 'tool_use', id: 'a1', name: 'Echo', input: { text: 'first' } },
      { type: 'tool_use', id: 'a2', name: 'Echo', input: { text: 'second' } },
      { type: 'tool_use', id: 'a3', name: 'Echo', input: { text: 'third' } },
    ];
    const results = await collectResults(blocks, [makeEchoTool()]);
    expect(results.map((r) => r.tool_use_id)).toEqual(['a1', 'a2', 'a3']);
    expect(results[0]?.content).toContain('first');
    expect(results[1]?.content).toContain('second');
    expect(results[2]?.content).toContain('third');
  });
});

// ─── Phase 4: per-tool renderResult ──────────────────────────────────────

describe('runTools — per-tool renderResult', () => {
  test('tool with renderResult: false → tool_result.content matches its render output', async () => {
    const tool = buildTool({
      name: 'Stamper',
      description: () => 'stamps stuff',
      inputSchema: z.object({ id: z.string() }),
      async call(input) {
        return { data: { stampedAt: 1234, id: input.id } };
      },
      renderResult: (out) => ({ content: `STAMP(${out.id})@${out.stampedAt}` }),
    }) as unknown as Tool<unknown, unknown>;

    const blocks: UseBlock[] = [
      { type: 'tool_use', id: 's1', name: 'Stamper', input: { id: 'X' } },
    ];
    const results = await collectResults(blocks, [tool]);
    expect(results[0]?.content).toBe('STAMP(X)@1234');
    expect(results[0]?.is_error).toBeUndefined();
  });

  test('renderResult.isError=true sets is_error on the tool_result block', async () => {
    const tool = buildTool({
      name: 'AlwaysErrorRender',
      description: () => 'data ok but render says err',
      inputSchema: z.object({}),
      async call() {
        return { data: { msg: 'looks fine' } };
      },
      renderResult: () => ({ content: 'rendered as err', isError: true }),
    }) as unknown as Tool<unknown, unknown>;

    const blocks: UseBlock[] = [
      { type: 'tool_use', id: 'e1', name: 'AlwaysErrorRender', input: {} },
    ];
    const results = await collectResults(blocks, [tool]);
    expect(results[0]?.is_error).toBe(true);
    expect(results[0]?.content).toBe('rendered as err');
  });

  test('tool without renderResult falls back to JSON of data', async () => {
    const tool = buildTool({
      name: 'JsonOut',
      description: () => 'no render',
      inputSchema: z.object({}),
      async call() {
        return { data: { a: 1, b: [2, 3] } };
      },
    }) as unknown as Tool<unknown, unknown>;

    const blocks: UseBlock[] = [{ type: 'tool_use', id: 'j1', name: 'JsonOut', input: {} }];
    const results = await collectResults(blocks, [tool]);
    expect(results[0]?.content).toContain('"a"');
    expect(results[0]?.content).toContain('1');
  });
});

// ─── Phase 12.5: observation envelope ────────────────────────────────────

describe('runTools — observation envelope (Phase 12.5)', () => {
  test('observation header is prepended above renderResult content', async () => {
    const tool = buildTool({
      name: 'EnvSuccess',
      description: () => 'success path',
      inputSchema: z.object({}),
      async call() {
        return {
          data: { value: 42 },
          observation: {
            status: 'success' as const,
            summary: 'computed value',
            artifacts: ['/tmp/result.txt'],
          },
        };
      },
      renderResult: (out) => ({ content: `value=${out.value}` }),
    }) as unknown as Tool<unknown, unknown>;
    const blocks: UseBlock[] = [{ type: 'tool_use', id: 'e1', name: 'EnvSuccess', input: {} }];
    const results = await collectResults(blocks, [tool]);
    expect(results[0]?.content).toContain('status: success');
    expect(results[0]?.content).toContain('summary: computed value');
    expect(results[0]?.content).toContain('artifacts:');
    expect(results[0]?.content).toContain('  - /tmp/result.txt');
    // Body still present after the envelope.
    expect(results[0]?.content).toContain('value=42');
    expect(results[0]?.is_error).toBeUndefined();
  });

  test('observation status:error forces is_error even when renderResult does not', async () => {
    const tool = buildTool({
      name: 'EnvErr',
      description: () => 'error path',
      inputSchema: z.object({}),
      async call() {
        return {
          data: { code: 1 },
          observation: {
            status: 'error' as const,
            summary: 'file not found',
            next_actions: ['re-read the directory listing', 'check the path'],
          },
        };
      },
      renderResult: (out) => ({ content: `code=${out.code}` }),
    }) as unknown as Tool<unknown, unknown>;
    const blocks: UseBlock[] = [{ type: 'tool_use', id: 'e2', name: 'EnvErr', input: {} }];
    const results = await collectResults(blocks, [tool]);
    expect(results[0]?.is_error).toBe(true);
    expect(results[0]?.content).toContain('next_actions:');
    expect(results[0]?.content).toContain('  - re-read the directory listing');
    expect(results[0]?.content).toContain('  - check the path');
  });

  test('observation absent → tool_result content is unchanged from prior shape', async () => {
    const tool = buildTool({
      name: 'NoEnv',
      description: () => 'no envelope',
      inputSchema: z.object({}),
      async call() {
        return { data: { value: 'plain' } };
      },
      renderResult: (out) => ({ content: `plain=${out.value}` }),
    }) as unknown as Tool<unknown, unknown>;
    const blocks: UseBlock[] = [{ type: 'tool_use', id: 'e3', name: 'NoEnv', input: {} }];
    const results = await collectResults(blocks, [tool]);
    expect(results[0]?.content).toBe('plain=plain');
    expect(results[0]?.is_error).toBeUndefined();
  });
});

// ─── Phase 4: partitioning ───────────────────────────────────────────────

describe('partitionToolCalls', () => {
  function safeTool(name: string, safe: boolean): Tool<unknown, unknown> {
    return buildTool({
      name,
      description: () => name,
      inputSchema: z.object({}),
      async call() {
        return { data: undefined };
      },
      isConcurrencySafe: () => safe,
    }) as unknown as Tool<unknown, unknown>;
  }

  test('all-safe blocks form a single concurrent partition', () => {
    const safe = safeTool('Safe', true);
    const tools = new Map([['Safe', safe]]);
    const blocks: UseBlock[] = [
      { type: 'tool_use', id: 'a', name: 'Safe', input: {} },
      { type: 'tool_use', id: 'b', name: 'Safe', input: {} },
      { type: 'tool_use', id: 'c', name: 'Safe', input: {} },
    ];
    const partitions = partitionToolCalls(blocks, tools);
    expect(partitions).toHaveLength(1);
    expect(partitions[0]?.mode).toBe('concurrent');
    expect(partitions[0]?.items.length).toBe(3);
  });

  test('all-unsafe blocks form a single serial partition', () => {
    const unsafe = safeTool('Unsafe', false);
    const tools = new Map([['Unsafe', unsafe]]);
    const blocks: UseBlock[] = [
      { type: 'tool_use', id: 'a', name: 'Unsafe', input: {} },
      { type: 'tool_use', id: 'b', name: 'Unsafe', input: {} },
    ];
    const partitions = partitionToolCalls(blocks, tools);
    expect(partitions).toHaveLength(1);
    expect(partitions[0]?.mode).toBe('serial');
  });

  test('contiguous same-class runs are grouped; class change opens a new partition', () => {
    const safe = safeTool('Safe', true);
    const unsafe = safeTool('Unsafe', false);
    const tools = new Map<string, Tool<unknown, unknown>>([
      ['Safe', safe],
      ['Unsafe', unsafe],
    ]);
    const blocks: UseBlock[] = [
      { type: 'tool_use', id: '1', name: 'Safe', input: {} },
      { type: 'tool_use', id: '2', name: 'Safe', input: {} },
      { type: 'tool_use', id: '3', name: 'Unsafe', input: {} },
      { type: 'tool_use', id: '4', name: 'Safe', input: {} },
    ];
    const partitions = partitionToolCalls(blocks, tools);
    expect(partitions).toHaveLength(3);
    expect(partitions[0]?.mode).toBe('concurrent');
    expect(partitions[0]?.items.length).toBe(2);
    expect(partitions[1]?.mode).toBe('serial');
    expect(partitions[2]?.mode).toBe('concurrent');
    expect(partitions[2]?.items.length).toBe(1);
  });

  test('unknown tool name lands in a serial partition (so executeOne can return the unknown-tool error)', () => {
    const safe = safeTool('Safe', true);
    const tools = new Map([['Safe', safe]]);
    const blocks: UseBlock[] = [
      { type: 'tool_use', id: '1', name: 'Safe', input: {} },
      { type: 'tool_use', id: '2', name: 'Phantom', input: {} },
    ];
    const partitions = partitionToolCalls(blocks, tools);
    expect(partitions[0]?.mode).toBe('concurrent');
    expect(partitions[1]?.mode).toBe('serial');
  });
});

// ─── Phase 4: path-scoped sub-batching ───────────────────────────────────

describe('splitByPathOverlap', () => {
  function pathTool(
    name: string,
    opts: { readOnly: boolean; paths: (input: { path: string }) => string[] },
  ): Tool<unknown, unknown> {
    return buildTool({
      name,
      description: () => name,
      inputSchema: z.object({ path: z.string() }),
      async call() {
        return { data: undefined };
      },
      isConcurrencySafe: () => true,
      isReadOnly: () => opts.readOnly,
      affectedPaths: opts.paths,
    }) as unknown as Tool<unknown, unknown>;
  }

  const Reader = pathTool('Reader', {
    readOnly: true,
    paths: (i) => [i.path],
  });
  const Writer = pathTool('Writer', {
    readOnly: false,
    paths: (i) => [i.path],
  });
  const tools = new Map([
    ['Reader', Reader],
    ['Writer', Writer],
  ]);

  function block(id: string, name: string, path: string): UseBlock {
    return { type: 'tool_use', id, name, input: { path } };
  }

  test('two readers on the same path stay in one sub-batch (idempotent reads parallel)', () => {
    const items = [
      { block: block('a', 'Reader', '/tmp/x'), index: 0 },
      { block: block('b', 'Reader', '/tmp/x'), index: 1 },
    ];
    const out = splitByPathOverlap(items, tools, '/tmp');
    expect(out).toHaveLength(1);
    expect(out[0]?.length).toBe(2);
  });

  test('two readers on different paths stay in one sub-batch', () => {
    const items = [
      { block: block('a', 'Reader', '/tmp/x'), index: 0 },
      { block: block('b', 'Reader', '/tmp/y'), index: 1 },
    ];
    const out = splitByPathOverlap(items, tools, '/tmp');
    expect(out).toHaveLength(1);
  });

  test('two writers on different paths run in parallel (one sub-batch)', () => {
    const items = [
      { block: block('a', 'Writer', '/tmp/x'), index: 0 },
      { block: block('b', 'Writer', '/tmp/y'), index: 1 },
    ];
    const out = splitByPathOverlap(items, tools, '/tmp');
    expect(out).toHaveLength(1);
  });

  test('two writers on the same path serialize into separate sub-batches', () => {
    const items = [
      { block: block('a', 'Writer', '/tmp/same'), index: 0 },
      { block: block('b', 'Writer', '/tmp/same'), index: 1 },
    ];
    const out = splitByPathOverlap(items, tools, '/tmp');
    expect(out).toHaveLength(2);
  });

  test('reader+writer on overlapping paths serialize', () => {
    const items = [
      { block: block('a', 'Reader', '/tmp/file'), index: 0 },
      { block: block('b', 'Writer', '/tmp/file'), index: 1 },
    ];
    const out = splitByPathOverlap(items, tools, '/tmp');
    expect(out).toHaveLength(2);
  });

  test('parent/child relationship counts as overlap for writer conflicts', () => {
    const items = [
      { block: block('a', 'Writer', '/tmp/dir'), index: 0 },
      { block: block('b', 'Writer', '/tmp/dir/inner'), index: 1 },
    ];
    const out = splitByPathOverlap(items, tools, '/tmp');
    expect(out).toHaveLength(2);
  });

  test('relative paths get resolved against ctx.cwd before overlap check', () => {
    const items = [
      { block: block('a', 'Writer', 'sub/x'), index: 0 },
      { block: block('b', 'Writer', '/tmp/sub/x'), index: 1 },
    ];
    const out = splitByPathOverlap(items, tools, '/tmp');
    expect(out).toHaveLength(2);
  });

  test('home shorthand paths are expanded before overlap check', () => {
    const items = [
      { block: block('a', 'Writer', '~/same'), index: 0 },
      { block: block('b', 'Writer', `${homedir()}/same`), index: 1 },
    ];
    const out = splitByPathOverlap(items, tools, '/tmp');
    expect(out).toHaveLength(2);
  });
});

// ─── Phase 4: order preservation under concurrent execution ─────────────

describe('runTools — order-preserving concurrent execution', () => {
  function makeDelayedTool(): Tool<unknown, unknown> {
    return buildTool({
      name: 'Delay',
      description: () => 'delays then echoes id',
      inputSchema: z.object({ ms: z.number(), id: z.string() }),
      async call(input) {
        await new Promise((r) => setTimeout(r, input.ms));
        return { data: { id: input.id, completedAt: Date.now() } };
      },
      isConcurrencySafe: () => true,
      renderResult: (out) => ({ content: `id=${out.id}` }),
    }) as unknown as Tool<unknown, unknown>;
  }

  test('output blocks preserve input order even when later blocks finish first', async () => {
    // First block sleeps longest. If we returned in completion order, the
    // last block would land first.
    const blocks: UseBlock[] = [
      { type: 'tool_use', id: 'a', name: 'Delay', input: { ms: 60, id: 'A' } },
      { type: 'tool_use', id: 'b', name: 'Delay', input: { ms: 20, id: 'B' } },
      { type: 'tool_use', id: 'c', name: 'Delay', input: { ms: 5, id: 'C' } },
    ];
    const results = await collectResults(blocks, [makeDelayedTool()]);
    expect(results.map((r) => r.tool_use_id)).toEqual(['a', 'b', 'c']);
    expect(results[0]?.content).toBe('id=A');
    expect(results[1]?.content).toBe('id=B');
    expect(results[2]?.content).toBe('id=C');
  });

  test('actually runs concurrent — total wall time approximates the slowest block, not the sum', async () => {
    const blocks: UseBlock[] = [
      { type: 'tool_use', id: 'a', name: 'Delay', input: { ms: 50, id: 'A' } },
      { type: 'tool_use', id: 'b', name: 'Delay', input: { ms: 50, id: 'B' } },
      { type: 'tool_use', id: 'c', name: 'Delay', input: { ms: 50, id: 'C' } },
    ];
    const start = Date.now();
    await collectResults(blocks, [makeDelayedTool()]);
    const elapsed = Date.now() - start;
    // 3 sequential 50ms calls would take ~150ms; concurrent should hover
    // around 50–100ms even on a slow machine. Use a generous upper bound
    // to keep the test stable in CI.
    expect(elapsed).toBeLessThan(140);
  });
});

// ─── Phase 4: concurrent cap ─────────────────────────────────────────────

describe('runTools — concurrency cap', () => {
  test('CONCURRENT_CAP is 10', () => {
    expect(CONCURRENT_CAP).toBe(10);
  });

  test('a partition larger than the cap is split into waves; output order is still preserved', async () => {
    const tool = buildTool({
      name: 'Counter',
      description: () => 'counts',
      inputSchema: z.object({ id: z.number() }),
      async call(input) {
        await new Promise((r) => setTimeout(r, 5));
        return { data: { id: input.id } };
      },
      isConcurrencySafe: () => true,
      renderResult: (out) => ({ content: String(out.id) }),
    }) as unknown as Tool<unknown, unknown>;

    const blocks: UseBlock[] = Array.from({ length: 25 }, (_, i) => ({
      type: 'tool_use',
      id: `b${i}`,
      name: 'Counter',
      input: { id: i },
    }));
    const results = await collectResults(blocks, [tool]);
    expect(results).toHaveLength(25);
    expect(results.map((r) => Number(r.content))).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });
});

// ─── Backlog item 5: 4-state ObservationStatus mapping ───────────────────
//
// Phase 13.4's observer accepts success / error / denied / cancelled, but
// the orchestrator initially only mapped success / error because denied and
// cancelled outcomes short-circuited before the PostToolUse intercept.
// These tests pin the corrected behavior: every early-return path AND the
// post-call intercept land in the observer with the right ObservationStatus.

type ObserverCall = ObserveInput;

function makeFakeObserver(): { observer: LearningObserver; calls: ObserverCall[] } {
  const calls: ObserverCall[] = [];
  // Minimal stub — only the methods the orchestrator's notify path touches.
  // We intentionally do not extend LearningObserver because its constructor
  // touches the filesystem (project-id resolution); a structural cast is
  // sufficient since only `observe()` is called from runTools.
  const observer = {
    observe(input: ObserveInput) {
      calls.push(input);
    },
    drain: async () => {},
    getDroppedCount: () => 0,
  } as unknown as LearningObserver;
  return { observer, calls };
}

describe('runTools — observer 4-state ObservationStatus mapping', () => {
  test('success: tool returns cleanly → observer captures status: success', async () => {
    const { observer, calls } = makeFakeObserver();
    const ctxWithObserver: ToolContext = { ...ctx, learningObserver: observer };
    const blocks: UseBlock[] = [
      { type: 'tool_use', id: 'ok-1', name: 'Echo', input: { text: 'hi' } },
    ];
    for await (const _ of runTools(blocks, ctxWithObserver, [makeEchoTool()])) {
      // drain
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe('success');
    expect(calls[0]?.toolName).toBe('Echo');
    expect(calls[0]?.traceId).toBe('ok-1');
  });

  test('error: tool throws → observer captures status: error', async () => {
    const { observer, calls } = makeFakeObserver();
    const ctxWithObserver: ToolContext = { ...ctx, learningObserver: observer };
    const blocks: UseBlock[] = [{ type: 'tool_use', id: 'e-1', name: 'Broken', input: {} }];
    for await (const _ of runTools(blocks, ctxWithObserver, [makeThrowingTool()])) {
      // drain
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe('error');
  });

  test('denied: permission gate denies → observer captures status: denied', async () => {
    const { observer, calls } = makeFakeObserver();
    const ctxWithObserver: ToolContext = { ...ctx, learningObserver: observer };
    let toolCalled = false;
    const tool = buildTool({
      name: 'Echo',
      description: () => 'echo',
      inputSchema: z.object({ text: z.string() }),
      async call() {
        toolCalled = true;
        return { data: 'nope' };
      },
    }) as unknown as Tool<unknown, unknown>;
    const denyAll: CanUseTool = async () => ({ behavior: 'deny', reason: 'policy' });
    const blocks: UseBlock[] = [
      { type: 'tool_use', id: 'd-1', name: 'Echo', input: { text: 'x' } },
    ];
    for await (const _ of runTools(blocks, ctxWithObserver, [tool], denyAll)) {
      // drain
    }
    expect(toolCalled).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe('denied');
    expect(calls[0]?.toolName).toBe('Echo');
    expect(calls[0]?.traceId).toBe('d-1');
  });

  test('cancelled: pre-aborted signal short-circuits → observer captures status: cancelled', async () => {
    const { observer, calls } = makeFakeObserver();
    const controller = new AbortController();
    controller.abort();
    let toolCalled = false;
    const tool = buildTool({
      name: 'Echo',
      description: () => 'echo',
      inputSchema: z.object({ text: z.string() }),
      async call() {
        toolCalled = true;
        return { data: 'should not run' };
      },
    }) as unknown as Tool<unknown, unknown>;
    const ctxWithObserver: ToolContext = {
      ...ctx,
      learningObserver: observer,
      signal: controller.signal,
    };
    const blocks: UseBlock[] = [
      { type: 'tool_use', id: 'c-1', name: 'Echo', input: { text: 'x' } },
    ];
    for await (const _ of runTools(blocks, ctxWithObserver, [tool])) {
      // drain
    }
    expect(toolCalled).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe('cancelled');
    expect(calls[0]?.toolName).toBe('Echo');
    expect(calls[0]?.traceId).toBe('c-1');
  });

  test('unknown tool: observer captures status: error (negative-example signal)', async () => {
    const { observer, calls } = makeFakeObserver();
    const ctxWithObserver: ToolContext = { ...ctx, learningObserver: observer };
    const blocks: UseBlock[] = [{ type: 'tool_use', id: 'u-1', name: 'DoesNotExist', input: {} }];
    for await (const _ of runTools(blocks, ctxWithObserver, [makeEchoTool()])) {
      // drain
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe('error');
    expect(calls[0]?.toolName).toBe('DoesNotExist');
  });

  test('input validation failure: observer captures status: error', async () => {
    const { observer, calls } = makeFakeObserver();
    const ctxWithObserver: ToolContext = { ...ctx, learningObserver: observer };
    const blocks: UseBlock[] = [
      { type: 'tool_use', id: 'iv-1', name: 'Echo', input: { text: 42 } as unknown },
    ];
    for await (const _ of runTools(blocks, ctxWithObserver, [makeEchoTool()])) {
      // drain
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe('error');
  });

  test('observation envelope status:error → observer captures status: error', async () => {
    const { observer, calls } = makeFakeObserver();
    const ctxWithObserver: ToolContext = { ...ctx, learningObserver: observer };
    const tool = buildTool({
      name: 'EnvErr',
      description: () => 'returns error envelope',
      inputSchema: z.object({}),
      async call() {
        return {
          data: 'data',
          observation: { status: 'error' as const, summary: 'failed' },
        };
      },
    }) as unknown as Tool<unknown, unknown>;
    const blocks: UseBlock[] = [{ type: 'tool_use', id: 'env-1', name: 'EnvErr', input: {} }];
    for await (const _ of runTools(blocks, ctxWithObserver, [tool])) {
      // drain
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe('error');
    expect(calls[0]?.observationEnvelope?.status).toBe('error');
  });

  test('absent observer: dispatch path is a no-op (no throws, no calls recorded)', async () => {
    const blocks: UseBlock[] = [
      { type: 'tool_use', id: 'na-1', name: 'Echo', input: { text: 'hi' } },
    ];
    // ctx has no learningObserver — should not throw.
    const results: unknown[] = [];
    for await (const msg of runTools(blocks, ctx, [makeEchoTool()])) {
      results.push(msg);
    }
    expect(results.length).toBeGreaterThan(0);
  });
});

// Unit tests for the extracted notifyLearningObserver helper. Verifies that
// each ObservationStatus value flows through unchanged and that the helper
// is a no-op when the observer is absent.
describe('notifyLearningObserver helper', () => {
  test('forwards each of the 4 ObservationStatus values verbatim', () => {
    const { observer, calls } = makeFakeObserver();
    const fakeCtx: ToolContext = { ...ctx, learningObserver: observer };
    const states: ObservationStatus[] = ['success', 'error', 'denied', 'cancelled'];
    for (const status of states) {
      notifyLearningObserver(fakeCtx, 'T', { x: 1 }, status, 7, { traceId: `tid-${status}` });
    }
    expect(calls.map((c) => c.status)).toEqual(states);
    expect(calls.map((c) => c.traceId)).toEqual(states.map((s) => `tid-${s}`));
    expect(calls.every((c) => c.durationMs === 7)).toBe(true);
  });

  test('no-op when ctx.learningObserver is absent', () => {
    expect(() =>
      notifyLearningObserver(ctx, 'T', {}, 'denied', 0, { traceId: 'tid' }),
    ).not.toThrow();
  });

  test('omits traceId when not provided', () => {
    const { observer, calls } = makeFakeObserver();
    const fakeCtx: ToolContext = { ...ctx, learningObserver: observer };
    notifyLearningObserver(fakeCtx, 'T', {}, 'success', 0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.traceId).toBeUndefined();
  });
});

describe('validateInput dispatch', () => {
  function makeValidatedTool(verdict: { ok: true } | { ok: false; reason: string }): {
    tool: Tool<unknown, unknown>;
    wasCalled: () => boolean;
  } {
    let called = false;
    const tool = buildTool({
      name: 'Validated',
      description: () => 'tool with a validateInput guard',
      inputSchema: z.object({ url: z.string() }),
      validateInput: async () => verdict,
      async call() {
        called = true;
        return { data: 'ran' };
      },
    }) as unknown as Tool<unknown, unknown>;
    return { tool, wasCalled: () => called };
  }

  test('validateInput rejection short-circuits to is_error and skips call()', async () => {
    const { tool, wasCalled } = makeValidatedTool({ ok: false, reason: 'blocked host' });
    const results = await collectResults(
      [{ type: 'tool_use', id: 'v1', name: 'Validated', input: { url: 'http://x' } }],
      [tool],
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.is_error).toBe(true);
    expect(String(results[0]?.content)).toContain('blocked host');
    expect(wasCalled()).toBe(false);
  });

  test('validateInput pass lets call() run', async () => {
    const { tool, wasCalled } = makeValidatedTool({ ok: true });
    const results = await collectResults(
      [{ type: 'tool_use', id: 'v2', name: 'Validated', input: { url: 'http://x' } }],
      [tool],
    );
    expect(results[0]?.is_error).toBeFalsy();
    expect(wasCalled()).toBe(true);
  });
});

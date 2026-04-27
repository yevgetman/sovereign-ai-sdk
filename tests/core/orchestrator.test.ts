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
  partitionToolCalls,
  runTools,
  splitByPathOverlap,
} from '../../src/core/orchestrator.js';
import type { ContentBlock } from '../../src/core/types.js';
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

// runTools orchestrator tests. Uses fake tools built via buildTool() so
// we exercise the real dispatch path without relying on BashTool's
// subprocess infrastructure.

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { runTools } from '../../src/core/orchestrator.js';
import type { ContentBlock } from '../../src/core/types.js';
import { buildTool } from '../../src/tool/buildTool.js';
import type { Tool, ToolContext } from '../../src/tool/types.js';

const ctx: ToolContext = {
  cwd: process.cwd(),
  bundleRoot: process.cwd(),
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
): Promise<ResultBlock[]> {
  const out: ResultBlock[] = [];
  for await (const msg of runTools(blocks, ctx, tools)) {
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

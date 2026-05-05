// Phase 10.5 part 2b — wrapToolsForReplay tests. Build a real Tool via
// buildTool(), wrap it with replay results, verify each call returns
// the next captured result keyed by (toolName, callIndex).

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { wrapToolsForReplay } from '../../../src/eval/replay/toolPool.js';
import type { ReplayFixture } from '../../../src/eval/replay/types.js';
import { buildTool } from '../../../src/tool/buildTool.js';
import type { Tool, ToolContext } from '../../../src/tool/types.js';

function makeEcho(): Tool<unknown, unknown> {
  return buildTool({
    name: 'Echo',
    description: () => 'echo input',
    inputSchema: z.object({ text: z.string() }),
    async call(input) {
      return { data: { echoed: input.text, source: 'live' } };
    },
  }) as unknown as Tool<unknown, unknown>;
}

function makeRead(): Tool<unknown, unknown> {
  return buildTool({
    name: 'Read',
    description: () => 'read a file',
    inputSchema: z.object({ path: z.string() }),
    async call(input) {
      return { data: `contents of ${input.path} (live)` };
    },
  }) as unknown as Tool<unknown, unknown>;
}

const ctx: ToolContext = {
  cwd: '/tmp',
  bundleRoot: '/tmp',
  sessionId: 'replay-test',
};

function fixtureWith(
  ...results: Array<{ toolName: string; data: unknown; error?: string }>
): ReplayFixture {
  return {
    meta: {
      sessionId: 's',
      provider: 'p',
      model: 'm',
      capturedAt: '2026-05-05T00:00:00.000Z',
    },
    turns: [
      {
        turn: 0,
        providerEvents: [],
        toolResults: results.map((r, i) => ({
          toolName: r.toolName,
          callIndex: i,
          data: r.data,
          ...(r.error !== undefined ? { error: r.error } : {}),
        })),
      },
    ],
  };
}

describe('wrapToolsForReplay', () => {
  test('wrapped tool returns the captured data instead of running its real call()', async () => {
    const fixture = fixtureWith({
      toolName: 'Echo',
      data: { echoed: 'replayed', source: 'fixture' },
    });
    const [echo] = wrapToolsForReplay([makeEcho()], fixture);
    const result = await echo!.call({ text: 'live-input' }, ctx);
    expect(result).toEqual({ data: { echoed: 'replayed', source: 'fixture' } });
  });

  test('the K-th call to a tool gets the K-th captured result', async () => {
    const fixture = fixtureWith(
      { toolName: 'Read', data: 'content of A' },
      { toolName: 'Read', data: 'content of B' },
      { toolName: 'Read', data: 'content of C' },
    );
    const [read] = wrapToolsForReplay([makeRead()], fixture);
    const r1 = await read!.call({ path: '/x' }, ctx);
    const r2 = await read!.call({ path: '/y' }, ctx);
    const r3 = await read!.call({ path: '/z' }, ctx);
    expect(r1).toEqual({ data: 'content of A' });
    expect(r2).toEqual({ data: 'content of B' });
    expect(r3).toEqual({ data: 'content of C' });
  });

  test('throws when the agent makes more calls than were captured', async () => {
    const fixture = fixtureWith({ toolName: 'Read', data: 'one' });
    const [read] = wrapToolsForReplay([makeRead()], fixture);
    await read!.call({ path: '/x' }, ctx);
    await expect(read!.call({ path: '/y' }, ctx)).rejects.toThrow(/replay exhausted for tool Read/);
  });

  test('captured `error` re-throws as a real error', async () => {
    const fixture = fixtureWith({ toolName: 'Read', data: '', error: 'permission denied' });
    const [read] = wrapToolsForReplay([makeRead()], fixture);
    await expect(read!.call({ path: '/x' }, ctx)).rejects.toThrow(/permission denied/);
  });

  test('tools not present in the fixture pass through unchanged', async () => {
    const fixture = fixtureWith({ toolName: 'Read', data: 'x' });
    const wrapped = wrapToolsForReplay([makeEcho()], fixture);
    const result = await wrapped[0]!.call({ text: 'live' }, ctx);
    expect(result).toEqual({ data: { echoed: 'live', source: 'live' } });
  });

  test('counters are independent per tool', async () => {
    const fixture = fixtureWith(
      { toolName: 'Read', data: 'r0' },
      { toolName: 'Echo', data: { echoed: 'e0', source: 'fx' } },
      { toolName: 'Read', data: 'r1' },
      { toolName: 'Echo', data: { echoed: 'e1', source: 'fx' } },
    );
    const [echo, read] = wrapToolsForReplay([makeEcho(), makeRead()], fixture);
    expect(await read!.call({ path: '/a' }, ctx)).toEqual({ data: 'r0' });
    expect(await echo!.call({ text: 'live' }, ctx)).toEqual({
      data: { echoed: 'e0', source: 'fx' },
    });
    expect(await read!.call({ path: '/b' }, ctx)).toEqual({ data: 'r1' });
    expect(await echo!.call({ text: 'live' }, ctx)).toEqual({
      data: { echoed: 'e1', source: 'fx' },
    });
  });

  test('observation is preserved when captured', async () => {
    const fixture: ReplayFixture = {
      ...fixtureWith({ toolName: 'Read', data: 'x' }),
      turns: [
        {
          turn: 0,
          providerEvents: [],
          toolResults: [
            {
              toolName: 'Read',
              callIndex: 0,
              data: 'x',
              observation: {
                status: 'success',
                summary: 'read 1KB',
                next_actions: [],
                artifacts: [],
              },
            },
          ],
        },
      ],
    };
    const [read] = wrapToolsForReplay([makeRead()], fixture);
    const result = (await read!.call({ path: '/x' }, ctx)) as {
      data: unknown;
      observation: { status: string };
    };
    expect(result.data).toBe('x');
    expect(result.observation?.status).toBe('success');
  });
});

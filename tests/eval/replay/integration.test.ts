// Phase 10.5 part 2b — replay round-trip integration. Synthesize a
// two-turn fixture where the agent calls a tool in turn 0 and finishes
// in turn 1. Drive it through query() with ReplayProvider + wrapped
// tools and assert the agent's behavior is identical across runs.
//
// This is the load-bearing test: it proves the replay primitives wire
// cleanly into the existing orchestrator (no special replay code path
// in query.ts / orchestrator.ts).

import { describe, expect, test } from 'bun:test';
import { query } from '@yevgetman/sov-sdk/core/query';
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  Terminal,
} from '@yevgetman/sov-sdk/core/types';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import type { Tool, ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { z } from 'zod';
import { ReplayProvider } from '../../../src/eval/replay/provider.js';
import { wrapToolsForReplay } from '../../../src/eval/replay/toolPool.js';
import type { ReplayFixture } from '../../../src/eval/replay/types.js';

function makeRead(): Tool<unknown, unknown> {
  return buildTool({
    name: 'Read',
    description: () => 'read a file',
    inputSchema: z.object({ path: z.string() }),
    async call(input) {
      // The fixture supplies the canned result; this body should never
      // run when wrapped. Throw on accidental live execution.
      throw new Error(`live Read call escaped the wrapper for path=${input.path}`);
    },
  }) as unknown as Tool<unknown, unknown>;
}

const ctx: ToolContext = {
  cwd: '/tmp',
  bundleRoot: '/tmp',
  sessionId: 'replay-integration',
};

const TURN_0_TOOL_USE: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: '/x' } }],
};

const TURN_1_FINAL: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'the file says: hello world' }],
};

function twoTurnFixture(): ReplayFixture {
  return {
    meta: {
      sessionId: 'fx-2turn',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      capturedAt: '2026-05-05T20:00:00.000Z',
    },
    turns: [
      {
        turn: 0,
        providerEvents: [
          { type: 'message_start' },
          { type: 'tool_use_delta', id: 'tu_1', partial: '{"path":"/x"}' },
          { type: 'message_stop', stop_reason: 'tool_use' },
          { type: 'assistant_message', message: TURN_0_TOOL_USE },
        ],
        toolResults: [
          {
            toolName: 'Read',
            callIndex: 0,
            data: 'hello world',
          },
        ],
      },
      {
        turn: 1,
        providerEvents: [
          { type: 'message_start' },
          { type: 'text_delta', text: 'the file says: hello world' },
          { type: 'message_stop', stop_reason: 'end_turn' },
          { type: 'assistant_message', message: TURN_1_FINAL },
        ],
        toolResults: [],
      },
    ],
  };
}

async function drain(
  gen: AsyncGenerator<StreamEvent | Message, Terminal>,
): Promise<{ events: (StreamEvent | Message)[]; terminal: Terminal }> {
  const events: (StreamEvent | Message)[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { events, terminal: step.value };
    events.push(step.value);
  }
}

describe('replay round-trip through query()', () => {
  test('two-turn session with one tool call replays deterministically', async () => {
    const fixture = twoTurnFixture();
    const provider = new ReplayProvider({ fixture });
    const tools = wrapToolsForReplay([makeRead()], fixture);
    const gen = query({
      provider,
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'read /x and tell me' }] }],
      systemPrompt: [],
      tools,
      toolContext: ctx,
      canUseTool: async () => ({ behavior: 'allow' }),
      maxTokens: 256,
    });
    const { events, terminal } = await drain(gen);
    expect(terminal.reason).toBe('completed');
    expect(provider.turnsConsumed).toBe(2);
    expect(provider.isExhausted).toBe(true);
    // Two assistant_message events fire — turn 0 (tool_use) and turn 1
    // (final text). The turn-1 one carries the captured response text.
    const finalText = events
      .filter(
        (e): e is StreamEvent => 'type' in e && (e as StreamEvent).type === 'assistant_message',
      )
      .map((e) => (e.type === 'assistant_message' ? e.message : null))
      .find((m) => m && m.content[0]?.type === 'text');
    if (!finalText || finalText.content[0]?.type !== 'text') {
      throw new Error('no final text assistant message');
    }
    expect(finalText.content[0].text).toBe('the file says: hello world');
  });

  test('running the fixture twice produces the same outcome (deterministic)', async () => {
    const captured: string[] = [];
    for (let i = 0; i < 2; i++) {
      const fixture = twoTurnFixture();
      const provider = new ReplayProvider({ fixture });
      const tools = wrapToolsForReplay([makeRead()], fixture);
      const gen = query({
        provider,
        model: 'm',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
        systemPrompt: [],
        tools,
        toolContext: ctx,
        canUseTool: async () => ({ behavior: 'allow' }),
        maxTokens: 256,
      });
      const { terminal } = await drain(gen);
      captured.push(terminal.reason);
    }
    expect(captured).toEqual(['completed', 'completed']);
  });
});

describe('wrapToolsForReplay callIndex correlation', () => {
  test('returns results by callIndex even when captured in completion order', async () => {
    // Two Read calls. The fixture stores them in COMPLETION order — call #1
    // finished before call #0 (as happens for a concurrent same-tool wave) —
    // but each carries its call-START callIndex. Replay must hand back results
    // by callIndex, not by stored order, or the two get swapped.
    const fixture: ReplayFixture = {
      meta: {
        sessionId: 'fx',
        provider: 'anthropic',
        model: 'm',
        capturedAt: '2026-05-05T20:00:00.000Z',
      },
      turns: [
        {
          turn: 0,
          providerEvents: [],
          toolResults: [
            { toolName: 'Read', callIndex: 1, data: 'B' },
            { toolName: 'Read', callIndex: 0, data: 'A' },
          ],
        },
      ],
    };
    const [read] = wrapToolsForReplay([makeRead()], fixture);
    if (!read) throw new Error('no wrapped tool');
    const first = (await read.call({ path: '/a' }, ctx)) as { data: unknown };
    const second = (await read.call({ path: '/b' }, ctx)) as { data: unknown };
    expect(first.data).toBe('A'); // call #0 → callIndex-0 result, not the first-stored 'B'
    expect(second.data).toBe('B');
  });
});

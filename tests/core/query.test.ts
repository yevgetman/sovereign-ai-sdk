// Turn-loop tests. Fixture-based: a fake provider yields a scripted
// sequence of StreamEvents; we assert query() pipes them through, captures
// the assistant message, and terminates with the right reason.
//
// We don't hit the real Anthropic API in unit tests. The provider
// translation layer is exercised by a fixture-replay test at the provider
// boundary (tests/providers/anthropic.test.ts).

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { query } from '../../src/core/query.js';
import type { AssistantMessage, Message, StreamEvent } from '../../src/core/types.js';
import type { LLMProvider, ProviderRequest } from '../../src/providers/types.js';
import { buildTool } from '../../src/tool/buildTool.js';
import type { Tool, ToolContext } from '../../src/tool/types.js';

/**
 * Fake provider that runs through a queue of turn-scripts. Each script is
 * the set of events for one provider.stream() call; when the script ends,
 * the next call consumes the next script. Mimics what Anthropic does when
 * the model alternates between tool-use and end_turn turns.
 */
function scriptedTurns(turns: StreamEvent[][]): LLMProvider {
  const queue = [...turns];
  return {
    name: 'fake',
    async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      const events = queue.shift();
      if (!events) throw new Error('scriptedTurns: no more turns in script');
      let last: AssistantMessage | undefined;
      for (const ev of events) {
        if (ev.type === 'assistant_message') last = ev.message;
        yield ev;
      }
      return last ?? { role: 'assistant', content: [] };
    },
  };
}

const completedAnswer: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: '4' }],
};

const completedEvents: StreamEvent[] = [
  { type: 'message_start' },
  { type: 'text_delta', text: '4' },
  { type: 'message_stop', stop_reason: 'end_turn' },
  { type: 'assistant_message', message: completedAnswer },
];

const toolUseAnswer: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 't1', name: 'Echo', input: { text: 'hello' } }],
};

const toolUseThenFinishTurns: StreamEvent[][] = [
  // Turn 1: assistant asks to call Echo
  [
    { type: 'message_start' },
    { type: 'tool_use_delta', id: 't1', partial: '{"text":"hello"}' },
    { type: 'message_stop', stop_reason: 'tool_use' },
    { type: 'assistant_message', message: toolUseAnswer },
  ],
  // Turn 2: assistant finishes with text
  [
    { type: 'message_start' },
    { type: 'text_delta', text: 'done' },
    { type: 'message_stop', stop_reason: 'end_turn' },
    {
      type: 'assistant_message',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    },
  ],
];

function makeEchoTool(): Tool<unknown, unknown> {
  return buildTool({
    name: 'Echo',
    description: () => 'echo input',
    inputSchema: z.object({ text: z.string() }),
    async call(input) {
      return { data: { echoed: input.text } };
    },
  }) as unknown as Tool<unknown, unknown>;
}

const toolCtx: ToolContext = {
  cwd: process.cwd(),
  bundleRoot: process.cwd(),
  sessionId: 'test',
};

describe('query() — Phase 2 turn loop', () => {
  test('single turn with no tool_use returns completed', async () => {
    const provider = scriptedTurns([completedEvents]);
    const gen = query({
      provider,
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: [{ type: 'text', text: "what's 2+2?" }] }],
      systemPrompt: [],
      maxTokens: 256,
    });
    const yielded: (StreamEvent | Message)[] = [];
    let terminal: { reason: string } | undefined;
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        terminal = step.value;
        break;
      }
      yielded.push(step.value);
    }
    expect(terminal?.reason).toBe('completed');
  });

  test('tool_use turn dispatches runTools and continues to completion', async () => {
    const provider = scriptedTurns(toolUseThenFinishTurns);
    const gen = query({
      provider,
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'say hello' }] }],
      systemPrompt: [],
      tools: [makeEchoTool()],
      toolContext: toolCtx,
      maxTokens: 256,
    });
    const yielded: (StreamEvent | Message)[] = [];
    let terminal: { reason: string; error?: Error } | undefined;
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        terminal = step.value;
        break;
      }
      yielded.push(step.value);
    }
    expect(terminal?.reason).toBe('completed');
    // Between the two assistant_message events, there should be one user
    // message carrying the tool_result.
    const userMessages = yielded.filter(
      (v) => v && typeof v === 'object' && 'role' in v && v.role === 'user',
    ) as Message[];
    expect(userMessages).toHaveLength(1);
    const [userMsg] = userMessages;
    expect(userMsg?.content[0]?.type).toBe('tool_result');
  });

  test('tool_use with no tools provided returns error', async () => {
    const firstTurn = toolUseThenFinishTurns[0];
    if (!firstTurn) throw new Error('test fixture missing');
    const provider = scriptedTurns([firstTurn]);
    const gen = query({
      provider,
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      systemPrompt: [],
      maxTokens: 256,
    });
    let terminal: { reason: string; error?: Error } | undefined;
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        terminal = step.value;
        break;
      }
    }
    expect(terminal?.reason).toBe('error');
    expect(terminal?.error?.message).toContain('no tools');
  });

  test('maxTurns caps the tool-continuation loop', async () => {
    // Every turn asks to call Echo again; without a cap this would loop
    // forever. With maxTurns=2 the generator should return max_turns.
    const keepCallingTurns: StreamEvent[][] = Array.from({ length: 5 }, (_, i) => [
      { type: 'message_start' } as StreamEvent,
      { type: 'tool_use_delta', id: `t${i}`, partial: '{"text":"x"}' } as StreamEvent,
      { type: 'message_stop', stop_reason: 'tool_use' } as StreamEvent,
      {
        type: 'assistant_message',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: `t${i}`, name: 'Echo', input: { text: 'x' } }],
        },
      } as StreamEvent,
    ]);
    const provider = scriptedTurns(keepCallingTurns);
    const gen = query({
      provider,
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      systemPrompt: [],
      tools: [makeEchoTool()],
      toolContext: toolCtx,
      maxTurns: 2,
      maxTokens: 256,
    });
    let terminal: { reason: string } | undefined;
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        terminal = step.value;
        break;
      }
    }
    expect(terminal?.reason).toBe('max_turns');
  });

  test('honors pre-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = scriptedTurns([completedEvents]);
    const gen = query({
      provider,
      model: 'claude-opus-4-7',
      messages: [],
      systemPrompt: [],
      maxTokens: 256,
      signal: controller.signal,
    });
    const first = await gen.next();
    expect(first.done).toBe(true);
    expect((first.value as { reason: string }).reason).toBe('interrupted');
  });

  test('treats empty assistant response as error', async () => {
    const provider: LLMProvider = {
      name: 'empty',
      // biome-ignore lint/correctness/useYield: intentional — zero events, tests the no-assistant-message error path.
      async *stream() {
        return { role: 'assistant', content: [] };
      },
    };
    const gen = query({
      provider,
      model: 'claude-opus-4-7',
      messages: [],
      systemPrompt: [],
      maxTokens: 256,
    });
    const step = await gen.next();
    expect(step.done).toBe(true);
    expect((step.value as { reason: string }).reason).toBe('error');
  });
});

// Turn-loop tests. Fixture-based: a fake provider yields a scripted
// sequence of StreamEvents; we assert query() pipes them through, captures
// the assistant message, and terminates with the right reason.
//
// We don't hit the real Anthropic API in unit tests. The provider
// translation layer is exercised by a fixture-replay test at the provider
// boundary (tests/providers/anthropic.test.ts).

import { describe, expect, test } from 'bun:test';
import { query } from '../../src/core/query.js';
import type { AssistantMessage, StreamEvent } from '../../src/core/types.js';
import type { LLMProvider, ProviderRequest } from '../../src/providers/types.js';

function scripted(events: StreamEvent[]): LLMProvider {
  return {
    name: 'fake',
    async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
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
  content: [{ type: 'tool_use', id: 't1', name: 'fake_tool', input: {} }],
};

const toolUseEvents: StreamEvent[] = [
  { type: 'message_start' },
  { type: 'tool_use_delta', id: 't1', partial: '{}' },
  { type: 'message_stop', stop_reason: 'tool_use' },
  { type: 'assistant_message', message: toolUseAnswer },
];

describe('query() — Phase 1 turn loop', () => {
  test('yields provider events and returns completed on end_turn', async () => {
    const provider = scripted(completedEvents);
    const gen = query({
      provider,
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: [{ type: 'text', text: "what's 2+2?" }] }],
      systemPrompt: [],
      maxTokens: 256,
    });
    const yielded: StreamEvent[] = [];
    let terminal: { reason: string } | undefined;
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        terminal = step.value;
        break;
      }
      yielded.push(step.value as StreamEvent);
    }
    expect(yielded.map((e) => e.type)).toEqual([
      'message_start',
      'text_delta',
      'message_stop',
      'assistant_message',
    ]);
    expect(terminal?.reason).toBe('completed');
  });

  test('returns error when assistant asks for a tool (Phase 2 territory)', async () => {
    const provider = scripted(toolUseEvents);
    const gen = query({
      provider,
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'list files' }] }],
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
    expect(terminal?.error?.message).toContain('Phase 2');
  });

  test('honors pre-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = scripted(completedEvents);
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

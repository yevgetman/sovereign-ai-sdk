// Phase 10.6 part 2b — interactive escalation prompt. When
// escalationMode is 'ask' AND the classifier produces
// 'local-with-escalation' AND an asker is supplied, the router
// awaits the user's yes/no and routes accordingly. Without an asker,
// 'ask' falls through to the default lane (matches the pre-2b behavior
// for piped/CI sessions).

import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, Message, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import { RouterProvider } from '../../src/router/provider.js';
import type { RouterConfig } from '../../src/router/types.js';

const ASSISTANT_DONE: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'ok' }],
};

function fakeProvider(name: string): LLMProvider {
  return {
    name,
    async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      yield { type: 'message_start' };
      yield { type: 'text_delta', text: name };
      yield { type: 'message_stop', stop_reason: 'end_turn' };
      yield { type: 'assistant_message', message: ASSISTANT_DONE };
      return ASSISTANT_DONE;
    },
  };
}

const baseConfig: RouterConfig = {
  localProvider: 'ollama',
  localModel: 'qwen2.5:14b',
  frontierProvider: 'anthropic',
  frontierModel: 'claude-sonnet-4-6',
  escalationMode: 'ask',
};

/** History with `errCount` failed tool_results — enough errors to
 *  trip the classifier into local-with-escalation. */
function historyWithToolErrors(errCount: number): Message[] {
  const content: Message['content'] = [];
  for (let i = 0; i < errCount; i++) {
    content.push({
      type: 'tool_result',
      tool_use_id: `tu_${i}`,
      content: 'tool error',
      is_error: true,
    });
  }
  return [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'trying' }] },
    { role: 'user', content },
  ];
}

async function consume(provider: LLMProvider, req: ProviderRequest): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  const gen = provider.stream(req);
  for (;;) {
    const step = await gen.next();
    if (step.done) return events;
    events.push(step.value);
  }
}

describe('RouterProvider — interactive ask', () => {
  test("'ask' falls through to local when no asker is supplied (CI/piped path)", async () => {
    const router = new RouterProvider({
      config: baseConfig,
      localProvider: fakeProvider('local'),
      frontierProvider: fakeProvider('frontier'),
    });
    const events = await consume(router, {
      model: 'unused',
      system: [],
      messages: historyWithToolErrors(3),
      maxTokens: 100,
    });
    const route = events.find((e) => e.type === 'route_decision');
    if (route?.type !== 'route_decision') throw new Error('no route_decision');
    expect(route.info.lane).toBe('local');
  });

  test('escalates to frontier when asker returns true', async () => {
    const askPrompts: string[] = [];
    const router = new RouterProvider({
      config: baseConfig,
      localProvider: fakeProvider('local'),
      frontierProvider: fakeProvider('frontier'),
      escalationAsker: async (prompt) => {
        askPrompts.push(prompt);
        return true;
      },
    });
    const events = await consume(router, {
      model: 'unused',
      system: [],
      messages: historyWithToolErrors(3),
      maxTokens: 100,
    });
    const route = events.find((e) => e.type === 'route_decision');
    if (route?.type !== 'route_decision') throw new Error('no route_decision');
    expect(route.info.lane).toBe('frontier');
    expect(route.info.classifierLane).toBe('local-with-escalation');
    expect(route.info.reason).toContain('user approved escalation');
    expect(askPrompts).toHaveLength(1);
    expect(askPrompts[0]).toContain('struggling');
    expect(askPrompts[0]).toContain('anthropic');
  });

  test('stays on default lane when asker returns false', async () => {
    const router = new RouterProvider({
      config: baseConfig,
      localProvider: fakeProvider('local'),
      frontierProvider: fakeProvider('frontier'),
      escalationAsker: async () => false,
    });
    const events = await consume(router, {
      model: 'unused',
      system: [],
      messages: historyWithToolErrors(3),
      maxTokens: 100,
    });
    const route = events.find((e) => e.type === 'route_decision');
    if (route?.type !== 'route_decision') throw new Error('no route_decision');
    expect(route.info.lane).toBe('local');
    expect(route.info.reason).toContain('user declined escalation');
  });

  test("doesn't prompt when classifier output is plain 'local' (no escalation)", async () => {
    const askPrompts: string[] = [];
    const router = new RouterProvider({
      config: baseConfig,
      localProvider: fakeProvider('local'),
      frontierProvider: fakeProvider('frontier'),
      escalationAsker: async (prompt) => {
        askPrompts.push(prompt);
        return true;
      },
    });
    const events = await consume(router, {
      model: 'unused',
      system: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      maxTokens: 100,
    });
    const route = events.find((e) => e.type === 'route_decision');
    if (route?.type !== 'route_decision') throw new Error('no route_decision');
    expect(route.info.lane).toBe('local');
    expect(askPrompts).toHaveLength(0);
  });

  test("doesn't prompt when escalationMode is 'auto' (auto-escalates without asking)", async () => {
    const askPrompts: string[] = [];
    const router = new RouterProvider({
      config: { ...baseConfig, escalationMode: 'auto' },
      localProvider: fakeProvider('local'),
      frontierProvider: fakeProvider('frontier'),
      escalationAsker: async (prompt) => {
        askPrompts.push(prompt);
        return true;
      },
    });
    const events = await consume(router, {
      model: 'unused',
      system: [],
      messages: historyWithToolErrors(3),
      maxTokens: 100,
    });
    const route = events.find((e) => e.type === 'route_decision');
    if (route?.type !== 'route_decision') throw new Error('no route_decision');
    expect(route.info.lane).toBe('frontier');
    expect(askPrompts).toHaveLength(0);
  });

  test('a thrown asker swallows the error and falls through to local (defensive)', async () => {
    const router = new RouterProvider({
      config: baseConfig,
      localProvider: fakeProvider('local'),
      frontierProvider: fakeProvider('frontier'),
      escalationAsker: async () => {
        throw new Error('TTY closed');
      },
    });
    const events = await consume(router, {
      model: 'unused',
      system: [],
      messages: historyWithToolErrors(3),
      maxTokens: 100,
    });
    const route = events.find((e) => e.type === 'route_decision');
    if (route?.type !== 'route_decision') throw new Error('no route_decision');
    expect(route.info.lane).toBe('local');
  });
});

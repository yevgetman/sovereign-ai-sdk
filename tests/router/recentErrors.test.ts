// Phase 10.6 part 2 — recent-error tracking. RouterProvider scans
// req.messages for the last N tool_result blocks, counting how many
// were errors and how many matched a schema-failure pattern. We test
// the integration end-to-end: build a synthetic message history with
// known tool_result outcomes, drive a RouterProvider with
// `escalationMode: auto`, and assert the classifier escalates to
// `frontier` once the threshold is crossed.

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
  escalationMode: 'auto',
};

/** Build a synthetic conversation history with `errCount` failed
 *  tool_results, optionally tagged with a schema-failure error
 *  message. */
function historyWithToolErrors(errCount: number, schemaFailure = false): Message[] {
  const content: Message['content'] = [];
  for (let i = 0; i < errCount; i++) {
    content.push({
      type: 'tool_result',
      tool_use_id: `tu_${i}`,
      content: schemaFailure
        ? 'input validation failed: missing required field'
        : 'tool error: something went wrong',
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

describe('RouterProvider — recent-error tracking', () => {
  test('routes local when no errors are observed', async () => {
    const router = new RouterProvider({
      config: baseConfig,
      localProvider: fakeProvider('local'),
      frontierProvider: fakeProvider('frontier'),
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
  });

  test('escalates to frontier (escalationMode: auto) when ≥ 3 tool errors are present', async () => {
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
    expect(route.info.lane).toBe('frontier');
    expect(route.info.classifierLane).toBe('local-with-escalation');
    expect(route.info.reason).toContain('tool errors');
  });

  test('stays local when only 2 tool errors are present (below threshold)', async () => {
    const router = new RouterProvider({
      config: baseConfig,
      localProvider: fakeProvider('local'),
      frontierProvider: fakeProvider('frontier'),
    });
    const events = await consume(router, {
      model: 'unused',
      system: [],
      messages: historyWithToolErrors(2),
      maxTokens: 100,
    });
    const route = events.find((e) => e.type === 'route_decision');
    if (route?.type !== 'route_decision') throw new Error('no route_decision');
    expect(route.info.lane).toBe('local');
  });

  test('escalates when ≥ 2 schema failures match the pattern', async () => {
    const router = new RouterProvider({
      config: baseConfig,
      localProvider: fakeProvider('local'),
      frontierProvider: fakeProvider('frontier'),
    });
    const events = await consume(router, {
      model: 'unused',
      system: [],
      messages: historyWithToolErrors(2, true),
      maxTokens: 100,
    });
    const route = events.find((e) => e.type === 'route_decision');
    if (route?.type !== 'route_decision') throw new Error('no route_decision');
    expect(route.info.lane).toBe('frontier');
    expect(route.info.reason).toContain('schema failures');
  });

  test('escalation stays local when escalationMode is "never"', async () => {
    const router = new RouterProvider({
      config: { ...baseConfig, escalationMode: 'never' },
      localProvider: fakeProvider('local'),
      frontierProvider: fakeProvider('frontier'),
    });
    const events = await consume(router, {
      model: 'unused',
      system: [],
      messages: historyWithToolErrors(5),
      maxTokens: 100,
    });
    const route = events.find((e) => e.type === 'route_decision');
    if (route?.type !== 'route_decision') throw new Error('no route_decision');
    expect(route.info.lane).toBe('local');
    expect(route.info.classifierLane).toBe('local-with-escalation');
  });
});

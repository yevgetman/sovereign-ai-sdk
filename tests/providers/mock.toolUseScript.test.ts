// T12 — MockProvider.toolUseScript: richer canned tool-use sequences for the
// multi-call test paths T13/T14 need (delegator → atom-1 → atom-2 → synthesis →
// final). The legacy `toolUseMode` toggle is preserved verbatim when the script
// is unset so existing mock-driven tests stay green.
//
// The mock emits internal `StreamEvent` shapes (`message_start`,
// `text_delta`, `tool_use_delta`, `usage_delta`, `message_stop`,
// `assistant_message`) — NOT Anthropic SSE wire events. The orchestrator
// (`query()`) consumes these directly. The test asserts on this shape.
//
// The script cursor is a static field; each test resets it in `afterEach`.

import { afterEach, describe, expect, test } from 'bun:test';
import type {
  AssistantMessage,
  ContentBlock,
  Message,
  StreamEvent,
} from '@yevgetman/sov-sdk/core/types';
import { MockProvider, type ToolCallScript } from '@yevgetman/sov-sdk/providers/mock';
import type { ProviderRequest } from '@yevgetman/sov-sdk/providers/types';

function baseRequest(messages: Message[]): ProviderRequest {
  return {
    model: 'mock',
    system: [],
    messages,
    maxTokens: 1024,
  };
}

async function drain(
  gen: AsyncGenerator<StreamEvent, AssistantMessage>,
): Promise<{ events: StreamEvent[]; ret: AssistantMessage }> {
  const events: StreamEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, ret: next.value };
}

describe('MockProvider.toolUseScript', () => {
  afterEach(() => {
    MockProvider.toolUseScript = undefined;
    MockProvider.resetScriptCursor();
    MockProvider.toolUseMode = false;
  });

  test('walks script across successive stream calls — tool_use then text', async () => {
    const script: ToolCallScript[] = [
      {
        kind: 'tool_use',
        name: 'AgentTool',
        input: { subagent_type: 'cheap-task', prompt: 'x' },
        id: 'a1',
      },
      { kind: 'text', text: 'final answer' },
    ];
    MockProvider.toolUseScript = script;
    const provider = new MockProvider();

    // First stream call — should emit a tool_use_delta + assistant_message
    // whose content carries a tool_use block (name='AgentTool', id='a1').
    const messages1: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    const { events: events1, ret: ret1 } = await drain(provider.stream(baseRequest(messages1)));
    const toolUseDeltas = events1.filter(
      (e): e is StreamEvent & { type: 'tool_use_delta' } => e.type === 'tool_use_delta',
    );
    expect(toolUseDeltas.length).toBe(1);
    expect(toolUseDeltas[0]?.id).toBe('a1');
    const messageStop1 = events1.find(
      (e): e is StreamEvent & { type: 'message_stop' } => e.type === 'message_stop',
    );
    expect(messageStop1?.stop_reason).toBe('tool_use');
    // Assistant message should contain the tool_use block.
    const toolUseBlock = ret1.content.find(
      (b: ContentBlock): b is ContentBlock & { type: 'tool_use' } => b.type === 'tool_use',
    );
    expect(toolUseBlock).toBeDefined();
    expect(toolUseBlock?.name).toBe('AgentTool');
    expect(toolUseBlock?.id).toBe('a1');
    expect(toolUseBlock?.input).toEqual({ subagent_type: 'cheap-task', prompt: 'x' });

    // Second stream call — script cursor advances; should emit text_deltas
    // and end_turn (no tool_use).
    const messages2: Message[] = [
      ...messages1,
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'a1', name: 'AgentTool', input: {} }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'a1',
            content: 'result',
          },
        ],
      },
    ];
    const { events: events2, ret: ret2 } = await drain(provider.stream(baseRequest(messages2)));
    const textDeltas = events2.filter(
      (e): e is StreamEvent & { type: 'text_delta' } => e.type === 'text_delta',
    );
    expect(textDeltas.length).toBeGreaterThan(0);
    expect(textDeltas.map((d) => d.text).join('')).toBe('final answer');
    const messageStop2 = events2.find(
      (e): e is StreamEvent & { type: 'message_stop' } => e.type === 'message_stop',
    );
    expect(messageStop2?.stop_reason).toBe('end_turn');
    const textBlock = ret2.content.find(
      (b: ContentBlock): b is ContentBlock & { type: 'text' } => b.type === 'text',
    );
    expect(textBlock?.text).toBe('final answer');
    // No tool_use block on the second call's assistant message.
    expect(ret2.content.find((b) => b.type === 'tool_use')).toBeUndefined();
  });

  test('multi-step script walks through several tool_use entries', async () => {
    MockProvider.toolUseScript = [
      { kind: 'tool_use', name: 'AgentTool', input: { n: 1 }, id: 'a1' },
      { kind: 'tool_use', name: 'AgentTool', input: { n: 2 }, id: 'a2' },
      { kind: 'text', text: 'synthesis' },
    ];
    const provider = new MockProvider();

    const { ret: ret1 } = await drain(
      provider.stream(baseRequest([{ role: 'user', content: [{ type: 'text', text: 'go' }] }])),
    );
    expect(
      ret1.content.find((b): b is ContentBlock & { type: 'tool_use' } => b.type === 'tool_use')?.id,
    ).toBe('a1');

    const { ret: ret2 } = await drain(
      provider.stream(baseRequest([{ role: 'user', content: [{ type: 'text', text: 'go' }] }])),
    );
    expect(
      ret2.content.find((b): b is ContentBlock & { type: 'tool_use' } => b.type === 'tool_use')?.id,
    ).toBe('a2');

    const { ret: ret3 } = await drain(
      provider.stream(baseRequest([{ role: 'user', content: [{ type: 'text', text: 'go' }] }])),
    );
    expect(
      ret3.content.find((b): b is ContentBlock & { type: 'text' } => b.type === 'text')?.text,
    ).toBe('synthesis');
  });

  test('past end of script falls through to default Hello-world behavior', async () => {
    MockProvider.toolUseScript = [{ kind: 'text', text: 'only entry' }];
    const provider = new MockProvider();

    // Drain the only scripted entry.
    await drain(
      provider.stream(baseRequest([{ role: 'user', content: [{ type: 'text', text: 'x' }] }])),
    );

    // Second call — script exhausted; default Hello-world path takes over.
    const { ret } = await drain(
      provider.stream(baseRequest([{ role: 'user', content: [{ type: 'text', text: 'x' }] }])),
    );
    const text = ret.content.find((b): b is ContentBlock & { type: 'text' } => b.type === 'text');
    expect(text?.text).toBe('Hello world.');
  });

  test('resetScriptCursor() rewinds to start of script', async () => {
    MockProvider.toolUseScript = [
      { kind: 'text', text: 'first' },
      { kind: 'text', text: 'second' },
    ];
    const provider = new MockProvider();

    const { ret: r1 } = await drain(
      provider.stream(baseRequest([{ role: 'user', content: [{ type: 'text', text: 'x' }] }])),
    );
    expect(
      r1.content.find((b): b is ContentBlock & { type: 'text' } => b.type === 'text')?.text,
    ).toBe('first');

    MockProvider.resetScriptCursor();

    const { ret: r2 } = await drain(
      provider.stream(baseRequest([{ role: 'user', content: [{ type: 'text', text: 'x' }] }])),
    );
    expect(
      r2.content.find((b): b is ContentBlock & { type: 'text' } => b.type === 'text')?.text,
    ).toBe('first');
  });

  test('legacy toolUseMode behavior preserved when script is unset', async () => {
    MockProvider.toolUseScript = undefined;
    MockProvider.toolUseMode = true;
    const provider = new MockProvider();
    const { events, ret } = await drain(
      provider.stream(baseRequest([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])),
    );
    // Existing behavior: first call (no tool_result in history) emits a
    // Bash tool_use. Mirror the assertion from existing tool-use tests.
    const toolUseDelta = events.find(
      (e): e is StreamEvent & { type: 'tool_use_delta' } => e.type === 'tool_use_delta',
    );
    expect(toolUseDelta).toBeDefined();
    const toolUseBlock = ret.content.find(
      (b): b is ContentBlock & { type: 'tool_use' } => b.type === 'tool_use',
    );
    expect(toolUseBlock?.name).toBe('Bash');
  });

  test('default Hello-world behavior preserved when both script and toolUseMode unset', async () => {
    MockProvider.toolUseScript = undefined;
    MockProvider.toolUseMode = false;
    const provider = new MockProvider();
    const { ret } = await drain(
      provider.stream(baseRequest([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])),
    );
    const text = ret.content.find((b): b is ContentBlock & { type: 'text' } => b.type === 'text');
    expect(text?.text).toBe('Hello world.');
  });
});

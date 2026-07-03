// Phase 10.5 — assert that query() + the orchestrator emit the right
// TraceEvents at the right boundaries. Uses a fake provider + tool +
// recorder array (no real LLM, no real disk).

import { describe, expect, test } from 'bun:test';
import { query } from '@yevgetman/sov-sdk/core/query';
import type { AssistantMessage, Message, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import type { CanUseTool } from '@yevgetman/sov-sdk/permissions/types';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import type { Tool, ToolContext } from '@yevgetman/sov-sdk/tool/types';
import type { TraceEvent } from '@yevgetman/sov-sdk/trace/types';
import { z } from 'zod';

function scriptedTurns(turns: StreamEvent[][]): LLMProvider {
  const queue = [...turns];
  return {
    name: 'fake',
    async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      const events = queue.shift();
      if (!events) throw new Error('scriptedTurns: no more turns');
      let last: AssistantMessage | undefined;
      for (const ev of events) {
        if (ev.type === 'assistant_message') last = ev.message;
        yield ev;
      }
      return last ?? { role: 'assistant', content: [] };
    },
  };
}

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

function makeThrowingTool(): Tool<unknown, unknown> {
  return buildTool({
    name: 'Boom',
    description: () => 'always throws',
    inputSchema: z.object({}),
    async call() {
      throw new Error('intentional failure');
    },
  }) as unknown as Tool<unknown, unknown>;
}

const toolCtx: ToolContext = {
  cwd: process.cwd(),
  bundleRoot: process.cwd(),
  sessionId: 'trace-test',
};

const completedAnswer: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'done' }],
};

const completedEvents: StreamEvent[] = [
  { type: 'message_start' },
  { type: 'text_delta', text: 'done' },
  { type: 'usage_delta', usage: { inputTokens: 12, outputTokens: 3 } },
  { type: 'message_stop', stop_reason: 'end_turn' },
  { type: 'assistant_message', message: completedAnswer },
];

async function drain(gen: AsyncGenerator<StreamEvent | Message, unknown>): Promise<void> {
  for (;;) {
    const step = await gen.next();
    if (step.done) return;
  }
}

describe('query() trace recording', () => {
  test('emits turn_start + provider_request + provider_response on a no-tool turn', async () => {
    const events: TraceEvent[] = [];
    const gen = query({
      provider: scriptedTurns([completedEvents]),
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      systemPrompt: [{ text: 'system prompt body', cacheable: true }],
      maxTokens: 256,
      traceRecorder: (e) => events.push(e),
    });
    await drain(gen);
    const types = events.map((e) => e.type);
    expect(types).toEqual(['turn_start', 'provider_request', 'provider_response']);
    const turnStart = events[0];
    expect(turnStart && turnStart.type === 'turn_start' && turnStart.turn).toBe(0);
    const req = events[1];
    if (req?.type !== 'provider_request') throw new Error('expected provider_request');
    expect(req.provider).toBe('fake');
    expect(req.model).toBe('claude-sonnet-4-6');
    expect(req.purpose).toBe('main');
    expect(req.messageCount).toBe(1);
    expect(req.systemBytes).toBe(Buffer.byteLength('system prompt body', 'utf8'));
    const resp = events[2];
    if (resp?.type !== 'provider_response') throw new Error('expected provider_response');
    expect(resp.usage.inputTokens).toBe(12);
    expect(resp.usage.outputTokens).toBe(3);
    expect(resp.stopReason).toBe('end_turn');
    expect(resp.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test('provider_response usage merges split deltas per field within one call', async () => {
    // Anthropic emits two usage_delta events per call: message_start carries
    // input + cache fields, message_delta carries output only. A whole-object
    // overwrite (last-delta-wins) would drop the earlier input/cache figures.
    // The recorded provider_response must carry the union: last-seen per field.
    const splitDeltaEvents: StreamEvent[] = [
      { type: 'message_start' },
      {
        type: 'usage_delta',
        usage: { inputTokens: 100, cacheReadInputTokens: 20, cacheCreationInputTokens: 5 },
      },
      { type: 'text_delta', text: 'done' },
      { type: 'usage_delta', usage: { outputTokens: 42 } },
      { type: 'message_stop', stop_reason: 'end_turn' },
      { type: 'assistant_message', message: completedAnswer },
    ];
    const events: TraceEvent[] = [];
    const gen = query({
      provider: scriptedTurns([splitDeltaEvents]),
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      systemPrompt: [{ text: 'system prompt body', cacheable: true }],
      maxTokens: 256,
      traceRecorder: (e) => events.push(e),
    });
    await drain(gen);
    const resp = events.find((e) => e.type === 'provider_response');
    if (resp?.type !== 'provider_response') throw new Error('expected provider_response');
    // Fields from the FIRST delta survive the SECOND delta that omitted them.
    expect(resp.usage.inputTokens).toBe(100);
    expect(resp.usage.cacheReadInputTokens).toBe(20);
    expect(resp.usage.cacheCreationInputTokens).toBe(5);
    // The field from the second delta is also present.
    expect(resp.usage.outputTokens).toBe(42);
  });

  test('provider_response usage is unchanged when a call emits a single delta', async () => {
    // A single-delta call must record exactly the fields the provider sent.
    const events: TraceEvent[] = [];
    const gen = query({
      provider: scriptedTurns([completedEvents]),
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      systemPrompt: [{ text: 'system prompt body', cacheable: true }],
      maxTokens: 256,
      traceRecorder: (e) => events.push(e),
    });
    await drain(gen);
    const resp = events.find((e) => e.type === 'provider_response');
    if (resp?.type !== 'provider_response') throw new Error('expected provider_response');
    expect(resp.usage.inputTokens).toBe(12);
    expect(resp.usage.outputTokens).toBe(3);
    expect(resp.usage.cacheReadInputTokens).toBeUndefined();
    expect(resp.usage.cacheCreationInputTokens).toBeUndefined();
  });

  test('emits permission_check + tool_start + tool_end around a successful tool call', async () => {
    const events: TraceEvent[] = [];
    const tool = makeEchoTool();
    const toolUseAnswer: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'Echo', input: { text: 'hi' } }],
    };
    const turns: StreamEvent[][] = [
      [
        { type: 'message_start' },
        { type: 'message_stop', stop_reason: 'tool_use' },
        { type: 'assistant_message', message: toolUseAnswer },
      ],
      completedEvents,
    ];
    const canUse: CanUseTool = async () => ({ behavior: 'allow' });
    const gen = query({
      provider: scriptedTurns(turns),
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      systemPrompt: [],
      tools: [tool],
      toolContext: toolCtx,
      canUseTool: canUse,
      maxTokens: 256,
      traceRecorder: (e) => events.push(e),
    });
    await drain(gen);
    const types = events.map((e) => e.type);
    expect(types).toContain('permission_check');
    expect(types).toContain('tool_start');
    expect(types).toContain('tool_end');
    const perm = events.find((e) => e.type === 'permission_check');
    if (perm?.type !== 'permission_check') throw new Error('no permission_check');
    expect(perm.tool).toBe('Echo');
    expect(perm.decision).toBe('allow');
    expect(perm.transformed).toBe(false);
    const toolEnd = events.find((e) => e.type === 'tool_end');
    if (toolEnd?.type !== 'tool_end') throw new Error('no tool_end');
    expect(toolEnd.tool).toBe('Echo');
    expect(toolEnd.toolUseId).toBe('t1');
    expect(toolEnd.outputBytes).toBeGreaterThan(0);
    expect(toolEnd.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('emits tool_error when a tool throws', async () => {
    const events: TraceEvent[] = [];
    const tool = makeThrowingTool();
    const toolUseAnswer: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'x1', name: 'Boom', input: {} }],
    };
    const turns: StreamEvent[][] = [
      [
        { type: 'message_start' },
        { type: 'message_stop', stop_reason: 'tool_use' },
        { type: 'assistant_message', message: toolUseAnswer },
      ],
      completedEvents,
    ];
    const gen = query({
      provider: scriptedTurns(turns),
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      systemPrompt: [],
      tools: [tool],
      toolContext: toolCtx,
      canUseTool: async () => ({ behavior: 'allow' }),
      maxTokens: 256,
      traceRecorder: (e) => events.push(e),
    });
    await drain(gen);
    const err = events.find((e) => e.type === 'tool_error');
    if (err?.type !== 'tool_error') throw new Error('no tool_error');
    expect(err.tool).toBe('Boom');
    expect(err.message).toContain('intentional failure');
    expect(events.find((e) => e.type === 'tool_end')).toBeUndefined();
  });

  test('emits permission_check with decision: deny when canUseTool denies', async () => {
    const events: TraceEvent[] = [];
    const tool = makeEchoTool();
    const toolUseAnswer: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'Echo', input: { text: 'no' } }],
    };
    const turns: StreamEvent[][] = [
      [
        { type: 'message_start' },
        { type: 'message_stop', stop_reason: 'tool_use' },
        { type: 'assistant_message', message: toolUseAnswer },
      ],
      completedEvents,
    ];
    const canUse: CanUseTool = async () => ({ behavior: 'deny', reason: 'rule says no' });
    const gen = query({
      provider: scriptedTurns(turns),
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      systemPrompt: [],
      tools: [tool],
      toolContext: toolCtx,
      canUseTool: canUse,
      maxTokens: 256,
      traceRecorder: (e) => events.push(e),
    });
    await drain(gen);
    const perm = events.find((e) => e.type === 'permission_check');
    if (perm?.type !== 'permission_check') throw new Error('no permission_check');
    expect(perm.decision).toBe('deny');
    expect(perm.reason).toBe('rule says no');
    expect(events.find((e) => e.type === 'tool_start')).toBeUndefined();
    expect(events.find((e) => e.type === 'tool_end')).toBeUndefined();
  });

  test('a thrown trace handler does not crash the run', async () => {
    let received = 0;
    const gen = query({
      provider: scriptedTurns([completedEvents]),
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      systemPrompt: [],
      maxTokens: 256,
      traceRecorder: () => {
        received++;
        throw new Error('handler is broken');
      },
    });
    let terminal: { reason: string } | undefined;
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        terminal = step.value as { reason: string };
        break;
      }
    }
    expect(terminal?.reason).toBe('completed');
    expect(received).toBeGreaterThan(0);
  });
});

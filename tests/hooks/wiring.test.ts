// End-to-end wiring tests for hooks. We don't spawn subprocesses here — a
// fake HookRunner records every call so we can assert order and arguments.
// The point is the integration: orchestrator + query() + hookRunner threaded
// together. Subprocess behavior is covered by tests/hooks/runner.test.ts.

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { query } from '../../src/core/query.js';
import type { AssistantMessage, Message, StreamEvent } from '../../src/core/types.js';
import type { HookEvent, HookEventName, HookResult, HookRunner } from '../../src/hooks/types.js';
import type { LLMProvider, ProviderRequest } from '../../src/providers/types.js';
import { buildTool } from '../../src/tool/buildTool.js';
import type { Tool, ToolContext } from '../../src/tool/types.js';

function fakeHookRunner(scripted: Partial<Record<HookEventName, HookResult[]>> = {}): {
  runner: HookRunner;
  calls: { event: HookEventName; payload: HookEvent }[];
} {
  const calls: { event: HookEventName; payload: HookEvent }[] = [];
  const queues: Partial<Record<HookEventName, HookResult[]>> = {};
  for (const [k, v] of Object.entries(scripted)) {
    queues[k as HookEventName] = [...(v ?? [])];
  }
  const runner: HookRunner = async (event, payload) => {
    calls.push({ event, payload: payload as HookEvent });
    const next = queues[event]?.shift();
    return next ?? { block: false };
  };
  return { runner, calls };
}

function scriptedTurns(turns: StreamEvent[][]): LLMProvider {
  const queue = [...turns];
  return {
    name: 'fake',
    async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      const events = queue.shift();
      if (!events) throw new Error('no more turns');
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
  content: [{ type: 'text', text: 'done' }],
};
const completedEvents: StreamEvent[] = [
  { type: 'message_start' },
  { type: 'text_delta', text: 'done' },
  { type: 'message_stop', stop_reason: 'end_turn' },
  { type: 'assistant_message', message: completedAnswer },
];

const echoUseAnswer: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 't1', name: 'Echo', input: { text: 'hi' } }],
};

const echoUseTurn: StreamEvent[] = [
  { type: 'message_start' },
  { type: 'tool_use_delta', id: 't1', partial: '{"text":"hi"}' },
  { type: 'message_stop', stop_reason: 'tool_use' },
  { type: 'assistant_message', message: echoUseAnswer },
];

function makeEchoTool(observe: (input: unknown) => void): Tool<unknown, unknown> {
  return buildTool({
    name: 'Echo',
    description: () => 'echoes input.text',
    inputSchema: z.object({ text: z.string() }),
    async call(input) {
      observe(input);
      return { data: { echoed: (input as { text: string }).text } };
    },
  }) as unknown as Tool<unknown, unknown>;
}

const toolCtx: ToolContext = {
  cwd: '/test/cwd',
  sessionId: 'sess-1',
};

async function drain(
  gen: AsyncGenerator<StreamEvent | Message, { reason: string }>,
): Promise<{ reason: string }> {
  for (;;) {
    const step = await gen.next();
    if (step.done) return step.value;
  }
}

describe('hook wiring', () => {
  test('UserPromptSubmit fires before turn 0; Stop fires on completed', async () => {
    const { runner, calls } = fakeHookRunner();
    const provider = scriptedTurns([completedEvents]);
    const gen = query({
      provider,
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      systemPrompt: [],
      maxTokens: 256,
      hookRunner: runner,
      sessionId: 'sess-1',
      cwd: '/test/cwd',
    });
    const term = await drain(gen);
    expect(term.reason).toBe('completed');

    const order = calls.map((c) => c.event);
    expect(order).toEqual(['UserPromptSubmit', 'Stop']);

    const ups = calls[0]?.payload;
    if (ups?.hookEventName !== 'UserPromptSubmit') throw new Error('expected UserPromptSubmit');
    expect(ups.session_id).toBe('sess-1');
    expect(ups.cwd).toBe('/test/cwd');
    expect(ups.prompt).toBe('hello');

    const stop = calls[1]?.payload;
    if (stop?.hookEventName !== 'Stop') throw new Error('expected Stop');
    expect(stop.reason).toBe('completed');
  });

  test('PreToolUse fires before tool.call; PostToolUse fires after; tool sees the original input', async () => {
    const { runner, calls } = fakeHookRunner();
    let toolSawInput: unknown;
    const tool = makeEchoTool((i) => {
      toolSawInput = i;
    });
    const provider = scriptedTurns([echoUseTurn, completedEvents]);
    const gen = query({
      provider,
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      systemPrompt: [],
      maxTokens: 256,
      tools: [tool],
      toolContext: toolCtx,
      hookRunner: runner,
    });
    const term = await drain(gen);
    expect(term.reason).toBe('completed');

    const order = calls.map((c) => c.event);
    expect(order).toEqual(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);

    const pre = calls[1]?.payload;
    if (pre?.hookEventName !== 'PreToolUse') throw new Error('expected PreToolUse');
    expect(pre.tool_name).toBe('Echo');
    expect(pre.tool_input).toEqual({ text: 'hi' });

    expect(toolSawInput).toEqual({ text: 'hi' });

    const post = calls[2]?.payload;
    if (post?.hookEventName !== 'PostToolUse') throw new Error('expected PostToolUse');
    expect(post.tool_name).toBe('Echo');
    expect(post.tool_output).toEqual({ echoed: 'hi' });
    expect(post.is_error).toBe(false);
  });

  test('PreToolUse updatedInput is re-validated and passed to tool.call', async () => {
    const { runner } = fakeHookRunner({
      PreToolUse: [{ block: false, updatedInput: { text: 'rewritten' } }],
    });
    let toolSawInput: { text: string } | undefined;
    const tool = makeEchoTool((i) => {
      toolSawInput = i as { text: string };
    });
    const provider = scriptedTurns([echoUseTurn, completedEvents]);
    const gen = query({
      provider,
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      systemPrompt: [],
      maxTokens: 256,
      tools: [tool],
      toolContext: toolCtx,
      hookRunner: runner,
    });
    await drain(gen);
    expect(toolSawInput).toEqual({ text: 'rewritten' });
  });

  test('PreToolUse updatedInput failing schema produces is_error tool_result', async () => {
    const { runner } = fakeHookRunner({
      PreToolUse: [{ block: false, updatedInput: { text: 42 } }], // text is z.string()
    });
    let toolCalled = false;
    const tool = makeEchoTool(() => {
      toolCalled = true;
    });
    const provider = scriptedTurns([echoUseTurn, completedEvents]);
    const gen = query({
      provider,
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      systemPrompt: [],
      maxTokens: 256,
      tools: [tool],
      toolContext: toolCtx,
      hookRunner: runner,
    });
    const yielded: (StreamEvent | Message)[] = [];
    for (;;) {
      const step = await gen.next();
      if (step.done) break;
      yielded.push(step.value);
    }
    expect(toolCalled).toBe(false);
    const userMsg = yielded.find(
      (m): m is Message => typeof m === 'object' && 'role' in m && m.role === 'user',
    );
    const block = userMsg?.content[0];
    if (block?.type !== 'tool_result') throw new Error('expected tool_result');
    expect(block.is_error).toBe(true);
    expect(block.content).toContain('hook-updated input validation failed');
  });

  test('PreToolUse block produces is_error tool_result with the hook reason', async () => {
    const { runner } = fakeHookRunner({
      PreToolUse: [{ block: true, reason: 'audit policy: no echoing' }],
    });
    const tool = makeEchoTool(() => {});
    const provider = scriptedTurns([echoUseTurn, completedEvents]);
    const gen = query({
      provider,
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      systemPrompt: [],
      maxTokens: 256,
      tools: [tool],
      toolContext: toolCtx,
      hookRunner: runner,
    });
    const yielded: (StreamEvent | Message)[] = [];
    for (;;) {
      const step = await gen.next();
      if (step.done) break;
      yielded.push(step.value);
    }
    const userMsg = yielded.find(
      (m): m is Message => typeof m === 'object' && 'role' in m && m.role === 'user',
    );
    const block = userMsg?.content[0];
    if (block?.type !== 'tool_result') throw new Error('expected tool_result');
    expect(block.is_error).toBe(true);
    expect(block.content).toContain('audit policy: no echoing');
  });

  test('PostToolUse additionalContext is appended to tool_result content', async () => {
    const { runner } = fakeHookRunner({
      PostToolUse: [{ block: false, additionalContext: 'audited at 12:34' }],
    });
    const tool = makeEchoTool(() => {});
    const provider = scriptedTurns([echoUseTurn, completedEvents]);
    const gen = query({
      provider,
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      systemPrompt: [],
      maxTokens: 256,
      tools: [tool],
      toolContext: toolCtx,
      hookRunner: runner,
    });
    const yielded: (StreamEvent | Message)[] = [];
    for (;;) {
      const step = await gen.next();
      if (step.done) break;
      yielded.push(step.value);
    }
    const userMsg = yielded.find(
      (m): m is Message => typeof m === 'object' && 'role' in m && m.role === 'user',
    );
    const block = userMsg?.content[0];
    if (block?.type !== 'tool_result') throw new Error('expected tool_result');
    expect(block.content).toContain('audited at 12:34');
  });

  test('UserPromptSubmit rewrittenPrompt rewrites the latest user message text', async () => {
    const { runner } = fakeHookRunner({
      UserPromptSubmit: [{ block: false, rewrittenPrompt: 'redacted' }],
    });
    const seenRequests: ProviderRequest[] = [];
    const provider: LLMProvider = {
      name: 'capture',
      async *stream(req) {
        seenRequests.push(req);
        for (const ev of completedEvents) yield ev;
        return completedAnswer;
      },
    };
    const gen = query({
      provider,
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'API_KEY=secret' }] }],
      systemPrompt: [],
      maxTokens: 256,
      hookRunner: runner,
      sessionId: 's',
      cwd: '/c',
    });
    await drain(gen);
    const sentMessages = seenRequests[0]?.messages ?? [];
    const sentText = sentMessages[0]?.content[0];
    if (sentText?.type !== 'text') throw new Error('expected text block');
    expect(sentText.text).toBe('redacted');
  });

  test('UserPromptSubmit block returns error terminal and still fires Stop', async () => {
    const { runner, calls } = fakeHookRunner({
      UserPromptSubmit: [{ block: true, reason: 'forbidden prompt' }],
    });
    let providerCalled = false;
    const provider: LLMProvider = {
      name: 'capture',
      async *stream() {
        providerCalled = true;
        for (const ev of completedEvents) yield ev;
        return completedAnswer;
      },
    };
    const gen = query({
      provider,
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'evil' }] }],
      systemPrompt: [],
      maxTokens: 256,
      hookRunner: runner,
      sessionId: 's',
      cwd: '/c',
    });
    const term = await drain(gen);
    expect(term.reason).toBe('error');
    expect(providerCalled).toBe(false);
    expect(calls.map((c) => c.event)).toEqual(['UserPromptSubmit', 'Stop']);
  });
});

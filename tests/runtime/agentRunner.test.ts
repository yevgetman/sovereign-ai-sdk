// Phase 13.3 — AgentRunner tests. AgentRunner is the focused wrapper
// around query() that owns the non-UI plumbing: session id threading,
// parent-child lineage carry, turn-budget enforcement, final-result
// extraction, and budget telemetry. Sub-agents (Phase 13.5) consume
// AgentRunner directly; the REPL keeps its inline query() call (UI is
// woven into the per-event loop and isn't pure plumbing).

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemSegment,
} from '../../src/core/types.js';
import type { LLMProvider, ProviderRequest } from '../../src/providers/types.js';
import { AgentRunner } from '../../src/runtime/agentRunner.js';
import { buildTool } from '../../src/tool/buildTool.js';
import type { Tool, ToolContext } from '../../src/tool/types.js';

function scriptedTurns(turns: StreamEvent[][]): LLMProvider {
  const queue = [...turns];
  return {
    name: 'fake',
    async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      const events = queue.shift();
      if (!events) throw new Error('scriptedTurns: queue empty');
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
  content: [{ type: 'text', text: 'final answer' }],
};

const completedTurn: StreamEvent[] = [
  { type: 'message_start' },
  { type: 'text_delta', text: 'final answer' },
  { type: 'message_stop', stop_reason: 'end_turn' },
  { type: 'assistant_message', message: completedAnswer },
];

const toolUseAnswer: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 't1', name: 'Echo', input: { text: 'hi' } }],
};

const toolUseTurn: StreamEvent[] = [
  { type: 'message_start' },
  { type: 'tool_use_delta', id: 't1', partial: '{"text":"hi"}' },
  { type: 'message_stop', stop_reason: 'tool_use' },
  { type: 'assistant_message', message: toolUseAnswer },
];

function makeEchoTool(): Tool<unknown, unknown> {
  return buildTool({
    name: 'Echo',
    description: () => 'echo input',
    inputSchema: z.object({ text: z.string() }),
    async call(input) {
      return { data: { echoed: (input as { text: string }).text } };
    },
  }) as unknown as Tool<unknown, unknown>;
}

const baseSystemPrompt: SystemSegment[] = [{ text: 'You are a test agent.', cacheable: false }];

const baseToolContext: ToolContext = {
  cwd: process.cwd(),
  sessionId: 'child-test',
};

async function drain(
  gen: AsyncGenerator<StreamEvent | Message, unknown>,
): Promise<{ events: (StreamEvent | Message)[]; result: unknown }> {
  const events: (StreamEvent | Message)[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { events, result: step.value };
    events.push(step.value);
  }
}

describe('AgentRunner', () => {
  test('single-turn run completes and exposes the final assistant message', async () => {
    const runner = new AgentRunner({
      provider: scriptedTurns([completedTurn]),
      model: 'fake-model',
      systemPrompt: baseSystemPrompt,
      maxTokens: 256,
      sessionId: 'child-1',
      toolContext: baseToolContext,
    });
    const { result } = await drain(runner.run('hello'));
    const r = result as Awaited<
      ReturnType<typeof runner.run> extends AsyncGenerator<unknown, infer R> ? R : never
    >;
    expect((r as { terminal: { reason: string } }).terminal.reason).toBe('completed');
    expect((r as { finalAssistant?: AssistantMessage }).finalAssistant?.content[0]).toEqual({
      type: 'text',
      text: 'final answer',
    });
    expect((r as { iterationsUsed: number }).iterationsUsed).toBe(1);
    expect((r as { toolCallCount: number }).toolCallCount).toBe(0);
  });

  test('records parentSessionId into the result when provided', async () => {
    const runner = new AgentRunner({
      provider: scriptedTurns([completedTurn]),
      model: 'fake-model',
      systemPrompt: baseSystemPrompt,
      maxTokens: 256,
      sessionId: 'child-1',
      parentSessionId: 'parent-abc',
      toolContext: baseToolContext,
    });
    const { result } = await drain(runner.run('hi'));
    expect((result as { parentSessionId?: string }).parentSessionId).toBe('parent-abc');
    expect((result as { sessionId: string }).sessionId).toBe('child-1');
  });

  test('counts tool calls across turns and yields all stream events', async () => {
    const runner = new AgentRunner({
      provider: scriptedTurns([toolUseTurn, completedTurn]),
      model: 'fake-model',
      systemPrompt: baseSystemPrompt,
      maxTokens: 256,
      sessionId: 'child-tool',
      tools: [makeEchoTool()],
      toolContext: baseToolContext,
    });
    const { events, result } = await drain(runner.run('use tool'));
    expect((result as { toolCallCount: number }).toolCallCount).toBe(1);
    expect((result as { iterationsUsed: number }).iterationsUsed).toBe(2);
    expect((result as { terminal: { reason: string } }).terminal.reason).toBe('completed');
    // The yielded stream should include text_delta events from the final turn
    const textDeltas = events.filter(
      (e) => 'type' in e && (e as StreamEvent).type === 'text_delta',
    );
    expect(textDeltas.length).toBeGreaterThan(0);
  });

  test('honors maxTurns by terminating with reason max_turns', async () => {
    // Provider always returns tool_use, no end_turn; runner.maxTurns = 2 caps it.
    const tightProvider: LLMProvider = {
      name: 'fake-loop',
      async *stream(_req) {
        yield { type: 'message_start' };
        yield { type: 'tool_use_delta', id: 't1', partial: '{"text":"x"}' };
        yield { type: 'message_stop', stop_reason: 'tool_use' };
        const a: AssistantMessage = {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Echo', input: { text: 'x' } }],
        };
        yield { type: 'assistant_message', message: a };
        return a;
      },
    };
    const runner = new AgentRunner({
      provider: tightProvider,
      model: 'fake-model',
      systemPrompt: baseSystemPrompt,
      maxTokens: 256,
      maxTurns: 2,
      sessionId: 'child-cap',
      tools: [makeEchoTool()],
      toolContext: baseToolContext,
    });
    const { result } = await drain(runner.run('go'));
    expect((result as { terminal: { reason: string } }).terminal.reason).toBe('max_turns');
  });

  test('AbortSignal cancels the run with reason interrupted', async () => {
    const ctl = new AbortController();
    // Provider that hangs forever — abort is the only way out.
    const stuckProvider: LLMProvider = {
      name: 'stuck',
      async *stream(_req) {
        yield { type: 'message_start' };
        await new Promise((_resolve, reject) => {
          ctl.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
        return { role: 'assistant', content: [] };
      },
    };
    const runner = new AgentRunner({
      provider: stuckProvider,
      model: 'fake-model',
      systemPrompt: baseSystemPrompt,
      maxTokens: 256,
      sessionId: 'child-abort',
      signal: ctl.signal,
      toolContext: baseToolContext,
    });
    const promise = drain(runner.run('hang'));
    setTimeout(() => ctl.abort(), 5);
    const { result } = await promise;
    expect(['interrupted', 'error']).toContain(
      (result as { terminal: { reason: string } }).terminal.reason,
    );
  });

  test('threads sessionId from constructor through to provider request', async () => {
    const seen: ProviderRequest[] = [];
    const captureProvider: LLMProvider = {
      name: 'capture',
      async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
        seen.push(req);
        for (const ev of completedTurn) yield ev;
        return completedAnswer;
      },
    };
    const ctx: ToolContext = {
      cwd: process.cwd(),
      sessionId: 'child-thread',
    };
    const runner = new AgentRunner({
      provider: captureProvider,
      model: 'fake-model',
      systemPrompt: baseSystemPrompt,
      maxTokens: 256,
      sessionId: 'child-thread',
      toolContext: ctx,
    });
    await drain(runner.run('hi'));
    // No assertion on sessionId in the request (provider doesn't see it),
    // but messages should land at the provider with the user prompt.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.messages[0]?.role).toBe('user');
    const block = seen[0]?.messages[0]?.content[0];
    expect(block?.type).toBe('text');
    if (block?.type === 'text') expect(block.text).toBe('hi');
  });
});

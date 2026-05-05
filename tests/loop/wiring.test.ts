// Phase 10.5 — query() integration with the loop detector. We script a
// fake provider to repeat the same tool call across many turns and assert:
// (1) loop_detected StreamEvent fires, (2) trace event records, (3) first
// detection injects a guidance message + continues, (4) second detection
// terminates with reason: error.

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { query } from '../../src/core/query.js';
import type { AssistantMessage, Message, StreamEvent, Terminal } from '../../src/core/types.js';
import type { LLMProvider, ProviderRequest } from '../../src/providers/types.js';
import { buildTool } from '../../src/tool/buildTool.js';
import type { Tool, ToolContext } from '../../src/tool/types.js';
import type { TraceEvent } from '../../src/trace/types.js';

const STUCK_TOOL_USE: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 'tu_loop', name: 'Echo', input: { text: 'same' } }],
};

const COMPLETED: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'breaking out of the loop' }],
};

function stuckProvider(opts: { breakAt?: number } = {}): LLMProvider {
  let turn = 0;
  return {
    name: 'stuck',
    async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      const broken = opts.breakAt !== undefined && turn >= opts.breakAt;
      turn++;
      if (broken) {
        yield { type: 'message_start' };
        yield { type: 'message_stop', stop_reason: 'end_turn' };
        yield { type: 'assistant_message', message: COMPLETED };
        return COMPLETED;
      }
      yield { type: 'message_start' };
      yield { type: 'message_stop', stop_reason: 'tool_use' };
      yield { type: 'assistant_message', message: STUCK_TOOL_USE };
      return STUCK_TOOL_USE;
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

const toolCtx: ToolContext = {
  cwd: process.cwd(),
  bundleRoot: process.cwd(),
  sessionId: 'loop-wire-test',
};

async function drainCollecting(
  gen: AsyncGenerator<StreamEvent | Message, Terminal>,
): Promise<{ events: (StreamEvent | Message)[]; terminal: Terminal }> {
  const events: (StreamEvent | Message)[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { events, terminal: step.value };
    events.push(step.value);
  }
}

describe('query() ⊕ loop detector', () => {
  test('emits loop_detected and injects guidance after the threshold', async () => {
    const traceEvents: TraceEvent[] = [];
    // breakAt=4: model calls the same tool 4 times in a row, then stops.
    // Expected: 4th turn triggers the consecutive-identical detector and
    // injects guidance; the 5th turn stops cleanly.
    const gen = query({
      provider: stuckProvider({ breakAt: 4 }),
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      systemPrompt: [],
      tools: [makeEchoTool()],
      toolContext: toolCtx,
      canUseTool: async () => ({ behavior: 'allow' }),
      maxTokens: 256,
      maxTurns: 20,
      traceRecorder: (e) => traceEvents.push(e),
    });
    const { events, terminal } = await drainCollecting(gen);
    expect(terminal.reason).toBe('completed');
    const loopEvents = events.filter(
      (e) => 'type' in e && (e as StreamEvent).type === 'loop_detected',
    );
    expect(loopEvents).toHaveLength(1);
    expect(traceEvents.find((t) => t.type === 'loop_detected')).toBeDefined();
    // The injected guidance message must appear in the yielded stream.
    const guidanceMsg = events.find(
      (e) =>
        'role' in e &&
        e.role === 'user' &&
        e.content.some(
          (b) => b.type === 'text' && b.text.includes('looks like the same action is repeating'),
        ),
    );
    expect(guidanceMsg).toBeDefined();
  });

  test('terminates with reason: error after the second detection', async () => {
    // Model never breaks out — same tool call forever. After the first
    // detection we inject guidance, but the next turn keeps repeating, so
    // a second detection fires and the loop terminates.
    const gen = query({
      provider: stuckProvider({}),
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      systemPrompt: [],
      tools: [makeEchoTool()],
      toolContext: toolCtx,
      canUseTool: async () => ({ behavior: 'allow' }),
      maxTokens: 256,
      maxTurns: 20,
    });
    const { events, terminal } = await drainCollecting(gen);
    expect(terminal.reason).toBe('error');
    expect(terminal.error?.message).toContain('aborted by loop detector');
    const loopEvents = events.filter(
      (e) => 'type' in e && (e as StreamEvent).type === 'loop_detected',
    );
    expect(loopEvents).toHaveLength(2);
    // Second loop_detected must carry occurrence: 2.
    const second = loopEvents[1] as Extract<StreamEvent, { type: 'loop_detected' }>;
    expect(second.info.occurrence).toBe(2);
  });
});

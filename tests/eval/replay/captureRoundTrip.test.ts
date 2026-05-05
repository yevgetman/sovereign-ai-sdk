// Phase 10.5 part 2b-ii — full capture-then-replay round-trip. Drive a
// scripted "live" provider + real tool through query() with capture
// wrappers, snapshot the resulting fixture, then re-run the fixture
// through the 2b-i replay primitives and assert the second run's
// event stream matches the first byte-for-byte. This is the
// load-bearing test that proves capture and replay agree.

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { query } from '../../../src/core/query.js';
import type { AssistantMessage, Message, StreamEvent, Terminal } from '../../../src/core/types.js';
import {
  CapturingProvider,
  createCaptureSink,
  wrapToolsForCapture,
} from '../../../src/eval/replay/capture.js';
import { ReplayProvider } from '../../../src/eval/replay/provider.js';
import { wrapToolsForReplay } from '../../../src/eval/replay/toolPool.js';
import type { LLMProvider, ProviderRequest } from '../../../src/providers/types.js';
import { buildTool } from '../../../src/tool/buildTool.js';
import type { Tool, ToolContext } from '../../../src/tool/types.js';

const ctx: ToolContext = {
  cwd: '/tmp',
  bundleRoot: '/tmp',
  sessionId: 'roundtrip',
};

const TURN_0_TOOL_USE: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: '/x' } }],
};

const TURN_1_FINAL: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'the file says: hello live' }],
};

function liveProvider(): LLMProvider {
  let turn = 0;
  return {
    name: 'fake-live',
    async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      const next = turn;
      turn++;
      if (next === 0) {
        yield { type: 'message_start' };
        yield { type: 'tool_use_delta', id: 'tu_1', partial: '{"path":"/x"}' };
        yield { type: 'message_stop', stop_reason: 'tool_use' };
        yield { type: 'assistant_message', message: TURN_0_TOOL_USE };
        return TURN_0_TOOL_USE;
      }
      yield { type: 'message_start' };
      yield { type: 'text_delta', text: 'the file says: hello live' };
      yield { type: 'message_stop', stop_reason: 'end_turn' };
      yield { type: 'assistant_message', message: TURN_1_FINAL };
      return TURN_1_FINAL;
    },
  };
}

function liveReadTool(): Tool<unknown, unknown> {
  return buildTool({
    name: 'Read',
    description: () => 'read',
    inputSchema: z.object({ path: z.string() }),
    async call(input) {
      return { data: `live-content-of-${input.path}` };
    },
  }) as unknown as Tool<unknown, unknown>;
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

/** Strip the StreamEvents from a mixed events-and-messages stream so
 *  the comparison focuses on what the provider actually emits. */
function streamEventsOnly(events: (StreamEvent | Message)[]): StreamEvent[] {
  return events.filter((e): e is StreamEvent => 'type' in e && !('role' in e));
}

describe('capture → replay round-trip', () => {
  test('a live two-turn run captures correctly and replays byte-for-byte', async () => {
    // ── live capture pass ──────────────────────────────────────────
    const sink = createCaptureSink({
      sessionId: 'live-1',
      provider: 'fake-live',
      model: 'fake-model',
    });
    const captureProvider = new CapturingProvider(liveProvider(), sink);
    const captureTools = wrapToolsForCapture([liveReadTool()], sink);
    const liveGen = query({
      provider: captureProvider,
      model: 'fake-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'read /x and tell me' }] }],
      systemPrompt: [],
      tools: captureTools,
      toolContext: ctx,
      canUseTool: async () => ({ behavior: 'allow' }),
      maxTokens: 256,
    });
    const liveOutcome = await drain(liveGen);
    expect(liveOutcome.terminal.reason).toBe('completed');

    const fixture = sink.finish();
    expect(fixture.turns).toHaveLength(2);
    expect(fixture.turns[0]?.toolResults).toHaveLength(1);
    expect(fixture.turns[0]?.toolResults[0]).toMatchObject({
      toolName: 'Read',
      callIndex: 0,
      data: 'live-content-of-/x',
    });
    expect(fixture.turns[1]?.toolResults).toHaveLength(0);

    // ── replay pass ────────────────────────────────────────────────
    const replayProvider = new ReplayProvider({ fixture });
    // Use a different live tool whose body throws — replay must NOT
    // touch the underlying call.
    const sentinelTool = buildTool({
      name: 'Read',
      description: () => 'should not run',
      inputSchema: z.object({ path: z.string() }),
      async call() {
        throw new Error('replay leaked: live tool body invoked');
      },
    }) as unknown as Tool<unknown, unknown>;
    const replayTools = wrapToolsForReplay([sentinelTool], fixture);
    const replayGen = query({
      provider: replayProvider,
      model: 'fake-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'read /x and tell me' }] }],
      systemPrompt: [],
      tools: replayTools,
      toolContext: ctx,
      canUseTool: async () => ({ behavior: 'allow' }),
      maxTokens: 256,
    });
    const replayOutcome = await drain(replayGen);

    // Terminal reasons must agree.
    expect(replayOutcome.terminal.reason).toBe(liveOutcome.terminal.reason);

    // The provider StreamEvents seen by the agent loop must match
    // byte-for-byte. (User-message content blocks may differ because
    // the agent loop builds tool_result messages itself; comparing
    // StreamEvents-only avoids that noise.)
    expect(streamEventsOnly(replayOutcome.events)).toEqual(streamEventsOnly(liveOutcome.events));
  });

  test('error-path tool is captured and re-thrown faithfully on replay', async () => {
    const failingTool = buildTool({
      name: 'Boom',
      description: () => 'always throws',
      inputSchema: z.object({}),
      async call() {
        throw new Error('boom');
      },
    }) as unknown as Tool<unknown, unknown>;

    // A scripted live provider that asks to call Boom once, then ends.
    const TOOL_USE: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'Boom', input: {} }],
    };
    const FINAL: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'gave up' }],
    };
    let turn = 0;
    const provider: LLMProvider = {
      name: 'fake-live',
      async *stream(): AsyncGenerator<StreamEvent, AssistantMessage> {
        const next = turn;
        turn++;
        if (next === 0) {
          yield { type: 'message_stop', stop_reason: 'tool_use' };
          yield { type: 'assistant_message', message: TOOL_USE };
          return TOOL_USE;
        }
        yield { type: 'message_stop', stop_reason: 'end_turn' };
        yield { type: 'assistant_message', message: FINAL };
        return FINAL;
      },
    };

    const sink = createCaptureSink({ sessionId: 's', provider: 'fake-live', model: 'm' });
    const cp = new CapturingProvider(provider, sink);
    const ct = wrapToolsForCapture([failingTool], sink);
    const gen = query({
      provider: cp,
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'try Boom' }] }],
      systemPrompt: [],
      tools: ct,
      toolContext: ctx,
      canUseTool: async () => ({ behavior: 'allow' }),
      maxTokens: 256,
    });
    await drain(gen);

    const fixture = sink.finish();
    expect(fixture.turns[0]?.toolResults[0]).toMatchObject({
      toolName: 'Boom',
      callIndex: 0,
      error: 'boom',
    });

    // Replay should re-throw the captured error from the wrapper.
    const replayTools = wrapToolsForReplay(
      [
        buildTool({
          name: 'Boom',
          description: () => 'sentinel',
          inputSchema: z.object({}),
          async call() {
            throw new Error('replay leaked: live Boom invoked');
          },
        }) as unknown as Tool<unknown, unknown>,
      ],
      fixture,
    );
    const [boomReplay] = replayTools;
    await expect(boomReplay?.call({}, ctx)).rejects.toThrow('boom');
  });
});

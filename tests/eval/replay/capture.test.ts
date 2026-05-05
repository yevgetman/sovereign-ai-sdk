// Phase 10.5 part 2b-ii — capture-mode unit tests. CaptureSink behavior,
// CapturingProvider event mirroring, wrapToolsForCapture key counters
// + error-path recording.

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { AssistantMessage, StreamEvent } from '../../../src/core/types.js';
import {
  CapturingProvider,
  createCaptureSink,
  wrapToolsForCapture,
} from '../../../src/eval/replay/capture.js';
import type { LLMProvider, ProviderRequest } from '../../../src/providers/types.js';
import { buildTool } from '../../../src/tool/buildTool.js';
import type { Tool, ToolContext } from '../../../src/tool/types.js';

const COMPLETED: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'done' }],
};

function scriptedProvider(name: string, events: StreamEvent[]): LLMProvider {
  return {
    name,
    async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      let final: AssistantMessage | undefined;
      for (const event of events) {
        if (event.type === 'assistant_message') final = event.message;
        yield event;
      }
      return final ?? COMPLETED;
    },
  };
}

const ctx: ToolContext = {
  cwd: '/tmp',
  bundleRoot: '/tmp',
  sessionId: 'capture-test',
};

describe('createCaptureSink', () => {
  test('produces a fixture with empty turns when finish() is called immediately', () => {
    const sink = createCaptureSink({ sessionId: 's', provider: 'p', model: 'm' });
    const fixture = sink.finish();
    expect(fixture.meta.sessionId).toBe('s');
    expect(fixture.meta.provider).toBe('p');
    expect(fixture.meta.model).toBe('m');
    expect(fixture.turns).toEqual([]);
    expect(typeof fixture.meta.capturedAt).toBe('string');
  });

  test('finish() is idempotent — calling it twice returns the same fixture', () => {
    const sink = createCaptureSink({ sessionId: 's', provider: 'p', model: 'm' });
    sink.startTurn(0);
    sink.recordProviderEvent({ type: 'message_start' });
    const first = sink.finish();
    const second = sink.finish();
    expect(second).toBe(first);
  });

  test('rejects events recorded before any turn opened', () => {
    const sink = createCaptureSink({ sessionId: 's', provider: 'p', model: 'm' });
    expect(() => sink.recordProviderEvent({ type: 'message_start' })).toThrow(/before startTurn/);
    expect(() => sink.recordToolResult({ toolName: 'x', callIndex: 0, data: '' })).toThrow(
      /before startTurn/,
    );
  });

  test('rejects events recorded after finish()', () => {
    const sink = createCaptureSink({ sessionId: 's', provider: 'p', model: 'm' });
    sink.startTurn(0);
    sink.finish();
    expect(() => sink.recordProviderEvent({ type: 'message_start' })).toThrow(/already finished/);
    expect(() => sink.startTurn(1)).toThrow(/already finished/);
  });

  test('startTurn closes the previous turn and opens a new one', () => {
    const sink = createCaptureSink({ sessionId: 's', provider: 'p', model: 'm' });
    sink.startTurn(0);
    sink.recordProviderEvent({ type: 'text_delta', text: 'A' });
    sink.startTurn(1);
    sink.recordProviderEvent({ type: 'text_delta', text: 'B' });
    const fixture = sink.finish();
    expect(fixture.turns).toHaveLength(2);
    expect(fixture.turns[0]?.providerEvents).toHaveLength(1);
    expect(fixture.turns[1]?.providerEvents).toHaveLength(1);
  });
});

describe('CapturingProvider', () => {
  test('forwards every StreamEvent unchanged and mirrors them into the sink', async () => {
    const events: StreamEvent[] = [
      { type: 'message_start' },
      { type: 'text_delta', text: 'hi' },
      { type: 'message_stop', stop_reason: 'end_turn' },
      { type: 'assistant_message', message: COMPLETED },
    ];
    const sink = createCaptureSink({ sessionId: 's', provider: 'fake', model: 'm' });
    const provider = new CapturingProvider(scriptedProvider('fake', events), sink);
    expect(provider.name).toBe('fake');

    const yielded: StreamEvent[] = [];
    let final: AssistantMessage | undefined;
    const gen = provider.stream({ model: 'm', system: [], messages: [], maxTokens: 100 });
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        final = step.value;
        break;
      }
      yielded.push(step.value);
    }
    expect(yielded).toEqual(events);
    expect(final).toEqual(COMPLETED);

    const fixture = sink.finish();
    expect(fixture.turns).toHaveLength(1);
    expect(fixture.turns[0]?.providerEvents).toEqual(events);
  });

  test('opens one turn per stream() call', async () => {
    const sink = createCaptureSink({ sessionId: 's', provider: 'fake', model: 'm' });
    const provider = new CapturingProvider(
      scriptedProvider('fake', [
        { type: 'message_start' },
        { type: 'message_stop', stop_reason: 'end_turn' },
        { type: 'assistant_message', message: COMPLETED },
      ]),
      sink,
    );
    for (let i = 0; i < 3; i++) {
      for await (const _ of provider.stream({
        model: 'm',
        system: [],
        messages: [],
        maxTokens: 100,
      })) {
        // drain
      }
    }
    expect(provider.turnsObserved).toBe(3);
    expect(sink.finish().turns).toHaveLength(3);
  });
});

function makeReadTool(content: string): Tool<unknown, unknown> {
  return buildTool({
    name: 'Read',
    description: () => 'read',
    inputSchema: z.object({ path: z.string() }),
    async call() {
      return { data: content };
    },
  }) as unknown as Tool<unknown, unknown>;
}

function makeBoomTool(): Tool<unknown, unknown> {
  return buildTool({
    name: 'Boom',
    description: () => 'always throws',
    inputSchema: z.object({}),
    async call() {
      throw new Error('intentional failure');
    },
  }) as unknown as Tool<unknown, unknown>;
}

describe('wrapToolsForCapture', () => {
  test('records each tool result with its per-tool callIndex', async () => {
    const sink = createCaptureSink({ sessionId: 's', provider: 'fake', model: 'm' });
    sink.startTurn(0);
    const [read] = wrapToolsForCapture([makeReadTool('hello')], sink);
    await read?.call({ path: '/x' }, ctx);
    await read?.call({ path: '/y' }, ctx);
    const fixture = sink.finish();
    const results = fixture.turns[0]?.toolResults ?? [];
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ toolName: 'Read', callIndex: 0, data: 'hello' });
    expect(results[1]).toMatchObject({ toolName: 'Read', callIndex: 1, data: 'hello' });
  });

  test('per-tool counters are independent', async () => {
    const sink = createCaptureSink({ sessionId: 's', provider: 'fake', model: 'm' });
    sink.startTurn(0);
    const [read, boom] = wrapToolsForCapture([makeReadTool('x'), makeBoomTool()], sink);
    await read?.call({ path: '/a' }, ctx);
    await expect(boom?.call({}, ctx)).rejects.toThrow();
    await read?.call({ path: '/b' }, ctx);
    const fixture = sink.finish();
    const results = fixture.turns[0]?.toolResults ?? [];
    expect(results).toHaveLength(3);
    expect(results.map((r) => `${r.toolName}#${r.callIndex}`)).toEqual([
      'Read#0',
      'Boom#0',
      'Read#1',
    ]);
  });

  test('records thrown errors and re-throws them', async () => {
    const sink = createCaptureSink({ sessionId: 's', provider: 'fake', model: 'm' });
    sink.startTurn(0);
    const [boom] = wrapToolsForCapture([makeBoomTool()], sink);
    await expect(boom?.call({}, ctx)).rejects.toThrow('intentional failure');
    const fixture = sink.finish();
    const result = fixture.turns[0]?.toolResults[0];
    expect(result).toMatchObject({ toolName: 'Boom', callIndex: 0, error: 'intentional failure' });
  });
});

// Task 3.1 — createAgent() assembler tests.
//
// createAgent is the public standing-config + per-turn-override front door to
// the turn loop. These tests pin the load-bearing contracts from the brief:
//   1. Stream-passthrough: run() yields query()'s exact StreamEvent|Message
//      stream, unchanged and in order; RunResult.finalAssistant/terminal are
//      populated; with no SessionStore nothing is persisted (no-disk default).
//   2. Tool turns populate RunResult.toolCallCount / distinctToolNames.
//   3. Per-turn overrides win — a per-turn canUseTool denies a tool the
//      standing config would otherwise allow.
//   4. An injected SessionStore persists the session + messages (load-back).
//   5. An injected observe fn reaches ToolContext.learningObserver on a tool
//      call.
//
// A deterministic scripted LLMProvider (one fresh instance per call, since a
// generator is single-use) stands in for a real provider — no network, no disk.

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createAgent } from '../../src/agent/createAgent.js';
import type { ObserveInput } from '../../src/core/observePort.js';
import { query } from '../../src/core/query.js';
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemSegment,
} from '../../src/core/types.js';
import type { CanUseTool } from '../../src/permissions/types.js';
import { createInMemorySessionStore } from '../../src/persistence/inMemoryStore.js';
import type { LLMProvider, ProviderRequest } from '../../src/providers/types.js';
import { buildTool } from '../../src/tool/buildTool.js';
import type { Tool, ToolContext } from '../../src/tool/types.js';

// --- Scripted provider + drains -------------------------------------------

/** Build a fresh LLMProvider that replays one canned StreamEvent[] per
 *  successive stream() call. Each call to this factory returns a NEW provider
 *  (generators are single-use) so the same script can drive both query() and
 *  createAgent() for an apples-to-apples passthrough comparison. */
function scriptedProvider(turns: StreamEvent[][]): LLMProvider {
  const queue = [...turns];
  return {
    name: 'fake',
    async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      const events = queue.shift();
      if (!events) throw new Error('scriptedProvider: queue empty');
      let last: AssistantMessage | undefined;
      for (const ev of events) {
        if (ev.type === 'assistant_message') last = ev.message;
        yield ev;
      }
      return last ?? { role: 'assistant', content: [] };
    },
  };
}

/** Like `scriptedProvider`, but captures every `ProviderRequest` it receives so
 *  a test can assert what reached the provider (temperature, cacheEnabled). One
 *  fresh instance per call. */
function recordingProvider(turns: StreamEvent[][]): {
  provider: LLMProvider;
  requests: ProviderRequest[];
} {
  const queue = [...turns];
  const requests: ProviderRequest[] = [];
  const provider: LLMProvider = {
    name: 'recording',
    async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      requests.push(req);
      const events = queue.shift();
      if (!events) throw new Error('recordingProvider: queue empty');
      let last: AssistantMessage | undefined;
      for (const ev of events) {
        if (ev.type === 'assistant_message') last = ev.message;
        yield ev;
      }
      return last ?? { role: 'assistant', content: [] };
    },
  };
  return { provider, requests };
}

const completedAnswer: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'final answer' }],
};

const completedTurn: StreamEvent[] = [
  { type: 'message_start' },
  { type: 'text_delta', text: 'final answer' },
  { type: 'usage_delta', usage: { inputTokens: 11, outputTokens: 7 } },
  { type: 'message_stop', stop_reason: 'end_turn' },
  { type: 'assistant_message', message: completedAnswer },
];

const echoToolUse: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 't1', name: 'Echo', input: { text: 'hi' } }],
};

const echoToolUseTurn: StreamEvent[] = [
  { type: 'message_start' },
  { type: 'tool_use_delta', id: 't1', partial: '{"text":"hi"}' },
  { type: 'message_stop', stop_reason: 'tool_use' },
  { type: 'assistant_message', message: echoToolUse },
];

const baseSystemPrompt: SystemSegment[] = [{ text: 'You are a test agent.', cacheable: false }];

function makeEchoTool(onCall?: () => void): Tool<unknown, unknown> {
  return buildTool({
    name: 'Echo',
    description: () => 'echo input',
    inputSchema: z.object({ text: z.string() }),
    async call(input) {
      onCall?.();
      return { data: { echoed: (input as { text: string }).text } };
    },
  }) as unknown as Tool<unknown, unknown>;
}

async function drain(
  gen: AsyncGenerator<StreamEvent | Message, RunResultLike>,
): Promise<{ events: (StreamEvent | Message)[]; result: RunResultLike }> {
  const events: (StreamEvent | Message)[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { events, result: step.value };
    events.push(step.value);
  }
}

async function drainEvents(
  gen: AsyncGenerator<StreamEvent | Message, unknown>,
): Promise<(StreamEvent | Message)[]> {
  const events: (StreamEvent | Message)[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return events;
    events.push(step.value);
  }
}

type RunResultLike = ReturnType<typeof createAgent>['run'] extends (
  ...args: never[]
) => AsyncGenerator<unknown, infer R>
  ? R
  : never;

// --- Tests -----------------------------------------------------------------

describe('createAgent', () => {
  test('run() yields query()s exact stream unchanged + in order (passthrough invariant)', async () => {
    // Drain query() directly for the canonical sequence...
    const queryEvents = await drainEvents(
      query({
        provider: scriptedProvider([completedTurn]),
        model: 'fake-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        systemPrompt: baseSystemPrompt,
        maxTokens: 256,
      }),
    );

    // ...then drain createAgent over the identical script + inputs.
    const agent = createAgent({
      provider: scriptedProvider([completedTurn]),
      model: 'fake-model',
      systemPrompt: baseSystemPrompt,
      maxTokens: 256,
    });
    const { events: agentEvents, result } = await drain(agent.run('hello'));

    // The stream-passthrough invariant: byte-for-byte the same events, in order.
    expect(agentEvents).toEqual(queryEvents);
    // ...and the structured result is populated.
    expect(result.terminal.reason).toBe('completed');
    expect(result.finalAssistant).toEqual(completedAnswer);
    expect(result.iterationsUsed).toBe(1);
    expect(result.toolCallCount).toBe(0);
    expect(result.messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    });
    // A fresh sessionId was minted.
    expect(typeof result.sessionId).toBe('string');
    expect(result.sessionId.length).toBeGreaterThan(0);
  });

  test('no SessionStore + no transcripts → runs clean with nothing persisted (no-disk default)', async () => {
    // No store/transcripts supplied: the run must complete without touching any
    // persistence and without throwing — the embeddable default.
    const agent = createAgent({
      provider: scriptedProvider([completedTurn]),
      model: 'fake-model',
      maxTokens: 256,
    });
    const { result } = await drain(agent.run('hello'));
    expect(result.terminal.reason).toBe('completed');
    expect(result.finalAssistant).toEqual(completedAnswer);
  });

  test('a Message[] input is used verbatim and never mutated', async () => {
    const input: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'prior' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'text', text: 'now' }] },
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    const agent = createAgent({
      provider: scriptedProvider([completedTurn]),
      model: 'fake-model',
      maxTokens: 256,
    });
    const { result } = await drain(agent.run(input));
    expect(result.terminal.reason).toBe('completed');
    // Seed history preserved at the head of the result messages.
    expect(result.messages.slice(0, 3)).toEqual(input);
    // The caller's array + elements are untouched.
    expect(input).toEqual(snapshot);
  });

  test('a tool turn populates toolCallCount + distinctToolNames', async () => {
    let called = false;
    const agent = createAgent({
      provider: scriptedProvider([echoToolUseTurn, completedTurn]),
      model: 'fake-model',
      systemPrompt: baseSystemPrompt,
      tools: [
        makeEchoTool(() => {
          called = true;
        }),
      ],
      maxTokens: 256,
    });
    const { events, result } = await drain(agent.run('use the tool'));

    expect(called).toBe(true);
    expect(result.terminal.reason).toBe('completed');
    expect(result.toolCallCount).toBe(1);
    expect(result.distinctToolNames).toEqual(['Echo']);
    // The tool_result user message flowed through the stream (passthrough).
    const toolResultMsg = events.find(
      (e): e is Message =>
        'role' in e && e.role === 'user' && e.content.some((b) => b.type === 'tool_result'),
    );
    expect(toolResultMsg).toBeDefined();
  });

  test('a per-turn canUseTool denies a tool the standing config would allow', async () => {
    let called = false;
    const denyAll: CanUseTool = async () => ({ behavior: 'deny', reason: 'blocked by test' });

    const agent = createAgent({
      provider: scriptedProvider([echoToolUseTurn, completedTurn]),
      model: 'fake-model',
      tools: [
        makeEchoTool(() => {
          called = true;
        }),
      ],
      // No standing canUseTool → the tool would otherwise run.
      maxTokens: 256,
    });
    const { result } = await drain(agent.run('use the tool', { canUseTool: denyAll }));

    // The per-turn deny short-circuits execution: the tool never ran...
    expect(called).toBe(false);
    // ...yet the model still REQUESTED it (counted), and the run completed via
    // the denial tool_result continuation.
    expect(result.toolCallCount).toBe(1);
    expect(result.terminal.reason).toBe('completed');
    const denialResult = result.messages.find(
      (m) =>
        m.role === 'user' && m.content.some((b) => b.type === 'tool_result' && b.is_error === true),
    );
    expect(denialResult).toBeDefined();
  });

  test('an injected SessionStore persists the session + messages (load-back)', async () => {
    const store = createInMemorySessionStore();
    const sessionId = 'sess-3-1';
    const agent = createAgent({
      provider: scriptedProvider([completedTurn]),
      model: 'fake-model',
      systemPrompt: baseSystemPrompt,
      sessionStore: store,
      maxTokens: 256,
    });
    const { result } = await drain(agent.run('hello', { sessionId }));

    expect(result.sessionId).toBe(sessionId);

    // The session row was created/upserted with the run's provider + model.
    const session = store.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session?.model).toBe('fake-model');
    expect(session?.provider).toBe('fake');

    // Both the seed user message and the assistant reply were persisted in order.
    const persisted = store.loadMessages(sessionId);
    expect(persisted.length).toBe(2);
    expect(persisted[0]?.role).toBe('user');
    expect(persisted[0]?.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(persisted[1]?.role).toBe('assistant');
    expect(persisted[1]?.content).toEqual([{ type: 'text', text: 'final answer' }]);

    // recordTokenUsage accumulated the streamed usage_delta + a cost figure.
    expect(session?.inputTokens).toBe(11);
    expect(session?.outputTokens).toBe(7);
  });

  test('an injected observe fn reaches ToolContext.learningObserver on a tool call', async () => {
    const observed: ObserveInput[] = [];
    const agent = createAgent({
      provider: scriptedProvider([echoToolUseTurn, completedTurn]),
      model: 'fake-model',
      tools: [makeEchoTool()],
      observe: (i) => observed.push(i),
      maxTokens: 256,
    });
    await drain(agent.run('use the tool'));

    // The orchestrator fired the adapter after the Echo dispatch.
    expect(observed.length).toBeGreaterThanOrEqual(1);
    const echoObs = observed.find((o) => o.toolName === 'Echo');
    expect(echoObs).toBeDefined();
    expect(echoObs?.status).toBe('success');
  });

  test('a per-turn override beats standing config (model + systemPrompt + provider)', async () => {
    // Standing provider would throw if used; the per-turn provider must win.
    const standingProvider: LLMProvider = {
      name: 'standing',
      // biome-ignore lint/correctness/useYield: unconditional throw — must never run.
      async *stream(): AsyncGenerator<StreamEvent, AssistantMessage> {
        throw new Error('standing provider should not be used when perTurn.provider is set');
      },
    };
    let seenSystem: SystemSegment[] | undefined;
    let seenModel: string | undefined;
    const perTurnProvider: LLMProvider = {
      name: 'perturn',
      async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
        seenSystem = req.system;
        seenModel = req.model;
        for (const ev of completedTurn) yield ev;
        return completedAnswer;
      },
    };

    const agent = createAgent({
      provider: standingProvider,
      model: 'standing-model',
      systemPrompt: 'standing system',
      maxTokens: 256,
    });
    const { result } = await drain(
      agent.run('hello', {
        provider: perTurnProvider,
        model: 'perturn-model',
        systemPrompt: [{ text: 'perturn system', cacheable: false }],
      }),
    );

    expect(result.terminal.reason).toBe('completed');
    expect(seenModel).toBe('perturn-model');
    expect(seenSystem).toEqual([{ text: 'perturn system', cacheable: false }]);
  });

  test('a string systemPrompt is wrapped into a single non-cacheable segment', async () => {
    let seenSystem: SystemSegment[] | undefined;
    const provider: LLMProvider = {
      name: 'fake',
      async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
        seenSystem = req.system;
        for (const ev of completedTurn) yield ev;
        return completedAnswer;
      },
    };
    const agent = createAgent({
      provider,
      model: 'fake-model',
      systemPrompt: 'be terse',
      maxTokens: 256,
    });
    await drain(agent.run('hi'));
    expect(seenSystem).toEqual([{ text: 'be terse', cacheable: false }]);
  });

  test('a host-supplied perTurn.toolContext is used verbatim', async () => {
    const calls: string[] = [];
    const customContext: ToolContext = {
      cwd: '/custom/cwd',
      sessionId: 'ctx-supplied',
      learningObserver: { observe: (i) => calls.push(i.toolName) },
    };
    const agent = createAgent({
      provider: scriptedProvider([echoToolUseTurn, completedTurn]),
      model: 'fake-model',
      tools: [makeEchoTool()],
      maxTokens: 256,
    });
    const { result } = await drain(agent.run('go', { toolContext: customContext }));
    expect(result.terminal.reason).toBe('completed');
    // The host context's learningObserver (not a built one) received the call.
    expect(calls).toContain('Echo');
  });
});

// Task 4.4a — the three remaining per-turn QueryParams fields exposed on
// createAgent. createAgent threads each via the same conditional spread as
// microcompactConfig, so an absent value leaves query()'s default behavior
// byte-identical. Observed at the provider-request boundary (temperature +
// cacheEnabled, which query() forwards) and via terminal.reason (checkin).
describe('createAgent — per-turn QueryParams completeness (temperature/cacheEnabled/maxToolCallsBeforeCheckin)', () => {
  test('temperature: standing config reaches the provider request', async () => {
    const { provider, requests } = recordingProvider([completedTurn]);
    const agent = createAgent({ provider, model: 'fake-model', temperature: 0.2, maxTokens: 256 });
    const { result } = await drain(agent.run('hello'));
    expect(result.terminal.reason).toBe('completed');
    expect(requests[0]?.temperature).toBe(0.2);
  });

  test('temperature: a per-turn override beats standing config', async () => {
    const { provider, requests } = recordingProvider([completedTurn]);
    const agent = createAgent({ provider, model: 'fake-model', temperature: 0.2, maxTokens: 256 });
    await drain(agent.run('hello', { temperature: 0.9 }));
    expect(requests[0]?.temperature).toBe(0.9);
  });

  test('cacheEnabled: false reaches the turn; omitting it preserves the true default', async () => {
    // Explicit false threads through to the provider request.
    const off = recordingProvider([completedTurn]);
    const offAgent = createAgent({
      provider: off.provider,
      model: 'fake-model',
      cacheEnabled: false,
      maxTokens: 256,
    });
    await drain(offAgent.run('hello'));
    expect(off.requests[0]?.cacheEnabled).toBe(false);

    // Omitted → createAgent passes no cacheEnabled key, so query()'s default
    // (true) reaches the provider unchanged.
    const on = recordingProvider([completedTurn]);
    const onAgent = createAgent({ provider: on.provider, model: 'fake-model', maxTokens: 256 });
    await drain(onAgent.run('hello'));
    expect(on.requests[0]?.cacheEnabled).toBe(true);
  });

  test('cacheEnabled: a per-turn false overrides a standing true', async () => {
    const { provider, requests } = recordingProvider([completedTurn]);
    const agent = createAgent({
      provider,
      model: 'fake-model',
      cacheEnabled: true,
      maxTokens: 256,
    });
    await drain(agent.run('hello', { cacheEnabled: false }));
    expect(requests[0]?.cacheEnabled).toBe(false);
  });

  test('maxToolCallsBeforeCheckin: N pauses the turn loop with terminal reason checkin', async () => {
    const { provider } = recordingProvider([echoToolUseTurn]);
    const agent = createAgent({
      provider,
      model: 'fake-model',
      tools: [makeEchoTool()],
      maxToolCallsBeforeCheckin: 1,
      maxTokens: 256,
    });
    const { result } = await drain(agent.run('use the tool'));
    expect(result.terminal.reason).toBe('checkin');
    expect(result.terminal.toolCallCount).toBe(1);
  });

  test('maxToolCallsBeforeCheckin: a per-turn override pauses where standing config would not', async () => {
    const { provider } = recordingProvider([echoToolUseTurn]);
    const agent = createAgent({
      provider,
      model: 'fake-model',
      tools: [makeEchoTool()],
      maxTokens: 256,
    });
    const { result } = await drain(agent.run('use the tool', { maxToolCallsBeforeCheckin: 1 }));
    expect(result.terminal.reason).toBe('checkin');
  });

  test('regression guard: with none of the three set, query()s behavior is byte-identical (no temperature key, default cache, no check-in)', async () => {
    const { provider, requests } = recordingProvider([echoToolUseTurn, completedTurn]);
    const agent = createAgent({
      provider,
      model: 'fake-model',
      tools: [makeEchoTool()],
      maxTokens: 256,
    });
    const { result } = await drain(agent.run('use the tool'));

    const req = requests[0];
    expect(req).toBeDefined();
    // temperature is forwarded conditionally by query(), so an absent value yields
    // NO temperature key in the provider request — a 1:1 proof that createAgent
    // injected no temperature into QueryParams.
    expect(req && 'temperature' in req).toBe(false);
    // cacheEnabled untouched → query()'s default (true) reaches the provider.
    expect(req?.cacheEnabled).toBe(true);
    // maxToolCallsBeforeCheckin absent → a tool-call turn does NOT check in.
    expect(result.terminal.reason).toBe('completed');
  });
});

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
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent } from '@yevgetman/sov-sdk/agent/createAgent';
import type { ObserveInput } from '@yevgetman/sov-sdk/core/observePort';
import { query } from '@yevgetman/sov-sdk/core/query';
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemSegment,
  TokenUsage,
} from '@yevgetman/sov-sdk/core/types';
import type { MemoryRuntime } from '@yevgetman/sov-sdk/memory/provider';
import type { CanUseTool } from '@yevgetman/sov-sdk/permissions/types';
import { createInMemorySessionStore } from '@yevgetman/sov-sdk/persistence/inMemoryStore';
import type { SessionStore } from '@yevgetman/sov-sdk/persistence/sessionStore';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import type { Tool, ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { z } from 'zod';

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

/** A provider whose `stream()` runs a `finally` when its generator is finalized
 *  — on normal completion OR on an early `.return()`. Lets a test prove that
 *  abandoning run()'s stream (a `break` with NO abort) propagates teardown into
 *  query()/provider.stream and closes the upstream socket promptly (F7). One
 *  fresh instance per call (generators are single-use). */
function finalizerProvider(turns: StreamEvent[][], onFinalize: () => void): LLMProvider {
  const queue = [...turns];
  return {
    name: 'finalizer',
    async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      try {
        const events = queue.shift();
        if (!events) throw new Error('finalizerProvider: queue empty');
        let last: AssistantMessage | undefined;
        for (const ev of events) {
          if (ev.type === 'assistant_message') last = ev.message;
          yield ev;
        }
        return last ?? { role: 'assistant', content: [] };
      } finally {
        onFinalize();
      }
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
  { type: 'usage_delta', usage: { inputTokens: 11, outputTokens: 7 } },
  { type: 'message_stop', stop_reason: 'end_turn' },
  { type: 'assistant_message', message: completedAnswer },
];

const secondAnswer: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'second answer' }],
};

/** A second completed turn (distinct reply text) so a two-run test can tell
 *  run 1's assistant output apart from run 2's. */
const secondCompletedTurn: StreamEvent[] = [
  { type: 'message_start' },
  { type: 'text_delta', text: 'second answer' },
  { type: 'usage_delta', usage: { inputTokens: 21, outputTokens: 9 } },
  { type: 'message_stop', stop_reason: 'end_turn' },
  { type: 'assistant_message', message: secondAnswer },
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

  test('a stable-sessionId rehydration run persists only the new tail (no duplicate rows)', async () => {
    // Task 4.1 — the persistTurn dedup contract. The canonical multi-turn
    // embedder: run 1 seeds a fresh session; run 2 rehydrates the SAME store's
    // history verbatim, appends a new user message, and runs under the SAME
    // sessionId. The store must end up with the exact conversation — the
    // rehydrated prefix must NOT be re-saved as duplicate rows.
    const store = createInMemorySessionStore();
    const sessionId = 'sess-4-1-rehydrate';
    const agent = createAgent({
      provider: scriptedProvider([completedTurn, secondCompletedTurn]),
      model: 'fake-model',
      sessionStore: store,
      maxTokens: 256,
    });

    // Run 1 — fresh session: seed user message + assistant reply persisted.
    await drain(agent.run('hello', { sessionId }));
    expect(store.loadMessages(sessionId).length).toBe(2);

    // Run 2 — rehydrate history FROM the store, append a new user message.
    const rehydrated: Message[] = store
      .loadMessages(sessionId)
      .map((m) =>
        m.role === 'user'
          ? { role: 'user', content: m.content }
          : { role: 'assistant', content: m.content },
      );
    const input: Message[] = [
      ...rehydrated,
      { role: 'user', content: [{ type: 'text', text: 'and now?' }] },
    ];
    await drain(agent.run(input, { sessionId }));

    // The store holds the EXACT conversation sequence — no duplicate rows.
    const persisted = store.loadMessages(sessionId).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    expect(persisted).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'and now?' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] },
    ]);
  });

  test('a fresh (non-rehydrated) seed on an existing session appends without loss', async () => {
    // Session reuse WITHOUT rehydration: run 2 passes a brand-new string input
    // under the same sessionId. The seed is not the stored history, so nothing
    // is treated as already-persisted — both new messages append (and nothing
    // duplicates, since nothing was re-sent).
    const store = createInMemorySessionStore();
    const sessionId = 'sess-4-1-append';
    const agent = createAgent({
      provider: scriptedProvider([completedTurn, secondCompletedTurn]),
      model: 'fake-model',
      sessionStore: store,
      maxTokens: 256,
    });

    await drain(agent.run('hello', { sessionId }));
    await drain(agent.run('more please', { sessionId }));

    const persisted = store.loadMessages(sessionId).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    expect(persisted).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'more please' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] },
    ]);
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

// F27 (audit 2026-07-01) — a caller-supplied sessionId is untrusted (it flows
// verbatim into skill-prompt env substitution + is a persistence/path key). It
// must be validated against a safe charset at the createAgent boundary. The
// charset mirrors the transcript/trace filename sanitizers (which preserve the
// `:` channel-key delimiter), so UUIDs and `agent:main:...` channel ids pass
// unchanged while shell-sigil / traversal characters are rejected.
describe('createAgent — sessionId boundary validation (F27)', () => {
  test('rejects a caller-supplied sessionId carrying an inline-shell sigil', async () => {
    const agent = createAgent({
      provider: scriptedProvider([completedTurn]),
      model: 'fake-model',
      maxTokens: 256,
    });
    await expect(drain(agent.run('hi', { sessionId: '`!touch /tmp/pwn`' }))).rejects.toThrow(
      /sessionId/,
    );
  });

  test('rejects a caller-supplied sessionId with a path separator', async () => {
    const agent = createAgent({
      provider: scriptedProvider([completedTurn]),
      model: 'fake-model',
      maxTokens: 256,
    });
    await expect(drain(agent.run('hi', { sessionId: '../../etc/passwd' }))).rejects.toThrow(
      /sessionId/,
    );
  });

  test('accepts a UUID sessionId unchanged (the randomUUID default shape)', async () => {
    const uuid = 'd2bb51f0-624d-494e-aa4c-f84b52ffb754';
    const agent = createAgent({
      provider: scriptedProvider([completedTurn]),
      model: 'fake-model',
      maxTokens: 256,
    });
    const { result } = await drain(agent.run('hi', { sessionId: uuid }));
    expect(result.sessionId).toBe(uuid);
  });

  test('accepts a colon-delimited channel session id unchanged (regression guard)', async () => {
    // A real gateway conversation key. If validation excluded `:`, this would
    // break every Telegram/Slack channel session — the transcript/trace path
    // sanitizers preserve `:`, so the boundary must too.
    const channelId = 'agent:main:slack:dm:U1';
    const agent = createAgent({
      provider: scriptedProvider([completedTurn]),
      model: 'fake-model',
      maxTokens: 256,
    });
    const { result } = await drain(agent.run('hi', { sessionId: channelId }));
    expect(result.sessionId).toBe(channelId);
  });

  test('accepts an SMS channel key with a `+` phone number unchanged (regression guard)', async () => {
    // buildSessionKey embeds an externally-controlled chatId; an SMS chatId is a
    // phone number carrying a leading `+` (`agent:main:sms:private:+15551234567`).
    // A positive `[A-Za-z0-9._:-]` allowlist would wrongly reject this and break
    // every phone/email-backed channel — the denylist must permit `+`/`@`.
    const smsKey = 'agent:main:sms:private:+15551234567';
    const agent = createAgent({
      provider: scriptedProvider([completedTurn]),
      model: 'fake-model',
      maxTokens: 256,
    });
    const { result } = await drain(agent.run('hi', { sessionId: smsKey }));
    expect(result.sessionId).toBe(smsKey);
  });

  test('mints a fresh UUID when no sessionId is supplied (default untouched)', async () => {
    const agent = createAgent({
      provider: scriptedProvider([completedTurn]),
      model: 'fake-model',
      maxTokens: 256,
    });
    const { result } = await drain(agent.run('hi'));
    expect(result.sessionId).toMatch(/^[A-Za-z0-9._:-]+$/);
    expect(result.sessionId.length).toBeGreaterThan(0);
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

// Task 7.2 — the `rethrow` option restores the pre-7.1 error-path byte-identity.
// createAgent threads `memoryManager` to query(), which awaits its
// `prefetchSnapshot` OUTSIDE query()'s per-turn try/catch (src/core/query.ts:
// 74-76) — so a throw there ESCAPES the generator (one of the three pre-loop
// throw ops, alongside the recall thunk + the UserPromptSubmit hook). The
// DEFAULT (convert) turns that escape into a returned terminal{reason:'error'}
// (matching AgentRunner — cron/channels/sub-agents depend on it); `rethrow: true`
// lets it PROPAGATE out of run() exactly like a direct query() drive, which the
// gateway opts into so its outer catch maps the throw to `turn_error`.
describe('createAgent — rethrow (Task 7.2 error-path byte-identity)', () => {
  const boom = new Error('memory injection boom');
  /** A MemoryRuntime whose injection prefetch THROWS — the closest reachable
   *  pre-loop throw createAgent threads into query(). */
  function throwingMemory(): MemoryRuntime {
    return {
      async prefetchSnapshot(): Promise<string> {
        throw boom;
      },
      async syncTurn(): Promise<void> {},
      async onMemoryWrite(): Promise<void> {},
      async onDelegation(): Promise<void> {},
    };
  }

  test('rethrow unset → a thrown pre-loop op is CONVERTED to terminal{reason:error} (the default; byte-identical to today)', async () => {
    const agent = createAgent({
      provider: scriptedProvider([completedTurn]),
      model: 'fake-model',
      memoryManager: throwingMemory(),
      maxTokens: 256,
    });
    // No throw escapes run(): the drive's try/catch converts it and returns a
    // normal RunResult carrying the error terminal.
    const { result } = await drain(agent.run('hello'));
    expect(result.terminal.reason).toBe('error');
    expect(result.terminal.error).toBe(boom);
  });

  test('rethrow: true (per-turn) → the SAME thrown pre-loop op PROPAGATES out of run() (consumer .next() rejects), NOT a returned terminal', async () => {
    const agent = createAgent({
      provider: scriptedProvider([completedTurn]),
      model: 'fake-model',
      memoryManager: throwingMemory(),
      maxTokens: 256,
    });
    // The generator rejects — exactly like a direct query() drive.
    await expect(drain(agent.run('hello', { rethrow: true }))).rejects.toThrow(
      'memory injection boom',
    );
  });

  test('rethrow: true via standing config is honored without a per-turn override', async () => {
    const agent = createAgent({
      provider: scriptedProvider([completedTurn]),
      model: 'fake-model',
      memoryManager: throwingMemory(),
      rethrow: true,
      maxTokens: 256,
    });
    await expect(drain(agent.run('hello'))).rejects.toThrow('memory injection boom');
  });

  test('a per-turn rethrow:false overrides a standing rethrow:true (convert wins for that turn)', async () => {
    const agent = createAgent({
      provider: scriptedProvider([completedTurn]),
      model: 'fake-model',
      memoryManager: throwingMemory(),
      rethrow: true,
      maxTokens: 256,
    });
    const { result } = await drain(agent.run('hello', { rethrow: false }));
    expect(result.terminal.reason).toBe('error');
    expect(result.terminal.error).toBe(boom);
  });

  test('rethrow has NO effect on a normal (non-throwing) turn — completes + returns a RunResult either way', async () => {
    const agent = createAgent({
      provider: scriptedProvider([completedTurn]),
      model: 'fake-model',
      maxTokens: 256,
    });
    const { result } = await drain(agent.run('hello', { rethrow: true }));
    expect(result.terminal.reason).toBe('completed');
    expect(result.finalAssistant).toEqual(completedAnswer);
  });
});

// Task 4.2 — cross-call token-usage accumulation. A tool-loop run makes
// MULTIPLE provider calls; within one call usage_delta events are
// CUMULATIVE-FROM-ZERO (keep the last), across calls the per-call finals must
// be SUMMED. The old code kept only the globally-last snapshot, silently
// dropping every earlier call's tokens from recordTokenUsage. These tests use
// usage-emitting variants of the shared fixtures (the originals emit no
// usage_delta and stay untouched — single-call persist tests above pin the
// unchanged single-call path).
describe('createAgent — cross-call token-usage accumulation (Task 4.2)', () => {
  /** The echo tool-use turn, augmented with cumulative in-call usage deltas:
   *  call 1's final is 12 in / 9 out. */
  const usageEchoToolUseTurn: StreamEvent[] = [
    { type: 'message_start' },
    { type: 'usage_delta', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'tool_use_delta', id: 't1', partial: '{"text":"hi"}' },
    { type: 'usage_delta', usage: { inputTokens: 12, outputTokens: 9 } },
    { type: 'message_stop', stop_reason: 'tool_use' },
    { type: 'assistant_message', message: echoToolUse },
  ];

  /** The final (post-tool) turn: call 2's final is 8 in / 4 out. */
  const usageCompletedTurn: StreamEvent[] = [
    { type: 'message_start' },
    { type: 'usage_delta', usage: { inputTokens: 7, outputTokens: 3 } },
    { type: 'text_delta', text: 'final answer' },
    { type: 'usage_delta', usage: { inputTokens: 8, outputTokens: 4 } },
    { type: 'message_stop', stop_reason: 'end_turn' },
    { type: 'assistant_message', message: completedAnswer },
  ];

  /** Wrap the in-memory store so a test can assert the EXACT TokenUsage object
   *  that reached recordTokenUsage (field split + absence, not just totals). */
  function capturingStore(): {
    store: SessionStore;
    recorded: { usage: TokenUsage; costUsd: number }[];
  } {
    const inner = createInMemorySessionStore();
    const recorded: { usage: TokenUsage; costUsd: number }[] = [];
    const store: SessionStore = {
      ...inner,
      recordTokenUsage(sessionId, usage, estimatedCostUsd) {
        recorded.push({ usage, costUsd: estimatedCostUsd });
        inner.recordTokenUsage(sessionId, usage, estimatedCostUsd);
      },
    };
    return { store, recorded };
  }

  test('a two-call tool loop records the SUM of per-call finals — not the last snapshot, not the naive delta-sum', async () => {
    const { store, recorded } = capturingStore();
    const agent = createAgent({
      provider: scriptedProvider([usageEchoToolUseTurn, usageCompletedTurn]),
      model: 'fake-model',
      tools: [makeEchoTool()],
      sessionStore: store,
      maxTokens: 256,
    });
    const { result } = await drain(agent.run('use the tool', { sessionId: 'sess-4-2-sum' }));

    expect(result.terminal.reason).toBe('completed');
    // ONE recordTokenUsage per run, carrying the summed per-call finals:
    // 12+8 = 20 in / 9+4 = 13 out. NOT 8/4 (the old last-snapshot bug) and NOT
    // 37/21 (naively summing every cumulative delta double-counts).
    expect(recorded.length).toBe(1);
    expect(recorded[0]?.usage).toEqual({ inputTokens: 20, outputTokens: 13 });
    // Fields no call reported stay ABSENT (no zero fabrication).
    expect(recorded[0] !== undefined && 'cacheReadInputTokens' in recorded[0].usage).toBe(false);
    expect(recorded[0] !== undefined && 'cacheCreationInputTokens' in recorded[0].usage).toBe(
      false,
    );
    // The session row accumulated the same totals.
    const session = store.getSession('sess-4-2-sum');
    expect(session?.inputTokens).toBe(20);
    expect(session?.outputTokens).toBe(13);
  });

  test('a cache field reported by only ONE call is summed correctly — neither dropped nor zero-fabricated', async () => {
    // Call 1's message_start delta carries input + cacheRead; its second delta
    // (the Anthropic message_delta shape) omits the cache field — last-seen is
    // PER FIELD, so 40 survives within the call. Call 2 reports no cache
    // fields at all.
    const cacheToolUseTurn: StreamEvent[] = [
      { type: 'message_start' },
      { type: 'usage_delta', usage: { inputTokens: 10, cacheReadInputTokens: 40 } },
      { type: 'tool_use_delta', id: 't1', partial: '{"text":"hi"}' },
      { type: 'usage_delta', usage: { inputTokens: 12, outputTokens: 9 } },
      { type: 'message_stop', stop_reason: 'tool_use' },
      { type: 'assistant_message', message: echoToolUse },
    ];
    const { store, recorded } = capturingStore();
    const agent = createAgent({
      provider: scriptedProvider([cacheToolUseTurn, usageCompletedTurn]),
      model: 'fake-model',
      tools: [makeEchoTool()],
      sessionStore: store,
      maxTokens: 256,
    });
    await drain(agent.run('use the tool', { sessionId: 'sess-4-2-cache' }));

    expect(recorded.length).toBe(1);
    expect(recorded[0]?.usage).toEqual({
      inputTokens: 20,
      outputTokens: 13,
      cacheReadInputTokens: 40,
    });
    // cacheCreationInputTokens was never reported by ANY call → still absent.
    expect(recorded[0] !== undefined && 'cacheCreationInputTokens' in recorded[0].usage).toBe(
      false,
    );
  });

  test('a run whose provider emits NO usage_delta records nothing (recordTokenUsage skipped, as today)', async () => {
    // The original fixtures emit no usage_delta — the pre-4.2 skip contract.
    const { store, recorded } = capturingStore();
    const agent = createAgent({
      provider: scriptedProvider([
        echoToolUseTurn,
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'final answer' },
          { type: 'message_stop', stop_reason: 'end_turn' },
          { type: 'assistant_message', message: completedAnswer },
        ],
      ]),
      model: 'fake-model',
      tools: [makeEchoTool()],
      sessionStore: store,
      maxTokens: 256,
    });
    const { result } = await drain(agent.run('use the tool', { sessionId: 'sess-4-2-none' }));
    expect(result.terminal.reason).toBe('completed');
    expect(recorded.length).toBe(0);
  });

  test("a rehydration run records only THIS run's usage (no re-count of prior runs)", async () => {
    // Interaction with the 4.1 dedup: run 2 rehydrates run 1's history, but the
    // accumulator only ever sees run 2's live stream — run 1's tokens are not
    // recorded twice. The session row holds run1 + run2 (store-side accumulate),
    // each recordTokenUsage call carries only its own run.
    const { store, recorded } = capturingStore();
    const sessionId = 'sess-4-2-rehydrate';
    const agent = createAgent({
      provider: scriptedProvider([completedTurn, usageCompletedTurn]),
      model: 'fake-model',
      sessionStore: store,
      maxTokens: 256,
    });

    await drain(agent.run('hello', { sessionId }));
    expect(recorded[0]?.usage).toEqual({ inputTokens: 11, outputTokens: 7 });

    const rehydrated: Message[] = store
      .loadMessages(sessionId)
      .map((m) =>
        m.role === 'user'
          ? { role: 'user', content: m.content }
          : { role: 'assistant', content: m.content },
      );
    await drain(
      agent.run([...rehydrated, { role: 'user', content: [{ type: 'text', text: 'and now?' }] }], {
        sessionId,
      }),
    );

    expect(recorded.length).toBe(2);
    expect(recorded[1]?.usage).toEqual({ inputTokens: 8, outputTokens: 4 });
    // Store-side totals: 11+8 / 7+4 — each run counted exactly once.
    const session = store.getSession(sessionId);
    expect(session?.inputTokens).toBe(19);
    expect(session?.outputTokens).toBe(11);
  });

  // --- F6: a STRING config provider resolves with NO disk (the README promise).
  test('a string config provider resolves without creating/reading HARNESS_HOME (F6)', async () => {
    // Point HARNESS_HOME at a path that does NOT exist. A disk-free provider
    // resolution (README "no disk, no server") must never mkdir it.
    const home = join(tmpdir(), `sov-f6-${randomUUID()}`);
    const prevHome = process.env.HARNESS_HOME;
    const prevConfig = process.env.HARNESS_CONFIG;
    process.env.HARNESS_HOME = home;
    // Force the resolveHarnessHome()/config.json path (not an explicit config).
    // `delete` is the only correct way to UNSET an env var — `= undefined` stores
    // the string "undefined" in process.env.
    // biome-ignore lint/performance/noDelete: env-var unset requires delete (one-off test cleanup).
    delete process.env.HARNESS_CONFIG;
    try {
      expect(existsSync(home)).toBe(false);
      // An UNKNOWN provider name makes resolveProvider throw deterministically
      // AFTER the settings-load seam — no network, no credential dependency. The
      // mkdir, if any, happens inside loadSettings() BEFORE that throw, so the
      // directory's existence is a clean witness for "did resolution touch disk".
      const agent = createAgent({ provider: 'totally-unknown-provider-xyz', model: 'x' });
      await agent
        .run('hi')
        .next()
        .then(
          () => {
            throw new Error('expected string-provider resolution to throw');
          },
          () => {
            /* expected: unknown provider */
          },
        );
      // Load-bearing: resolving the string provider created NO ~/.harness.
      expect(existsSync(home)).toBe(false);
    } finally {
      // biome-ignore lint/performance/noDelete: env-var unset requires delete (test cleanup).
      if (prevHome === undefined) delete process.env.HARNESS_HOME;
      else process.env.HARNESS_HOME = prevHome;
      if (prevConfig !== undefined) process.env.HARNESS_CONFIG = prevConfig;
    }
  });

  // --- F7: early abandonment of run() finalizes the inner query()/provider.stream.
  test('breaking the stream early (no abort) finalizes query()/provider.stream + skips persistence (F7)', async () => {
    let finalized = false;
    const store = createInMemorySessionStore();
    const agent = createAgent({
      provider: finalizerProvider([completedTurn], () => {
        finalized = true;
      }),
      model: 'fake-model',
      maxTokens: 256,
      sessionStore: store,
    });
    let seen = 0;
    // Abandon after the FIRST event WITHOUT firing an abort signal — the `break`
    // makes `for await` call the outer generator's `.return()` while it is
    // suspended at `yield ev`, with provider.stream still mid-stream.
    for await (const _ev of agent.run('hi', { sessionId: 'f7-abandon' })) {
      seen += 1;
      if (seen === 1) break;
    }
    expect(seen).toBe(1);
    // GREEN after the fix: teardown propagated into query() (its for-await closes
    // provider.stream), so the finally ran. RED before: the inner generator is
    // orphaned until GC and `finalized` stays false.
    expect(finalized).toBe(true);
    // Persistence must NOT run for an abandoned turn (it lives AFTER the loop).
    expect(store.loadMessages('f7-abandon')).toHaveLength(0);
  });

  test('normal completion still delivers every event AND persists the turn (F7 no-regression)', async () => {
    let finalized = false;
    const store = createInMemorySessionStore();
    const events: (StreamEvent | Message)[] = [];
    const agent = createAgent({
      provider: finalizerProvider([completedTurn], () => {
        finalized = true;
      }),
      model: 'fake-model',
      maxTokens: 256,
      sessionStore: store,
    });
    for await (const ev of agent.run('hi', { sessionId: 'f7-normal' })) {
      events.push(ev);
    }
    // The finally's `gen.return()` is a harmless no-op on an already-done
    // generator: every scripted event is delivered unchanged...
    expect(finalized).toBe(true);
    expect(events).toEqual(completedTurn);
    // ...and persistence still runs on the normal path.
    expect(store.loadMessages('f7-normal').length).toBeGreaterThan(0);
  });

  // --- F8: a specifically-typed buildTool() composes with NO double-cast.
  test('buildTool() flows into createAgent({tools}) + run({tools}) with NO cast (F8 typecheck witness)', async () => {
    // The load-bearing assertion is at COMPILE time (`bun run typecheck`): the
    // specific Tool<{text},{echoed}> from buildTool() must be assignable to
    // AgentConfig.tools / PerTurn.tools with NO `as unknown as
    // Tool<unknown, unknown>` double-cast (which silently erased type safety).
    // If those fields regress to Tool<unknown,unknown>[], tsc fails here (TS2322).
    const echoTool = buildTool({
      name: 'Echo',
      description: () => 'echo input',
      inputSchema: z.object({ text: z.string() }),
      async call(input) {
        return { data: { echoed: input.text } };
      },
    });
    const agent = createAgent({
      provider: scriptedProvider([echoToolUseTurn, completedTurn]),
      model: 'fake-model',
      maxTokens: 256,
      tools: [echoTool], // ← no cast (AgentConfig.tools)
    });
    const { result } = await drain(agent.run('use it', { tools: [echoTool] })); // ← no cast (PerTurn.tools)
    expect(result.terminal.reason).toBe('completed');
    expect(result.toolCallCount).toBe(1);
    expect(result.distinctToolNames).toEqual(['Echo']);
  });
});

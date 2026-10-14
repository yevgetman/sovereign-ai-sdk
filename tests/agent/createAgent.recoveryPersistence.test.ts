import { expect, test } from 'bun:test';
import { type RunResult, createAgent } from '@yevgetman/sov-sdk/agent/createAgent';
import type { ConductProvider } from '@yevgetman/sov-sdk/core/conductPort';
import type { AssistantMessage, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import { createInMemorySessionStore } from '@yevgetman/sov-sdk/persistence/inMemoryStore';
import type { SessionStore } from '@yevgetman/sov-sdk/persistence/sessionStore';
import { SessionPersistenceError } from '@yevgetman/sov-sdk/providers/errors';
import type { LLMProvider } from '@yevgetman/sov-sdk/providers/types';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import { z } from 'zod';

const answer = (text: string): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
});
function provider(texts = ['complete']): LLMProvider {
  let turn = 0;
  return {
    name: 'fake',
    async *stream() {
      yield { type: 'message_start' };
      yield { type: 'usage_delta', usage: { inputTokens: 5, outputTokens: 2 } };
      yield { type: 'message_stop', stop_reason: 'end_turn' };
      const message = answer(texts[turn++] ?? 'extra');
      yield { type: 'assistant_message', message };
      return message;
    },
  };
}
const native = { sessionId: 'durable-native', persistCompletedMessages: true };
for (const aborted of [false, true]) {
  test(`opt-in completed message is durable before ${aborted ? 'cancellation' : 'early close'}`, async () => {
    const store = createInMemorySessionStore();
    const controller = new AbortController();
    const agent = createAgent({ provider: provider(), model: 'fake', sessionStore: store });
    for await (const event of agent.run('prompt', { ...native, signal: controller.signal })) {
      if ('type' in event && event.type === 'assistant_message') {
        expect(store.loadMessages(native.sessionId).map((m) => m.role)).toEqual([
          'user',
          'assistant',
        ]);
        if (aborted) controller.abort();
        break;
      }
    }
    expect(store.loadMessages(native.sessionId).at(-1)?.content).toEqual(
      answer('complete').content,
    );
  });
}

test('opt-in final persistence does not duplicate completed rows or transcripts', async () => {
  const store = createInMemorySessionStore();
  const transcripts: string[] = [];
  const agent = createAgent({
    provider: provider(),
    model: 'fake',
    sessionStore: store,
    transcripts: {
      recordMessage: (_id, role) => {
        transcripts.push(role);
      },
      async closeSession() {},
      async closeAll() {},
    },
  });
  for await (const _event of agent.run('prompt', native)) {
  }
  expect(store.loadMessages(native.sessionId)).toHaveLength(2);
  expect(transcripts).toEqual(['user', 'assistant']);
});

test('a substituted completed message, never the unapproved draft, is durable before close', async () => {
  const store = createInMemorySessionStore();
  const agent = createAgent({
    provider: provider(['unapproved']),
    model: 'fake',
    sessionStore: store,
    conduct: {
      outputGuard: { onFinal: () => ({ action: 'replace', text: 'approved' }) },
    } as ConductProvider,
  });
  for await (const event of agent.run('prompt', native)) {
    if ('type' in event && event.type === 'assistant_message') break;
  }
  expect(store.loadMessages(native.sessionId).at(-1)?.content).toEqual(answer('approved').content);
});

test('a storage failure refuses the completed event before it can be reported durable', async () => {
  const backing = createInMemorySessionStore();
  const store = new Proxy(backing, {
    get(target, key) {
      if (key === 'saveMessage')
        return () => {
          throw new Error('write failed');
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as SessionStore;
  const events: StreamEvent[] = [];
  const agent = createAgent({ provider: provider(), model: 'fake', sessionStore: store });
  try {
    for await (const event of agent.run('prompt', native)) if ('type' in event) events.push(event);
  } catch (err) {
    expect(err).toBeInstanceOf(SessionPersistenceError);
  }
  expect(events.filter((e) => e.type === 'assistant_message')).toHaveLength(0);
});

function toolProvider(): LLMProvider {
  let round = 0;
  return {
    name: 'fake',
    async *stream() {
      yield { type: 'message_start' };
      yield { type: 'usage_delta', usage: { inputTokens: 5, outputTokens: 2 } };
      const tool = round++ === 0;
      yield { type: 'message_stop', stop_reason: tool ? 'tool_use' : 'end_turn' };
      const message: AssistantMessage = tool
        ? {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'receipt-1', name: 'Effect', input: {} }],
          }
        : answer(round === 2 ? 'discard' : 'approved');
      yield { type: 'assistant_message', message };
      return message;
    },
  };
}

test('opt-in conduct regeneration rolls back early snapshots and transcripts', async () => {
  const store = createInMemorySessionStore();
  const transcript: string[] = [];
  const agent = createAgent({
    provider: toolProvider(),
    model: 'fake',
    sessionStore: store,
    tools: [
      buildTool({
        name: 'Effect',
        description: () => 'fixture effect',
        inputSchema: z.object({}),
        async call() {
          return { data: 'receipt' };
        },
      }),
    ],
    transcripts: {
      recordMessage: (_id, role) => {
        transcript.push(role);
      },
      async rewindMessages(_id, count) {
        transcript.splice(transcript.length - count);
      },
      async closeSession() {},
      async closeAll() {},
    },
    conduct: {
      outputGuard: {
        onFinal: (message) =>
          message.content.some((b) => b.type === 'text' && b.text === 'discard')
            ? { action: 'regenerate', reason: 'fixture' }
            : { action: 'pass' },
      },
    },
  });
  for await (const _event of agent.run('prompt', native)) {
  }
  expect(store.loadMessages(native.sessionId).map((m) => m.role)).toEqual(['user', 'assistant']);
  expect(store.loadMessages(native.sessionId).at(-1)?.content).toEqual(answer('approved').content);
  expect(transcript).toEqual(['user', 'assistant']);
  expect(store.loadToolExecutions(native.sessionId)).toHaveLength(0);
});

test('completed tool receipts survive close and resume without executing the effect again', async () => {
  const store = createInMemorySessionStore();
  let effects = 0;
  const tool = buildTool({
    name: 'Effect',
    description: () => 'fixture effect',
    inputSchema: z.object({}),
    async call() {
      effects++;
      return { data: 'receipt' };
    },
  });
  const agent = createAgent({
    provider: toolProvider(),
    model: 'fake',
    sessionStore: store,
    tools: [tool],
  });
  const controller = new AbortController();
  for await (const event of agent.run('prompt', { ...native, signal: controller.signal })) {
    if ('role' in event && event.content.some((b) => b.type === 'tool_result')) {
      controller.abort();
      break;
    }
  }
  expect(store.loadMessages(native.sessionId)).toHaveLength(3);
  expect(store.loadToolExecutions(native.sessionId)).toMatchObject([
    { state: 'completed', toolUseId: 'receipt-1' },
  ]);
  const history = store
    .loadMessages(native.sessionId)
    .map((m) => ({ role: m.role, content: m.content }));
  const resumed = createAgent({
    provider: provider(['resumed']),
    model: 'fake',
    sessionStore: store,
    tools: [tool],
  });
  for await (const _event of resumed.run(history, {
    ...native,
    storedPrefixLength: history.length,
  })) {
  }
  expect(effects).toBe(1);
  expect(store.loadMessages(native.sessionId)).toHaveLength(4);
  expect(store.loadToolExecutions(native.sessionId)).toHaveLength(1);
});

test('a transient transcript fault after canonical save does not duplicate the completed assistant', async () => {
  const store = createInMemorySessionStore();
  store.createSession({ sessionId: native.sessionId, model: 'fake', provider: 'fake' });
  const seed = { role: 'user' as const, content: [{ type: 'text' as const, text: 'prompt' }] };
  store.saveMessage(native.sessionId, seed);
  let throws = 0;
  const agent = createAgent({
    provider: provider(),
    model: 'fake',
    sessionStore: store,
    transcripts: {
      recordMessage: (_id, role) => {
        if (role === 'assistant' && throws++ === 0)
          throw new Error('fixture transcript write failed');
      },
      async closeSession() {},
      async closeAll() {},
    },
  });
  const events: StreamEvent[] = [];
  const stream = agent.run([seed], { ...native, storedPrefixLength: 1 });
  let result: RunResult | undefined;
  for (;;) {
    const step = await stream.next();
    if (step.done) {
      result = step.value;
      break;
    }
    if ('type' in step.value) events.push(step.value);
  }
  expect(result?.terminal).toMatchObject({
    reason: 'error',
    error: expect.any(SessionPersistenceError),
  });
  expect(events.some((event) => event.type === 'assistant_message')).toBe(false);
  expect(store.loadMessages(native.sessionId).map((m) => m.role)).toEqual(['user', 'assistant']);
});

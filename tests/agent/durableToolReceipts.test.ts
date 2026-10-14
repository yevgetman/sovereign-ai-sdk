import { expect, test } from 'bun:test';
import { createAgent } from '@yevgetman/sov-sdk/agent/createAgent';
import type { AssistantMessage, Message, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import { createInMemorySessionStore } from '@yevgetman/sov-sdk/persistence/inMemoryStore';
import type { LLMProvider } from '@yevgetman/sov-sdk/providers/types';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import { z } from 'zod';

const sessionId = 'durable-receipt';
test('a completed side effect has a persisted result before the continuation model starts', async () => {
  const store = createInMemorySessionStore();
  let effects = 0;
  let calls = 0;
  const provider: LLMProvider = {
    name: 'fixture',
    async *stream(): AsyncGenerator<StreamEvent, AssistantMessage> {
      calls++;
      const message: AssistantMessage =
        calls === 1
          ? {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'write-1', name: 'WriteFixture', input: {} }],
            }
          : { role: 'assistant', content: [{ type: 'text', text: 'done' }] };
      if (calls === 2) {
        expect(effects).toBe(1);
        expect(
          store
            .loadMessages(sessionId)
            .some((row) =>
              row.content.some(
                (block) => block.type === 'tool_result' && block.tool_use_id === 'write-1',
              ),
            ),
        ).toBe(true);
      }
      yield { type: 'message_start' };
      yield { type: 'message_stop', stop_reason: calls === 1 ? 'tool_use' : 'end_turn' };
      yield { type: 'assistant_message', message };
      return message;
    },
  };
  const tool = buildTool({
    name: 'WriteFixture',
    description: () => 'Write a fixture effect',
    inputSchema: z.object({}),
    async call() {
      effects++;
      return { data: 'receipt' };
    },
  });
  const agent = createAgent({ provider, model: 'fixture', sessionStore: store, tools: [tool] });
  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'write once' }] }];
  const gen = agent.run(messages, { sessionId });
  for (;;) {
    const step = await gen.next();
    if (step.done) {
      expect(step.value.terminal.reason).toBe('completed');
      break;
    }
  }
});

function scriptProvider(
  batches: AssistantMessage[],
  onRequest?: (call: number) => void,
): LLMProvider {
  let call = 0;
  return {
    name: 'fixture',
    async *stream() {
      onRequest?.(++call);
      const message = batches.shift();
      if (!message) throw new Error('unexpected provider continuation');
      yield { type: 'message_start' };
      yield {
        type: 'message_stop',
        stop_reason: message.content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
      };
      yield { type: 'assistant_message', message };
      return message;
    },
  };
}
async function drain(gen: ReturnType<ReturnType<typeof createAgent>['run']>) {
  for (;;) {
    const next = await gen.next();
    if (next.done) return next.value;
  }
}
const batch: AssistantMessage = {
  role: 'assistant',
  content: [
    { type: 'tool_use', id: 'fast', name: 'Fast', input: {} },
    { type: 'tool_use', id: 'slow', name: 'Slow', input: {} },
  ],
};
const end: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'done' }] };

test('a fast receipt is stored while its concurrent sibling is still running; transcript stays ordered', async () => {
  const store = createInMemorySessionStore();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let observed!: () => void;
  const completed = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const original = store.saveToolExecution;
  store.saveToolExecution = (id, execution) => {
    original(id, execution);
    if (execution.toolUseId === 'fast' && execution.state === 'completed') observed();
  };
  const fast = buildTool({
    name: 'Fast',
    description: () => 'fast',
    inputSchema: z.object({}),
    isConcurrencySafe: () => true,
    async call() {
      return { data: 'fast-receipt' };
    },
  });
  const slow = buildTool({
    name: 'Slow',
    description: () => 'slow',
    inputSchema: z.object({}),
    isConcurrencySafe: () => true,
    async call() {
      await wait;
      return { data: 'slow-receipt' };
    },
  });
  const agent = createAgent({
    provider: scriptProvider([batch, end]),
    model: 'fixture',
    sessionStore: store,
    tools: [fast, slow],
  });
  const running = drain(agent.run('run both', { sessionId }));
  await completed;
  expect(store.loadToolExecutions(sessionId).find((row) => row.toolUseId === 'fast')?.state).toBe(
    'completed',
  );
  expect(store.loadToolExecutions(sessionId).find((row) => row.toolUseId === 'slow')?.state).toBe(
    'started',
  );
  expect(
    store
      .loadMessages(sessionId)
      .flatMap((row) => row.content)
      .filter((b) => b.type === 'tool_result'),
  ).toHaveLength(0);
  release();
  const result = await running;
  expect(result.terminal.reason).toBe('completed');
  expect(
    store
      .loadMessages(sessionId)
      .flatMap((row) => row.content)
      .filter((b) => b.type === 'tool_result')
      .map((b) => b.tool_use_id),
  ).toEqual(['fast', 'slow']);
});

test('a receipt storage failure joins a running sibling, keeps its successful output, and stops continuation', async () => {
  const store = createInMemorySessionStore();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let observed!: () => void;
  const failed = new Promise<void>((resolve) => {
    observed = resolve;
  });
  let slowFinished = false;
  let calls = 0;
  const original = store.saveToolExecution;
  store.saveToolExecution = (id, execution) => {
    if (execution.toolUseId === 'fast' && execution.state === 'completed') {
      observed();
      throw new Error('disk full');
    }
    original(id, execution);
  };
  const fast = buildTool({
    name: 'Fast',
    description: () => 'fast',
    inputSchema: z.object({}),
    isConcurrencySafe: () => true,
    async call() {
      return { data: 'fast-receipt' };
    },
  });
  const slow = buildTool({
    name: 'Slow',
    description: () => 'slow',
    inputSchema: z.object({}),
    isConcurrencySafe: () => true,
    async call() {
      await wait;
      slowFinished = true;
      return { data: 'slow-receipt' };
    },
  });
  const agent = createAgent({
    provider: scriptProvider([batch, end], (call) => {
      calls = call;
    }),
    model: 'fixture',
    sessionStore: store,
    tools: [fast, slow],
  });
  const running = drain(agent.run('run both', { sessionId }));
  let returned = false;
  void running.then(() => {
    returned = true;
  });
  await failed;
  expect(returned).toBe(false);
  release();
  const result = await running;
  expect(slowFinished).toBe(true);
  expect(calls).toBe(1);
  expect(result.terminal.reason).toBe('error');
  expect((result.terminal.error as { code?: string }).code).toBe('storage_failed');
  expect(
    result.messages
      .flatMap((row) => row.content)
      .filter((b) => b.type === 'tool_result')
      .map((b) => b.content),
  ).toEqual(['fast-receipt', 'slow-receipt']);
});

test('canonical result storage failure retains the real receipt in returned history and makes no next model call', async () => {
  const store = createInMemorySessionStore();
  const save = store.saveMessage;
  store.saveMessage = (id, message) => {
    if (message.content.some((b) => b.type === 'tool_result')) throw new Error('disk full');
    return save(id, message);
  };
  let calls = 0;
  const tool = buildTool({
    name: 'Fast',
    description: () => 'fast',
    inputSchema: z.object({}),
    async call() {
      return { data: 'real-receipt' };
    },
  });
  const first: AssistantMessage = { role: 'assistant', content: batch.content.slice(0, 1) };
  const result = await drain(
    createAgent({
      provider: scriptProvider([first, end], (call) => {
        calls = call;
      }),
      model: 'fixture',
      sessionStore: store,
      tools: [tool],
    }).run('run', { sessionId }),
  );
  expect(calls).toBe(1);
  expect((result.terminal.error as { code?: string }).code).toBe('storage_failed');
  expect(
    result.messages
      .flatMap((row) => row.content)
      .filter((b) => b.type === 'tool_result')
      .map((b) => b.content),
  ).toEqual(['real-receipt']);
  expect(
    store.loadToolExecutions(sessionId).find((row) => row.toolUseId === 'fast')?.result?.content,
  ).toBe('real-receipt');
});

test('early stream abandonment after a tool result leaves a durable receipt without duplicate rows', async () => {
  const store = createInMemorySessionStore();
  const tool = buildTool({
    name: 'Fast',
    description: () => 'fast',
    inputSchema: z.object({}),
    async call() {
      return { data: 'real-receipt' };
    },
  });
  const first: AssistantMessage = { role: 'assistant', content: batch.content.slice(0, 1) };
  const gen = createAgent({
    provider: scriptProvider([first, end]),
    model: 'fixture',
    sessionStore: store,
    tools: [tool],
  }).run('run', { sessionId });
  for await (const event of gen) {
    if ('role' in event && event.role === 'user') break;
  }
  const rows = store.loadMessages(sessionId);
  expect(rows).toHaveLength(3);
  expect(rows[2]?.content[0]).toMatchObject({ type: 'tool_result', content: 'real-receipt' });
  expect(store.loadToolExecutions(sessionId).find((row) => row.toolUseId === 'fast')?.state).toBe(
    'completed',
  );
});

test('journal-only hosts retain one canonical writer and bind receipts to its assistant row', async () => {
  const store = createInMemorySessionStore();
  store.upsertSession({ sessionId, model: 'fixture', provider: 'fixture' });
  const input: Message = { role: 'user', content: [{ type: 'text', text: 'run' }] };
  store.saveMessage(sessionId, input);
  const tool = buildTool({
    name: 'Fast',
    description: () => 'fast',
    inputSchema: z.object({}),
    async call() {
      expect(store.loadMessages(sessionId).at(-1)?.role).toBe('assistant');
      return { data: 'host-receipt' };
    },
  });
  const first: AssistantMessage = { role: 'assistant', content: batch.content.slice(0, 1) };
  const gen = createAgent({
    provider: scriptProvider([first, end]),
    model: 'fixture',
    toolExecutionStore: store,
    tools: [tool],
  }).run([input], { sessionId });
  for (;;) {
    const step = await gen.next();
    if (step.done) {
      expect(step.value.terminal.reason).toBe('completed');
      break;
    }
    if ('role' in step.value) store.saveMessage(sessionId, step.value);
    else if (step.value.type === 'assistant_message')
      store.saveMessage(sessionId, step.value.message);
  }
  const rows = store.loadMessages(sessionId);
  expect(rows).toHaveLength(4);
  expect(store.loadToolExecutions(sessionId)[0]).toMatchObject({
    assistantMessageId: rows[1]?.id,
    state: 'completed',
    result: { content: 'host-receipt' },
  });
});

test('post-tool hook failure keeps its known completed effect and original receipt in the journal', async () => {
  const store = createInMemorySessionStore();
  let effects = 0;
  let calls = 0;
  const tool = buildTool({
    name: 'Fast',
    description: () => 'fast',
    inputSchema: z.object({}),
    async call() {
      effects++;
      return { data: 'effect-receipt' };
    },
  });
  const first: AssistantMessage = { role: 'assistant', content: batch.content.slice(0, 1) };
  const result = await drain(
    createAgent({
      provider: scriptProvider([first, end], (call) => {
        calls = call;
      }),
      model: 'fixture',
      sessionStore: store,
      tools: [tool],
      hookRunner: async (event) => {
        if (event === 'PostToolUse') throw new Error('post hook failed');
        return { block: false };
      },
    }).run('run', { sessionId }),
  );
  expect(effects).toBe(1);
  expect(calls).toBe(2);
  expect(result.terminal.reason).toBe('completed');
  expect(store.loadToolExecutions(sessionId)[0]).toMatchObject({
    state: 'completed',
    result: { content: expect.stringContaining('effect-receipt') },
  });
  expect(store.loadToolExecutions(sessionId)[0]?.result?.content).toContain('post hook failed');
});

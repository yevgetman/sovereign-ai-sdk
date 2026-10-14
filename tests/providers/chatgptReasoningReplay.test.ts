import { expect, test } from 'bun:test';
import { createAgent } from '@yevgetman/sov-sdk/agent/createAgent';
import type { AssistantMessage, Message } from '@yevgetman/sov-sdk/core/types';
import { createInMemorySessionStore } from '@yevgetman/sov-sdk/persistence/inMemoryStore';
import { ChatGptSubscriptionProvider } from '@yevgetman/sov-sdk/providers/chatgpt';
import type { SubscriptionRecord } from '@yevgetman/sov-sdk/providers/subscription/port';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import { z } from 'zod';

const item = {
  type: 'reasoning',
  id: 'rs_fixture',
  summary: [],
  status: 'completed',
  encrypted_content: 'fixture-cipher',
  future: { nested: [false, 1, null] },
};
const wire = (output: unknown[]) =>
  new Response(
    `data: ${JSON.stringify({
      type: 'response.completed',
      response: { status: 'completed', output },
    })}\n\n`,
  );
function fixture(tool = false) {
  let record: SubscriptionRecord = {
    accessToken: 'fixture-access',
    refreshToken: 'fixture-refresh',
    expiresAt: Date.now() + 3600000,
    accountBinding: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  };
  const sent: Record<string, unknown>[] = [];
  const provider = new ChatGptSubscriptionProvider({
    port: {
      read: async () => ({ ...record }),
      write: async (_service, next) => {
        record = next;
      },
      delete: async () => {},
    },
    fetchImpl: async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return wire([
        item,
        tool && sent.length === 1
          ? {
              type: 'function_call',
              id: 'fc_fixture',
              call_id: 'call_fixture',
              name: 'FixtureRead',
              arguments: '{}',
            }
          : { type: 'message', content: [{ type: 'output_text', text: 'fixture answer' }] },
      ]);
    },
  });
  return {
    provider,
    sent,
    changeLogin: () => {
      record = { ...record, accountBinding: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
    },
  };
}
async function drain(generator: ReturnType<ReturnType<typeof createAgent>['run']>) {
  for (;;) {
    const step = await generator.next();
    if (step.done) return step.value;
  }
}

test('ChatGPT stateless reasoning rehydrates and replays complete items over two turns', async () => {
  const f = fixture();
  const store = createInMemorySessionStore();
  const agent = createAgent({ provider: f.provider, model: 'gpt-5.3-codex', sessionStore: store });
  const first = await drain(agent.run('fixture prompt'));
  expect(first.terminal.reason).toBe('completed');
  const restored = store
    .loadMessages(first.sessionId)
    .map(({ role, content }) => ({ role, content })) as Message[];
  const second = await drain(
    agent.run([...restored, { role: 'user', content: [{ type: 'text', text: 'followup' }] }], {
      sessionId: first.sessionId,
    }),
  );
  expect(second.terminal.reason).toBe('completed');
  expect(f.sent).toHaveLength(2);
  expect(f.sent.every((body) => body.store === false)).toBe(true);
  expect(f.sent[1]?.input).toContainEqual(item);
  expect(store.loadMessages(first.sessionId)).toHaveLength(4);
});

test('ChatGPT reasoning survives tool dispatch and the same-turn continuation', async () => {
  const f = fixture(true);
  let calls = 0;
  const agent = createAgent({
    provider: f.provider,
    model: 'gpt-5.3-codex',
    maxTurns: 2,
    tools: [
      buildTool({
        name: 'FixtureRead',
        description: () => 'Fixture read',
        inputSchema: z.object({}),
        isReadOnly: () => true,
        async call() {
          calls++;
          return { data: { value: 5 } };
        },
      }),
    ],
  });
  const result = await drain(agent.run('fixture prompt'));
  expect(result.terminal.reason).toBe('completed');
  expect(calls).toBe(1);
  expect(f.sent).toHaveLength(2);
  expect(f.sent[1]?.input).toContainEqual(item);
  expect(f.sent[1]?.input).toContainEqual({
    type: 'function_call_output',
    call_id: 'call_fixture',
    output: JSON.stringify({ value: 5 }, null, 2),
  });
});

for (const change of ['model', 'login'] as const) {
  test(`ChatGPT refuses a ${change} change before sending saved ciphertext`, async () => {
    const f = fixture();
    let assistant: AssistantMessage | undefined;
    const request = { model: 'gpt-5.3-codex', messages: [], system: [], maxTokens: 128 };
    for await (const event of f.provider.stream(request))
      if (event.type === 'assistant_message') assistant = event.message;
    if (!assistant) throw new Error('missing fixture message');
    if (change === 'login') f.changeLogin();
    await expect(
      f.provider
        .stream({
          ...request,
          model: change === 'model' ? 'fixture-other-model' : request.model,
          messages: [assistant],
        })
        .next(),
    ).rejects.toMatchObject({ code: 'unsupported_input' });
    expect(f.sent).toHaveLength(1);
  });
}

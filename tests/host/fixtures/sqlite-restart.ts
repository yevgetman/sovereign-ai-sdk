// Host-only fixture: the SQLite adapter remains outside the MIT SDK.
import assert from 'node:assert/strict';
import { SessionWorkQueue, buildTool, createAgent } from '@yevgetman/sov-sdk';
import type { AssistantMessage, LLMProvider, Message } from '@yevgetman/sov-sdk';
import { repairMissingToolResults } from '@yevgetman/sov-sdk/core/transcriptRepair';
import { z } from 'zod';
import { SessionDb } from '../../../src/agent/sessionDb.js';

const [mode, path] = process.argv.slice(2);
if (!path) throw new Error('fixture requires an explicit temporary database');
const store = SessionDb.open({ path });
const queue = new SessionWorkQueue({ maxActiveSessions: 1, maxQueued: 1, maxQueuedPerSession: 1 });
const sessionId = 'restart-fixture';
async function drain<T>(gen: AsyncGenerator<unknown, T>): Promise<T> {
  for (;;) {
    const step = await gen.next();
    if (step.done) return step.value;
  }
}
if (mode === 'crash') {
  const provider: LLMProvider = {
    name: 'mock',
    async *stream() {
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'interrupted', name: 'RestartProbe', input: {} }],
      };
      yield { type: 'message_stop', stop_reason: 'tool_use' };
      yield { type: 'assistant_message', message };
      return message;
    },
  };
  const tool = buildTool({
    name: 'RestartProbe',
    description: () => 'interrupted fixture',
    inputSchema: z.object({}),
    async call() {
      process.stdout.write('READY\n');
      // Keep this fixture process alive until the parent kills it. No real tool
      // effect is performed, and the transcript's pre-tool boundary is durable.
      await new Promise<void>(() => {
        setInterval(() => {}, 1000);
      });
      return { data: 'unreachable' };
    },
  });
  const agent = createAgent({ provider, model: 'mock', sessionStore: store, tools: [tool] });
  await queue.submit(sessionId, async (signal) =>
    drain(agent.run('initial', { sessionId, signal })),
  );
} else if (mode === 'resume') {
  const raw: Message[] = store
    .loadMessages(sessionId)
    .map(({ role, content }) => ({ role, content }));
  assert.equal(raw.length, 2, 'initial user + assistant were durable before the crash');
  const repair = repairMissingToolResults(raw);
  assert.equal(repair.insertedToolResults, 1);
  assert.equal(store.loadMessages(sessionId).length, 2, 'repair does not rewrite raw storage');
  const provider: LLMProvider = {
    name: 'mock',
    async *stream(request) {
      assert.ok(
        request.messages.some((message) =>
          message.content.some(
            (block) =>
              block.type === 'tool_result' && block.tool_use_id === 'interrupted' && block.is_error,
          ),
        ),
      );
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'recovered without replay' }],
      };
      yield { type: 'message_stop', stop_reason: 'end_turn' };
      yield { type: 'assistant_message', message };
      return message;
    },
  };
  const agent = createAgent({ provider, model: 'mock', sessionStore: store });
  const input: Message[] = [
    ...repair.messages,
    { role: 'user', content: [{ type: 'text', text: 'resume' }] },
  ];
  const result = await queue.submit(sessionId, async (signal) =>
    drain(agent.run(input, { sessionId, signal, storedPrefixLength: repair.messages.length })),
  );
  assert.equal(result.terminal.reason, 'completed');
  assert.equal(store.loadMessages(sessionId).length, 4, 'only the resumed user and answer append');
  assert.equal(
    store.handle.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()
      ?.integrity_check,
    'ok',
  );
  await queue.shutdown(false);
  store.close();
  console.log('RESTART_OK');
} else throw new Error('invalid fixture mode');

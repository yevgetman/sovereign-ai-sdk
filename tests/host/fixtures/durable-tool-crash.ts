// Isolated process fixture. Its only effect is a counter file in the test's temp directory.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { buildTool, createAgent } from '@yevgetman/sov-sdk';
import type { AssistantMessage, LLMProvider, Message } from '@yevgetman/sov-sdk';
import { repairMissingToolResults } from '@yevgetman/sov-sdk/core/transcriptRepair';
import { z } from 'zod';
import { SessionDb } from '../../../src/agent/sessionDb.js';

const [mode, stage, dbPath, effectPath] = process.argv.slice(2);
if (!stage || !dbPath || !effectPath) throw new Error('explicit fixture paths required');
const sessionId = 'durable-crash';
const store = SessionDb.open({ path: dbPath });
const effects = () => (existsSync(effectPath) ? Number(readFileSync(effectPath, 'utf8')) : 0);
const fail = () => process.exit(71);
async function drain<T>(gen: AsyncGenerator<unknown, T>): Promise<T> {
  for (;;) {
    const next = await gen.next();
    if (next.done) return next.value;
  }
}
if (mode === 'crash') {
  const original = store.saveToolExecution.bind(store);
  store.saveToolExecution = (id, execution) => {
    if (execution.state === 'completed' && stage === 'after-effect-before-receipt') fail();
    original(id, execution);
    if (execution.state === 'interrupted' && stage === 'before-execution') fail();
    if (execution.state === 'completed' && stage === 'after-receipt') fail();
  };
  const saveMessage = store.saveMessage.bind(store);
  store.saveMessage = (id, message) => {
    const rowId = saveMessage(id, message);
    if (stage === 'before-model' && message.content.some((block) => block.type === 'tool_result'))
      fail();
    return rowId;
  };
  let calls = 0;
  const provider: LLMProvider = {
    name: 'fixture',
    async *stream() {
      if (++calls === 2) fail();
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'effect', name: 'Effect', input: {} }],
      };
      yield { type: 'message_stop', stop_reason: 'tool_use' };
      yield { type: 'assistant_message', message };
      return message;
    },
  };
  const tool = buildTool({
    name: 'Effect',
    description: () => 'Temp counter effect',
    inputSchema: z.object({}),
    async call() {
      if (stage === 'during-execution') fail();
      writeFileSync(effectPath, String(effects() + 1));
      return {
        data: 'effect-receipt',
        newMessages: [
          { role: 'user' as const, content: [{ type: 'text' as const, text: 'fixture-extra' }] },
        ],
      };
    },
  });
  await drain(
    createAgent({ provider, model: 'fixture', tools: [tool], sessionStore: store }).run(
      'effect once',
      { sessionId },
    ),
  );
  throw new Error('did not reach crash seam');
}
if (mode === 'resume') {
  const rows = store.loadMessages(sessionId);
  const raw: Message[] = rows.map(({ role, content }) => ({ role, content }));
  const executions = store.loadToolExecutions(sessionId);
  const view = repairMissingToolResults(
    raw,
    executions,
    rows.map((row) => row.id),
  ).messages;
  const resultBlock = view
    .flatMap((message) => message.content)
    .find((block) => block.type === 'tool_result');
  assert.ok(resultBlock?.type === 'tool_result');
  const completed = stage === 'after-receipt' || stage === 'before-model';
  assert.equal(effects(), stage === 'before-execution' || stage === 'during-execution' ? 0 : 1);
  assert.equal(resultBlock.is_error === true, !completed);
  if (completed) {
    assert.equal(resultBlock.content, 'effect-receipt');
    assert.ok(
      view
        .flatMap((message) => message.content)
        .some((block) => block.type === 'text' && block.text === 'fixture-extra'),
    );
  } else if (stage === 'before-execution')
    assert.match(resultBlock.content, /interrupted before execution/);
  else assert.match(resultBlock.content, /outcome unknown.*Do not repeat/);
  let called = 0;
  const tool = buildTool({
    name: 'Effect',
    description: () => 'must not replay',
    inputSchema: z.object({}),
    async call() {
      called++;
      throw new Error('replayed');
    },
  });
  const provider: LLMProvider = {
    name: 'fixture',
    async *stream(request) {
      assert.deepEqual(request.messages, view);
      const message: AssistantMessage = {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: completed ? 'continued from receipt' : 'verify effect before retry',
          },
        ],
      };
      yield { type: 'message_stop', stop_reason: 'end_turn' };
      yield { type: 'assistant_message', message };
      return message;
    },
  };
  const before = effects();
  const result = await drain(
    createAgent({ provider, model: 'fixture', tools: [tool], sessionStore: store }).run(view, {
      sessionId,
      storedPrefixLength: view.length,
    }),
  );
  assert.equal(result.terminal.reason, 'completed');
  assert.equal(called, 0);
  assert.equal(effects(), before);
  const persisted = store.loadMessages(sessionId);
  assert.equal(persisted.length, rows.length + 1, 'only the continuation is appended');
  assert.deepEqual(persisted.slice(0, rows.length), rows, 'raw stored transcript remains verbatim');
  console.log('DURABLE_RESUME_OK');
  store.close();
} else throw new Error('invalid mode');

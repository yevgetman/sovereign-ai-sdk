// PerTurn.storedPrefixLength — resume from a repaired view of stored rows
// without writing the view again, plus toolset execution enforcement.

import { describe, expect, test } from 'bun:test';
import { createAgent } from '@yevgetman/sov-sdk/agent/createAgent';
import { repairMissingToolResults } from '@yevgetman/sov-sdk/core/transcriptRepair';
import type { AssistantMessage, Message, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import { createInMemorySessionStore } from '@yevgetman/sov-sdk/persistence/inMemoryStore';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import { z } from 'zod';

const SESSION = 'resume-session';

function textTurn(text: string): StreamEvent[] {
  const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text }] };
  return [
    { type: 'message_start' },
    { type: 'text_delta', text },
    { type: 'message_stop', stop_reason: 'end_turn' },
    { type: 'assistant_message', message },
  ];
}

function toolTurn(id: string, name: string): StreamEvent[] {
  const message: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input: { text: 'hi' } }],
  };
  return [
    { type: 'message_start' },
    { type: 'message_stop', stop_reason: 'tool_use' },
    { type: 'assistant_message', message },
  ];
}

function recording(turns: StreamEvent[][]): { provider: LLMProvider; requests: ProviderRequest[] } {
  const queue = turns.map((turn) => [...turn]);
  const requests: ProviderRequest[] = [];
  const provider: LLMProvider = {
    name: 'recording',
    async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      requests.push(structuredClone(req));
      const events = queue.shift();
      if (!events) throw new Error('recording: queue empty');
      let last: AssistantMessage | undefined;
      for (const event of events) {
        if (event.type === 'assistant_message') last = event.message;
        yield event;
      }
      return last ?? { role: 'assistant', content: [] };
    },
  };
  return { provider, requests };
}

function spyTool(name: string, calls: string[]) {
  return buildTool({
    name,
    description: () => name,
    inputSchema: z.object({ text: z.string().optional() }),
    async call() {
      calls.push(name);
      return { data: { ok: true } };
    },
  });
}

async function drain(gen: ReturnType<ReturnType<typeof createAgent>['run']>) {
  for (;;) {
    const step = await gen.next();
    if (step.done) return step.value;
  }
}

/** A store left by a turn that saved its tool call and then died, followed by
 *  the next user message (saved before the resumed run starts). */
function interruptedStore() {
  const store = createInMemorySessionStore();
  store.upsertSession({ sessionId: SESSION, model: 'm', provider: 'recording' });
  const rows: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'run echo' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call-1', name: 'Echo', input: { text: 'hi' } }],
    },
    { role: 'user', content: [{ type: 'text', text: 'what happened?' }] },
  ];
  for (const row of rows) store.saveMessage(SESSION, { role: row.role, content: row.content });
  const stored = store
    .loadMessages(SESSION)
    .map((row): Message => ({ role: row.role as Message['role'], content: row.content }));
  return { store, stored };
}

describe('storedPrefixLength', () => {
  test('a resumed orphan gets an interrupted result, is not re-run, and nothing is saved twice', async () => {
    const { store, stored } = interruptedStore();
    const { messages: view, insertedToolResults } = repairMissingToolResults(stored);
    expect(insertedToolResults).toBe(1);
    const calls: string[] = [];
    const { provider, requests } = recording([textTurn('it was interrupted')]);
    const agent = createAgent({
      provider,
      model: 'm',
      sessionStore: store,
      tools: [spyTool('Echo', calls)],
    });

    const result = await drain(
      agent.run(view, { sessionId: SESSION, storedPrefixLength: view.length }),
    );

    expect(result.terminal.reason).toBe('completed');
    expect(calls).toEqual([]);
    const sent = JSON.stringify(requests[0]?.messages);
    expect(sent).toContain('"tool_use_id":"call-1"');
    expect(sent).toContain('"is_error":true');
    const rows = store.loadMessages(SESSION);
    expect(rows).toHaveLength(stored.length + 1);
    // The legacy record is retained verbatim; only the reply is appended.
    expect(rows.slice(0, stored.length).map((r) => r.content)).toEqual(
      stored.map((m) => m.content),
    );
    expect(rows[rows.length - 1]?.role).toBe('assistant');
  });

  test('without the boundary the repaired view is written again (the gap it closes)', async () => {
    const { store, stored } = interruptedStore();
    const { messages: view } = repairMissingToolResults(stored);
    const { provider } = recording([textTurn('ok')]);
    const agent = createAgent({ provider, model: 'm', sessionStore: store });
    await drain(agent.run(view, { sessionId: SESSION }));
    expect(store.loadMessages(SESSION).length).toBeGreaterThan(stored.length + 1);
  });

  test('save-before-tool honours the boundary: each new row is written once, call saved before it runs', async () => {
    const { store, stored } = interruptedStore();
    const { messages: view } = repairMissingToolResults(stored);
    const order: string[] = [];
    const save = store.saveMessage.bind(store);
    store.saveMessage = (sessionId, msg) => {
      order.push(`save:${msg.role}`);
      return save(sessionId, msg);
    };
    const calls: string[] = [];
    const echo = buildTool({
      name: 'Echo',
      description: () => 'Echo',
      inputSchema: z.object({ text: z.string().optional() }),
      async call() {
        calls.push('Echo');
        order.push('call');
        return { data: { ok: true } };
      },
    });
    const { provider } = recording([toolTurn('call-2', 'Echo'), textTurn('done')]);
    const agent = createAgent({ provider, model: 'm', sessionStore: store, tools: [echo] });

    const result = await drain(
      agent.run(view, { sessionId: SESSION, storedPrefixLength: view.length }),
    );

    expect(result.terminal.reason).toBe('completed');
    expect(calls).toEqual(['Echo']);
    expect(order).toEqual(['save:assistant', 'call', 'save:user', 'save:assistant']);
    const rows = store.loadMessages(SESSION);
    expect(rows).toHaveLength(stored.length + 3);
    const toolCalls = rows.filter((r) => JSON.stringify(r.content).includes('"id":"call-2"'));
    expect(toolCalls).toHaveLength(1);
    const results = rows.filter((r) =>
      JSON.stringify(r.content).includes('"tool_use_id":"call-2"'),
    );
    expect(results).toHaveLength(1);
  });

  test('a boundary inside the input saves the unsaved seed tail with the tool call', async () => {
    const store = createInMemorySessionStore();
    store.upsertSession({ sessionId: SESSION, model: 'm', provider: 'recording' });
    const first: Message = { role: 'user', content: [{ type: 'text', text: 'one' }] };
    store.saveMessage(SESSION, first);
    const second: Message = { role: 'user', content: [{ type: 'text', text: 'two' }] };
    const calls: string[] = [];
    const { provider } = recording([toolTurn('call-3', 'Echo'), textTurn('done')]);
    const agent = createAgent({
      provider,
      model: 'm',
      sessionStore: store,
      tools: [spyTool('Echo', calls)],
    });
    await drain(agent.run([first, second], { sessionId: SESSION, storedPrefixLength: 1 }));
    const roles = store.loadMessages(SESSION).map((r) => r.role);
    expect(roles).toEqual(['user', 'user', 'assistant', 'user', 'assistant']);
  });

  test('an out-of-range boundary fails before the provider is called', async () => {
    const { provider, requests } = recording([textTurn('x')]);
    const agent = createAgent({ provider, model: 'm', sessionStore: createInMemorySessionStore() });
    for (const bad of [-1, 2, 0.5]) {
      const result = await drain(agent.run('hi', { storedPrefixLength: bad }));
      expect(result.terminal.reason).toBe('error');
      expect(result.terminal.error).toBeInstanceOf(RangeError);
    }
    expect(requests).toHaveLength(0);
  });
});

describe('toolset execution', () => {
  test('a call to a tool outside the toolset is not executed even if the model emits it', async () => {
    const calls: string[] = [];
    const { provider, requests } = recording([toolTurn('call-4', 'Bash'), textTurn('done')]);
    const agent = createAgent({
      provider,
      model: 'm',
      toolset: 'web',
      maxTurns: 4,
      tools: [spyTool('Bash', calls), spyTool('WebSearch', calls)],
    });
    const result = await drain(agent.run('hi'));
    expect(requests[0]?.tools?.map((t) => t.name)).toEqual(['WebSearch']);
    expect(calls).toEqual([]);
    const toolResult = result.messages
      .flatMap((m) => m.content)
      .find((b) => b.type === 'tool_result');
    expect(toolResult).toMatchObject({ tool_use_id: 'call-4', is_error: true });
  });
});

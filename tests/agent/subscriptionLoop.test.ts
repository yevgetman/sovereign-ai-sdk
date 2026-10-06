// Toolset filter, maxTurns defaults, and save-before-run.

import { describe, expect, test } from 'bun:test';
import { createAgent } from '@yevgetman/sov-sdk/agent/createAgent';
import type { AssistantMessage, Message, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import { createInMemorySessionStore } from '@yevgetman/sov-sdk/persistence/inMemoryStore';
import type { SessionStore } from '@yevgetman/sov-sdk/persistence/sessionStore';
import {
  CredentialUnavailableError,
  PersistBeforeRunError,
  UnknownToolsetError,
} from '@yevgetman/sov-sdk/providers/errors';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import { intersectToolNames, wrapToolsetCanUseTool } from '@yevgetman/sov-sdk/tool/toolset';
import type { Tool } from '@yevgetman/sov-sdk/tool/types';
import { z } from 'zod';

const answer: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'done' }],
};

const textTurn: StreamEvent[] = [
  { type: 'message_start' },
  { type: 'text_delta', text: 'done' },
  { type: 'message_stop', stop_reason: 'end_turn' },
  { type: 'assistant_message', message: answer },
];

const toolMessage: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 't1', name: 'Echo', input: { text: 'hi' } }],
};

const toolTurn: StreamEvent[] = [
  { type: 'message_start' },
  { type: 'message_stop', stop_reason: 'tool_use' },
  { type: 'assistant_message', message: toolMessage },
];

function recording(turns: StreamEvent[][]): { provider: LLMProvider; requests: ProviderRequest[] } {
  const queue = turns.map((turn) => [...turn]);
  const requests: ProviderRequest[] = [];
  const provider: LLMProvider = {
    name: 'recording',
    async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      requests.push(req);
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

function namedTool(name: string, onCall?: () => void) {
  return buildTool({
    name,
    description: () => name,
    inputSchema: z.object({ text: z.string().optional() }),
    async call() {
      onCall?.();
      return { data: { ok: true } };
    },
  });
}

async function run(agent: ReturnType<typeof createAgent>, input: string | Message[] = 'hi') {
  const gen = agent.run(input);
  for (;;) {
    const step = await gen.next();
    if (step.done) return step.value;
  }
}

describe('toolset', () => {
  test('chat sends no tool schemas and defaults maxTurns to 1', async () => {
    const { provider, requests } = recording([textTurn]);
    let polls = 0;
    const result = await run(
      createAgent({
        provider,
        model: 'm',
        tools: [namedTool('Bash'), namedTool('WebSearch')],
        toolset: 'chat',
        pollSteering: async () => {
          polls += 1;
          return null;
        },
      }),
    );
    expect(result.terminal.reason).toBe('completed');
    expect(requests[0]?.tools).toBeUndefined();
    expect(polls).toBe(0);
  });

  test('a caller maxTurns wins over the chat default', async () => {
    const { provider } = recording([textTurn]);
    let polls = 0;
    await run(
      createAgent({
        provider,
        model: 'm',
        toolset: 'chat',
        maxTurns: 3,
        pollSteering: async () => {
          polls += 1;
          return null;
        },
      }),
    );
    expect(polls).toBe(1);
  });

  test('web publishes only WebSearch and WebFetch', async () => {
    const { provider, requests } = recording([textTurn]);
    await run(
      createAgent({
        provider,
        model: 'm',
        toolset: 'web',
        tools: [namedTool('WebSearch'), namedTool('WebFetch'), namedTool('Bash')],
      }),
    );
    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(['WebSearch', 'WebFetch']);
  });

  test('ops drops coding and web tools', async () => {
    const { provider, requests } = recording([textTurn]);
    await run(
      createAgent({
        provider,
        model: 'm',
        toolset: 'ops',
        tools: [
          namedTool('memory'),
          namedTool('Bash'),
          namedTool('FileRead'),
          namedTool('FileWrite'),
          namedTool('FileEdit'),
          namedTool('AgentTool'),
          namedTool('WebSearch'),
          namedTool('HarnessInfo'),
        ],
      }),
    );
    const names = requests[0]?.tools?.map((tool) => tool.name) ?? [];
    expect(names).toEqual(['memory', 'HarnessInfo']);
    for (const blocked of ['Bash', 'FileRead', 'FileWrite', 'FileEdit', 'AgentTool', 'WebSearch']) {
      expect(names).not.toContain(blocked);
    }
  });

  test('an omitted toolset keeps the assembled names', async () => {
    const tools = [namedTool('Bash'), namedTool('memory')];
    const { provider, requests } = recording([textTurn]);
    await run(createAgent({ provider, model: 'm', tools }));
    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(['Bash', 'memory']);
  });

  test('an unknown toolset fails before stream', async () => {
    const { provider, requests } = recording([textTurn]);
    const result = await run(createAgent({ provider, model: 'm', toolset: 'chatty' }));
    expect(result.terminal.reason).toBe('error');
    expect(result.terminal.error).toBeInstanceOf(UnknownToolsetError);
    expect(requests).toHaveLength(0);
  });

  test('a skill allow-list cannot add Bash to ops', async () => {
    const ops = ['memory', 'skills_list'];
    expect(intersectToolNames(ops, ['Bash', 'memory'])).toEqual(['memory']);
    const decision = await wrapToolsetCanUseTool(undefined, [{ name: 'memory' }])(
      { name: 'Bash' } as Tool<unknown, unknown>,
      {},
      { cwd: '/tmp', sessionId: 's' },
    );
    expect(decision).toEqual({ behavior: 'deny', reason: 'tool is outside the turn toolset' });
  });

  test('string chatgpt still fails inside createAgent', async () => {
    const agent = createAgent({ provider: 'chatgpt', model: 'gpt-5.3-codex', settings: {} });
    await expect(run(agent)).rejects.toBeInstanceOf(CredentialUnavailableError);
  });
});

describe('save before run', () => {
  test('the assistant tool call is saved before the tool runs', async () => {
    const order: string[] = [];
    const store = createInMemorySessionStore();
    const save = store.saveMessage.bind(store);
    store.saveMessage = (sessionId, msg) => {
      order.push(`save:${msg.role}:${msg.toolCalls ? 'tools' : 'plain'}`);
      return save(sessionId, msg);
    };
    const { provider } = recording([toolTurn, textTurn]);
    const result = await run(
      createAgent({
        provider,
        model: 'm',
        sessionStore: store,
        tools: [
          namedTool('Echo', () => {
            order.push('call');
          }),
        ],
      }),
    );
    expect(result.terminal.reason).toBe('completed');
    expect(order.indexOf('save:assistant:tools')).toBeGreaterThan(-1);
    expect(order.indexOf('save:assistant:tools')).toBeLessThan(order.indexOf('call'));
    const assistants = store
      .loadMessages(result.sessionId)
      .filter(
        (row) => row.role === 'assistant' && JSON.stringify(row.content).includes('tool_use'),
      );
    expect(assistants).toHaveLength(1);
  });

  test('a throwing store does not run the tool', async () => {
    let called = false;
    const inner = createInMemorySessionStore();
    const store: SessionStore = {
      createSession: (input) => inner.createSession(input),
      upsertSession: () => {
        throw new Error('secret token sk-live');
      },
      getSession: (id, owner) => inner.getSession(id, owner),
      updateSessionModel: (id, model) => inner.updateSessionModel(id, model),
      saveMessage: () => {
        throw new Error('secret token sk-live');
      },
      loadMessages: (id) => inner.loadMessages(id),
      truncateMessages: (id, keep) => inner.truncateMessages(id, keep),
      recordTokenUsage: (id, usage, cost) => inner.recordTokenUsage(id, usage, cost),
    };
    const { provider } = recording([toolTurn, textTurn]);
    const result = await run(
      createAgent({
        provider,
        model: 'm',
        sessionStore: store,
        tools: [
          namedTool('Echo', () => {
            called = true;
          }),
        ],
      }),
    );
    expect(called).toBe(false);
    expect(result.terminal.reason).toBe('error');
    expect(result.terminal.error).toBeInstanceOf(PersistBeforeRunError);
    expect(result.terminal.error?.message).toBe('tool call was not run: transcript write failed');
    expect(JSON.stringify(result.messages)).not.toContain('sk-live');
  });

  test('no store still runs the tool', async () => {
    let called = false;
    const { provider } = recording([toolTurn, textTurn]);
    const result = await run(
      createAgent({
        provider,
        model: 'm',
        tools: [
          namedTool('Echo', () => {
            called = true;
          }),
        ],
      }),
    );
    expect(called).toBe(true);
    expect(result.terminal.reason).toBe('completed');
  });
});

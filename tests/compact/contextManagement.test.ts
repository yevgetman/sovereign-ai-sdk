import { describe, expect, test } from 'bun:test';
import { createAgent, createInMemorySessionStore } from '@yevgetman/sov-sdk';
import type {
  ContextManagementPort,
  ContextManagementRequest,
} from '@yevgetman/sov-sdk/compact/contextManagement';
import { ContextManagementError, historyBytes } from '@yevgetman/sov-sdk/compact/contextManagement';
import type { AssistantMessage, Message, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import type { SessionStore } from '@yevgetman/sov-sdk/persistence/sessionStore';
import { RegenerationRollbackUnavailableError } from '@yevgetman/sov-sdk/providers/errors';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import { z } from 'zod';

const seed: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'old '.repeat(2000) }] },
  { role: 'assistant', content: [{ type: 'text', text: 'old reply' }] },
  { role: 'user', content: [{ type: 'text', text: 'latest request' }] },
];
const answer: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'answer' }] };
function port(onRequest?: (req: ContextManagementRequest) => void): ContextManagementPort {
  return {
    async reduce(request) {
      onRequest?.(request);
      return {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Earlier history summarized.' }] },
          structuredClone(request.messages.at(-1) as Message),
        ],
        usage: { inputTokens: 9, outputTokens: 2 },
        estimatedCostUsd: 0.01,
      };
    },
  };
}
function provider(turn?: (call: number) => AssistantMessage | Error | 'partial-error') {
  const requests: ProviderRequest[] = [];
  const result: LLMProvider = {
    name: 'fixture',
    async *stream(request) {
      const { signal: _signal, ...snapshot } = request;
      requests.push(structuredClone(snapshot));
      const value = turn?.(requests.length) ?? answer;
      if (value instanceof Error) throw value;
      yield { type: 'message_start' };
      if (value === 'partial-error') {
        yield { type: 'text_delta', text: 'partial' };
        throw new Error('context length exceeded');
      }
      yield { type: 'usage_delta', usage: { inputTokens: 3 } };
      yield { type: 'usage_delta', usage: { outputTokens: 4 } };
      yield {
        type: 'message_stop',
        stop_reason: value.content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
      };
      yield { type: 'assistant_message', message: value };
      return value;
    },
  };
  return { provider: result, requests };
}
async function drain(gen: ReturnType<ReturnType<typeof createAgent>['run']>) {
  const events: (StreamEvent | Message)[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { result: step.value, events };
    events.push(step.value);
  }
}

describe('injected context management', () => {
  test('reduces model context while full transcript rehydration stays verbatim; usage counted once', async () => {
    const store = createInMemorySessionStore();
    const recorded: number[] = [];
    const sessionStore: SessionStore = {
      ...store,
      recordTokenUsage(id, usage, cost) {
        recorded.push(cost);
        store.recordTokenUsage(id, usage, cost);
      },
    };
    const { provider: p, requests } = provider();
    const agent = createAgent({
      provider: p,
      model: 'fixture',
      sessionStore,
      contextManager: port(),
      contextLimits: { maxHistoryBytes: 1000 },
    });
    const original = JSON.stringify(seed);
    const first = await drain(agent.run(seed, { sessionId: 'context-transcript' }));
    expect(first.result.terminal.reason).toBe('completed');
    expect(historyBytes(requests[0]?.messages ?? [])).toBeLessThan(1000);
    expect(first.result.messages).toEqual([...seed, answer]);
    expect(
      store.loadMessages('context-transcript').map((m) => ({ role: m.role, content: m.content })),
    ).toEqual(first.result.messages);
    expect(first.result.usage).toEqual({ inputTokens: 12, outputTokens: 6 });
    expect(first.result.estimatedCostUsd).toBe(0.01);
    expect(recorded).toEqual([0.01]);
    expect(first.events.filter((e) => 'type' in e && e.type === 'message_start')).toHaveLength(1);
    expect(first.events.filter((e) => 'type' in e && e.type === 'context_management')).toHaveLength(
      1,
    );
    expect(JSON.stringify(seed)).toBe(original);
    await drain(
      agent.run(
        [...first.result.messages, { role: 'user', content: [{ type: 'text', text: 'followup' }] }],
        { sessionId: 'context-transcript' },
      ),
    );
    expect(store.loadMessages('context-transcript')).toHaveLength(seed.length + 3);
  });

  test('per-turn context port overrides standing port; absent port leaves history unchanged', async () => {
    const { provider: p, requests } = provider();
    await drain(createAgent({ provider: p, model: 'fixture' }).run(seed));
    expect(requests[0]?.messages).toEqual(seed);
    let calls = 0;
    const agent = createAgent({
      provider: p,
      model: 'fixture',
      contextManager: {
        async reduce() {
          throw new Error('wrong port');
        },
      },
      contextLimits: { maxHistoryBytes: 1000 },
    });
    expect(
      (await drain(agent.run(seed, { contextManager: port(() => calls++) }))).result.terminal
        .reason,
    ).toBe('completed');
    expect(calls).toBe(1);
  });

  test('recovers overflow once before output; never recovers after partial output', async () => {
    for (const alwaysFails of [false, true]) {
      let reductions = 0;
      const { provider: p, requests } = provider((n) =>
        alwaysFails || n === 1 ? new Error('context length exceeded') : answer,
      );
      const { result } = await drain(
        createAgent({
          provider: p,
          model: 'fixture',
          contextManager: port(() => reductions++),
          contextLimits: { maxHistoryBytes: 100000 },
        }).run(seed),
      );
      expect(requests).toHaveLength(2);
      expect(reductions).toBe(1);
      expect(result.terminal.reason).toBe(alwaysFails ? 'error' : 'completed');
    }
    const { provider: p, requests } = provider(() => 'partial-error');
    let reductions = 0;
    const { result } = await drain(
      createAgent({
        provider: p,
        model: 'fixture',
        contextManager: port(() => reductions++),
        contextLimits: { maxHistoryBytes: 100000 },
      }).run(seed),
    );
    expect(result.terminal.reason).toBe('error');
    expect(requests).toHaveLength(1);
    expect(reductions).toBe(0);
  });

  test('never retries overflow after a tool runs and preserves early persisted tool transcript', async () => {
    let effects = 0;
    let reductions = 0;
    const use: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'c', name: 'Echo', input: {} }],
    };
    const { provider: p, requests } = provider((n) =>
      n === 1 ? use : new Error('context length exceeded'),
    );
    const store = createInMemorySessionStore();
    const { result } = await drain(
      createAgent({
        provider: p,
        model: 'fixture',
        sessionStore: store,
        tools: [
          buildTool({
            name: 'Echo',
            description: () => 'echo',
            inputSchema: z.object({}),
            async call() {
              effects++;
              return { data: 'done' };
            },
          }),
        ],
        contextManager: port(() => reductions++),
        contextLimits: { maxHistoryBytes: 100000 },
      }).run(seed, { sessionId: 'context-tools' }),
    );
    expect(result.terminal.reason).toBe('error');
    expect(effects).toBe(1);
    expect(requests).toHaveLength(2);
    expect(reductions).toBe(0);
    expect(store.loadMessages('context-tools')).toHaveLength(seed.length + 2);
    expect(store.loadMessages('context-tools')[0]?.content).toEqual(seed[0]?.content);
  });

  test('rejects empty, inflated, malformed, orphan-tool and changed-tail summaries before provider runs', async () => {
    const replacements: Message[][] = [
      [{ role: 'user', content: [{ type: 'text', text: '   ' }] }, seed.at(-1) as Message],
      [],
      seed,
      [{ role: 'user', content: [] }],
      [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'bad' }] }],
      [{ role: 'user', content: [{ type: 'text', text: 'changed latest request' }] }],
    ];
    for (const messages of replacements) {
      const { provider: p, requests } = provider();
      const { result } = await drain(
        createAgent({
          provider: p,
          model: 'fixture',
          contextManager: {
            async reduce() {
              return { messages };
            },
          },
          contextLimits: { maxHistoryBytes: 1000 },
        }).run(seed),
      );
      expect(result.terminal.reason).toBe('error');
      expect(result.terminal.error).toBeInstanceOf(ContextManagementError);
      expect(requests).toHaveLength(0);
    }
  });

  test('preserves complete adjacent tool pairs in model context and accounts rejected summaries', async () => {
    const use: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'existing', name: 'Echo', input: {} }],
    };
    const resultMessage: Message = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'existing', content: 'result' }],
    };
    const input: Message[] = [...seed, use, resultMessage];
    const { provider: p, requests } = provider();
    const manager: ContextManagementPort = {
      async reduce() {
        return {
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'summary' }] },
            use,
            resultMessage,
          ],
          usage: { inputTokens: 2 },
          estimatedCostUsd: 0.02,
        };
      },
    };
    expect(
      (
        await drain(
          createAgent({
            provider: p,
            model: 'fixture',
            contextManager: manager,
            contextLimits: { maxHistoryBytes: 1000 },
          }).run(input),
        )
      ).result.terminal.reason,
    ).toBe('completed');
    expect(requests[0]?.messages.slice(-2)).toEqual([use, resultMessage]);
    const rejected = await drain(
      createAgent({
        provider: p,
        model: 'fixture',
        contextManager: {
          async reduce() {
            return { messages: [], usage: { inputTokens: 8 }, estimatedCostUsd: 0.03 };
          },
        },
        contextLimits: { maxHistoryBytes: 1000 },
      }).run(seed),
    );
    expect(rejected.result.terminal.reason).toBe('error');
    expect(rejected.result.usage).toEqual({ inputTokens: 8 });
    expect(rejected.result.estimatedCostUsd).toBe(0.03);
    expect(rejected.events).toContainEqual({
      type: 'context_management',
      info: {
        applied: false,
        reason: 'budget',
        beforeBytes: historyBytes(seed),
        afterBytes: historyBytes(seed),
        usage: { inputTokens: 8 },
        estimatedCostUsd: 0.03,
      },
    });
  });

  test('a port cannot mutate live history or widen the configured envelope', async () => {
    const limits = { maxHistoryBytes: 1000 };
    const { provider: p, requests } = provider();
    const original = JSON.stringify(seed);
    const { result } = await drain(
      createAgent({
        provider: p,
        model: 'fixture',
        contextLimits: limits,
        contextManager: {
          async reduce(req) {
            req.limits.maxHistoryBytes = 100000;
            const first = req.messages[0]?.content[0];
            if (first?.type === 'text') first.text = 'changed';
            return {
              messages: [
                { role: 'user', content: [{ type: 'text', text: 'summary '.repeat(250) }] },
                req.messages.at(-1) as Message,
              ],
            };
          },
        },
      }).run(seed),
    );
    expect(result.terminal.reason).toBe('error');
    expect(requests).toHaveLength(0);
    expect(limits.maxHistoryBytes).toBe(1000);
    expect(JSON.stringify(seed)).toBe(original);
  });

  test('invalid limits and disabled overflow retries fail without provider replays', async () => {
    const { provider: p, requests } = provider(() => new Error('context length exceeded'));
    const disabled = await drain(
      createAgent({
        provider: p,
        model: 'fixture',
        contextManager: port(),
        contextLimits: { maxHistoryBytes: 100000, maxOverflowRetries: 0 },
      }).run(seed),
    );
    expect(disabled.result.terminal.reason).toBe('error');
    expect(requests).toHaveLength(1);
    const invalid = await drain(
      createAgent({
        provider: p,
        model: 'fixture',
        contextManager: port(),
        contextLimits: { maxHistoryBytes: -1 },
      }).run(seed),
    );
    expect(invalid.result.terminal.error).toBeInstanceOf(ContextManagementError);
    expect(requests).toHaveLength(1);
  });

  test('cancellation settles the supplied port and starts no provider work', async () => {
    const abort = new AbortController();
    let settled = false;
    const manager: ContextManagementPort = {
      async reduce(req) {
        await new Promise<void>((_resolve, reject) => {
          req.signal.addEventListener(
            'abort',
            () => {
              settled = true;
              reject(req.signal.reason);
            },
            { once: true },
          );
          abort.abort();
        });
        return { messages: [] };
      },
    };
    const { provider: p, requests } = provider();
    const { result } = await drain(
      createAgent({
        provider: p,
        model: 'fixture',
        contextManager: manager,
        contextLimits: { maxHistoryBytes: 1000 },
      }).run(seed, { signal: abort.signal }),
    );
    expect(result.terminal.reason).toBe('interrupted');
    expect(settled).toBe(true);
    expect(requests).toHaveLength(0);
  });

  test('unpriced summary cost remains unknown and is not persisted as zero', async () => {
    const { provider: p } = provider();
    const recorded: number[] = [];
    const store = createInMemorySessionStore();
    const { result } = await drain(
      createAgent({
        provider: p,
        model: 'fixture',
        sessionStore: {
          ...store,
          recordTokenUsage(_id, _usage, cost) {
            recorded.push(cost);
          },
        },
        contextManager: {
          async reduce(req) {
            return {
              messages: [
                { role: 'user', content: [{ type: 'text', text: 'summary' }] },
                req.messages.at(-1) as Message,
              ],
              usage: { inputTokens: 9 },
            };
          },
        },
        contextLimits: { maxHistoryBytes: 1000 },
      }).run(seed),
    );
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 4 });
    expect(result.estimatedCostUsd).toBeUndefined();
    expect(recorded).toEqual([]);
  });

  test('legacy SessionStore without truncateMessages works normally and fails closed if regeneration needs rollback', async () => {
    const inner = createInMemorySessionStore();
    const { truncateMessages: _unused, ...legacy } = inner;
    const { provider: p } = provider();
    expect(
      (
        await drain(
          createAgent({ provider: p, model: 'fixture', sessionStore: legacy }).run('hello'),
        )
      ).result.terminal.reason,
    ).toBe('completed');
    const use: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'c', name: 'Echo', input: {} }],
    };
    const { provider: p2, requests } = provider((n) => (n === 1 ? use : answer));
    let effects = 0;
    const { result } = await drain(
      createAgent({
        provider: p2,
        model: 'fixture',
        sessionStore: legacy,
        tools: [
          buildTool({
            name: 'Echo',
            description: () => 'echo',
            inputSchema: z.object({}),
            async call() {
              effects++;
              return { data: 'done' };
            },
          }),
        ],
        conduct: {
          outputGuard: {
            onFinal(message) {
              return message.content.some((b) => b.type === 'tool_use')
                ? { action: 'pass' }
                : { action: 'regenerate' };
            },
          },
        },
      }).run('hello', { sessionId: 'legacy-rollback' }),
    );
    expect(result.terminal.reason).toBe('error');
    expect(result.terminal.error).toBeInstanceOf(RegenerationRollbackUnavailableError);
    expect(effects).toBe(1);
    expect(requests).toHaveLength(2);
    expect(inner.loadMessages('legacy-rollback')).toHaveLength(3);
  });
});

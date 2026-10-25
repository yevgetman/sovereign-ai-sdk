import { expect, test } from 'bun:test';
import { type RunResult, createAgent } from '@yevgetman/sov-sdk/agent/createAgent';
import { query } from '@yevgetman/sov-sdk/core/query';
import type {
  AssistantMessage,
  Message,
  ModelCallBudget,
  QueryParams,
  StreamEvent,
  Terminal,
} from '@yevgetman/sov-sdk/core/types';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import { CapabilityProfileRegistry } from '@yevgetman/sov-sdk/tool/capabilityProfiles';
import { z } from 'zod';

const seed: Message = {
  role: 'user',
  content: [{ type: 'text', text: 'Investigate every page and preserve the request.' }],
};
const context = { cwd: '/tmp', sessionId: 'continuous-test', model: 'fixture' };
function fixture(total: number, sameInput = false) {
  let calls = 0;
  let effects = 0;
  let largestContext = 0;
  const provider: LLMProvider = {
    name: 'fixture',
    async *stream(request: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      largestContext = Math.max(largestContext, JSON.stringify(request.messages).length);
      calls++;
      const message: AssistantMessage = {
        role: 'assistant',
        content:
          calls <= total
            ? [
                {
                  type: 'tool_use',
                  id: `call-${calls}`,
                  name: 'page',
                  input: { cursor: sameInput ? 0 : calls },
                },
              ]
            : [{ type: 'text', text: 'All pages investigated.' }],
      };
      yield { type: 'message_start' };
      yield { type: 'message_stop', stop_reason: calls <= total ? 'tool_use' : 'end_turn' };
      yield { type: 'assistant_message', message };
      return message;
    },
  };
  const tool = buildTool<unknown, unknown>({
    name: 'page',
    description: () => 'Read the next page',
    inputSchema: z.unknown(),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    checkPermissions: async () => ({ behavior: 'allow' as const }),
    call: async () => ({ data: ++effects }),
    renderResult: (data) => ({ content: `page ${data}: new read-only evidence ${'x'.repeat(80)}` }),
  });
  return {
    provider,
    tool,
    get calls() {
      return calls;
    },
    get effects() {
      return effects;
    },
    get largestContext() {
      return largestContext;
    },
  };
}
async function drain(gen: AsyncGenerator<StreamEvent | Message, Terminal>) {
  for (;;) {
    const step = await gen.next();
    if (step.done) return step.value;
  }
}
function params(f: ReturnType<typeof fixture>): QueryParams {
  return {
    provider: f.provider,
    model: 'fixture',
    messages: [seed],
    systemPrompt: [],
    tools: [f.tool],
    toolContext: context,
    maxTokens: 64,
    contextLimits: { maxHistoryBytes: 3000 },
    contextManager: {
      reduce: async (request) => ({ messages: [seed, ...request.messages.slice(-2)] }),
    },
  };
}
test('root omission and explicit null finish 1005 productive pages with bounded context', async () => {
  for (const maxTurns of [undefined, null]) {
    const f = fixture(1005);
    const p = params(f);
    if (maxTurns !== undefined) p.maxTurns = maxTurns;
    expect((await drain(query(p))).reason).toBe('completed');
    expect(f.calls).toBe(1006);
    expect(f.effects).toBe(1005);
    expect(f.largestContext).toBeLessThanOrEqual(3000);
  }
});
test('identical calls with changing results make progress beyond 1000 calls', async () => {
  const f = fixture(1005, true);
  expect((await drain(query(params(f)))).reason).toBe('completed');
  expect(f.effects).toBe(1005);
});
test('SDK and profile null override finite configured defaults; toolsets add no budget', async () => {
  const registry = new CapabilityProfileRegistry([{ name: 'reader', tools: ['page'] }]);
  expect(registry.maxTurns('ops')).toBeNull();
  expect(registry.maxTurns('reader')).toBeNull();
  const f = fixture(120);
  const agent = createAgent({
    provider: f.provider,
    model: 'fixture',
    maxTurns: 2,
    tools: [f.tool],
    maxTokens: 64,
  });
  const run = agent.run([seed], { maxTurns: null, toolContext: context });
  let result: RunResult;
  for (;;) {
    const s = await run.next();
    if (s.done) {
      result = s.value;
      break;
    }
  }
  expect(result.terminal.reason).toBe('completed');
  expect(f.calls).toBe(121);
});
test('finite own and ancestor policies are exact and null never clears parent', async () => {
  for (const ancestor of [false, true]) {
    const f = fixture(50);
    const parent: ModelCallBudget = { limit: 7, used: 0 };
    const p = params(f);
    p.maxTurns = ancestor ? null : 7;
    if (ancestor) p.modelCallBudget = parent;
    expect((await drain(query(p))).reason).toBe('max_turns');
    expect(f.calls).toBe(7);
    expect(f.effects).toBe(7);
    if (ancestor) expect(parent.used).toBe(7);
  }
});
test('slice does not become an inherited child authority ceiling', async () => {
  const f = fixture(50);
  const p = params(f);
  p.executionSliceModelCalls = 1;
  let inherited: ModelCallBudget | undefined;
  p.tools = [
    {
      ...f.tool,
      call: async (_input, ctx) => {
        inherited = ctx.modelCallBudget;
        return { data: 1 };
      },
    },
  ];
  expect((await drain(query(p))).reason).toBe('max_turns');
  expect(inherited?.limit).toBeNull();
  expect(inherited?.used).toBe(1);
});
test('zero negative fractional and nonfinite limits reject without provider work', async () => {
  for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const f = fixture(1);
    const p = params(f);
    p.maxTurns = invalid;
    const terminal = await drain(query(p));
    expect(terminal.reason).toBe('error');
    expect(f.calls).toBe(0);
  }
});
test('agent active transcript is bounded across multiple reductions', async () => {
  const f = fixture(1005);
  const p = params(f);
  const agent = createAgent({
    provider: f.provider,
    model: 'fixture',
    tools: [f.tool],
    maxTokens: 64,
    ...(p.contextLimits ? { contextLimits: p.contextLimits } : {}),
    ...(p.contextManager ? { contextManager: p.contextManager } : {}),
  });
  const gen = agent.run([seed], { toolContext: context });
  let result: RunResult;
  for (;;) {
    const s = await gen.next();
    if (s.done) {
      result = s.value;
      break;
    }
  }
  expect(result.terminal.reason).toBe('completed');
  expect(f.calls).toBe(1006);
  expect(result.messages.length).toBeLessThan(30);
});

test('owner final waits for its own task completion without model polling or unrelated global work', async () => {
  const f = fixture(1);
  let state: import('@yevgetman/sov-sdk/core/taskPort').TaskState = 'running';
  let getCalls = 0;
  const record = () => ({
    id: 'owned',
    parentSessionId: 'continuous-test',
    agent: 'reader',
    prompt: 'read',
    state,
    createdAt: '2026-10-24',
    updatedAt: '2026-10-24',
  });
  const manager: import('@yevgetman/sov-sdk/tool/ports').TaskManagerPort = {
    create: async () => record(),
    get: (id) => {
      getCalls++;
      return id === 'owned' ? record() : null;
    },
    list: () => [{ ...record(), id: 'unrelated', state: 'running' }],
    stop: async () => null,
    output: () => ({ state }),
  };
  const p = params(f);
  p.toolContext = { ...context, taskManager: manager };
  p.tools = [
    {
      ...f.tool,
      call: async (_input, ctx) => {
        await ctx.taskManager?.create({
          parentSessionId: ctx.sessionId,
          agentName: 'reader',
          prompt: 'read',
          parentToolPool: [],
          parentToolContext: ctx,
        });
        return { data: 1 };
      },
    },
  ];
  let terminal: Terminal | undefined;
  const running = drain(query(p)).then((result) => {
    terminal = result;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(terminal).toBeUndefined();
  expect(f.calls).toBe(2);
  state = 'completed';
  expect((await running).reason).toBe('completed');
  expect(f.calls).toBe(2);
  expect(getCalls).toBeGreaterThan(0);
});

test('owner stop interrupts known task wait and failed task cannot mean completed', async () => {
  for (const cancelled of [false, true]) {
    const f = fixture(1);
    const controller = new AbortController();
    const p = params(f);
    const state = cancelled ? 'running' : 'failed';
    const record = {
      id: 'owned',
      parentSessionId: 'continuous-test',
      agent: 'reader',
      prompt: 'read',
      state,
      createdAt: '2026-10-24',
      updatedAt: '2026-10-24',
      resultPreview: 'explicit call limit reached',
    } as const;
    const manager: import('@yevgetman/sov-sdk/tool/ports').TaskManagerPort = {
      create: async () => record,
      get: () => record,
      list: () => [],
      stop: async () => record,
      output: () => ({ state, terminalReason: 'max_turns' }),
    };
    p.signal = controller.signal;
    p.toolContext = { ...context, taskManager: manager };
    p.tools = [
      {
        ...f.tool,
        call: async (_input, ctx) => {
          await ctx.taskManager?.create({
            parentSessionId: ctx.sessionId,
            agentName: 'reader',
            prompt: 'read',
            parentToolPool: [],
            parentToolContext: ctx,
          });
          return { data: 1 };
        },
      },
    ];
    const running = drain(query(p));
    if (cancelled) setTimeout(() => controller.abort(), 10);
    const terminal = await running;
    expect(terminal.reason).toBe(cancelled ? 'interrupted' : 'error');
    if (!cancelled) expect(terminal.error?.message).toContain('explicit call limit reached');
    expect(f.calls).toBe(2);
  }
});

test('conduct regeneration cannot reset the explicitly bounded agent budget', async () => {
  const f = fixture(0);
  const agent = createAgent({
    provider: f.provider,
    model: 'fixture',
    maxTurns: 1,
    conduct: { outputGuard: { onFinal: () => ({ action: 'regenerate' }) } },
  });
  const run = agent.run([seed]);
  let result: RunResult;
  for (;;) {
    const s = await run.next();
    if (s.done) {
      result = s.value;
      break;
    }
  }
  expect(f.calls).toBe(1);
  expect(result.terminal.reason).toBe('max_turns');
});

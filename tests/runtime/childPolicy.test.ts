import { expect, test } from 'bun:test';
import {
  CapabilityProfileRegistry,
  LaneSemaphores,
  PathLockManager,
  SubagentScheduler,
  TreeBudget,
  buildTool,
  createAgent,
  intersectCanUseTool,
} from '@yevgetman/sov-sdk';
import type {
  AgentDefinition,
  AssistantMessage,
  ChildPolicy,
  LLMProvider,
  StreamEvent,
  Tool,
  ToolContext,
} from '@yevgetman/sov-sdk';
import { z } from 'zod';

const answer: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'done' }] };
const agent: AgentDefinition = {
  name: 'worker',
  description: 'test',
  systemPrompt: 'worker',
  allowedTools: ['Read'],
  maxTurns: 3,
  readOnly: true,
  supportsMissionState: false,
  inheritParentTools: false,
  allowedSubagents: [],
  path: '/tmp/worker',
  realpath: '/tmp/worker',
  dir: '/tmp',
  source: 'bundle',
  trustTier: 'builtin',
};
const input = {
  agentName: 'worker',
  prompt: 'work',
  parentSessionId: 'parent',
  parentToolPool: [],
  parentToolContext: { cwd: '/tmp', sessionId: 'parent' },
};
function scheduler(provider: LLMProvider, policy?: ChildPolicy, definition = agent) {
  let sessions = 0;
  const scheduler = new SubagentScheduler({
    agents: { agents: [definition], byName: new Map([[definition.name, definition]]) },
    laneSemaphores: new LaneSemaphores({ frontier: 2 }),
    pathLock: new PathLockManager(),
    resolveProvider: () => ({
      transport: provider as never,
      client: {},
      baseUrl: 'fake://',
      model: 'gpt-4o-mini',
      contextLength: 10_000,
      authType: 'none',
      metadata: { provider: 'openai' },
    }),
    createChildSession: () => `child-${++sessions}`,
    defaultProvider: 'openai',
    defaultModel: 'gpt-4o-mini',
    maxTokens: 10,
    ...(policy !== undefined ? { childPolicy: policy } : {}),
  });
  return { scheduler, sessions: () => sessions };
}
function completedProvider(
  record?: (request: import('@yevgetman/sov-sdk').ProviderRequest) => void,
): LLMProvider {
  return {
    name: 'openai',
    async *stream(request): AsyncGenerator<StreamEvent, AssistantMessage> {
      record?.(request);
      yield { type: 'message_start' };
      yield { type: 'usage_delta', usage: { inputTokens: 5, outputTokens: 3 } };
      yield { type: 'message_stop', stop_reason: 'end_turn' };
      yield { type: 'assistant_message', message: answer };
      return answer;
    },
  };
}
async function finish(run: ReturnType<ReturnType<typeof createAgent>['run']>) {
  for (;;) {
    const step = await run.next();
    if (step.done) return step.value;
  }
}
const read = buildTool({
  name: 'Read',
  description: () => 'read',
  inputSchema: z.object({}),
  async call() {
    return { data: {} };
  },
});
const external = buildTool({
  name: 'mcp_inventory',
  description: () => 'inventory',
  inputSchema: z.object({}),
  async call() {
    return { data: {} };
  },
});

test('custom profiles require explicit external tool membership, preserve builtins and intersect parents', async () => {
  const registry = new CapabilityProfileRegistry([
    { name: 'inventory', tools: ['mcp_inventory'], maxTurns: 2 },
    { name: 'reader', tools: ['Read'] },
  ]);
  expect(registry.filter('inventory', [read, external]).map((tool) => tool.name)).toEqual([
    'mcp_inventory',
  ]);
  expect(registry.filter('inventory', [read, external], 'reader')).toEqual([]);
  expect(registry.filter('chat', [read, external])).toEqual([]);
  expect(registry.filter('coding', [read, external])).toHaveLength(2);
  expect(() => registry.filter('missing', [read])).toThrow('unknown');
  expect(() => new CapabilityProfileRegistry([{ name: 'coding', tools: ['Read'] }])).toThrow(
    'invalid',
  );
  let visible: string[] = [];
  const result = await finish(
    createAgent({
      provider: completedProvider((request) => {
        visible = request.tools?.map((tool) => tool.name) ?? [];
      }),
      model: 'gpt-4o-mini',
      tools: [read, external],
      toolset: 'inventory',
      capabilityProfiles: registry,
    }).run('inventory'),
  );
  expect(result.terminal.reason).toBe('completed');
  expect(visible).toEqual(['mcp_inventory']);
});

test('children inherit recall, hooks and output governance while tools only narrow', async () => {
  const events: string[] = [];
  const registry = new CapabilityProfileRegistry([{ name: 'reader', tools: ['Read'] }]);
  const { scheduler: children } = scheduler(
    completedProvider((request) => {
      expect(request.tools?.map((tool) => tool.name)).toEqual(['Read']);
      expect(JSON.stringify(request.messages)).toContain('remember');
    }),
    {
      capabilityProfiles: registry,
      profile: 'reader',
      inheritedConfig: {
        recall: async () => ({ injectionText: 'remember', lessons: [] }),
        hookRunner: async (name) => {
          events.push(name);
          return { block: false };
        },
        conduct: { outputGuard: { onFinal: () => ({ action: 'replace', text: 'governed' }) } },
      },
    },
    { ...agent, inheritParentTools: true, capabilityProfile: 'coding' },
  );
  const result = await children.delegate({ ...input, parentToolPool: [read, external] });
  expect(result.summary).toBe('governed');
  expect(events).toContain('UserPromptSubmit');
  expect(events).toContain('Stop');
  expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
  expect(result.estimatedCostUsd).toBeCloseTo(0.00000255, 8);
});

test('narrowing permissions cannot override parent denials or rewrite parent-authorized input', async () => {
  const deny = intersectCanUseTool(
    async () => ({ behavior: 'deny', reason: 'parent' }),
    async () => ({ behavior: 'allow' }),
  );
  expect(
    (await deny(read as unknown as Tool<unknown, unknown>, {}, input.parentToolContext)).behavior,
  ).toBe('deny');
  const rewrite = intersectCanUseTool(undefined, async () => ({
    behavior: 'allow',
    updatedInput: { widened: true },
  }));
  expect(
    (await rewrite(read as unknown as Tool<unknown, unknown>, {}, input.parentToolContext))
      .behavior,
  ).toBe('deny');
});

test('child patterns are enforced on tool input and malformed scopes fail before session creation', async () => {
  const definition = { ...agent, allowedTools: ['Read(safe)'] };
  let calls = 0;
  const gated = buildTool({
    name: 'Read',
    description: () => 'read',
    inputSchema: z.object({ path: z.string() }),
    async preparePermissionMatcher(value) {
      return (pattern) => pattern === value.path;
    },
    async call() {
      calls++;
      return { data: {} };
    },
  });
  let turns = 0;
  const scripted: LLMProvider = {
    name: 'openai',
    async *stream() {
      yield { type: 'message_start' } as const;
      if (turns++ === 0) {
        yield { type: 'message_stop', stop_reason: 'tool_use' } as const;
        const toolAnswer: AssistantMessage = {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't', name: 'Read', input: { path: 'outside' } }],
        };
        yield { type: 'assistant_message', message: toolAnswer } as const;
        return toolAnswer;
      }
      yield { type: 'message_stop', stop_reason: 'end_turn' } as const;
      yield { type: 'assistant_message', message: answer } as const;
      return answer;
    },
  };
  const { scheduler: children } = scheduler(scripted, undefined, definition);
  const result = await children.delegate({ ...input, parentToolPool: [gated] });
  expect(result.terminal.reason).toBe('completed');
  expect(calls).toBe(0);
  const invalid = scheduler(completedProvider(), undefined, {
    ...agent,
    allowedTools: ['Read(unclosed'],
  });
  await expect(invalid.scheduler.delegate({ ...input, parentToolPool: [gated] })).rejects.toThrow();
  expect(invalid.sessions()).toBe(0);
  expect(invalid.scheduler.activeChildren('parent')).toBe(0);
});

test('native recursive tools inherit depth, filtered pool and cumulative child budget', async () => {
  const budget = new TreeBudget({ maxDepth: 1, maxTotalChildren: 3 });
  let nestedDenied = false;
  let childContext: ToolContext | undefined;
  const spawn = buildTool({
    name: 'AgentTool',
    description: () => 'spawn',
    inputSchema: z.object({}),
    async call(_value, ctx) {
      childContext = ctx;
      try {
        await children.delegate({
          ...input,
          parentSessionId: ctx.sessionId,
          parentToolContext: ctx,
          parentToolPool: ctx.parentToolPool ?? [],
        });
      } catch (error) {
        nestedDenied = String(error).includes('depth');
      }
      return { data: {} };
    },
  });
  let turns = 0;
  const scripted: LLMProvider = {
    name: 'openai',
    async *stream() {
      yield { type: 'message_start' } as const;
      if (turns++ === 0) {
        const tools: AssistantMessage = {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'spawn', name: 'AgentTool', input: {} }],
        };
        yield { type: 'message_stop', stop_reason: 'tool_use' } as const;
        yield { type: 'assistant_message', message: tools } as const;
        return tools;
      }
      yield { type: 'message_stop', stop_reason: 'end_turn' } as const;
      yield { type: 'assistant_message', message: answer } as const;
      return answer;
    },
  };
  const fixture = scheduler(
    scripted,
    { treeBudget: budget },
    { ...agent, allowedTools: ['AgentTool'], allowedSubagents: ['worker'] },
  );
  const children = fixture.scheduler;
  await children.delegate({ ...input, parentToolPool: [spawn, external] });
  expect(nestedDenied).toBe(true);
  expect(childContext?.delegationDepth).toBe(1);
  expect(childContext?.parentToolPool?.map((tool) => tool.name)).toEqual(['AgentTool']);
  expect(fixture.sessions()).toBe(1);
  expect(budget.snapshot()).toMatchObject({ totalChildren: 1, activeChildren: 0 });
});

test('token ceilings need explicit host bounds and share accounting across children', async () => {
  const budget = new TreeBudget({ maxTotalTokens: 10 });
  const { scheduler: children } = scheduler(completedProvider(), {
    treeBudget: budget,
    estimateRequestBudget: () => ({ tokens: 10 }),
  });
  const result = await children.delegate(input);
  expect(result.terminal.reason).toBe('completed');
  expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
  const blocked = await children.delegate(input);
  expect(blocked.terminal.reason).toBe('error');
  expect(budget.snapshot()).toMatchObject({
    accountedTokens: 8,
    totalChildren: 2,
    activeChildren: 0,
  });
  const missing = scheduler(completedProvider(), {
    treeBudget: new TreeBudget({ maxTotalTokens: 10 }),
  });
  expect((await missing.scheduler.delegate(input)).terminal.reason).toBe('interrupted');
});

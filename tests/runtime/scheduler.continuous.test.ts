import { describe, expect, spyOn, test } from 'bun:test';
import type { AgentDefinition } from '@yevgetman/sov-sdk/agents/types';
import type { AssistantMessage, ModelCallBudget, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import type { ResolvedProvider } from '@yevgetman/sov-sdk/providers/resolver';
import type { ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import { LaneSemaphores } from '@yevgetman/sov-sdk/runtime/laneSemaphores';
import { PathLockManager } from '@yevgetman/sov-sdk/runtime/pathLock';
import { SubagentScheduler } from '@yevgetman/sov-sdk/runtime/scheduler';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import type { ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { AgentTool } from '@yevgetman/sov-sdk/tools/AgentTool';
import { z } from 'zod';

function definition(name: string, maxTurns: number | null = null): AgentDefinition {
  return {
    name,
    maxTurns,
    description: name,
    systemPrompt: name,
    allowedTools: ['Step', 'AgentTool'],
    allowedSubagents: ['grandchild'],
    inheritParentTools: true,
    readOnly: true,
    supportsMissionState: false,
    path: '/tmp/agent',
    realpath: '/tmp/agent',
    dir: '/tmp',
    source: 'project',
    trustTier: 'trusted',
  };
}
const step = buildTool({
  name: 'Step',
  description: () => 'Make progress',
  inputSchema: z.object({ page: z.number() }),
  isReadOnly: () => true,
  async call(input) {
    return { data: input };
  },
});
function setup(
  opts: {
    childLimit?: number | null;
    calls?: number;
    nested?: boolean;
    timeout?: number | null;
    delayMs?: number;
    advanceClock?: () => void;
  } = {},
) {
  let streams = 0;
  const agents = [definition('child', opts.childLimit ?? null), definition('grandchild')];
  const registry = { agents, byName: new Map(agents.map((a) => [a.name, a])) };
  let session = 0;
  const scheduler = new SubagentScheduler({
    agents: registry,
    laneSemaphores: new LaneSemaphores({}),
    pathLock: new PathLockManager(),
    defaultProvider: 'test',
    defaultModel: 'test',
    maxTokens: 128,
    ...(opts.timeout !== undefined ? { perChildTimeoutMs: opts.timeout } : {}),
    createChildSession: () => `child-${++session}`,
    resolveProvider: () =>
      ({
        transport: {
          name: 'test',
          async *stream(request: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
            streams++;
            opts.advanceClock?.();
            if (opts.delayMs) await Bun.sleep(opts.delayMs);
            const isChild = request.system.some((s) => s.text === 'child');
            const tool = opts.nested && isChild ? 'AgentTool' : 'Step';
            const useTool = opts.nested ? true : streams <= (opts.calls ?? 60);
            const message: AssistantMessage = {
              role: 'assistant',
              content: useTool
                ? [
                    {
                      type: 'tool_use',
                      id: `call-${streams}`,
                      name: tool,
                      input:
                        tool === 'AgentTool'
                          ? { subagent_type: 'grandchild', prompt: 'work' }
                          : { page: streams },
                    },
                  ]
                : [{ type: 'text', text: 'complete' }],
            };
            yield { type: 'message_start' };
            yield { type: 'message_stop', stop_reason: useTool ? 'tool_use' : 'end_turn' };
            yield { type: 'assistant_message', message };
            return message;
          },
        },
        client: {},
        baseUrl: 'fake://',
        model: 'test',
        contextLength: 32000,
        authType: 'none',
        metadata: { provider: 'test' },
      }) as unknown as ResolvedProvider,
  });
  const context: ToolContext = {
    cwd: process.cwd(),
    sessionId: 'parent',
    agents: registry,
    subagentScheduler: scheduler,
    parentToolPool: [step, AgentTool],
  };
  const run = (extra: Partial<ToolContext> = {}, override?: number | null) =>
    scheduler.delegate({
      agentName: 'child',
      prompt: 'work',
      parentSessionId: 'parent',
      parentToolPool: [step, AgentTool],
      parentToolContext: { ...context, ...extra },
      ...(extra.signal ? { parentSignal: extra.signal } : {}),
      ...(override !== undefined ? { perChildTimeoutMsOverride: override } : {}),
    });
  return { scheduler, run, streams: () => streams };
}

describe('continuous child authority', () => {
  test('null child completes beyond former 50-call default', async () => {
    const fixture = setup();
    const result = await fixture.run();
    expect(result.terminal.reason).toBe('completed');
    expect(fixture.streams()).toBe(61);
    expect(result.toolCallCount).toBe(60);
  });
  test('model-call bound does not imply a wall-clock lifetime', async () => {
    let now = Date.now();
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const fixture = setup({
        childLimit: 2,
        calls: 1,
        advanceClock: () => {
          now += 180_000;
        },
      });
      const result = await fixture.run();
      expect(result.terminal.reason).toBe('completed');
      expect(fixture.streams()).toBe(2);
      expect(result.durationMs).toBeGreaterThan(120_000);
    } finally {
      clock.mockRestore();
    }
  });
  test('null child cannot clear a finite parent ceiling', async () => {
    const budget: ModelCallBudget = { limit: 4, used: 1 };
    const fixture = setup();
    const result = await fixture.run({ modelCallBudget: budget });
    expect(fixture.streams()).toBe(3);
    expect(budget.used).toBe(4);
    expect(result.terminal.reason).toBe('max_turns');
    expect(result.summary).toContain('incomplete');
    // A second dispatch cannot refresh the parent authority.
    expect((await fixture.run({ modelCallBudget: budget })).terminal.reason).toBe('max_turns');
    expect(fixture.streams()).toBe(3);
  });
  test('finite child ceiling includes grandchild calls under unlimited parent', async () => {
    const budget: ModelCallBudget = { limit: null, used: 0 };
    const fixture = setup({ childLimit: 3, nested: true });
    const result = await fixture.run({ modelCallBudget: budget });
    expect(result.terminal.reason).toBe('max_turns');
    expect(fixture.streams()).toBe(3);
    expect(budget.used).toBe(3);
    expect(result.summary).toContain('incomplete');
  });
  test.each([null, 1000])(
    'request timeout %s cannot extend finite host timeout',
    async (override) => {
      const fixture = setup({ timeout: 5, delayMs: 20 });
      const result = await fixture.run({}, override);
      expect(result.terminal.reason).toBe('interrupted');
      expect(fixture.streams()).toBe(1);
      expect(fixture.scheduler.activeChildren('parent')).toBe(0);
    },
  );
  test('null timeout cannot clear an expired parent deadline', async () => {
    const fixture = setup();
    await expect(fixture.run({ deadlineAt: Date.now() - 1 }, null)).rejects.toThrow('deadline');
    expect(fixture.streams()).toBe(0);
    expect(fixture.scheduler.activeChildren('parent')).toBe(0);
  });
  test('parent stop cancels continuous child without releasing its authority', async () => {
    const fixture = setup();
    const controller = new AbortController();
    controller.abort(new Error('owner stop'));
    await expect(fixture.run({ signal: controller.signal })).rejects.toThrow('owner stop');
    expect(fixture.streams()).toBe(0);
    expect(fixture.scheduler.activeChildren('parent')).toBe(0);
  });
  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    'rejects invalid explicit timeout %s',
    async (timeout) => {
      const fixture = setup({ timeout });
      await expect(fixture.run()).rejects.toThrow('positive integer or null');
      expect(fixture.streams()).toBe(0);
    },
  );
});

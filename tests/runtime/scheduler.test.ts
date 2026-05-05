// Phase 13.5 — sub-agent scheduler tests. Mocks the provider resolver and
// session-DB factory; uses the live LaneSemaphores + Semaphore primitives
// so the concurrency invariants are exercised end-to-end through the same
// code paths the REPL will use in production.

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { AgentDefinition, AgentRegistry } from '../../src/agents/types.js';
import type { AssistantMessage, StreamEvent } from '../../src/core/types.js';
import type { ResolvedProvider } from '../../src/providers/resolver.js';
import type { LLMProvider, ProviderRequest } from '../../src/providers/types.js';
import { LaneSemaphores } from '../../src/runtime/laneSemaphores.js';
import { SubagentScheduler } from '../../src/runtime/scheduler.js';
import { Semaphore } from '../../src/runtime/semaphore.js';
import { buildTool } from '../../src/tool/buildTool.js';
import type { Tool, ToolContext } from '../../src/tool/types.js';

function makeAgent(over: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: 'explore',
    description: 'A test explore agent',
    systemPrompt: 'You are a test agent. Be concise.',
    allowedTools: ['Read', 'Grep'],
    maxTurns: 5,
    readOnly: true,
    path: '/tmp/explore.md',
    realpath: '/tmp/explore.md',
    dir: '/tmp',
    source: 'bundle',
    trustTier: 'builtin',
    ...over,
  };
}

function makeAgentRegistry(agents: AgentDefinition[]): AgentRegistry {
  const byName = new Map<string, AgentDefinition>();
  for (const a of agents) byName.set(a.name, a);
  return { agents: [...agents], byName };
}

const completedAnswer: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'task complete' }],
};

function completedTurnEvents(): StreamEvent[] {
  return [
    { type: 'message_start' },
    { type: 'text_delta', text: 'task complete' },
    { type: 'message_stop', stop_reason: 'end_turn' },
    { type: 'assistant_message', message: completedAnswer },
  ];
}

function makeFakeResolved(model: string, holdMs = 0): ResolvedProvider {
  const transport: LLMProvider = {
    name: 'fake',
    async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
      for (const ev of completedTurnEvents()) yield ev;
      return completedAnswer;
    },
  };
  return {
    transport: transport as unknown as ResolvedProvider['transport'],
    client: transport,
    baseUrl: 'fake://',
    model,
    contextLength: 32_000,
    authType: 'none',
    metadata: { provider: 'fake' },
  };
}

function makeReadTool(): Tool<unknown, unknown> {
  return buildTool({
    name: 'Read',
    description: () => 'read input',
    inputSchema: z.object({ path: z.string() }),
    async call() {
      return { data: { content: 'fake' } };
    },
  }) as unknown as Tool<unknown, unknown>;
}

function makeAgentToolPlaceholder(): Tool<unknown, unknown> {
  return buildTool({
    name: 'AgentTool',
    description: () => 'agent tool placeholder',
    inputSchema: z.object({ subagent_type: z.string(), prompt: z.string() }),
    async call() {
      return { data: { ignored: true } };
    },
  }) as unknown as Tool<unknown, unknown>;
}

const baseToolContext: ToolContext = {
  cwd: process.cwd(),
  sessionId: 'parent',
};

type SessionRecord = {
  parentSessionId: string;
  agentName: string;
  provider: string;
  model: string;
  childSessionId: string;
};

function makeCreateChildSession(
  records: SessionRecord[],
): SubagentScheduler['opts']['createChildSession'] {
  let counter = 0;
  return (input) => {
    counter++;
    const childSessionId = `child-${counter}`;
    records.push({
      parentSessionId: input.parentSessionId,
      agentName: input.agentName,
      provider: input.provider,
      model: input.model,
      childSessionId,
    });
    return childSessionId;
  };
}

describe('SubagentScheduler', () => {
  test('delegates to a known agent and returns summary + lineage', async () => {
    const records: SessionRecord[] = [];
    const scheduler = new SubagentScheduler({
      agents: makeAgentRegistry([makeAgent({ name: 'explore' })]),
      laneSemaphores: new LaneSemaphores({}),
      writeLock: new Semaphore(1),
      resolveProvider: () => makeFakeResolved('claude-haiku-4-5-20251001'),
      createChildSession: makeCreateChildSession(records),
      defaultProvider: 'anthropic',
      defaultModel: 'claude-haiku-4-5-20251001',
      maxTokens: 256,
    });
    const result = await scheduler.delegate({
      agentName: 'explore',
      prompt: 'find auth code',
      parentSessionId: 'parent-1',
      parentToolPool: [makeReadTool()],
      parentToolContext: baseToolContext,
    });
    expect(result.childSessionId).toBe('child-1');
    expect(result.terminal.reason).toBe('completed');
    expect(result.summary).toBe('task complete');
    expect(result.agentName).toBe('explore');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      parentSessionId: 'parent-1',
      agentName: 'explore',
      provider: 'anthropic',
      childSessionId: 'child-1',
    });
  });

  test('throws on unknown agent name', async () => {
    const scheduler = new SubagentScheduler({
      agents: makeAgentRegistry([]),
      laneSemaphores: new LaneSemaphores({}),
      writeLock: new Semaphore(1),
      resolveProvider: () => makeFakeResolved('any'),
      createChildSession: () => 'child',
      defaultProvider: 'anthropic',
      defaultModel: 'claude-haiku-4-5-20251001',
      maxTokens: 256,
    });
    await expect(
      scheduler.delegate({
        agentName: 'mystery',
        prompt: 'p',
        parentSessionId: 'parent',
        parentToolPool: [],
        parentToolContext: baseToolContext,
      }),
    ).rejects.toThrow(/unknown subagent/);
  });

  test('enforces per-parent child cap', async () => {
    const scheduler = new SubagentScheduler({
      agents: makeAgentRegistry([makeAgent()]),
      laneSemaphores: new LaneSemaphores({}),
      writeLock: new Semaphore(1),
      resolveProvider: () => makeFakeResolved('m', 50),
      createChildSession: makeCreateChildSession([]),
      defaultProvider: 'anthropic',
      defaultModel: 'm',
      maxChildrenPerParent: 1,
      maxTokens: 256,
    });
    const p1 = scheduler.delegate({
      agentName: 'explore',
      prompt: 'a',
      parentSessionId: 'parent',
      parentToolPool: [makeReadTool()],
      parentToolContext: baseToolContext,
    });
    // Wait a tick so p1 acquires the slot before p2 attempts.
    await Promise.resolve();
    await expect(
      scheduler.delegate({
        agentName: 'explore',
        prompt: 'b',
        parentSessionId: 'parent',
        parentToolPool: [makeReadTool()],
        parentToolContext: baseToolContext,
      }),
    ).rejects.toThrow(/cap reached/);
    await p1;
  });

  test('lane semaphore serializes local-lane children when capacity is 1', async () => {
    const order: number[] = [];
    let counter = 0;
    const trackingProvider = (n: number): ResolvedProvider => ({
      transport: {
        name: 'tracked',
        async *stream(_req): AsyncGenerator<StreamEvent, AssistantMessage> {
          order.push(n);
          await new Promise((r) => setTimeout(r, 10));
          for (const ev of completedTurnEvents()) yield ev;
          return completedAnswer;
        },
      } as unknown as ResolvedProvider['transport'],
      client: {},
      baseUrl: 'fake://',
      model: 'qwen2.5:3b',
      contextLength: 32_000,
      authType: 'none',
      metadata: { provider: 'ollama' },
    });
    const scheduler = new SubagentScheduler({
      agents: makeAgentRegistry([makeAgent({ name: 'explore' })]),
      laneSemaphores: new LaneSemaphores({ local: 1 }),
      writeLock: new Semaphore(1),
      resolveProvider: () => trackingProvider(++counter),
      createChildSession: makeCreateChildSession([]),
      defaultProvider: 'ollama',
      defaultModel: 'qwen2.5:3b',
      maxTokens: 256,
    });
    await Promise.all([
      scheduler.delegate({
        agentName: 'explore',
        prompt: 'a',
        parentSessionId: 'parent',
        parentToolPool: [makeReadTool()],
        parentToolContext: baseToolContext,
      }),
      scheduler.delegate({
        agentName: 'explore',
        prompt: 'b',
        parentSessionId: 'parent',
        parentToolPool: [makeReadTool()],
        parentToolContext: baseToolContext,
      }),
      scheduler.delegate({
        agentName: 'explore',
        prompt: 'c',
        parentSessionId: 'parent',
        parentToolPool: [makeReadTool()],
        parentToolContext: baseToolContext,
      }),
    ]);
    // The provider's `stream()` records its sequence number when it
    // starts; if the lane semaphore worked, we observed [1, 2, 3] not
    // [1, 1, 1] (i.e. each child only began after the previous finished).
    expect(order).toEqual([1, 2, 3]);
  });

  test('write-capable children serialize through the global write lock', async () => {
    const order: string[] = [];
    let counter = 0;
    const writeAgent = makeAgent({ name: 'writer', readOnly: false, allowedTools: ['Read'] });
    const scheduler = new SubagentScheduler({
      agents: makeAgentRegistry([writeAgent]),
      laneSemaphores: new LaneSemaphores({}),
      writeLock: new Semaphore(1),
      resolveProvider: () => {
        const tag = `${++counter}`;
        return {
          transport: {
            name: 'order-tracker',
            async *stream(_req): AsyncGenerator<StreamEvent, AssistantMessage> {
              order.push(`start-${tag}`);
              await new Promise((r) => setTimeout(r, 5));
              order.push(`end-${tag}`);
              for (const ev of completedTurnEvents()) yield ev;
              return completedAnswer;
            },
          } as unknown as ResolvedProvider['transport'],
          client: {},
          baseUrl: 'fake://',
          model: 'm',
          contextLength: 32_000,
          authType: 'none',
          metadata: { provider: 'anthropic' },
        };
      },
      createChildSession: makeCreateChildSession([]),
      defaultProvider: 'anthropic',
      defaultModel: 'm',
      maxTokens: 256,
    });
    await Promise.all([
      scheduler.delegate({
        agentName: 'writer',
        prompt: 'a',
        parentSessionId: 'parent',
        parentToolPool: [makeReadTool()],
        parentToolContext: baseToolContext,
      }),
      scheduler.delegate({
        agentName: 'writer',
        prompt: 'b',
        parentSessionId: 'parent',
        parentToolPool: [makeReadTool()],
        parentToolContext: baseToolContext,
      }),
    ]);
    // Write lock should mean we never see start-2 before end-1.
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
  });

  test('parent abort signal cancels the child run', async () => {
    const ctl = new AbortController();
    const scheduler = new SubagentScheduler({
      agents: makeAgentRegistry([makeAgent()]),
      laneSemaphores: new LaneSemaphores({}),
      writeLock: new Semaphore(1),
      resolveProvider: () => ({
        transport: {
          name: 'hang',
          async *stream(_req): AsyncGenerator<StreamEvent, AssistantMessage> {
            yield { type: 'message_start' };
            await new Promise((_resolve, reject) => {
              ctl.signal.addEventListener('abort', () => reject(new Error('aborted')), {
                once: true,
              });
            });
            return { role: 'assistant', content: [] };
          },
        } as unknown as ResolvedProvider['transport'],
        client: {},
        baseUrl: 'fake://',
        model: 'm',
        contextLength: 32_000,
        authType: 'none',
        metadata: { provider: 'anthropic' },
      }),
      createChildSession: makeCreateChildSession([]),
      defaultProvider: 'anthropic',
      defaultModel: 'm',
      maxTokens: 256,
    });
    setTimeout(() => ctl.abort(), 5);
    const result = await scheduler.delegate({
      agentName: 'explore',
      prompt: 'hang',
      parentSessionId: 'parent',
      parentSignal: ctl.signal,
      parentToolPool: [makeReadTool()],
      parentToolContext: baseToolContext,
    });
    expect(['interrupted', 'error']).toContain(result.terminal.reason);
  });

  test('resolves agent.role through capability profile', async () => {
    const records: SessionRecord[] = [];
    const scheduler = new SubagentScheduler({
      agents: makeAgentRegistry([
        makeAgent({ name: 'explore', role: 'explore', model: undefined }),
      ]),
      laneSemaphores: new LaneSemaphores({}),
      writeLock: new Semaphore(1),
      resolveProvider: () => makeFakeResolved('whatever'),
      createChildSession: makeCreateChildSession(records),
      // Restrict available providers to anthropic only — should still
      // resolve since haiku-4-5 supports 'explore'.
      availableProviders: ['anthropic'],
      defaultProvider: 'anthropic',
      defaultModel: 'claude-haiku-4-5-20251001',
      maxTokens: 256,
    });
    await scheduler.delegate({
      agentName: 'explore',
      prompt: 'p',
      parentSessionId: 'parent',
      parentToolPool: [makeReadTool()],
      parentToolContext: baseToolContext,
    });
    // capability profile picked an anthropic model (cheapest in the list).
    expect(records[0]?.provider).toBe('anthropic');
    expect(records[0]?.model.startsWith('claude-')).toBe(true);
  });

  test('filters out SUBAGENT_EXCLUDED_TOOLS even if listed in allowedTools', async () => {
    const recordedToolNames: string[][] = [];
    const recordingProvider = (): ResolvedProvider => ({
      transport: {
        name: 'recorder',
        async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
          // Capture the tools that arrived in the provider request — that's
          // what the model would have seen. ProviderRequest.tools is a
          // ToolSchema[] so we read the names.
          const names = (req.tools ?? []).map((t) => t.name);
          recordedToolNames.push(names);
          for (const ev of completedTurnEvents()) yield ev;
          return completedAnswer;
        },
      } as unknown as ResolvedProvider['transport'],
      client: {},
      baseUrl: 'fake://',
      model: 'm',
      contextLength: 32_000,
      authType: 'none',
      metadata: { provider: 'anthropic' },
    });
    const scheduler = new SubagentScheduler({
      agents: makeAgentRegistry([
        makeAgent({
          name: 'naughty',
          allowedTools: ['Read', 'AgentTool'], // tries to grant recursion
        }),
      ]),
      laneSemaphores: new LaneSemaphores({}),
      writeLock: new Semaphore(1),
      resolveProvider: recordingProvider,
      createChildSession: makeCreateChildSession([]),
      defaultProvider: 'anthropic',
      defaultModel: 'm',
      maxTokens: 256,
    });
    await scheduler.delegate({
      agentName: 'naughty',
      prompt: 'go',
      parentSessionId: 'parent',
      parentToolPool: [makeReadTool(), makeAgentToolPlaceholder()],
      parentToolContext: baseToolContext,
    });
    expect(recordedToolNames[0]).toContain('Read');
    expect(recordedToolNames[0]).not.toContain('AgentTool');
  });

  test('activeChildren tracks count during in-flight delegations', async () => {
    const scheduler = new SubagentScheduler({
      agents: makeAgentRegistry([makeAgent()]),
      laneSemaphores: new LaneSemaphores({}),
      writeLock: new Semaphore(1),
      resolveProvider: () => makeFakeResolved('m', 20),
      createChildSession: makeCreateChildSession([]),
      defaultProvider: 'anthropic',
      defaultModel: 'm',
      maxTokens: 256,
    });
    expect(scheduler.activeChildren('parent')).toBe(0);
    const p = scheduler.delegate({
      agentName: 'explore',
      prompt: 'p',
      parentSessionId: 'parent',
      parentToolPool: [makeReadTool()],
      parentToolContext: baseToolContext,
    });
    // Yield to the runtime so the delegate enters the body and bumps count.
    await new Promise((r) => setTimeout(r, 5));
    expect(scheduler.activeChildren('parent')).toBe(1);
    await p;
    expect(scheduler.activeChildren('parent')).toBe(0);
  });
});

// Phase 1 T7 — SubagentScheduler resolveLane hook + tool-pool inheritance
// regression tests. Drives the scheduler end-to-end through delegate() and
// captures the resolved (provider, model) via SessionRecord plus the tool
// pool the model receives via a recording provider — mirrors the patterns in
// tests/runtime/scheduler.test.ts (resolves agent.role through capability
// profile / filters out SUBAGENT_EXCLUDED_TOOLS).

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { AgentDefinition, AgentRegistry } from '../../src/agents/types.js';
import type { LaneConfig } from '../../src/config/schema.js';
import type { AssistantMessage, StreamEvent } from '../../src/core/types.js';
import type { ResolvedProvider } from '../../src/providers/resolver.js';
import type { LLMProvider, ProviderRequest } from '../../src/providers/types.js';
import { LaneSemaphores } from '../../src/runtime/laneSemaphores.js';
import { PathLockManager } from '../../src/runtime/pathLock.js';
import { SubagentScheduler } from '../../src/runtime/scheduler.js';
import { buildTool } from '../../src/tool/buildTool.js';
import type { Tool, ToolContext } from '../../src/tool/types.js';

function makeAgent(over: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: 'explore',
    description: 'A test agent',
    systemPrompt: 'You are a test agent. Be concise.',
    allowedTools: ['Read', 'Grep'],
    maxTurns: 5,
    readOnly: true,
    supportsMissionState: false,
    inheritParentTools: false,
    allowedSubagents: [],
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

function makeFakeResolved(model: string): ResolvedProvider {
  const transport: LLMProvider = {
    name: 'fake',
    async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
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

function makeRecordingProvider(recordedToolNames: string[][]): () => ResolvedProvider {
  return () => ({
    transport: {
      name: 'recorder',
      async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
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

function makeBashTool(): Tool<unknown, unknown> {
  return buildTool({
    name: 'Bash',
    description: () => 'shell',
    inputSchema: z.object({ command: z.string() }),
    async call() {
      return { data: { stdout: '' } };
    },
  }) as unknown as Tool<unknown, unknown>;
}

function makeGrepTool(): Tool<unknown, unknown> {
  return buildTool({
    name: 'Grep',
    description: () => 'search',
    inputSchema: z.object({ pattern: z.string() }),
    async call() {
      return { data: { matches: [] } };
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

describe('SubagentScheduler — resolveLane callback (Phase 1 T7)', () => {
  test('uses resolveLane callback before falling back to capability table', async () => {
    const records: SessionRecord[] = [];
    const cheapLane: LaneConfig = {
      provider: 'ollama',
      model: 'qwen2.5:7b',
      allowedTools: null,
      maxTokens: null,
      timeoutMs: 120_000,
    };
    const scheduler = new SubagentScheduler({
      agents: makeAgentRegistry([makeAgent({ name: 'cheap-worker', role: 'cheap-task' })]),
      laneSemaphores: new LaneSemaphores({}),
      pathLock: new PathLockManager(),
      resolveProvider: () => makeFakeResolved('qwen2.5:7b'),
      createChildSession: makeCreateChildSession(records),
      defaultProvider: 'anthropic',
      defaultModel: 'claude-haiku-4-5-20251001',
      maxTokens: 256,
      resolveLane: (role: string) => (role === 'cheap-task' ? cheapLane : undefined),
    });
    await scheduler.delegate({
      agentName: 'cheap-worker',
      prompt: 'p',
      parentSessionId: 'parent',
      parentToolPool: [makeReadTool()],
      parentToolContext: baseToolContext,
    });
    expect(records[0]?.provider).toBe('ollama');
    expect(records[0]?.model).toBe('qwen2.5:7b');
  });

  test('falls back to capability table when resolveLane returns undefined', async () => {
    const records: SessionRecord[] = [];
    const scheduler = new SubagentScheduler({
      agents: makeAgentRegistry([makeAgent({ name: 'explorer', role: 'explore' })]),
      laneSemaphores: new LaneSemaphores({}),
      pathLock: new PathLockManager(),
      resolveProvider: () => makeFakeResolved('whatever'),
      createChildSession: makeCreateChildSession(records),
      availableProviders: ['anthropic'],
      defaultProvider: 'anthropic',
      defaultModel: 'claude-haiku-4-5-20251001',
      maxTokens: 256,
      // Resolver explicitly returns undefined for the 'explore' role —
      // the scheduler must fall through to findCapableModel.
      resolveLane: () => undefined,
    });
    await scheduler.delegate({
      agentName: 'explorer',
      prompt: 'p',
      parentSessionId: 'parent',
      parentToolPool: [makeReadTool()],
      parentToolContext: baseToolContext,
    });
    expect(records[0]?.provider).toBe('anthropic');
    expect(records[0]?.model.startsWith('claude-')).toBe(true);
  });

  test('falls back to capability table when resolveLane is not provided', async () => {
    const records: SessionRecord[] = [];
    const scheduler = new SubagentScheduler({
      agents: makeAgentRegistry([makeAgent({ name: 'explorer', role: 'explore' })]),
      laneSemaphores: new LaneSemaphores({}),
      pathLock: new PathLockManager(),
      resolveProvider: () => makeFakeResolved('whatever'),
      createChildSession: makeCreateChildSession(records),
      availableProviders: ['anthropic'],
      defaultProvider: 'anthropic',
      defaultModel: 'claude-haiku-4-5-20251001',
      maxTokens: 256,
      // No resolveLane wired — existing capability-table path must run
      // unchanged. This is the regression guard for the additive contract.
    });
    await scheduler.delegate({
      agentName: 'explorer',
      prompt: 'p',
      parentSessionId: 'parent',
      parentToolPool: [makeReadTool()],
      parentToolContext: baseToolContext,
    });
    expect(records[0]?.provider).toBe('anthropic');
    expect(records[0]?.model.startsWith('claude-')).toBe(true);
  });

  test('explicit agent.model wins over resolveLane', async () => {
    const records: SessionRecord[] = [];
    const scheduler = new SubagentScheduler({
      agents: makeAgentRegistry([
        makeAgent({ name: 'pinned', model: 'openrouter/qwen2.5-72b', role: 'cheap-task' }),
      ]),
      laneSemaphores: new LaneSemaphores({}),
      pathLock: new PathLockManager(),
      resolveProvider: () => makeFakeResolved('qwen2.5-72b'),
      createChildSession: makeCreateChildSession(records),
      defaultProvider: 'anthropic',
      defaultModel: 'claude-haiku-4-5-20251001',
      maxTokens: 256,
      resolveLane: () => ({
        provider: 'ollama',
        model: 'qwen2.5:7b',
        allowedTools: null,
        maxTokens: null,
        timeoutMs: 120_000,
      }),
    });
    await scheduler.delegate({
      agentName: 'pinned',
      prompt: 'p',
      parentSessionId: 'parent',
      parentToolPool: [makeReadTool()],
      parentToolContext: baseToolContext,
    });
    // agent.model has the highest precedence — neither resolveLane
    // nor the capability table should override an explicit pin.
    expect(records[0]?.provider).toBe('openrouter');
    expect(records[0]?.model).toBe('qwen2.5-72b');
  });
});

describe('SubagentScheduler — buildChildToolPool (Phase 1 T7)', () => {
  test('inheritParentTools=true: child gets parent pool minus exclusions', async () => {
    const recorded: string[][] = [];
    const scheduler = new SubagentScheduler({
      agents: makeAgentRegistry([
        makeAgent({
          name: 'inheritor',
          // Empty allowedTools — proves the inherited branch is in effect
          // (the strict path would have produced zero tools).
          allowedTools: [],
          inheritParentTools: true,
          allowedSubagents: [],
        }),
      ]),
      laneSemaphores: new LaneSemaphores({}),
      pathLock: new PathLockManager(),
      resolveProvider: makeRecordingProvider(recorded),
      createChildSession: makeCreateChildSession([]),
      defaultProvider: 'anthropic',
      defaultModel: 'm',
      maxTokens: 256,
    });
    await scheduler.delegate({
      agentName: 'inheritor',
      prompt: 'go',
      parentSessionId: 'parent',
      // AgentTool stays excluded because allowedSubagents is empty.
      parentToolPool: [makeReadTool(), makeBashTool(), makeAgentToolPlaceholder()],
      parentToolContext: baseToolContext,
    });
    expect(recorded[0]).toContain('Read');
    expect(recorded[0]).toContain('Bash');
    expect(recorded[0]).not.toContain('AgentTool');
  });

  test('inheritParentTools=true + allowedSubagents non-empty: AgentTool included', async () => {
    const recorded: string[][] = [];
    const scheduler = new SubagentScheduler({
      agents: makeAgentRegistry([
        makeAgent({
          name: 'delegator-shape',
          allowedTools: [],
          inheritParentTools: true,
          allowedSubagents: ['cheap-task'],
        }),
      ]),
      laneSemaphores: new LaneSemaphores({}),
      pathLock: new PathLockManager(),
      resolveProvider: makeRecordingProvider(recorded),
      createChildSession: makeCreateChildSession([]),
      defaultProvider: 'anthropic',
      defaultModel: 'm',
      maxTokens: 256,
    });
    await scheduler.delegate({
      agentName: 'delegator-shape',
      prompt: 'go',
      parentSessionId: 'parent',
      parentToolPool: [makeReadTool(), makeAgentToolPlaceholder()],
      parentToolContext: baseToolContext,
    });
    expect(recorded[0]).toContain('Read');
    expect(recorded[0]).toContain('AgentTool');
  });

  test('inheritParentTools=false (default): strict allowlist behavior preserved', async () => {
    // Regression guard for existing agents (explore, plan, verify, etc.).
    const recorded: string[][] = [];
    const scheduler = new SubagentScheduler({
      agents: makeAgentRegistry([
        makeAgent({
          name: 'strict',
          allowedTools: ['Read', 'Grep'],
          inheritParentTools: false,
          allowedSubagents: [],
        }),
      ]),
      laneSemaphores: new LaneSemaphores({}),
      pathLock: new PathLockManager(),
      resolveProvider: makeRecordingProvider(recorded),
      createChildSession: makeCreateChildSession([]),
      defaultProvider: 'anthropic',
      defaultModel: 'm',
      maxTokens: 256,
    });
    await scheduler.delegate({
      agentName: 'strict',
      prompt: 'go',
      parentSessionId: 'parent',
      parentToolPool: [makeReadTool(), makeGrepTool(), makeBashTool(), makeAgentToolPlaceholder()],
      parentToolContext: baseToolContext,
    });
    expect(recorded[0]).toContain('Read');
    expect(recorded[0]).toContain('Grep');
    expect(recorded[0]).not.toContain('Bash');
    expect(recorded[0]).not.toContain('AgentTool');
  });
});

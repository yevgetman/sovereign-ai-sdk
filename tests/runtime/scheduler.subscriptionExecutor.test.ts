// SPIKE — scheduler branch for the subscription-executor role. Proves:
//   - with subscriptionExecutor.enabled + the agent's role ===
//     'subscription-executor', delegate() routes to a MOCKED
//     runSubprocessExecutor (NOT AgentRunner / the provider) and round-trips
//     the summary + fires the memory hook through the UNCHANGED scheduler tail;
//   - with the config absent/disabled, the same delegation falls back to the
//     normal AgentRunner provider path (the provider IS called).
//
// The unchanged-green proof for the normal path lives in the existing
// tests/runtime/scheduler.test.ts (untouched) — this file only exercises the
// new branch.

import { describe, expect, test } from 'bun:test';
import type { AgentDefinition, AgentRegistry } from '../../src/agents/types.js';
import type { AssistantMessage, StreamEvent } from '../../src/core/types.js';
import type { MemoryRuntime } from '../../src/memory/provider.js';
import type { ResolvedProvider } from '../../src/providers/resolver.js';
import type { LLMProvider, ProviderRequest } from '../../src/providers/types.js';
import { LaneSemaphores } from '../../src/runtime/laneSemaphores.js';
import { SubagentScheduler } from '../../src/runtime/scheduler.js';
import { Semaphore } from '../../src/runtime/semaphore.js';
import type { SubprocessExecutorResult } from '../../src/runtime/subprocessExecutor.js';
import type { ToolContext } from '../../src/tool/types.js';

function makeAgent(over: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: 'subscription-executor',
    description: 'headless claude-code executor',
    systemPrompt: 'You delegate to a headless Claude Code session.',
    allowedTools: [],
    role: 'subscription-executor',
    maxTurns: 8,
    readOnly: true,
    supportsMissionState: false,
    inheritParentTools: false,
    allowedSubagents: [],
    path: '/tmp/subscription-executor.md',
    realpath: '/tmp/subscription-executor.md',
    dir: '/tmp',
    source: 'bundle',
    trustTier: 'builtin',
    ...over,
  };
}

function makeRegistry(agents: AgentDefinition[]): AgentRegistry {
  const byName = new Map<string, AgentDefinition>();
  for (const a of agents) byName.set(a.name, a);
  return { agents: [...agents], byName };
}

const answer: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'provider-path answer' }],
};

/** A provider that records whether it was called — so we can assert the
 *  subprocess branch BYPASSED it. */
function makeRecordingProvider(calledRef: { called: boolean }): ResolvedProvider {
  const transport: LLMProvider = {
    name: 'fake',
    async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      calledRef.called = true;
      yield { type: 'message_start' };
      yield { type: 'assistant_message', message: answer };
      yield { type: 'message_stop', stop_reason: 'end_turn' };
      return answer;
    },
  };
  return {
    transport: transport as unknown as ResolvedProvider['transport'],
    client: transport,
    baseUrl: 'fake://',
    model: 'claude-haiku-4-5-20251001',
    contextLength: 32_000,
    authType: 'none',
    metadata: { provider: 'fake' },
  };
}

const baseToolContext: ToolContext = { cwd: '/tmp/work', sessionId: 'parent' };

describe('SubagentScheduler — subscription-executor branch', () => {
  test('enabled + role match → routes to runSubprocessExecutor (provider NOT called)', async () => {
    const providerCalled = { called: false };
    const subprocessResult: SubprocessExecutorResult = {
      terminal: { reason: 'completed' },
      finalAssistant: { role: 'assistant', content: [{ type: 'text', text: 'SPIKE-OK' }] },
      iterationsUsed: 3,
      toolCallCount: 1,
      distinctToolNames: ['Read'],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'do it' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'SPIKE-OK' }] },
      ],
    };

    let capturedArgs: { prompt: string; cwd: string } | undefined;
    const memoryCalls: Array<{ task: string; result: string }> = [];
    const memoryManager = {
      onDelegation: async (task: string, result: string) => {
        memoryCalls.push({ task, result });
      },
    } as unknown as MemoryRuntime;

    const scheduler = new SubagentScheduler({
      agents: makeRegistry([makeAgent()]),
      laneSemaphores: new LaneSemaphores({}),
      writeLock: new Semaphore(1),
      resolveProvider: () => makeRecordingProvider(providerCalled),
      createChildSession: () => 'child-sub-1',
      defaultProvider: 'anthropic',
      defaultModel: 'claude-haiku-4-5-20251001',
      maxTokens: 256,
      subscriptionExecutor: { enabled: true, engine: 'claude-code', permissionMode: 'plan' },
      runSubprocessExecutor: async (opts) => {
        capturedArgs = { prompt: opts.prompt, cwd: opts.cwd };
        return subprocessResult;
      },
    });

    const result = await scheduler.delegate({
      agentName: 'subscription-executor',
      prompt: 'do it',
      parentSessionId: 'parent-1',
      parentToolPool: [],
      parentToolContext: baseToolContext,
      memoryManager,
    });

    // Routed through the subprocess, NOT the provider.
    expect(providerCalled.called).toBe(false);
    expect(capturedArgs?.prompt).toBe('do it');
    // cwd is constrained to the parent tool context cwd.
    expect(capturedArgs?.cwd).toBe('/tmp/work');

    // The summary round-trips through the UNCHANGED scheduler tail.
    expect(result.terminal.reason).toBe('completed');
    expect(result.summary).toBe('SPIKE-OK');
    expect(result.iterationsUsed).toBe(3);
    expect(result.toolCallCount).toBe(1);
    expect(result.distinctToolNames).toEqual(['Read']);
    expect(result.childSessionId).toBe('child-sub-1');

    // The memory hook fired (the downstream tail is unchanged).
    expect(memoryCalls).toHaveLength(1);
    expect(memoryCalls[0]).toMatchObject({ task: 'do it', result: 'SPIKE-OK' });
  });

  test('disabled → falls back to the normal AgentRunner provider path', async () => {
    const providerCalled = { called: false };
    let subprocessCalled = false;

    const scheduler = new SubagentScheduler({
      agents: makeRegistry([makeAgent()]),
      laneSemaphores: new LaneSemaphores({}),
      writeLock: new Semaphore(1),
      resolveProvider: () => makeRecordingProvider(providerCalled),
      createChildSession: () => 'child-sub-2',
      defaultProvider: 'anthropic',
      defaultModel: 'claude-haiku-4-5-20251001',
      maxTokens: 256,
      // enabled omitted → disabled
      subscriptionExecutor: { engine: 'claude-code' },
      runSubprocessExecutor: async () => {
        subprocessCalled = true;
        return {
          terminal: { reason: 'completed' },
          iterationsUsed: 0,
          toolCallCount: 0,
          distinctToolNames: [],
          messages: [],
        };
      },
    });

    const result = await scheduler.delegate({
      agentName: 'subscription-executor',
      prompt: 'do it',
      parentSessionId: 'parent-2',
      parentToolPool: [],
      parentToolContext: baseToolContext,
    });

    // The subprocess branch was NOT taken; the normal provider path ran.
    expect(subprocessCalled).toBe(false);
    expect(providerCalled.called).toBe(true);
    expect(result.summary).toBe('provider-path answer');
  });

  test('no subscriptionExecutor config at all → normal provider path', async () => {
    const providerCalled = { called: false };
    const scheduler = new SubagentScheduler({
      agents: makeRegistry([makeAgent()]),
      laneSemaphores: new LaneSemaphores({}),
      writeLock: new Semaphore(1),
      resolveProvider: () => makeRecordingProvider(providerCalled),
      createChildSession: () => 'child-sub-3',
      defaultProvider: 'anthropic',
      defaultModel: 'claude-haiku-4-5-20251001',
      maxTokens: 256,
      // no subscriptionExecutor, no runSubprocessExecutor injected
    });

    const result = await scheduler.delegate({
      agentName: 'subscription-executor',
      prompt: 'do it',
      parentSessionId: 'parent-3',
      parentToolPool: [],
      parentToolContext: baseToolContext,
    });

    expect(providerCalled.called).toBe(true);
    expect(result.summary).toBe('provider-path answer');
  });

  test('subprocess error terminal round-trips as a non-success result', async () => {
    const scheduler = new SubagentScheduler({
      agents: makeRegistry([makeAgent()]),
      laneSemaphores: new LaneSemaphores({}),
      writeLock: new Semaphore(1),
      resolveProvider: () => makeRecordingProvider({ called: false }),
      createChildSession: () => 'child-sub-4',
      defaultProvider: 'anthropic',
      defaultModel: 'claude-haiku-4-5-20251001',
      maxTokens: 256,
      subscriptionExecutor: { enabled: true },
      runSubprocessExecutor: async () => ({
        terminal: { reason: 'error', error: new Error('claude not logged in') },
        iterationsUsed: 0,
        toolCallCount: 0,
        distinctToolNames: [],
        messages: [],
      }),
    });

    const result = await scheduler.delegate({
      agentName: 'subscription-executor',
      prompt: 'do it',
      parentSessionId: 'parent-4',
      parentToolPool: [],
      parentToolContext: baseToolContext,
    });

    expect(result.terminal.reason).toBe('error');
    // extractSummary of an undefined finalAssistant is '' — the tail still
    // produced a structured result (no throw).
    expect(result.summary).toBe('');
  });
});

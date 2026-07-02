// Task 1.5 — pins the inverted subscription-executor PORT contract on the open
// scheduler. The scheduler no longer value-imports the proprietary
// `runSubprocessExecutor`; it consumes an INJECTED port. Two invariants:
//
//   1. Wiring + the preserved write-lock coupling: with subscription-executor
//      enabled and an injected fake executor, a delegation (a) calls the
//      INJECTED fake (never a real subprocess), and (b) acquires the WHOLE-TREE
//      path-lock `{kind:'all'}` even though the agent is readOnly:true — the
//      headless `claude -p` can't be write-scoped, so it must serialize with all
//      writers (a genuine read-only NATIVE child would take NO lock). This
//      coupling at scheduler.ts (the `useSubprocessExecutor` write-lock branch)
//      must survive the port inversion byte-for-byte.
//
//   2. Fail-closed: with subscription-executor enabled but NO `runSubprocessExecutor`
//      port injected, `delegate()` throws a clear error rather than silently
//      falling back to a default real-subprocess executor (the removed crossing).

import { describe, expect, test } from 'bun:test';
import type { AgentDefinition, AgentRegistry } from '@yevgetman/sov-sdk/agents/types';
import type { AssistantMessage, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import type { ResolvedProvider } from '@yevgetman/sov-sdk/providers/resolver';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import { LaneSemaphores } from '@yevgetman/sov-sdk/runtime/laneSemaphores';
import type { PathLockManager, PathScope } from '@yevgetman/sov-sdk/runtime/pathLock';
import { SubagentScheduler } from '@yevgetman/sov-sdk/runtime/scheduler';
import type { ToolContext } from '@yevgetman/sov-sdk/tool/types';
import type { SubprocessExecutorResult } from '../../src/runtime/subprocessExecutor.js';

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

const baseToolContext: ToolContext = { cwd: '/tmp/work', sessionId: 'parent' };

/** A resolvable provider whose `.stream()` THROWS — the subprocess branch must
 *  never drive the harness's own turn loop. `resolveProvider` itself succeeds
 *  (the scheduler resolves it eagerly even on the subprocess branch); the guard
 *  is that streaming never happens. */
function makeStreamGuardProvider(): ResolvedProvider {
  const transport: LLMProvider = {
    name: 'fake',
    // biome-ignore lint/correctness/useYield: guard — must never be driven on the subprocess branch.
    async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      throw new Error('provider.stream must NOT run on the subprocess branch');
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

/** Spy PathLockManager that records every scope it is asked to acquire. */
function makeSpyLock(acquired: PathScope[]): PathLockManager {
  return {
    acquire: async (scope: PathScope) => {
      acquired.push(scope);
      return () => {};
    },
    heldCount: () => 0,
    agentNames: () => [],
  } as unknown as PathLockManager;
}

const benignSuccess: SubprocessExecutorResult = {
  terminal: { reason: 'completed' },
  finalAssistant: { role: 'assistant', content: [{ type: 'text', text: 'PORT-OK' }] },
  iterationsUsed: 1,
  toolCallCount: 0,
  distinctToolNames: [],
  messages: [],
};

describe('SubagentScheduler — injected subscription-executor port', () => {
  test('enabled: calls the INJECTED port and takes the whole-tree lock (readOnly agent)', async () => {
    const acquired: PathScope[] = [];
    let injectedCalled = false;

    const scheduler = new SubagentScheduler({
      agents: makeRegistry([makeAgent()]), // readOnly: true
      laneSemaphores: new LaneSemaphores({}),
      pathLock: makeSpyLock(acquired),
      resolveProvider: () => makeStreamGuardProvider(),
      createChildSession: () => 'child-port-1',
      defaultProvider: 'anthropic',
      defaultModel: 'claude-haiku-4-5-20251001',
      maxTokens: 256,
      subscriptionExecutor: { enabled: true, engine: 'claude-code', permissionMode: 'plan' },
      runSubprocessExecutor: async () => {
        injectedCalled = true;
        return benignSuccess;
      },
    });

    const result = await scheduler.delegate({
      agentName: 'subscription-executor',
      prompt: 'do it',
      parentSessionId: 'parent-port-1',
      parentToolPool: [],
      parentToolContext: baseToolContext,
      // Even a declared narrow scope must be ignored for the subprocess branch.
      writeScope: { kind: 'globs', globs: ['src/a/**'] },
    });

    // (a) the INJECTED fake ran — no real subprocess.
    expect(injectedCalled).toBe(true);
    expect(result.summary).toBe('PORT-OK');
    // (b) the preserved coupling: whole-tree lock for the readOnly subprocess agent.
    expect(acquired).toHaveLength(1);
    expect(acquired[0]?.kind).toBe('all');
  });

  test('enabled but no port injected: delegate() throws a clear error (no default fallback)', async () => {
    const scheduler = new SubagentScheduler({
      agents: makeRegistry([makeAgent()]),
      laneSemaphores: new LaneSemaphores({}),
      pathLock: makeSpyLock([]),
      resolveProvider: () => makeStreamGuardProvider(),
      createChildSession: () => 'child-port-2',
      defaultProvider: 'anthropic',
      defaultModel: 'claude-haiku-4-5-20251001',
      maxTokens: 256,
      subscriptionExecutor: { enabled: true, engine: 'claude-code', permissionMode: 'plan' },
      // runSubprocessExecutor intentionally OMITTED.
    });

    await expect(
      scheduler.delegate({
        agentName: 'subscription-executor',
        prompt: 'do it',
        parentSessionId: 'parent-port-2',
        parentToolPool: [],
        parentToolContext: baseToolContext,
      }),
    ).rejects.toThrow(/no runSubprocessExecutor port was injected/);
  });
});

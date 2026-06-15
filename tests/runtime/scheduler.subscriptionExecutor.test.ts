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
import type { LearningObserver, ObserveInput } from '../../src/learning/observer.js';
import type { MemoryRuntime } from '../../src/memory/provider.js';
import type { ResolvedProvider } from '../../src/providers/resolver.js';
import type { LLMProvider, ProviderRequest } from '../../src/providers/types.js';
import { LaneSemaphores } from '../../src/runtime/laneSemaphores.js';
import { PathLockManager } from '../../src/runtime/pathLock.js';
import { SubagentScheduler } from '../../src/runtime/scheduler.js';
import {
  type RunSubprocessExecutorOpts,
  type SpawnFn,
  type SubprocessExecutorResult,
  runSubprocessExecutor,
} from '../../src/runtime/subprocessExecutor.js';
import type { ToolContext } from '../../src/tool/types.js';
import type { TraceEvent } from '../../src/trace/types.js';

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
      pathLock: new PathLockManager(),
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
      pathLock: new PathLockManager(),
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
      pathLock: new PathLockManager(),
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

  test('threads the child observer + trace recorder into runSubprocessExecutor', async () => {
    // The replay must land in the SAME learning destination a native
    // delegation uses: the child ToolContext inherits the parent's observer
    // (sessionId-bound), and the scheduler's wrapped trace recorder tags events
    // with the child sessionId. Assert the scheduler hands BOTH into the
    // subprocess executor — and that they're the same observer object the
    // native AgentRunner path would receive via childToolContext.
    const parentObserved: ObserveInput[] = [];
    const parentObserver = {
      observe: (i: ObserveInput) => parentObserved.push(i),
    } as unknown as LearningObserver;

    const parentTraced: TraceEvent[] = [];

    let captured: RunSubprocessExecutorOpts | undefined;
    const subprocessResult: SubprocessExecutorResult = {
      terminal: { reason: 'completed' },
      finalAssistant: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      iterationsUsed: 1,
      toolCallCount: 1,
      distinctToolNames: ['Bash'],
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }],
    };

    const scheduler = new SubagentScheduler({
      agents: makeRegistry([makeAgent()]),
      laneSemaphores: new LaneSemaphores({}),
      pathLock: new PathLockManager(),
      resolveProvider: () => makeRecordingProvider({ called: false }),
      createChildSession: () => 'child-obs-1',
      defaultProvider: 'anthropic',
      defaultModel: 'claude-haiku-4-5-20251001',
      maxTokens: 256,
      harnessHome: '/tmp/does-not-matter-trace-writer-best-effort',
      subscriptionExecutor: { enabled: true, engine: 'claude-code', permissionMode: 'plan' },
      runSubprocessExecutor: async (opts) => {
        captured = opts;
        // Drive the injected sinks the way the real executor would, so we can
        // assert the observation lands on the PARENT observer (the child's
        // corpus destination) and the trace event carries the child sessionId.
        opts.learningObserver?.observe({
          toolName: 'Bash',
          toolInput: { command: 'ls' },
          status: 'success',
          durationMs: 0,
          traceId: 'tu_1',
        });
        opts.traceRecorder?.({
          type: 'tool_start',
          tool: 'Bash',
          toolUseId: 'tu_1',
          iso: new Date().toISOString(),
        });
        return subprocessResult;
      },
    });

    await scheduler.delegate({
      agentName: 'subscription-executor',
      prompt: 'do it',
      parentSessionId: 'parent-obs',
      parentToolPool: [],
      // The parent ToolContext carries the observer — exactly as the runtime
      // builds it; the scheduler spreads it into the child context.
      parentToolContext: { ...baseToolContext, learningObserver: parentObserver },
      traceRecorder: (e) => parentTraced.push(e),
    });

    // Both sinks were threaded.
    expect(captured?.learningObserver).toBeDefined();
    expect(captured?.traceRecorder).toBeDefined();
    // The observer handed in IS the parent's (the child's corpus destination).
    expect(captured?.learningObserver).toBe(parentObserver);
    // The replayed observation landed on it.
    expect(parentObserved).toHaveLength(1);
    expect(parentObserved[0]).toMatchObject({ toolName: 'Bash', status: 'success' });
    // The replayed trace event reached the parent recorder, tagged with the
    // CHILD sessionId (parity with native child trace attribution).
    const start = parentTraced.find((e) => e.type === 'tool_start');
    expect(start).toBeDefined();
    expect((start as { sessionId?: string }).sessionId).toBe('child-obs-1');
  });

  test('no learningObserver on the parent context → no observer threaded (clean)', async () => {
    let captured: RunSubprocessExecutorOpts | undefined;
    const scheduler = new SubagentScheduler({
      agents: makeRegistry([makeAgent()]),
      laneSemaphores: new LaneSemaphores({}),
      pathLock: new PathLockManager(),
      resolveProvider: () => makeRecordingProvider({ called: false }),
      createChildSession: () => 'child-obs-2',
      defaultProvider: 'anthropic',
      defaultModel: 'claude-haiku-4-5-20251001',
      maxTokens: 256,
      subscriptionExecutor: { enabled: true },
      runSubprocessExecutor: async (opts) => {
        captured = opts;
        return {
          terminal: { reason: 'completed' },
          iterationsUsed: 0,
          toolCallCount: 0,
          distinctToolNames: [],
          messages: [],
        };
      },
    });

    await scheduler.delegate({
      agentName: 'subscription-executor',
      prompt: 'do it',
      parentSessionId: 'parent-obs-2',
      parentToolPool: [],
      parentToolContext: baseToolContext, // no observer
    });

    expect(captured).toBeDefined();
    expect(captured?.learningObserver).toBeUndefined();
  });

  // 2026-06-15 review fix C2 — the subscription-executor agent is readOnly:true
  // but its subprocess runs --dangerously-skip-permissions and CAN write the
  // tree, so it MUST acquire the whole-tree path-lock (serialize with all other
  // writers) rather than skip the lock like a genuine read-only child.
  test('a subscription-executor delegation acquires the whole-tree path-lock', async () => {
    const acquired: Array<{ kind: string }> = [];
    const spyLock = {
      acquire: async (scope: { kind: string }) => {
        acquired.push(scope);
        return () => {};
      },
      heldCount: () => 0,
      agentNames: () => [],
    } as unknown as PathLockManager;

    const scheduler = new SubagentScheduler({
      agents: makeRegistry([makeAgent()]), // readOnly: true
      laneSemaphores: new LaneSemaphores({}),
      pathLock: spyLock,
      resolveProvider: () => makeRecordingProvider({ called: false }),
      createChildSession: () => 'child-c2',
      defaultProvider: 'anthropic',
      defaultModel: 'claude-haiku-4-5-20251001',
      maxTokens: 256,
      subscriptionExecutor: { enabled: true, engine: 'claude-code', permissionMode: 'plan' },
      runSubprocessExecutor: async () => ({
        terminal: { reason: 'completed' },
        finalAssistant: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        iterationsUsed: 1,
        toolCallCount: 0,
        distinctToolNames: [],
        messages: [],
      }),
    });

    await scheduler.delegate({
      agentName: 'subscription-executor',
      prompt: 'do it',
      parentSessionId: 'parent-c2',
      parentToolPool: [],
      parentToolContext: baseToolContext,
      // Even a declared narrow scope must be ignored — we can't bound the
      // subprocess, so it takes the whole tree.
      writeScope: { kind: 'globs', globs: ['src/a/**'] },
    });

    expect(acquired).toHaveLength(1);
    expect(acquired[0]?.kind).toBe('all');
  });

  // A genuinely read-only NATIVE child (no subprocess) still skips the lock.
  test('a read-only native child does NOT acquire the path-lock', async () => {
    let acquireCalls = 0;
    const spyLock = {
      acquire: async () => {
        acquireCalls += 1;
        return () => {};
      },
      heldCount: () => 0,
      agentNames: () => [],
    } as unknown as PathLockManager;

    const scheduler = new SubagentScheduler({
      agents: makeRegistry([makeAgent({ name: 'ro', role: 'reviewer', readOnly: true })]),
      laneSemaphores: new LaneSemaphores({}),
      pathLock: spyLock,
      resolveProvider: () => makeRecordingProvider({ called: false }),
      createChildSession: () => 'child-ro',
      defaultProvider: 'anthropic',
      defaultModel: 'claude-haiku-4-5-20251001',
      maxTokens: 256,
      // no subscriptionExecutor → native AgentRunner path
    });

    await scheduler.delegate({
      agentName: 'ro',
      prompt: 'read',
      parentSessionId: 'parent-ro',
      parentToolPool: [],
      parentToolContext: baseToolContext,
    });

    expect(acquireCalls).toBe(0);
  });

  test('subprocess error terminal round-trips as a non-success result', async () => {
    const scheduler = new SubagentScheduler({
      agents: makeRegistry([makeAgent()]),
      laneSemaphores: new LaneSemaphores({}),
      pathLock: new PathLockManager(),
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

  test('end-to-end: real runSubprocessExecutor parses canned stream-json → non-empty summary', async () => {
    // Integration guard for the drive/TUI "(no summary)" path at the SCHEDULER
    // boundary. Instead of a stubbed runSubprocessExecutor returning a hand-made
    // result, this drives the REAL parser via an injected spawn that emits a
    // canned stream-json whose final assistant message is "There are 3 files."
    // The summary that flows out of delegate() (and thence to AgentTool ->
    // the model + the drive/TUI display) must be exactly that non-empty text.
    const STREAM: string[] = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-e2e', model: 'claude' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Listing the files.' },
            { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls -1A' } },
          ],
        },
        session_id: 'sess-e2e',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: 'a\nb\nc', is_error: false },
          ],
        },
        session_id: 'sess-e2e',
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'There are 3 files.' }] },
        session_id: 'sess-e2e',
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 2,
        result: 'There are 3 files.',
        session_id: 'sess-e2e',
      }),
    ];
    const fakeSpawn: SpawnFn = () => {
      const body = `${STREAM.join('\n')}\n`;
      return {
        stdout: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(body));
            c.close();
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          start(c) {
            c.close();
          },
        }),
        stdin: { write: () => 0, end: () => {} },
        exited: Promise.resolve(0),
        kill: () => {},
      };
    };

    const scheduler = new SubagentScheduler({
      agents: makeRegistry([makeAgent()]),
      laneSemaphores: new LaneSemaphores({}),
      pathLock: new PathLockManager(),
      resolveProvider: () => makeRecordingProvider({ called: false }),
      createChildSession: () => 'child-e2e',
      defaultProvider: 'anthropic',
      defaultModel: 'claude-haiku-4-5-20251001',
      maxTokens: 256,
      subscriptionExecutor: { enabled: true, engine: 'claude-code', permissionMode: 'plan' },
      // The REAL executor — only the subprocess spawn is faked.
      runSubprocessExecutor: (opts) => runSubprocessExecutor({ ...opts, spawn: fakeSpawn }),
    });

    const result = await scheduler.delegate({
      agentName: 'subscription-executor',
      prompt: 'count the files',
      parentSessionId: 'parent-e2e',
      parentToolPool: [],
      parentToolContext: baseToolContext,
    });

    expect(result.terminal.reason).toBe('completed');
    // The bug repro: a completed delegation must NOT yield an empty summary.
    expect(result.summary).toBe('There are 3 files.');
    expect(result.summary.length).toBeGreaterThan(0);
  });
});

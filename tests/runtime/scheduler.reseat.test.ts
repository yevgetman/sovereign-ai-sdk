// Task 4.5 — sub-agent scheduler native-path re-seat onto `createAgent()`
// (was `new AgentRunner(...).run()`). The FINAL + highest-risk (B)-surface.
//
// This is PURE PARITY: byte-identical behavior, NO ratified additions. Unlike
// the cron (Task 4.2) and channel (Task 4.3) re-seats, the scheduler does NOT
// thread `microcompactConfig` (that parity-fix was ratified ONLY for those
// surfaces) and does NOT thread `sessionStore`/`transcripts` (the scheduler owns
// child persistence + trajectory out-of-band — a store would double-write).
//
// The PRIMARY regression guard is the large existing, UNTOUCHED scheduler suite
// (tests/runtime/scheduler*.test.ts, tests/tools/agentTool*.test.ts,
// tests/workflows/engine.test.ts, tests/tasks/*). In particular:
//   - the subprocess-executor branch is guarded by
//     tests/runtime/scheduler.subscriptionExecutor.test.ts (Task 1.5),
//   - the write-lock `{kind:'all'}` serialization invariant is guarded by
//     "write-capable children serialize through the global write lock" in
//     tests/runtime/scheduler.test.ts (Task 1.5).
// This file adds the createAgent-specific parity assertions: the SAME
// DelegateResult, NO microcompaction reaching the turn, and an erroring child
// still producing its error DelegateResult (createAgent throw→terminal == case a).

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { AgentDefinition, AgentRegistry } from '../../src/agents/types.js';
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
    description: 'A test explore agent',
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

function makeRegistry(agents: AgentDefinition[]): AgentRegistry {
  const byName = new Map<string, AgentDefinition>();
  for (const a of agents) byName.set(a.name, a);
  return { agents: [...agents], byName };
}

const baseToolContext: ToolContext = {
  cwd: process.cwd(),
  sessionId: 'parent',
};

function makeCreateChildSession(): SubagentScheduler['opts']['createChildSession'] {
  let counter = 0;
  return () => {
    counter += 1;
    return `child-${counter}`;
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

const completedAnswer: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'task complete' }],
};

/** A single completed turn — one assistant text message, no tool calls. */
function makeOneTurnResolved(model: string): ResolvedProvider {
  const transport: LLMProvider = {
    name: 'fake',
    async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      yield { type: 'message_start' };
      yield { type: 'text_delta', text: 'task complete' };
      yield { type: 'message_stop', stop_reason: 'end_turn' };
      yield { type: 'assistant_message', message: completedAnswer };
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

function baseSchedulerOpts(registry: AgentRegistry, resolved: ResolvedProvider) {
  return {
    agents: registry,
    laneSemaphores: new LaneSemaphores({}),
    pathLock: new PathLockManager(),
    resolveProvider: () => resolved,
    createChildSession: makeCreateChildSession(),
    defaultProvider: 'anthropic',
    defaultModel: 'm',
    maxTokens: 256,
  } as const;
}

describe('SubagentScheduler native re-seat onto createAgent — pure parity', () => {
  test('a native delegation yields the SAME DelegateResult as the AgentRunner path', async () => {
    const scheduler = new SubagentScheduler(
      baseSchedulerOpts(makeRegistry([makeAgent({ name: 'explore' })]), makeOneTurnResolved('m')),
    );

    const result = await scheduler.delegate({
      agentName: 'explore',
      prompt: 'find auth code',
      parentSessionId: 'parent-1',
      parentToolPool: [makeReadTool()],
      parentToolContext: baseToolContext,
    });

    // Every DelegateResult field createAgent feeds is byte-identical to what the
    // old `new AgentRunner(...).run()` drained into.
    expect(result.childSessionId).toBe('child-1');
    expect(result.agentName).toBe('explore');
    // resolvedProvider/Model come from resolveProviderModel — an agent with no
    // model/role falls through to the construction-time defaults.
    expect(result.resolvedProvider).toBe('anthropic');
    expect(result.resolvedModel).toBe('m');
    expect(result.terminal.reason).toBe('completed');
    expect(result.summary).toBe('task complete');
    expect(result.finalAssistant).toEqual(completedAnswer);
    expect(result.iterationsUsed).toBe(1);
    expect(result.toolCallCount).toBe(0);
    expect(result.distinctToolNames).toEqual([]);
  });

  test('a tool-call turn populates distinctToolNames AND NO microcompaction reaches the turn', async () => {
    // The provider records the messages it sees PER turn so we can prove the
    // seed user prompt is still present on the final turn — i.e. nothing was
    // evicted. The scheduler threads NO `microcompactConfig`, so query() runs on
    // its built-in DEFAULT_MICROCOMPACT_CONFIG (byte-identical to AgentRunner,
    // which also threaded none); a small two-turn child never trips its
    // threshold, so the whole history survives. Had the scheduler injected an
    // aggressive operator config (as cron/channels do), the seed would be gone.
    const seenPerTurn: string[][] = [];
    const toolUseTurn: AssistantMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'reading' },
        { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: 'x' } },
      ],
    };
    const finalTurn: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'all done' }],
    };
    let call = 0;
    const transport: LLMProvider = {
      name: 'two-turn',
      async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
        // Snapshot (serialize) the history at call time — `req.messages` is the
        // live array query() mutates between turns.
        seenPerTurn.push(req.messages.map((m) => JSON.stringify(m.content)));
        call += 1;
        if (call === 1) {
          yield { type: 'message_start' };
          yield { type: 'message_stop', stop_reason: 'tool_use' };
          yield { type: 'assistant_message', message: toolUseTurn };
          return toolUseTurn;
        }
        yield { type: 'message_start' };
        yield { type: 'message_stop', stop_reason: 'end_turn' };
        yield { type: 'assistant_message', message: finalTurn };
        return finalTurn;
      },
    };
    const resolved: ResolvedProvider = {
      transport: transport as unknown as ResolvedProvider['transport'],
      client: transport,
      baseUrl: 'fake://',
      model: 'm',
      contextLength: 32_000,
      authType: 'none',
      metadata: { provider: 'fake' },
    };

    const scheduler = new SubagentScheduler(
      baseSchedulerOpts(makeRegistry([makeAgent({ name: 'explore' })]), resolved),
    );

    const result = await scheduler.delegate({
      agentName: 'explore',
      prompt: 'do the thing',
      parentSessionId: 'parent',
      parentToolPool: [makeReadTool()],
      parentToolContext: baseToolContext,
    });

    expect(result.terminal.reason).toBe('completed');
    expect(result.summary).toBe('all done');
    expect(result.distinctToolNames).toEqual(['Read']);
    expect(result.toolCallCount).toBe(1);
    expect(result.iterationsUsed).toBe(2);

    // Two provider turns ran, and the SECOND turn's request still carried the
    // original seed prompt → no eviction → no microcompactConfig reached the turn.
    expect(seenPerTurn).toHaveLength(2);
    expect(seenPerTurn[1]?.join(' ')).toContain('do the thing');
  });

  test('an erroring child still produces its error DelegateResult (no throw)', async () => {
    // createAgent converts a thrown/error-terminal turn into terminal.reason
    // 'error' — exactly as AgentRunner did (error-path case a). The scheduler
    // consumes the terminal, never a propagated throw, so delegate() RESOLVES
    // with an error DelegateResult rather than rejecting.
    const transport: LLMProvider = {
      name: 'boom',
      // biome-ignore lint/correctness/useYield: throws before yielding any event.
      async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
        throw new Error('child-boom');
      },
    };
    const resolved: ResolvedProvider = {
      transport: transport as unknown as ResolvedProvider['transport'],
      client: transport,
      baseUrl: 'fake://',
      model: 'm',
      contextLength: 32_000,
      authType: 'none',
      metadata: { provider: 'fake' },
    };

    const scheduler = new SubagentScheduler(
      baseSchedulerOpts(makeRegistry([makeAgent({ name: 'explore' })]), resolved),
    );

    const result = await scheduler.delegate({
      agentName: 'explore',
      prompt: 'will fail',
      parentSessionId: 'parent',
      parentToolPool: [makeReadTool()],
      parentToolContext: baseToolContext,
    });

    expect(result.terminal.reason).toBe('error');
    expect(result.terminal.error?.message ?? '').toContain('child-boom');
    expect(result.summary).toBe('');
    expect(result.finalAssistant).toBeUndefined();
    expect(result.distinctToolNames).toEqual([]);
    expect(result.toolCallCount).toBe(0);
    expect(result.iterationsUsed).toBe(0);
    // The counter returned cleanly to zero (the error path released the slot).
    expect(scheduler.activeChildren('parent')).toBe(0);
  });
});

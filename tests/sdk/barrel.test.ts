// Task 3.2 — the importability proof for the `src/sdk.ts` barrel.
//
// This is the external-consumer smoke: everything is imported FROM THE BARREL
// (`../../src/sdk.js`), not the deep modules — exactly as a downstream package
// consumer would `import { createAgent } from '@yevgetman/sov-sdk'`. It proves
// the Contract #1 surface is intact and that a bare turn runs with NO DISK:
//   1. Build an agent from a mock `LLMProvider` + a simple `buildTool` tool and
//      `run("hi")` with NO `sessionStore` → it completes and yields a final
//      assistant message, touching no persistence (the embeddable default).
//   2. A representative slice of the documented exports is defined — a cheap
//      guard that the barrel surface has not silently regressed (the precursor
//      to the Phase-8 surface snapshot).
//
// No `bun:sqlite` / no filesystem is reachable: the agent is run with no
// SessionStore and no TranscriptStore, and the only modules pulled are the open
// barrel + the scripted in-memory provider built here.

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
// `ProviderRequest` is intentionally NOT on the public surface (§5.1) — the mock
// provider's stream() param shape is pinned via the deep type here.
import type { ProviderRequest as Req } from '../../src/providers/types.js';
// IMPORTANT: import from the BARREL, not the deep modules — that is the proof.
import {
  SubagentScheduler,
  buildMcpClientPool,
  buildTool,
  buildToolScope,
  createAgent,
  createInMemorySessionStore,
  createNoopTranscriptStore,
  findCapableModel,
  query,
  resolveProvider,
} from '../../src/sdk.js';
import type {
  Agent,
  AgentConfig,
  AssistantMessage,
  CanUseTool,
  ChildCompletionEvent,
  DelegateInput,
  DelegateResult,
  DelegationLifecycleEvent,
  LLMProvider,
  LaneRegistry,
  LearningSink,
  McpClientPoolFactory,
  Message,
  PerTurn,
  RunResult,
  RunSubprocessExecutor,
  RunSubprocessExecutorOpts,
  Scheduler,
  SessionStore,
  SpawnFn,
  SpawnOpts,
  SpawnedProc,
  StreamEvent,
  SubagentSchedulerOpts,
  SubprocessExecutorResult,
  SystemSegment,
  Tool,
  ToolContext,
  ToolScope,
  TraceSink,
  TranscriptStore,
} from '../../src/sdk.js';

/** A fresh mock `LLMProvider` that replays one canned StreamEvent[] per
 *  successive `stream()` call (generators are single-use → one per turn). */
function mockProvider(turns: StreamEvent[][]): LLMProvider {
  const queue = [...turns];
  return {
    name: 'mock',
    async *stream(_req: Req): AsyncGenerator<StreamEvent, AssistantMessage> {
      const events = queue.shift();
      if (!events) throw new Error('mockProvider: queue empty');
      let last: AssistantMessage | undefined;
      for (const ev of events) {
        if (ev.type === 'assistant_message') last = ev.message;
        yield ev;
      }
      return last ?? { role: 'assistant', content: [] };
    },
  };
}

const finalAnswer: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'hello from the sdk barrel' }],
};

const completedTurn: StreamEvent[] = [
  { type: 'message_start' },
  { type: 'text_delta', text: 'hello from the sdk barrel' },
  { type: 'usage_delta', usage: { inputTokens: 5, outputTokens: 4 } },
  { type: 'message_stop', stop_reason: 'end_turn' },
  { type: 'assistant_message', message: finalAnswer },
];

const echoToolUse: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 't1', name: 'Echo', input: { text: 'hi' } }],
};

const echoToolUseTurn: StreamEvent[] = [
  { type: 'message_start' },
  { type: 'tool_use_delta', id: 't1', partial: '{"text":"hi"}' },
  { type: 'message_stop', stop_reason: 'tool_use' },
  { type: 'assistant_message', message: echoToolUse },
];

function makeEchoTool(onCall?: () => void): Tool<unknown, unknown> {
  return buildTool({
    name: 'Echo',
    description: () => 'echo input',
    inputSchema: z.object({ text: z.string() }),
    async call(input) {
      onCall?.();
      return { data: { echoed: (input as { text: string }).text } };
    },
  }) as unknown as Tool<unknown, unknown>;
}

async function drain(
  gen: AsyncGenerator<StreamEvent | Message, RunResult>,
): Promise<{ events: (StreamEvent | Message)[]; result: RunResult }> {
  const events: (StreamEvent | Message)[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { events, result: step.value };
    events.push(step.value);
  }
}

describe('sdk barrel — Contract #1 importability', () => {
  test('createAgent (from the barrel) runs a no-disk turn against a mock provider', async () => {
    // Built purely from barrel symbols — the external-consumer path.
    const agent: Agent = createAgent({
      provider: mockProvider([completedTurn]),
      model: 'mock-model',
      systemPrompt: 'be terse',
      maxTokens: 128,
      // NO sessionStore / NO transcripts → no disk, no bun:sqlite.
    });

    const { result } = await drain(agent.run('hi'));

    // It completed and surfaced a final assistant message.
    expect(result.terminal.reason).toBe('completed');
    expect(result.finalAssistant).toEqual(finalAnswer);
    expect(result.iterationsUsed).toBe(1);
    expect(result.toolCallCount).toBe(0);
    // A fresh in-memory session id was minted — nothing was persisted to disk.
    expect(typeof result.sessionId).toBe('string');
    expect(result.sessionId.length).toBeGreaterThan(0);
  });

  test('a barrel-built tool turn dispatches and is counted (no disk)', async () => {
    let called = false;
    const agent = createAgent({
      provider: mockProvider([echoToolUseTurn, completedTurn]),
      model: 'mock-model',
      tools: [
        makeEchoTool(() => {
          called = true;
        }),
      ],
      maxTokens: 128,
    });

    const { events, result } = await drain(agent.run('use the tool'));

    expect(called).toBe(true);
    expect(result.terminal.reason).toBe('completed');
    expect(result.toolCallCount).toBe(1);
    expect(result.distinctToolNames).toEqual(['Echo']);
    // The tool_result user message flowed through the stream (passthrough).
    const toolResult = events.find(
      (e): e is Message =>
        'role' in e && e.role === 'user' && e.content.some((b) => b.type === 'tool_result'),
    );
    expect(toolResult).toBeDefined();
  });

  test('a per-turn override (from barrel types) wins over standing config', async () => {
    const perTurn: PerTurn = {
      provider: mockProvider([completedTurn]),
      model: 'perturn-model',
    };
    const config: AgentConfig = {
      // A standing provider that throws if ever used — the per-turn one must win.
      provider: {
        name: 'standing',
        // biome-ignore lint/correctness/useYield: unconditional throw — must never run.
        async *stream(): AsyncGenerator<StreamEvent, AssistantMessage> {
          throw new Error('standing provider must not run when perTurn.provider is set');
        },
      },
      model: 'standing-model',
      maxTokens: 128,
    };
    const { result } = await drain(createAgent(config).run('hi', perTurn));
    expect(result.terminal.reason).toBe('completed');
  });

  test('the documented barrel surface is intact (export guard)', () => {
    // Values are defined functions...
    for (const fn of [
      query,
      createAgent,
      buildTool,
      resolveProvider,
      createInMemorySessionStore,
      createNoopTranscriptStore,
      findCapableModel,
    ]) {
      expect(typeof fn).toBe('function');
    }

    // ...and the in-memory / no-op ports the canary depends on are constructible
    // from the barrel without any disk-backed store.
    const store: SessionStore = createInMemorySessionStore();
    expect(typeof store.upsertSession).toBe('function');
    const transcripts: TranscriptStore = createNoopTranscriptStore();
    expect(typeof transcripts.recordMessage).toBe('function');

    // Type-only exports are exercised by referencing them in annotations above
    // (CanUseTool, SystemSegment, ToolContext, Message, etc.): if any were
    // missing from the barrel, this file would not typecheck.
    const _typeWitness: [CanUseTool?, SystemSegment?, ToolContext?, Message?] = [];
    expect(_typeWitness).toEqual([]);
  });

  test('the delegation / MCP-factory / tool-scope surface is on the barrel (Task 2.5)', () => {
    // New value exports are live bindings.
    expect(typeof SubagentScheduler).toBe('function');
    expect(typeof buildToolScope).toBe('function');

    // `SubagentScheduler` satisfies the narrow `Scheduler` port (the named form
    // of the `Pick<SubagentScheduler, 'delegate' | 'agentNames'>` surface the
    // workflow engine consumes) — typecheck-only witness.
    const schedulerWitness: Scheduler = {} as SubagentScheduler;
    expect(typeof schedulerWitness).toBe('object');

    // `buildMcpClientPool` satisfies the injectable pool-factory port.
    const factoryWitness: McpClientPoolFactory = buildMcpClientPool;
    expect(typeof factoryWitness).toBe('function');

    // `buildToolScope` returns the exported `ToolScope` shape.
    const scope: ToolScope = buildToolScope({
      allowedTools: undefined,
      tools: [],
      canUseTool: async () => ({ behavior: 'allow' as const }),
    });
    expect(scope.tools).toEqual([]);

    // Type-only surface (typecheck-only witness): the delegation port DTOs, the
    // subscription-executor port contract, and the relocated router/review DTOs.
    const _typeWitness: [
      ChildCompletionEvent?,
      DelegateInput?,
      DelegateResult?,
      DelegationLifecycleEvent?,
      LaneRegistry?,
      LearningSink?,
      RunSubprocessExecutor?,
      RunSubprocessExecutorOpts?,
      SpawnFn?,
      SpawnOpts?,
      SpawnedProc?,
      SubagentSchedulerOpts?,
      SubprocessExecutorResult?,
      TraceSink?,
    ] = [];
    expect(_typeWitness).toEqual([]);
  });
});

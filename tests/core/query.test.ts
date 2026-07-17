// Turn-loop tests. Fixture-based: a fake provider yields a scripted
// sequence of StreamEvents; we assert query() pipes them through, captures
// the assistant message, and terminates with the right reason.
//
// We don't hit the real Anthropic API in unit tests. The provider
// translation layer is exercised by a fixture-replay test at the provider
// boundary (tests/providers/anthropic.test.ts).

import { describe, expect, test } from 'bun:test';
import { query } from '@yevgetman/sov-sdk/core/query';
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  Terminal,
} from '@yevgetman/sov-sdk/core/types';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import type { Tool, ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { z } from 'zod';

/**
 * Fake provider that runs through a queue of turn-scripts. Each script is
 * the set of events for one provider.stream() call; when the script ends,
 * the next call consumes the next script. Mimics what Anthropic does when
 * the model alternates between tool-use and end_turn turns.
 */
function scriptedTurns(turns: StreamEvent[][]): LLMProvider {
  const queue = [...turns];
  return {
    name: 'fake',
    async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      const events = queue.shift();
      if (!events) throw new Error('scriptedTurns: no more turns in script');
      let last: AssistantMessage | undefined;
      for (const ev of events) {
        if (ev.type === 'assistant_message') last = ev.message;
        yield ev;
      }
      return last ?? { role: 'assistant', content: [] };
    },
  };
}

function capturingProvider(onRequest: (req: ProviderRequest) => void): LLMProvider {
  return {
    name: 'capture',
    async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      onRequest(req);
      for (const ev of completedEvents) yield ev;
      return completedAnswer;
    },
  };
}

function oneToolThenDoneProvider(onRequest: (req: ProviderRequest) => void): LLMProvider {
  let calls = 0;
  return {
    name: 'capture-tool-loop',
    async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      onRequest(req);
      calls++;
      if (calls === 1) {
        const assistant = toolUseAnswer;
        yield { type: 'message_start' };
        yield { type: 'message_stop', stop_reason: 'tool_use' };
        yield { type: 'assistant_message', message: assistant };
        return assistant;
      }
      for (const ev of completedEvents) yield ev;
      return completedAnswer;
    },
  };
}

/** Provider that returns N consecutive tool-use turns, then a final completion. */
function nToolTurnsThenDoneProvider(toolTurns: number): LLMProvider {
  let calls = 0;
  return {
    name: 'n-tool-then-done',
    async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      calls++;
      if (calls <= toolTurns) {
        yield { type: 'message_start' };
        yield { type: 'message_stop', stop_reason: 'tool_use' };
        yield { type: 'assistant_message', message: toolUseAnswer };
        return toolUseAnswer;
      }
      for (const ev of completedEvents) yield ev;
      return completedAnswer;
    },
  };
}

async function drainToTerminal(
  gen: AsyncGenerator<StreamEvent | Message, Terminal>,
): Promise<Terminal> {
  for (;;) {
    const step = await gen.next();
    if (step.done) return step.value;
  }
}

const completedAnswer: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: '4' }],
};

const completedEvents: StreamEvent[] = [
  { type: 'message_start' },
  { type: 'text_delta', text: '4' },
  { type: 'message_stop', stop_reason: 'end_turn' },
  { type: 'assistant_message', message: completedAnswer },
];

const toolUseAnswer: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 't1', name: 'Echo', input: { text: 'hello' } }],
};

const toolUseThenFinishTurns: StreamEvent[][] = [
  // Turn 1: assistant asks to call Echo
  [
    { type: 'message_start' },
    { type: 'tool_use_delta', id: 't1', partial: '{"text":"hello"}' },
    { type: 'message_stop', stop_reason: 'tool_use' },
    { type: 'assistant_message', message: toolUseAnswer },
  ],
  // Turn 2: assistant finishes with text
  [
    { type: 'message_start' },
    { type: 'text_delta', text: 'done' },
    { type: 'message_stop', stop_reason: 'end_turn' },
    {
      type: 'assistant_message',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    },
  ],
];

function makeEchoTool(): Tool<unknown, unknown> {
  return buildTool({
    name: 'Echo',
    description: () => 'echo input',
    inputSchema: z.object({ text: z.string() }),
    async call(input) {
      return { data: { echoed: input.text } };
    },
  }) as unknown as Tool<unknown, unknown>;
}

const toolCtx: ToolContext = {
  cwd: process.cwd(),
  bundleRoot: process.cwd(),
  sessionId: 'test',
};

describe('query() — Phase 2 turn loop', () => {
  test('single turn with no tool_use returns completed', async () => {
    const provider = scriptedTurns([completedEvents]);
    const gen = query({
      provider,
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: "what's 2+2?" }] }],
      systemPrompt: [],
      maxTokens: 256,
    });
    const yielded: (StreamEvent | Message)[] = [];
    let terminal: { reason: string } | undefined;
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        terminal = step.value;
        break;
      }
      yielded.push(step.value);
    }
    expect(terminal?.reason).toBe('completed');
  });

  test('passes cacheEnabled through to provider requests', async () => {
    const seen: ProviderRequest[] = [];
    const gen = query({
      provider: capturingProvider((req) => seen.push(req)),
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      systemPrompt: [{ text: 'system', cacheable: true }],
      maxTokens: 256,
      cacheEnabled: false,
    });
    for (;;) {
      const step = await gen.next();
      if (step.done) break;
    }
    expect(seen[0]?.cacheEnabled).toBe(false);
  });

  test('forwards effort into provider requests when set', async () => {
    const seen: ProviderRequest[] = [];
    const gen = query({
      provider: capturingProvider((req) => seen.push(req)),
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      systemPrompt: [{ text: 'system', cacheable: true }],
      maxTokens: 256,
      effort: 'high',
    });
    for (;;) {
      const step = await gen.next();
      if (step.done) break;
    }
    expect(seen[0]?.effort).toBe('high');
  });

  test('omits effort from provider requests when unset (default-off byte-identical)', async () => {
    const seen: ProviderRequest[] = [];
    const gen = query({
      provider: capturingProvider((req) => seen.push(req)),
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      systemPrompt: [{ text: 'system', cacheable: true }],
      maxTokens: 256,
      // effort intentionally omitted — the key must NOT appear on the request.
    });
    for (;;) {
      const step = await gen.next();
      if (step.done) break;
    }
    expect(seen[0]).toBeDefined();
    expect('effort' in (seen[0] ?? {})).toBe(false);
    expect(seen[0]?.effort).toBeUndefined();
  });

  test('injects memory snapshot once into the latest user message', async () => {
    const seen: ProviderRequest[] = [];
    let prefetches = 0;
    const gen = query({
      provider: oneToolThenDoneProvider((req) => seen.push(req)),
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'remembered turn' }] }],
      systemPrompt: [{ text: 'system', cacheable: true }],
      tools: [makeEchoTool()],
      toolContext: toolCtx,
      maxTokens: 256,
      memoryManager: {
        async prefetchSnapshot() {
          prefetches++;
          return '<memory-context>prefers terse</memory-context>';
        },
        async syncTurn() {},
        async onMemoryWrite() {},
        async onDelegation() {},
      },
    });
    for (;;) {
      const step = await gen.next();
      if (step.done) break;
    }
    expect(prefetches).toBe(1);
    const firstTurn = seen[0]?.messages[0];
    expect(firstTurn?.role).toBe('user');
    expect(firstTurn?.content[0]?.type).toBe('text');
    if (firstTurn?.content[0]?.type === 'text') {
      expect(firstTurn.content[0].text).toContain('prefers terse');
      expect(firstTurn.content[0].text).toContain('remembered turn');
    }
    const secondTurn = seen[1];
    expect(secondTurn?.messages.filter((message) => message.role === 'user')).toHaveLength(2);
  });

  test('preserves injected recall context when a UserPromptSubmit hook rewrites the prompt', async () => {
    // Regression: the UserPromptSubmit hook receives only the ORIGINAL prompt
    // text, but its rewrittenPrompt replaced the WHOLE latest-user text block —
    // silently wiping the <learned-context> recall block (and MEMORY.md) that
    // injection had already spliced in. The provider request must still carry
    // BOTH the injected recall marker AND the hook-rewritten user text.
    const seen: ProviderRequest[] = [];
    const RECALL_MARKER = '<learned-context>prefer ripgrep</learned-context>';
    const REWRITTEN = 'rewritten by hook';
    const ORIGINAL = 'original prompt';
    const gen = query({
      provider: capturingProvider((req) => seen.push(req)),
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: ORIGINAL }] }],
      systemPrompt: [{ text: 'system', cacheable: true }],
      maxTokens: 256,
      sessionId: 'hook-recall-test',
      cwd: process.cwd(),
      recall: async () => ({ injectionText: RECALL_MARKER, lessons: [] }),
      hookRunner: async (event) => {
        if (event === 'UserPromptSubmit') return { block: false, rewrittenPrompt: REWRITTEN };
        return { block: false };
      },
    });
    for (;;) {
      const step = await gen.next();
      if (step.done) break;
    }
    const firstUser = seen[0]?.messages.find((m) => m.role === 'user');
    expect(firstUser).toBeDefined();
    const firstText = firstUser?.content.find((b) => b.type === 'text');
    expect(firstText?.type).toBe('text');
    if (firstText?.type === 'text') {
      // Both the injected recall context AND the rewritten user text survive.
      expect(firstText.text).toContain(RECALL_MARKER);
      expect(firstText.text).toContain(REWRITTEN);
      // The original prompt was replaced by the rewrite (not appended alongside).
      expect(firstText.text).not.toContain(ORIGINAL);
      // No double-injection of the recall marker.
      expect(firstText.text.split(RECALL_MARKER)).toHaveLength(2);
    }
  });

  test('preserves injected memory snapshot when a UserPromptSubmit hook rewrites the prompt', async () => {
    // Same regression via the MEMORY.md injection path (memoryManager) rather
    // than the recall thunk: a hook rewrite must not wipe the memory snapshot.
    const seen: ProviderRequest[] = [];
    const MEMORY_MARKER = 'prefers terse output';
    const REWRITTEN = 'hook-rewritten prompt';
    const ORIGINAL = 'remember this';
    const gen = query({
      provider: capturingProvider((req) => seen.push(req)),
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: ORIGINAL }] }],
      systemPrompt: [{ text: 'system', cacheable: true }],
      maxTokens: 256,
      sessionId: 'hook-memory-test',
      cwd: process.cwd(),
      memoryManager: {
        async prefetchSnapshot() {
          return `<memory-context>${MEMORY_MARKER}</memory-context>`;
        },
        async syncTurn() {},
        async onMemoryWrite() {},
        async onDelegation() {},
      },
      hookRunner: async (event) => {
        if (event === 'UserPromptSubmit') return { block: false, rewrittenPrompt: REWRITTEN };
        return { block: false };
      },
    });
    for (;;) {
      const step = await gen.next();
      if (step.done) break;
    }
    const firstUser = seen[0]?.messages.find((m) => m.role === 'user');
    const firstText = firstUser?.content.find((b) => b.type === 'text');
    expect(firstText?.type).toBe('text');
    if (firstText?.type === 'text') {
      expect(firstText.text).toContain(MEMORY_MARKER);
      expect(firstText.text).toContain(REWRITTEN);
      expect(firstText.text).not.toContain(ORIGINAL);
    }
  });

  test('tool_use turn dispatches runTools and continues to completion', async () => {
    const provider = scriptedTurns(toolUseThenFinishTurns);
    const gen = query({
      provider,
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'say hello' }] }],
      systemPrompt: [],
      tools: [makeEchoTool()],
      toolContext: toolCtx,
      maxTokens: 256,
    });
    const yielded: (StreamEvent | Message)[] = [];
    let terminal: { reason: string; error?: Error } | undefined;
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        terminal = step.value;
        break;
      }
      yielded.push(step.value);
    }
    expect(terminal?.reason).toBe('completed');
    // Between the two assistant_message events, there should be one user
    // message carrying the tool_result.
    const userMessages = yielded.filter(
      (v) => v && typeof v === 'object' && 'role' in v && v.role === 'user',
    ) as Message[];
    expect(userMessages).toHaveLength(1);
    const [userMsg] = userMessages;
    expect(userMsg?.content[0]?.type).toBe('tool_result');
  });

  test('tool_use with no tools provided returns error', async () => {
    const firstTurn = toolUseThenFinishTurns[0];
    if (!firstTurn) throw new Error('test fixture missing');
    const provider = scriptedTurns([firstTurn]);
    const gen = query({
      provider,
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      systemPrompt: [],
      maxTokens: 256,
    });
    const yielded: (StreamEvent | Message)[] = [];
    let terminal: { reason: string; error?: Error } | undefined;
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        terminal = step.value;
        break;
      }
      yielded.push(step.value);
    }
    expect(terminal?.reason).toBe('error');
    expect(terminal?.error?.message).toContain('no tools');
    const toolResults = yielded.filter(
      (v) => v && typeof v === 'object' && 'role' in v && v.role === 'user',
    ) as Message[];
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 't1',
        content: 'tool call could not run: no tools were provided',
        is_error: true,
      },
    ]);
  });

  test('interrupted tool dispatch yields error tool_result blocks before stopping', async () => {
    const firstTurn = toolUseThenFinishTurns[0];
    if (!firstTurn) throw new Error('test fixture missing');
    const provider = scriptedTurns([firstTurn]);
    const controller = new AbortController();
    const gen = query({
      provider,
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      systemPrompt: [],
      tools: [makeEchoTool()],
      toolContext: toolCtx,
      maxTokens: 256,
      signal: controller.signal,
      canUseTool: async () => {
        controller.abort();
        throw new Error('prompt aborted');
      },
    });
    const yielded: (StreamEvent | Message)[] = [];
    let terminal: { reason: string; error?: Error } | undefined;
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        terminal = step.value;
        break;
      }
      yielded.push(step.value);
    }
    expect(terminal?.reason).toBe('interrupted');
    const toolResults = yielded.filter(
      (v) => v && typeof v === 'object' && 'role' in v && v.role === 'user',
    ) as Message[];
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 't1',
        content: 'tool call interrupted before a result was available',
        is_error: true,
      },
    ]);
  });

  test('maxTurns caps the tool-continuation loop', async () => {
    // Every turn asks to call Echo again; without a cap this would loop
    // forever. With maxTurns=2 the generator should return max_turns.
    const keepCallingTurns: StreamEvent[][] = Array.from({ length: 5 }, (_, i) => [
      { type: 'message_start' } as StreamEvent,
      { type: 'tool_use_delta', id: `t${i}`, partial: '{"text":"x"}' } as StreamEvent,
      { type: 'message_stop', stop_reason: 'tool_use' } as StreamEvent,
      {
        type: 'assistant_message',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: `t${i}`, name: 'Echo', input: { text: 'x' } }],
        },
      } as StreamEvent,
    ]);
    const provider = scriptedTurns(keepCallingTurns);
    const gen = query({
      provider,
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      systemPrompt: [],
      tools: [makeEchoTool()],
      toolContext: toolCtx,
      maxTurns: 2,
      maxTokens: 256,
    });
    let terminal: { reason: string } | undefined;
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        terminal = step.value;
        break;
      }
    }
    expect(terminal?.reason).toBe('max_turns');
  });

  test('max_tokens stop returns a distinct terminal reason', async () => {
    const partialAnswer: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'partial replacement file...' }],
    };
    const provider = scriptedTurns([
      [
        { type: 'message_start' },
        { type: 'text_delta', text: 'partial replacement file...' },
        { type: 'message_stop', stop_reason: 'max_tokens' },
        { type: 'assistant_message', message: partialAnswer },
      ],
    ]);
    const gen = query({
      provider,
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'rewrite the site' }] }],
      systemPrompt: [],
      maxTokens: 256,
    });
    let terminal: { reason: string } | undefined;
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        terminal = step.value;
        break;
      }
    }
    expect(terminal?.reason).toBe('max_tokens');
  });

  test('max_tokens with tool_use emits synthetic tool_result before stopping', async () => {
    const provider = scriptedTurns([
      [
        { type: 'message_start' },
        { type: 'message_stop', stop_reason: 'max_tokens' },
        { type: 'assistant_message', message: toolUseAnswer },
      ],
    ]);
    const gen = query({
      provider,
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'run a tool' }] }],
      systemPrompt: [],
      tools: [makeEchoTool()],
      toolContext: toolCtx,
      maxTokens: 256,
    });
    const yielded: (StreamEvent | Message)[] = [];
    let terminal: { reason: string } | undefined;
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        terminal = step.value;
        break;
      }
      yielded.push(step.value);
    }
    expect(terminal?.reason).toBe('max_tokens');
    const toolResults = yielded.filter(
      (v) => v && typeof v === 'object' && 'role' in v && v.role === 'user',
    ) as Message[];
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 't1',
      content:
        'tool call was not executed because the assistant response hit max_tokens before completing the turn',
      is_error: true,
    });
  });

  test('honors pre-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = scriptedTurns([completedEvents]);
    const gen = query({
      provider,
      model: 'claude-sonnet-4-6',
      messages: [],
      systemPrompt: [],
      maxTokens: 256,
      signal: controller.signal,
    });
    const first = await gen.next();
    expect(first.done).toBe(true);
    expect((first.value as { reason: string }).reason).toBe('interrupted');
  });

  test('treats empty assistant response as error', async () => {
    const provider: LLMProvider = {
      name: 'empty',
      // biome-ignore lint/correctness/useYield: intentional — zero events, tests the no-assistant-message error path.
      async *stream() {
        return { role: 'assistant', content: [] };
      },
    };
    const gen = query({
      provider,
      model: 'claude-sonnet-4-6',
      messages: [],
      systemPrompt: [],
      maxTokens: 256,
    });
    const step = await gen.next();
    expect(step.done).toBe(true);
    expect((step.value as { reason: string }).reason).toBe('error');
  });
});

describe('maxToolCallsBeforeCheckin', () => {
  const seed: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }];

  test('returns checkin terminal when tool-call count reaches limit', async () => {
    // 3 tool-use turns; limit 2 → checkin fires after turn 2
    const provider = nToolTurnsThenDoneProvider(3);
    const gen = query({
      provider,
      model: 'test',
      messages: seed,
      systemPrompt: [{ text: 'sys', cacheable: false }],
      tools: [makeEchoTool()],
      toolContext: toolCtx,
      maxTokens: 1000,
      maxToolCallsBeforeCheckin: 2,
    });
    const terminal = await drainToTerminal(gen);
    expect(terminal.reason).toBe('checkin');
    expect(terminal.toolCallCount).toBe(2);
  });

  test('does not checkin when limit is not reached', async () => {
    // 1 tool-use turn then completes; limit 5 → runs to completion
    const provider = nToolTurnsThenDoneProvider(1);
    const gen = query({
      provider,
      model: 'test',
      messages: seed,
      systemPrompt: [{ text: 'sys', cacheable: false }],
      tools: [makeEchoTool()],
      toolContext: toolCtx,
      maxTokens: 1000,
      maxToolCallsBeforeCheckin: 5,
    });
    const terminal = await drainToTerminal(gen);
    expect(terminal.reason).toBe('completed');
  });

  test('without maxToolCallsBeforeCheckin set, never checkins', async () => {
    // 5 tool-use turns; no limit → runs to completion
    const provider = nToolTurnsThenDoneProvider(5);
    const gen = query({
      provider,
      model: 'test',
      messages: seed,
      systemPrompt: [{ text: 'sys', cacheable: false }],
      tools: [makeEchoTool()],
      toolContext: toolCtx,
      maxTokens: 1000,
    });
    const terminal = await drainToTerminal(gen);
    expect(terminal.reason).toBe('completed');
  });
});

describe('query() — mid-turn steering (pollSteering)', () => {
  test('tool-boundary steer merges into the tool_result user message pre-yield', async () => {
    const provider = scriptedTurns(toolUseThenFinishTurns);
    let polls = 0;
    const gen = query({
      provider,
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'work' }] }],
      systemPrompt: [],
      tools: [makeEchoTool()],
      toolContext: toolCtx,
      maxTokens: 256,
      pollSteering: async () => {
        polls++;
        return polls === 1 ? 'STEER: switch to postgres' : null;
      },
    });
    const yielded: (StreamEvent | Message)[] = [];
    let terminal: { reason: string } | undefined;
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        terminal = step.value;
        break;
      }
      yielded.push(step.value);
    }
    expect(terminal?.reason).toBe('completed');
    const userMessages = yielded.filter(
      (v) => v && typeof v === 'object' && 'role' in v && v.role === 'user',
    ) as Message[];
    // One tool_result batch message, now carrying the steer as an extra text block.
    expect(userMessages).toHaveLength(1);
    const first = userMessages[0];
    expect(first?.content[0]?.type).toBe('tool_result');
    const textBlocks = (first?.content ?? []).filter((b) => b.type === 'text');
    expect(textBlocks.some((b) => 'text' in b && b.text.includes('switch to postgres'))).toBe(true);
  });

  test('turn-end steer continues the loop with a standalone user message', async () => {
    // Provider finishes WITHOUT tool calls twice: first final answer gets a
    // steer (loop continues), second final answer sees none (loop completes).
    const provider = scriptedTurns([completedEvents, completedEvents]);
    let polls = 0;
    const gen = query({
      provider,
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'answer me' }] }],
      systemPrompt: [],
      maxTokens: 256,
      pollSteering: async () => {
        polls++;
        return polls === 1 ? 'STEER: also include totals' : null;
      },
    });
    const yielded: (StreamEvent | Message)[] = [];
    let terminal: { reason: string } | undefined;
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        terminal = step.value;
        break;
      }
      yielded.push(step.value);
    }
    expect(terminal?.reason).toBe('completed');
    expect(polls).toBeGreaterThanOrEqual(2);
    const userMessages = yielded.filter(
      (v) => v && typeof v === 'object' && 'role' in v && v.role === 'user',
    ) as Message[];
    expect(userMessages).toHaveLength(1);
    const first = userMessages[0];
    expect(first?.content[0]?.type).toBe('text');
    expect(
      first?.content.some((b) => b.type === 'text' && b.text.includes('also include totals')),
    ).toBe(true);
  });

  test('null steering thunk leaves the turn byte-identical', async () => {
    const provider = scriptedTurns([completedEvents]);
    const gen = query({
      provider,
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'plain' }] }],
      systemPrompt: [],
      maxTokens: 256,
      pollSteering: async () => null,
    });
    const yielded: (StreamEvent | Message)[] = [];
    let terminal: { reason: string } | undefined;
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        terminal = step.value;
        break;
      }
      yielded.push(step.value);
    }
    expect(terminal?.reason).toBe('completed');
    expect(yielded.filter((v) => v && typeof v === 'object' && 'role' in v)).toHaveLength(0);
  });

  test('turn-end steering continuations are bounded by maxTurns', async () => {
    // Every model call finishes clean; steering ALWAYS has content — the loop
    // must stop at the bound, not spin forever. Review fix 2026-07-09: the
    // FINAL allowed iteration no longer polls (a steer consumed there could
    // never reach the model), so the run completes cleanly at the bound with
    // exactly maxTurns - 1 polls and the leftover steer stays at the source.
    let polls = 0;
    const provider = scriptedTurns([completedEvents, completedEvents, completedEvents]);
    const gen = query({
      provider,
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      systemPrompt: [],
      maxTokens: 256,
      maxTurns: 3,
      pollSteering: async () => {
        polls++;
        return 'STEER: keep going';
      },
    });
    const terminal = await drainToTerminal(gen);
    expect(terminal.reason).toBe('completed');
    expect(polls).toBe(2);
  });
});

describe('query() — steering maxTurns guards (review fixes)', () => {
  test('turn-end steer is NOT consumed on the final allowed iteration', async () => {
    // maxTurns=1: the single model call finishes clean; a pending steer must
    // be left in the source (poll never called) so the adapter's leftover
    // drain can deliver it honestly.
    let polls = 0;
    const provider = scriptedTurns([completedEvents]);
    const gen = query({
      provider,
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      systemPrompt: [],
      maxTokens: 256,
      maxTurns: 1,
      pollSteering: async () => {
        polls++;
        return 'STEER: too late';
      },
    });
    const terminal = await drainToTerminal(gen);
    expect(terminal.reason).toBe('completed');
    expect(polls).toBe(0);
  });

  test('tool-boundary steer is NOT consumed when no further model call is allowed', async () => {
    let polls = 0;
    const firstTurn = toolUseThenFinishTurns[0];
    if (!firstTurn) throw new Error('fixture missing');
    const provider = scriptedTurns([firstTurn]);
    const gen = query({
      provider,
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'work' }] }],
      systemPrompt: [],
      tools: [makeEchoTool()],
      toolContext: toolCtx,
      maxTokens: 256,
      maxTurns: 1,
      pollSteering: async () => {
        polls++;
        return 'STEER: unseen';
      },
    });
    const terminal = await drainToTerminal(gen);
    expect(terminal.reason).toBe('max_turns');
    expect(polls).toBe(0);
  });
});

describe('query() — ToolResult.newMessages reaches the model (end-to-end)', () => {
  // Base64 for "ABC" — a tiny stand-in image payload so we can pin the exact
  // bytes as they travel: tool → runTools merge → history → provider turn 2.
  const IMAGE_DATA = 'QUJD';

  /** Tool that returns an image via `newMessages` (user-role) alongside its
   *  normal tool_result data. Task 1 merges that image block into the
   *  tool_result user message so the model sees it on the next turn. */
  function makeImageTool(): Tool<unknown, unknown> {
    return buildTool({
      name: 'Echo',
      description: () => 'returns an image via newMessages',
      inputSchema: z.object({ text: z.string() }),
      async call() {
        return {
          data: 'read',
          newMessages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: IMAGE_DATA },
                },
              ],
            },
          ],
        };
      },
    }) as unknown as Tool<unknown, unknown>;
  }

  /** scriptedTurns variant that also records every request the provider
   *  receives, so we can inspect the exact message history the model is
   *  handed on turn 2 (the strongest signal the image reached the model). */
  function scriptedTurnsCapturing(turns: StreamEvent[][], seen: ProviderRequest[]): LLMProvider {
    const queue = [...turns];
    return {
      name: 'fake-capture',
      async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
        seen.push(req);
        const events = queue.shift();
        if (!events) throw new Error('scriptedTurnsCapturing: no more turns in script');
        let last: AssistantMessage | undefined;
        for (const ev of events) {
          if (ev.type === 'assistant_message') last = ev.message;
          yield ev;
        }
        return last ?? { role: 'assistant', content: [] };
      },
    };
  }

  test('a tool image returned via newMessages is in the history the model receives on turn 2', async () => {
    const seen: ProviderRequest[] = [];
    // Turn 1: assistant calls Echo → tool returns the image via newMessages.
    // Turn 2: assistant finishes with text (ends the run).
    const provider = scriptedTurnsCapturing(toolUseThenFinishTurns, seen);
    const gen = query({
      provider,
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'read the file' }] }],
      systemPrompt: [],
      tools: [makeImageTool()],
      toolContext: toolCtx,
      maxTokens: 256,
    });
    const yielded: (StreamEvent | Message)[] = [];
    let terminal: { reason: string } | undefined;
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        terminal = step.value;
        break;
      }
      yielded.push(step.value);
    }
    expect(terminal?.reason).toBe('completed');

    // The provider was called twice; turn 2's request carries the tool_result
    // user message. That message must ALSO contain the image block appended
    // after the tool_result — i.e. the picture reached the model.
    expect(seen).toHaveLength(2);
    const turn2Messages = seen[1]?.messages ?? [];
    const toolResultMsg = turn2Messages.find(
      (m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result'),
    );
    expect(toolResultMsg?.content[0]?.type).toBe('tool_result');
    const imageBlock = toolResultMsg?.content.find((b) => b.type === 'image');
    expect(imageBlock).toBeDefined();
    if (imageBlock?.type === 'image') {
      expect(imageBlock.source.type).toBe('base64');
      expect(imageBlock.source.media_type).toBe('image/png');
      expect(imageBlock.source.data).toBe(IMAGE_DATA);
    }

    // And the same is true of the user message query() yielded to the caller.
    const yieldedUser = (
      yielded.filter(
        (v) => v && typeof v === 'object' && 'role' in v && v.role === 'user',
      ) as Message[]
    )[0];
    expect(yieldedUser?.content[0]?.type).toBe('tool_result');
    expect(
      yieldedUser?.content.some((b) => b.type === 'image' && b.source.data === IMAGE_DATA),
    ).toBe(true);
  });
});

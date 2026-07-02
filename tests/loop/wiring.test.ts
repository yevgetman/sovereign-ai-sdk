// Phase 10.5 — query() integration with the loop detector. We script a
// fake provider to repeat the same tool call across many turns and assert:
// (1) loop_detected StreamEvent fires, (2) trace event records, (3) first
// detection injects a guidance message + continues, (4) second detection
// terminates with reason: error.

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
import type { TraceEvent } from '@yevgetman/sov-sdk/trace/types';
import { z } from 'zod';

const STUCK_TOOL_USE: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 'tu_loop', name: 'Echo', input: { text: 'same' } }],
};

const COMPLETED: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'breaking out of the loop' }],
};

function stuckProvider(opts: { breakAt?: number } = {}): LLMProvider {
  let turn = 0;
  return {
    name: 'stuck',
    async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      const broken = opts.breakAt !== undefined && turn >= opts.breakAt;
      turn++;
      if (broken) {
        yield { type: 'message_start' };
        yield { type: 'message_stop', stop_reason: 'end_turn' };
        yield { type: 'assistant_message', message: COMPLETED };
        return COMPLETED;
      }
      yield { type: 'message_start' };
      yield { type: 'message_stop', stop_reason: 'tool_use' };
      yield { type: 'assistant_message', message: STUCK_TOOL_USE };
      return STUCK_TOOL_USE;
    },
  };
}

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
  sessionId: 'loop-wire-test',
};

async function drainCollecting(
  gen: AsyncGenerator<StreamEvent | Message, Terminal>,
): Promise<{ events: (StreamEvent | Message)[]; terminal: Terminal }> {
  const events: (StreamEvent | Message)[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { events, terminal: step.value };
    events.push(step.value);
  }
}

describe('query() ⊕ loop detector', () => {
  test('emits loop_detected and injects guidance after the threshold', async () => {
    const traceEvents: TraceEvent[] = [];
    // breakAt=4: model calls the same tool 4 times in a row, then stops.
    // Expected: 4th turn triggers the consecutive-identical detector and
    // injects guidance; the 5th turn stops cleanly.
    const gen = query({
      provider: stuckProvider({ breakAt: 4 }),
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      systemPrompt: [],
      tools: [makeEchoTool()],
      toolContext: toolCtx,
      canUseTool: async () => ({ behavior: 'allow' }),
      maxTokens: 256,
      maxTurns: 20,
      traceRecorder: (e) => traceEvents.push(e),
    });
    const { events, terminal } = await drainCollecting(gen);
    expect(terminal.reason).toBe('completed');
    const loopEvents = events.filter(
      (e) => 'type' in e && (e as StreamEvent).type === 'loop_detected',
    );
    expect(loopEvents).toHaveLength(1);
    expect(traceEvents.find((t) => t.type === 'loop_detected')).toBeDefined();
    // The injected guidance message must appear in the yielded stream.
    const guidanceMsg = events.find(
      (e) =>
        'role' in e &&
        e.role === 'user' &&
        e.content.some(
          (b) => b.type === 'text' && b.text.includes('looks like the same action is repeating'),
        ),
    );
    expect(guidanceMsg).toBeDefined();
  });

  test('preserves tool_use → tool_result pairing when guidance is injected', async () => {
    // Provider-validity invariant: every assistant message containing one or
    // more `tool_use` blocks must be IMMEDIATELY followed by a user message
    // containing matching `tool_result` blocks. Anthropic returns 400 with
    // "tool_use ids were found without tool_result blocks immediately after"
    // otherwise. The original loop-detector wiring violated this by pushing
    // a text-only guidance message between the assistant's tool_use and the
    // user's tool_result. This test catches that regression.
    const gen = query({
      provider: stuckProvider({ breakAt: 4 }),
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      systemPrompt: [],
      tools: [makeEchoTool()],
      toolContext: toolCtx,
      canUseTool: async () => ({ behavior: 'allow' }),
      maxTokens: 256,
      maxTurns: 20,
    });
    const { events, terminal } = await drainCollecting(gen);
    expect(terminal.reason).toBe('completed');

    // Reconstruct the message timeline that would be sent to the provider on
    // each turn — assistant messages (from `assistant_message` StreamEvents)
    // and yielded user messages, in the order they would land in `history`.
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }];
    for (const e of events) {
      if ('type' in e && (e as StreamEvent).type === 'assistant_message') {
        messages.push((e as Extract<StreamEvent, { type: 'assistant_message' }>).message);
      } else if ('role' in e) {
        messages.push(e);
      }
    }

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m || m.role !== 'assistant') continue;
      const toolUseIds = m.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => (b.type === 'tool_use' ? b.id : ''));
      if (toolUseIds.length === 0) continue;
      const next = messages[i + 1];
      expect(next, `assistant tool_use at index ${i} must have a next message`).toBeDefined();
      expect(next?.role).toBe('user');
      const resultIds = (next?.content ?? [])
        .filter((b) => b.type === 'tool_result')
        .map((b) => (b.type === 'tool_result' ? b.tool_use_id : ''));
      for (const id of toolUseIds) {
        expect(
          resultIds,
          `tool_use ${id} (asst@${i}) must have a tool_result in user@${i + 1}`,
        ).toContain(id);
      }
    }
  });

  test('content-only first-strike loop does not orphan a trailing user message', async () => {
    // Regression: a content-loop detector firing its FIRST strike on a turn
    // with NO tool_use must NOT leave history ending on a standalone user
    // guidance message. A content-only turn always terminates (there is no
    // continuation), so a trailing user message can never be acted on — and
    // the NEXT user turn appended after it produces two consecutive user
    // messages → Anthropic 400 "roles must alternate". See
    // docs/postmortems/loop-detector-orphaned-tool-use.md (alternation invariant).
    //
    // We trip the content-loop detector on turn 0 with a single content-only
    // assistant message whose text is one 200-char chunk repeated 8 times
    // (>= contentRepeatThreshold), then the provider would complete.
    const chunk = 'A'.repeat(200);
    const loopText = chunk.repeat(8);
    const contentLoopOnce: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: loopText }],
    };
    const contentLoopProvider: LLMProvider = {
      name: 'content-loop',
      async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
        yield { type: 'message_start' };
        yield { type: 'message_stop', stop_reason: 'end_turn' };
        yield { type: 'assistant_message', message: contentLoopOnce };
        return contentLoopOnce;
      },
    };
    const gen = query({
      provider: contentLoopProvider,
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      systemPrompt: [],
      tools: [makeEchoTool()],
      toolContext: toolCtx,
      canUseTool: async () => ({ behavior: 'allow' }),
      maxTokens: 256,
      maxTurns: 20,
    });
    const { events, terminal } = await drainCollecting(gen);
    // The content-loop fired (first strike) and the content-only turn ends.
    expect(terminal.reason).toBe('completed');
    const loopEvents = events.filter(
      (e) => 'type' in e && (e as StreamEvent).type === 'loop_detected',
    );
    expect(loopEvents).toHaveLength(1);

    // Reconstruct the history a caller (REPL) would persist: user seed +
    // every assistant_message + every yielded user message.
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }];
    for (const e of events) {
      if ('type' in e && (e as StreamEvent).type === 'assistant_message') {
        messages.push((e as Extract<StreamEvent, { type: 'assistant_message' }>).message);
      } else if ('role' in e) {
        messages.push(e);
      }
    }

    // The persisted history must NOT end on a trailing standalone user
    // message — it must end on the assistant content-only reply.
    const last = messages[messages.length - 1];
    expect(last?.role).toBe('assistant');

    // No two consecutive user messages anywhere in the persisted timeline.
    for (let i = 1; i < messages.length; i++) {
      expect(
        !(messages[i - 1]?.role === 'user' && messages[i]?.role === 'user'),
        `messages ${i - 1} and ${i} must not both be user (alternation invariant)`,
      ).toBe(true);
    }

    // And a following user turn alternates correctly: appending the next
    // user message keeps the last two roles as user → assistant on the wire.
    const nextTurn: Message[] = [
      ...messages,
      { role: 'user', content: [{ type: 'text', text: 'what happened?' }] },
    ];
    expect(nextTurn[nextTurn.length - 2]?.role).toBe('assistant');
    expect(nextTurn[nextTurn.length - 1]?.role).toBe('user');
  });

  test('terminates with reason: error after the second detection', async () => {
    // Model never breaks out — same tool call forever. After the first
    // detection we inject guidance, but the next turn keeps repeating, so
    // a second detection fires and the loop terminates.
    const gen = query({
      provider: stuckProvider({}),
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      systemPrompt: [],
      tools: [makeEchoTool()],
      toolContext: toolCtx,
      canUseTool: async () => ({ behavior: 'allow' }),
      maxTokens: 256,
      maxTurns: 20,
    });
    const { events, terminal } = await drainCollecting(gen);
    expect(terminal.reason).toBe('error');
    expect(terminal.error?.message).toContain('aborted by loop detector');
    const loopEvents = events.filter(
      (e) => 'type' in e && (e as StreamEvent).type === 'loop_detected',
    );
    expect(loopEvents).toHaveLength(2);
    // Second loop_detected must carry occurrence: 2.
    const second = loopEvents[1] as Extract<StreamEvent, { type: 'loop_detected' }>;
    expect(second.info.occurrence).toBe(2);
  });

  test('second-strike abort yields synthetic tool_result for orphaned tool_use', async () => {
    // Regression: when the loop detector fires its second (terminating)
    // strike on a turn whose assistant message contains tool_use blocks,
    // it must yield a synthetic tool_result message before returning.
    // Without this, the persisted history (REPL turnMessages, sessionDb)
    // contains an assistant tool_use with no matching tool_result, and the
    // next provider call rejects with "tool_use ids were found without
    // tool_result blocks immediately after" (HTTP 400). See
    // docs/postmortems/loop-detector-orphaned-tool-use.md.
    const gen = query({
      provider: stuckProvider({}),
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      systemPrompt: [],
      tools: [makeEchoTool()],
      toolContext: toolCtx,
      canUseTool: async () => ({ behavior: 'allow' }),
      maxTokens: 256,
      maxTurns: 20,
    });
    const { events, terminal } = await drainCollecting(gen);
    expect(terminal.reason).toBe('error');

    // Reconstruct the message timeline that a caller (REPL) would persist:
    // user seed + every assistant_message + every yielded user message.
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }];
    for (const e of events) {
      if ('type' in e && (e as StreamEvent).type === 'assistant_message') {
        messages.push((e as Extract<StreamEvent, { type: 'assistant_message' }>).message);
      } else if ('role' in e) {
        messages.push(e);
      }
    }

    // Every assistant message containing tool_use must be IMMEDIATELY
    // followed by a user message containing matching tool_result blocks.
    // This is the same Anthropic invariant the first-strike test asserts;
    // it must hold on the second-strike abort path too.
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m || m.role !== 'assistant') continue;
      const toolUseIds = m.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => (b.type === 'tool_use' ? b.id : ''));
      if (toolUseIds.length === 0) continue;
      const next = messages[i + 1];
      expect(next, `assistant tool_use at index ${i} must have a next message`).toBeDefined();
      expect(next?.role).toBe('user');
      const resultIds = (next?.content ?? [])
        .filter((b) => b.type === 'tool_result')
        .map((b) => (b.type === 'tool_result' ? b.tool_use_id : ''));
      for (const id of toolUseIds) {
        expect(
          resultIds,
          `tool_use ${id} (asst@${i}) must have a tool_result in user@${i + 1}`,
        ).toContain(id);
      }
    }
  });
});

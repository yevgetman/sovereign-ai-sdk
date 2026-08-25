// query() ⊕ the progress-aware loop guard — wiring tests.
// Spec: specs/2026-08-25-progress-aware-loop-guard-design.md §3.3, §3.4, §3.7, §4.
//
// The detector's own unit tests live in `detector.test.ts`; this file asserts
// what the ORCHESTRATOR does with a detection:
//   - the pre-dispatch check fires and emits a `loop_detected` StreamEvent +
//     trace record carrying reason / action / mode,
//   - the post-dispatch `observeResults` ledger makes `no-progress` fire on the
//     FOLLOWING turn (one turn late, by design — §3.3),
//   - escalation follows `mode`: enforce guides then aborts at `maxStrikes`;
//     warn guides forever and never errors; off does nothing,
//   - `HARNESS_LOOP_DETECTOR=off` still wins over a configured mode,
//   - and, above all, the message-ordering invariants hold on every path
//     (postmortem `loop-detector-orphaned-tool-use.md`).

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

type LoopDetectedEvent = Extract<StreamEvent, { type: 'loop_detected' }>;

const SEED: Message = { role: 'user', content: [{ type: 'text', text: 'go' }] };

const STUCK_TOOL_USE: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 'tu_loop', name: 'Echo', input: { text: 'same' } }],
};

const COMPLETED: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'breaking out of the loop' }],
};

/** Repeats the IDENTICAL tool call every turn — the consecutive-identical shape. */
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

/** One tool call per turn with a DIFFERENT input each time, so
 *  consecutive-identical can never fire and only `no-progress` — which judges
 *  what came BACK — can. This is the varied-retry shape from spec §3.2. */
function varyingInputProvider(opts: { breakAt: number }): LLMProvider {
  let turn = 0;
  return {
    name: 'varying-input',
    async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      const index = turn++;
      const message: AssistantMessage =
        index >= opts.breakAt
          ? COMPLETED
          : {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: `tu_${index}`,
                  name: 'Constant',
                  input: { text: `variant-${index}` },
                },
              ],
            };
      yield { type: 'message_start' };
      yield { type: 'message_stop', stop_reason: index >= opts.breakAt ? 'end_turn' : 'tool_use' };
      yield { type: 'assistant_message', message };
      return message;
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

/** Returns the SAME text whatever the input — nothing new ever comes back. */
function makeConstantTool(): Tool<unknown, unknown> {
  return buildTool({
    name: 'Constant',
    description: () => 'always returns the same text',
    inputSchema: z.object({ text: z.string() }),
    async call() {
      return { data: 'nothing changed' };
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

function loopEventsOf(events: (StreamEvent | Message)[]): LoopDetectedEvent[] {
  return events.filter((e): e is LoopDetectedEvent => 'type' in e && e.type === 'loop_detected');
}

/** The message timeline a caller (REPL turnMessages, sessionDb) would persist:
 *  the user seed + every `assistant_message` + every yielded user message. */
function persistedTimeline(events: (StreamEvent | Message)[]): Message[] {
  const messages: Message[] = [SEED];
  for (const e of events) {
    if ('type' in e) {
      if (e.type === 'assistant_message') messages.push(e.message);
      continue;
    }
    messages.push(e);
  }
  return messages;
}

/** Anthropic's hard invariant: an assistant message containing `tool_use` must
 *  be IMMEDIATELY followed by a user message carrying a matching `tool_result`
 *  for every one of those ids. Breaking it 400s the NEXT call ("tool_use ids
 *  were found without tool_result blocks immediately after") and leaves the
 *  session permanently unrecoverable — that is the regression recorded in
 *  docs/07-history/postmortems/loop-detector-orphaned-tool-use.md. */
function expectToolUsePairing(messages: Message[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== 'assistant') continue;
    const toolUseIds = m.content.flatMap((b) => (b.type === 'tool_use' ? [b.id] : []));
    if (toolUseIds.length === 0) continue;
    const next = messages[i + 1];
    expect(next, `assistant tool_use at index ${i} must have a next message`).toBeDefined();
    expect(next?.role).toBe('user');
    const resultIds = (next?.content ?? []).flatMap((b) =>
      b.type === 'tool_result' ? [b.tool_use_id] : [],
    );
    for (const id of toolUseIds) {
      expect(
        resultIds,
        `tool_use ${id} (asst@${i}) must have a tool_result in user@${i + 1}`,
      ).toContain(id);
    }
  }
}

/** The user message that carries the loop-guard nudge, if one was emitted. */
function guidanceMessageOf(events: (StreamEvent | Message)[]): Message | undefined {
  return events.find(
    (e): e is Message =>
      !('type' in e) &&
      e.role === 'user' &&
      e.content.some((b) => b.type === 'text' && b.text.startsWith('Loop guard:')),
  );
}

describe('query() ⊕ loop guard — consecutive-identical', () => {
  test('emits loop_detected with reason/action/mode and injects guidance', async () => {
    const traceEvents: TraceEvent[] = [];
    // breakAt=4: the model makes the SAME call on turns 0–3, then stops.
    // consecutiveIdenticalThreshold defaults to 4, so the pre-dispatch check on
    // turn 3 sees a run of 4 and fires strike 1 → guidance, and turn 4 stops.
    const gen = query({
      provider: stuckProvider({ breakAt: 4 }),
      model: 'm',
      messages: [SEED],
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

    const loopEvents = loopEventsOf(events);
    expect(loopEvents).toHaveLength(1);
    const info = loopEvents[0]?.info;
    expect(info?.detector).toBe('consecutive-identical');
    expect(info?.repetitionCount).toBe(4);
    expect(info?.occurrence).toBe(1);
    expect(info?.action).toBe('guidance');
    expect(info?.mode).toBe('enforce');
    expect(info?.reason).toContain('the same call repeated');
    // consecutive-identical is not windowed — no window field.
    expect(info?.window).toBeUndefined();

    // The trace record carries the same explanation, so a kill is readable
    // from the log alone (spec §3.7).
    const traced = traceEvents.find((t) => t.type === 'loop_detected');
    expect(traced).toBeDefined();
    if (traced?.type === 'loop_detected') {
      expect(traced.detector).toBe('consecutive-identical');
      expect(traced.action).toBe('guidance');
      expect(traced.mode).toBe('enforce');
      expect(traced.reason).toBe(info?.reason ?? '');
    }
    // No detector exception was swallowed on the happy path.
    expect(traceEvents.filter((t) => t.type === 'loop_detector_error')).toHaveLength(0);

    const guidance = guidanceMessageOf(events);
    expect(guidance).toBeDefined();
    expect(
      guidance?.content.some(
        (b) =>
          b.type === 'text' &&
          b.text.includes('Change what you send, verify the earlier result, or stop and report.'),
      ),
    ).toBe(true);
  });

  test('preserves tool_use → tool_result pairing when guidance is injected', async () => {
    // The guidance rides `pendingGuidanceText` into the tool_result user
    // message rather than being pushed as a standalone text message between
    // the assistant's tool_use and the user's tool_result.
    const gen = query({
      provider: stuckProvider({ breakAt: 4 }),
      model: 'm',
      messages: [SEED],
      systemPrompt: [],
      tools: [makeEchoTool()],
      toolContext: toolCtx,
      canUseTool: async () => ({ behavior: 'allow' }),
      maxTokens: 256,
      maxTurns: 20,
    });
    const { events, terminal } = await drainCollecting(gen);
    expect(terminal.reason).toBe('completed');
    expectToolUsePairing(persistedTimeline(events));

    // And the guidance landed IN that tool_result message, not beside it.
    const guidance = guidanceMessageOf(events);
    expect(guidance?.content.some((b) => b.type === 'tool_result')).toBe(true);
  });

  test('content-only first-strike loop does not orphan a trailing user message', async () => {
    // Regression: a content-loop detector firing its FIRST strike on a turn
    // with NO tool_use must NOT leave history ending on a standalone user
    // guidance message. A content-only turn always terminates (there is no
    // continuation), so a trailing user message can never be acted on — and
    // the NEXT user turn appended after it produces two consecutive user
    // messages → Anthropic 400 "roles must alternate". See
    // docs/07-history/postmortems/loop-detector-orphaned-tool-use.md.
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
      messages: [SEED],
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
    const loopEvents = loopEventsOf(events);
    expect(loopEvents).toHaveLength(1);
    expect(loopEvents[0]?.info.detector).toBe('content-loop');

    const messages = persistedTimeline(events);
    // The persisted history must NOT end on a trailing standalone user
    // message — it must end on the assistant content-only reply.
    expect(messages[messages.length - 1]?.role).toBe('assistant');

    // No two consecutive user messages anywhere in the persisted timeline.
    for (let i = 1; i < messages.length; i++) {
      expect(
        !(messages[i - 1]?.role === 'user' && messages[i]?.role === 'user'),
        `messages ${i - 1} and ${i} must not both be user (alternation invariant)`,
      ).toBe(true);
    }

    // And a following user turn alternates correctly: appending the next
    // user message keeps the last two roles as assistant → user on the wire.
    const nextTurn: Message[] = [
      ...messages,
      { role: 'user', content: [{ type: 'text', text: 'what happened?' }] },
    ];
    expect(nextTurn[nextTurn.length - 2]?.role).toBe('assistant');
    expect(nextTurn[nextTurn.length - 1]?.role).toBe('user');
  });

  test('aborts at maxStrikes with the loop-guard error text', async () => {
    // The model never breaks out. Strike 1 (turn 3) injects guidance; the run
    // keeps repeating, so strike 2 (turn 7) reaches maxStrikes = 2 and aborts.
    const gen = query({
      provider: stuckProvider({}),
      model: 'm',
      messages: [SEED],
      systemPrompt: [],
      tools: [makeEchoTool()],
      toolContext: toolCtx,
      canUseTool: async () => ({ behavior: 'allow' }),
      maxTokens: 256,
      maxTurns: 20,
    });
    const { events, terminal } = await drainCollecting(gen);
    expect(terminal.reason).toBe('error');
    expect(terminal.error?.message).toContain('aborted by loop guard (consecutive-identical):');
    expect(terminal.error?.message).toContain('the same call repeated');

    const loopEvents = loopEventsOf(events);
    expect(loopEvents).toHaveLength(2);
    expect(loopEvents[0]?.info.action).toBe('guidance');
    expect(loopEvents[1]?.info.occurrence).toBe(2);
    expect(loopEvents[1]?.info.action).toBe('abort');
  });

  test('second-strike abort yields synthetic tool_result for orphaned tool_use', async () => {
    // Regression: when the guard fires its terminating strike on a turn whose
    // assistant message contains tool_use blocks, it must yield a synthetic
    // tool_result message before returning. Without it the persisted history
    // holds an assistant tool_use with no matching tool_result and the next
    // provider call 400s — the session is unrecoverable. See
    // docs/07-history/postmortems/loop-detector-orphaned-tool-use.md.
    const gen = query({
      provider: stuckProvider({}),
      model: 'm',
      messages: [SEED],
      systemPrompt: [],
      tools: [makeEchoTool()],
      toolContext: toolCtx,
      canUseTool: async () => ({ behavior: 'allow' }),
      maxTokens: 256,
      maxTurns: 20,
    });
    const { events, terminal } = await drainCollecting(gen);
    expect(terminal.reason).toBe('error');
    expectToolUsePairing(persistedTimeline(events));
  });
});

describe('query() ⊕ loop guard — no-progress (post-dispatch ledger)', () => {
  test('post-dispatch observe makes no-progress fire on the FOLLOWING turn', async () => {
    // `Constant` returns the same text for every (distinct) input, so
    // consecutive-identical can never fire and only the result-based ledger
    // can. Count math with noProgressWindow = 3 (spec §3.3 — the verdict lands
    // one turn late because the ledger is filled AFTER dispatch):
    //   turn 0  check: ledger empty          → null ; observe: result is NEW  → productive (priming)
    //   turn 1  check: [t0] (1 < 3)          → null ; observe: result seen    → unproductive
    //   turn 2  check: [t0,t1] (2 < 3)       → null ; observe: unproductive
    //   turn 3  check: [t0,t1,t2] has t0     → null ; observe: unproductive
    //   turn 4  check: [t1,t2,t3] ALL unprod → FIRES (strike 1 → guidance)
    // breakAt = 5 ⇒ turn 5 is the text-only finish, so exactly one detection.
    const traceEvents: TraceEvent[] = [];
    const gen = query({
      provider: varyingInputProvider({ breakAt: 5 }),
      model: 'm',
      messages: [SEED],
      systemPrompt: [],
      tools: [makeConstantTool()],
      toolContext: toolCtx,
      canUseTool: async () => ({ behavior: 'allow' }),
      maxTokens: 256,
      maxTurns: 20,
      loop: { noProgressWindow: 3 },
      traceRecorder: (e) => traceEvents.push(e),
    });
    const { events, terminal } = await drainCollecting(gen);
    expect(terminal.reason).toBe('completed');

    const loopEvents = loopEventsOf(events);
    expect(loopEvents).toHaveLength(1);
    const info = loopEvents[0]?.info;
    expect(info?.detector).toBe('no-progress');
    expect(info?.action).toBe('guidance');
    expect(info?.mode).toBe('enforce');
    expect(info?.repetitionCount).toBe(3);
    expect(info?.window).toEqual({ size: 3, unproductive: 3 });
    expect(info?.reason).toContain('returned nothing new');

    const traced = traceEvents.find((t) => t.type === 'loop_detected');
    if (traced?.type === 'loop_detected') {
      expect(traced.detector).toBe('no-progress');
      expect(traced.window).toEqual({ size: 3, unproductive: 3 });
    }

    // Guidance merged into the tool_result user message — never a standalone
    // user message — and the whole timeline stays pairing-valid.
    const guidance = guidanceMessageOf(events);
    expect(guidance).toBeDefined();
    expect(guidance?.content.some((b) => b.type === 'tool_result')).toBe(true);
    expectToolUsePairing(persistedTimeline(events));
  });
});

describe('query() ⊕ loop guard — policy modes', () => {
  test("mode: 'warn' guides on every detection and never returns reason 'error'", async () => {
    // The model is genuinely stuck and never breaks out; in `enforce` this run
    // would abort on strike 2. Under `warn` every detection is reported and
    // guidance is injected, but the run is only ever ended by maxTurns.
    const gen = query({
      provider: stuckProvider({}),
      model: 'm',
      messages: [SEED],
      systemPrompt: [],
      tools: [makeEchoTool()],
      toolContext: toolCtx,
      canUseTool: async () => ({ behavior: 'allow' }),
      maxTokens: 256,
      maxTurns: 12,
      loop: { mode: 'warn' },
    });
    const { events, terminal } = await drainCollecting(gen);
    expect(terminal.reason).not.toBe('error');
    expect(terminal.reason).toBe('max_turns');
    expect(terminal.error).toBeUndefined();

    const loopEvents = loopEventsOf(events);
    // At least two strikes fired — i.e. the run passed the point where
    // `enforce` would have aborted — and none of them did.
    expect(loopEvents.length).toBeGreaterThanOrEqual(2);
    for (const e of loopEvents) {
      expect(e.info.action).toBe('warn');
      expect(e.info.mode).toBe('warn');
    }
    expect(guidanceMessageOf(events)).toBeDefined();
    expectToolUsePairing(persistedTimeline(events));
  });

  test("mode: 'off' emits no loop_detected at all", async () => {
    // 12 identical calls — three times the consecutive-identical threshold.
    const traceEvents: TraceEvent[] = [];
    const gen = query({
      provider: stuckProvider({ breakAt: 12 }),
      model: 'm',
      messages: [SEED],
      systemPrompt: [],
      tools: [makeEchoTool()],
      toolContext: toolCtx,
      canUseTool: async () => ({ behavior: 'allow' }),
      maxTokens: 256,
      maxTurns: 20,
      loop: { mode: 'off' },
      traceRecorder: (e) => traceEvents.push(e),
    });
    const { events, terminal } = await drainCollecting(gen);
    expect(terminal.reason).toBe('completed');
    expect(loopEventsOf(events)).toHaveLength(0);
    expect(traceEvents.filter((t) => t.type === 'loop_detected')).toHaveLength(0);
  });

  test("env HARNESS_LOOP_DETECTOR=off wins over mode: 'enforce'", async () => {
    // The process-wide kill switch survives the config rework and outranks a
    // deployment that explicitly asked for enforcement (spec §3.4).
    const saved = process.env.HARNESS_LOOP_DETECTOR;
    process.env.HARNESS_LOOP_DETECTOR = 'off';
    try {
      const gen = query({
        provider: stuckProvider({ breakAt: 12 }),
        model: 'm',
        messages: [SEED],
        systemPrompt: [],
        tools: [makeEchoTool()],
        toolContext: toolCtx,
        canUseTool: async () => ({ behavior: 'allow' }),
        maxTokens: 256,
        maxTurns: 20,
        loop: { mode: 'enforce' },
      });
      const { events, terminal } = await drainCollecting(gen);
      expect(terminal.reason).toBe('completed');
      expect(loopEventsOf(events)).toHaveLength(0);
    } finally {
      // `process.env.X = undefined` would store the STRING "undefined" — the
      // key has to be removed to restore an originally-unset variable.
      if (saved === undefined) Reflect.deleteProperty(process.env, 'HARNESS_LOOP_DETECTOR');
      else process.env.HARNESS_LOOP_DETECTOR = saved;
    }
  });
});

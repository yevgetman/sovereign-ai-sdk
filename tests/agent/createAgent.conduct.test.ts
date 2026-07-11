import { describe, expect, test } from 'bun:test';
import { createAgent } from '@yevgetman/sov-sdk/agent/createAgent';
import { DEFAULT_CONDUCT_REFUSAL } from '@yevgetman/sov-sdk/core/conductPort';
import type {
  ConductAuditEvent,
  ConductOutputGuard,
  ConductProvider,
} from '@yevgetman/sov-sdk/core/conductPort';
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemSegment,
} from '@yevgetman/sov-sdk/core/types';
import { createInMemorySessionStore } from '@yevgetman/sov-sdk/persistence/inMemoryStore';
import type { LLMProvider } from '@yevgetman/sov-sdk/providers/types';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import type { Tool } from '@yevgetman/sov-sdk/tool/types';
import { z } from 'zod';

/** Scripted provider capturing the system prompt each stream() call receives. */
function scriptedProvider(seen: { systems: SystemSegment[][] }): LLMProvider {
  return {
    name: 'scripted',
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    async *stream(req: any): AsyncGenerator<StreamEvent> {
      seen.systems.push(req.system as SystemSegment[]);
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
      };
      yield { type: 'message_start' };
      yield { type: 'assistant_message', message };
      yield { type: 'message_stop', stop_reason: 'end_turn' };
    },
  } as unknown as LLMProvider;
}

async function drainRun(gen: AsyncGenerator<StreamEvent | Message, unknown>) {
  const events: (StreamEvent | Message)[] = [];
  let result: unknown;
  for (;;) {
    const step = await gen.next();
    if (step.done) {
      result = step.value;
      break;
    }
    events.push(step.value);
  }
  return { events, result };
}

const baseSegments: SystemSegment[] = [
  { text: 'base', cacheable: true },
  { text: 'dynamic', cacheable: false },
];

describe('createAgent conduct wiring', () => {
  test('null provider (absent conduct): system prompt reaches provider unchanged', async () => {
    const seen = { systems: [] as SystemSegment[][] };
    const agent = createAgent({
      provider: scriptedProvider(seen),
      model: 'test-model',
      systemPrompt: baseSegments,
    });
    await drainRun(agent.run('hello'));
    expect(seen.systems[0]).toEqual(baseSegments);
  });

  test('personaSegments compose after the cacheable prefix; audit fires with ctx fields', async () => {
    const seen = { systems: [] as SystemSegment[][] };
    const audits: ConductAuditEvent[] = [];
    const conduct: ConductProvider = {
      personaSegments: (ctx) => {
        expect(ctx.surface).toBe('user');
        expect(ctx.model).toBe('test-model');
        expect(ctx.providerName).toBe('scripted');
        expect(ctx.sessionId.length).toBeGreaterThan(0);
        return [{ text: 'persona', cacheable: true }];
      },
      auditSink: (e) => audits.push(e),
    };
    const agent = createAgent({
      provider: scriptedProvider(seen),
      model: 'test-model',
      systemPrompt: baseSegments,
      conduct,
    });
    await drainRun(agent.run('hello'));
    expect(seen.systems[0]?.map((s) => s.text)).toEqual(['base', 'persona', 'dynamic']);
    expect(audits.find((e) => e.stage === 'persona')?.verdict).toBe('segments:1');
  });

  test("internal surface: personaSegments skipped ('user'-only)", async () => {
    const seen = { systems: [] as SystemSegment[][] };
    let called = false;
    const conduct: ConductProvider = {
      personaSegments: () => {
        called = true;
        return [{ text: 'persona', cacheable: true }];
      },
    };
    const agent = createAgent({
      provider: scriptedProvider(seen),
      model: 'test-model',
      systemPrompt: baseSegments,
      conduct,
      conductSurface: 'internal',
    });
    await drainRun(agent.run('hello'));
    expect(called).toBe(false);
    expect(seen.systems[0]).toEqual(baseSegments);
  });

  test('personaSegments throw fails OPEN (base prompt used)', async () => {
    const seen = { systems: [] as SystemSegment[][] };
    const conduct: ConductProvider = {
      personaSegments: () => {
        throw new Error('persona exploded');
      },
    };
    const agent = createAgent({
      provider: scriptedProvider(seen),
      model: 'test-model',
      systemPrompt: baseSegments,
      conduct,
    });
    const { result } = await drainRun(agent.run('hello'));
    expect(seen.systems[0]).toEqual(baseSegments);
    // biome-ignore lint/suspicious/noExplicitAny: structural check
    expect((result as any).terminal.reason).toBe('completed');
  });

  test('perTurn.conduct overrides standing config', async () => {
    const seen = { systems: [] as SystemSegment[][] };
    const standing: ConductProvider = {
      personaSegments: () => [{ text: 'standing-persona', cacheable: true }],
    };
    const perTurn: ConductProvider = {
      personaSegments: () => [{ text: 'per-turn-persona', cacheable: true }],
    };
    const agent = createAgent({
      provider: scriptedProvider(seen),
      model: 'test-model',
      systemPrompt: baseSegments,
      conduct: standing,
    });
    await drainRun(agent.run('hello', { conduct: perTurn }));
    expect(seen.systems[0]?.map((s) => s.text)).toEqual(['base', 'per-turn-persona', 'dynamic']);
  });
});

describe('createAgent output gate', () => {
  test('onFinal replace: yielded event, finalAssistant, and messages[] all carry the substitution', async () => {
    const seen = { systems: [] as SystemSegment[][] };
    const conduct: ConductProvider = {
      outputGuard: {
        onFinal: () => ({ action: 'replace', text: '[rewritten]' }),
      },
    };
    const agent = createAgent({
      provider: scriptedProvider(seen),
      model: 'test-model',
      conduct,
    });
    const { events, result } = await drainRun(agent.run('hello'));
    const finals = events.filter(
      (e): e is Extract<StreamEvent, { type: 'assistant_message' }> =>
        'type' in e && e.type === 'assistant_message',
    );
    const block = finals[0]?.message.content[0];
    expect(block?.type === 'text' && block.text).toBe('[rewritten]');
    // biome-ignore lint/suspicious/noExplicitAny: structural checks
    const r = result as any;
    expect(r.finalAssistant.content[0].text).toBe('[rewritten]');
    const lastMsg = r.messages[r.messages.length - 1];
    expect(lastMsg.content[0].text).toBe('[rewritten]'); // scrub-before-persistence
  });

  test('onFinal block without template: DEFAULT_CONDUCT_REFUSAL substituted', async () => {
    const seen = { systems: [] as SystemSegment[][] };
    const conduct: ConductProvider = { outputGuard: { onFinal: () => ({ action: 'block' }) } };
    const agent = createAgent({ provider: scriptedProvider(seen), model: 'test-model', conduct });
    const { result } = await drainRun(agent.run('hello'));
    // biome-ignore lint/suspicious/noExplicitAny: structural check
    expect((result as any).finalAssistant.content[0].text).toBe(DEFAULT_CONDUCT_REFUSAL);
  });

  test('onDelta hold + release: held deltas are dropped from the yielded stream', async () => {
    const provider: LLMProvider = {
      name: 'scripted',
      async *stream(): AsyncGenerator<StreamEvent> {
        const message: AssistantMessage = {
          role: 'assistant',
          content: [{ type: 'text', text: 'abc' }],
        };
        yield { type: 'message_start' };
        yield { type: 'text_delta', text: 'a' };
        yield { type: 'text_delta', text: 'b' };
        yield { type: 'text_delta', text: 'c' };
        yield { type: 'assistant_message', message };
        yield { type: 'message_stop', stop_reason: 'end_turn' };
      },
    } as unknown as LLMProvider;
    const conduct: ConductProvider = {
      outputGuard: { onDelta: (text) => (text === 'b' ? '' : text) },
    };
    const agent = createAgent({ provider, model: 'test-model', conduct });
    const { events } = await drainRun(agent.run('hello'));
    const deltas = events
      .filter(
        (e): e is Extract<StreamEvent, { type: 'text_delta' }> =>
          'type' in e && e.type === 'text_delta',
      )
      .map((e) => e.text);
    expect(deltas).toEqual(['a', 'c']);
  });

  test("outputGuard runs on 'internal' surface too (floors everywhere)", async () => {
    const seen = { systems: [] as SystemSegment[][] };
    const conduct: ConductProvider = {
      outputGuard: { onFinal: () => ({ action: 'replace', text: '[floored]' }) },
    };
    const agent = createAgent({
      provider: scriptedProvider(seen),
      model: 'test-model',
      conduct,
      conductSurface: 'internal',
    });
    const { result } = await drainRun(agent.run('hello'));
    // biome-ignore lint/suspicious/noExplicitAny: structural check
    expect((result as any).finalAssistant.content[0].text).toBe('[floored]');
  });

  test('onFinal throw fails open: original message flows', async () => {
    const seen = { systems: [] as SystemSegment[][] };
    const conduct: ConductProvider = {
      outputGuard: {
        onFinal: () => {
          throw new Error('guard exploded');
        },
      },
    };
    const agent = createAgent({ provider: scriptedProvider(seen), model: 'test-model', conduct });
    const { result } = await drainRun(agent.run('hello'));
    // biome-ignore lint/suspicious/noExplicitAny: structural check
    expect((result as any).finalAssistant.content[0].text).toBe('ok');
  });
});

/** Scripted-guard harness for the 1d regenerate/flush drive-loop tests. Serves
 *  `replies[callIndex]` one per provider call (each call = message_start,
 *  text_delta(reply), assistant_message(reply), message_stop), captures the
 *  per-call system segments (so the steering segment on attempt 1 is
 *  assertable), and exposes `finalAssistantText` off the RunResult. Mirrors the
 *  existing scriptedProvider bootstrap. */
async function driveScripted(opts: { guard: ConductOutputGuard; replies: string[] }) {
  const systems: SystemSegment[][] = [];
  let callIndex = 0;
  const provider: LLMProvider = {
    name: 'scripted',
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    async *stream(req: any): AsyncGenerator<StreamEvent> {
      systems.push(req.system as SystemSegment[]);
      const reply = opts.replies[callIndex] ?? opts.replies[opts.replies.length - 1] ?? '';
      callIndex += 1;
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: reply }],
      };
      yield { type: 'message_start' };
      yield { type: 'text_delta', text: reply };
      yield { type: 'assistant_message', message };
      yield { type: 'message_stop', stop_reason: 'end_turn' };
    },
  } as unknown as LLMProvider;
  const agent = createAgent({
    provider,
    model: 'test-model',
    conduct: { outputGuard: opts.guard },
  });
  const events: (StreamEvent | Message)[] = [];
  const gen = agent.run('hello');
  // biome-ignore lint/suspicious/noExplicitAny: structural result capture
  let runResult: any;
  for (;;) {
    const step = await gen.next();
    if (step.done) {
      runResult = step.value;
      break;
    }
    events.push(step.value);
  }
  const textBlock = runResult?.finalAssistant?.content.find(
    (b: { type: string }) => b.type === 'text',
  );
  const finalAssistantText: string | undefined =
    textBlock && textBlock.type === 'text' ? textBlock.text : undefined;
  return { events, systems, result: { ...runResult, finalAssistantText } };
}

describe('conduct outputGuard — regenerate-once (1d)', () => {
  test('regenerate verdict re-runs the turn once with a steering segment; second pass passes', async () => {
    let finals = 0;
    const guard: ConductOutputGuard = {
      onFinal: () =>
        finals++ === 0 ? { action: 'regenerate', reason: 'rule r1' } : { action: 'pass' },
    };
    const { events, result, systems } = await driveScripted({
      guard,
      replies: ['bad reply', 'good reply'],
    });
    expect(finals).toBe(2);
    expect(result.finalAssistantText).toBe('good reply');
    // attempt-0 message never yielded or persisted:
    expect(events.filter((e) => 'type' in e && e.type === 'assistant_message')).toHaveLength(1);
    // steering segment present on attempt 1 only:
    expect(systems[0]?.some((s) => s.text.includes('rejected by the output governor'))).toBe(false);
    expect(systems[1]?.some((s) => s.text.includes('rejected by the output governor'))).toBe(true);
  });

  test('regenerate reason label is carried into the steering segment text', async () => {
    let finals = 0;
    const guard: ConductOutputGuard = {
      onFinal: () =>
        finals++ === 0 ? { action: 'regenerate', reason: 'rule r1' } : { action: 'pass' },
    };
    const { systems } = await driveScripted({ guard, replies: ['bad', 'good'] });
    const steering = systems[1]?.find((s) => s.text.includes('rejected by the output governor'));
    expect(steering?.text).toContain('rule r1');
    expect(steering?.cacheable).toBe(false);
  });

  test('second regenerate verdict is treated as block', async () => {
    const guard: ConductOutputGuard = { onFinal: () => ({ action: 'regenerate' }) };
    const { result, systems } = await driveScripted({ guard, replies: ['bad', 'still bad'] });
    expect(result.finalAssistantText).toBe(DEFAULT_CONDUCT_REFUSAL);
    // exactly TWO attempts, then bounded — no third provider call:
    expect(systems).toHaveLength(2);
  });

  test('onStreamEnd flush is emitted as a final text_delta before the assistant message', async () => {
    const guard: ConductOutputGuard = {
      onDelta: () => '',
      onStreamEnd: () => 'held tail released',
      onFinal: () => ({ action: 'pass' }),
    };
    const { events } = await driveScripted({ guard, replies: ['streamed text'] });
    const deltas = events
      .filter(
        (e): e is Extract<StreamEvent, { type: 'text_delta' }> =>
          'type' in e && e.type === 'text_delta',
      )
      .map((e) => e.text);
    expect(deltas[deltas.length - 1]).toBe('held tail released');
  });

  // Review fix (1d task 8): a `regenerate` verdict on the FINAL message of a
  // TOOL-USING turn must reset the discarded attempt's accumulation state.
  // Before the fix, attempt-0's tool_use assistant + tool_result user messages
  // stayed in `messages[]` (double-persisted, breaking provenance) and inflated
  // the counters; only `usageAcc` is retained (honest cross-attempt cost).
  test('regenerate on a tool-using turn discards the tool call from messages + counters, keeps usage', async () => {
    const toolUseMsg: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'Echo', input: { text: 'hi' } }],
    };
    const badFinalMsg: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'bad final' }],
    };
    const cleanFinalMsg: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'clean final' }],
    };
    // Three provider calls: attempt-0 tool_use → attempt-0 bad final
    // (regenerated) → attempt-1 clean final (passes).
    const turns: StreamEvent[][] = [
      [
        { type: 'message_start' },
        { type: 'tool_use_delta', id: 't1', partial: '{"text":"hi"}' },
        { type: 'usage_delta', usage: { inputTokens: 10, outputTokens: 5 } },
        { type: 'message_stop', stop_reason: 'tool_use' },
        { type: 'assistant_message', message: toolUseMsg },
      ],
      [
        { type: 'message_start' },
        { type: 'text_delta', text: 'bad final' },
        { type: 'usage_delta', usage: { inputTokens: 20, outputTokens: 8 } },
        { type: 'message_stop', stop_reason: 'end_turn' },
        { type: 'assistant_message', message: badFinalMsg },
      ],
      [
        { type: 'message_start' },
        { type: 'text_delta', text: 'clean final' },
        { type: 'usage_delta', usage: { inputTokens: 30, outputTokens: 12 } },
        { type: 'message_stop', stop_reason: 'end_turn' },
        { type: 'assistant_message', message: cleanFinalMsg },
      ],
    ];
    const queue = [...turns];
    const provider: LLMProvider = {
      name: 'scripted',
      async *stream(): AsyncGenerator<StreamEvent> {
        const events = queue.shift();
        if (!events) throw new Error('scripted queue empty');
        for (const ev of events) yield ev;
      },
    } as unknown as LLMProvider;

    // Regenerate ONLY the attempt-0 final text; the tool_use assistant message
    // (which must execute the tool) and the attempt-1 clean final both pass.
    const guard: ConductOutputGuard = {
      onFinal: (message) => {
        if (message.content.some((b) => b.type === 'tool_use')) return { action: 'pass' };
        const block = message.content.find((b) => b.type === 'text');
        const text = block && block.type === 'text' ? block.text : '';
        return text === 'bad final' ? { action: 'regenerate', reason: 'r1' } : { action: 'pass' };
      },
    };

    const echoTool = buildTool({
      name: 'Echo',
      description: () => 'echo input',
      inputSchema: z.object({ text: z.string() }),
      async call(input) {
        return { data: { echoed: (input as { text: string }).text } };
      },
    }) as unknown as Tool<unknown, unknown>;

    const store = createInMemorySessionStore();
    const agent = createAgent({
      provider,
      model: 'test-model',
      conduct: { outputGuard: guard },
      tools: [echoTool],
      sessionStore: store,
    });

    const gen = agent.run('use the tool', { sessionId: 'sess-regen-tool' });
    // biome-ignore lint/suspicious/noExplicitAny: structural result capture
    let result: any;
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        result = step.value;
        break;
      }
    }

    // Counters reflect attempt 1 only — the discarded tool call is gone.
    expect(result.terminal.reason).toBe('completed');
    expect(result.toolCallCount).toBe(0);
    expect(result.distinctToolNames).toEqual([]);
    expect(result.iterationsUsed).toBe(1);
    expect(result.finalAssistant.content[0].text).toBe('clean final');

    // RunResult.messages carry NO tool_use / tool_result from attempt 0:
    // only the seed user message + the attempt-1 answer.
    const carriesToolArtifacts = (blocks: { type: string }[]) =>
      blocks.some((b) => b.type === 'tool_use' || b.type === 'tool_result');
    // biome-ignore lint/suspicious/noExplicitAny: structural block inspection
    expect(result.messages.some((m: any) => carriesToolArtifacts(m.content))).toBe(false);
    expect(result.messages).toHaveLength(2);

    // Persisted history is identically clean (double-persist guarantee).
    const stored = store.loadMessages('sess-regen-tool');
    expect(stored).toHaveLength(2);
    // biome-ignore lint/suspicious/noExplicitAny: structural block inspection
    expect(stored.some((m: any) => carriesToolArtifacts(m.content))).toBe(false);

    // Usage still sums ALL THREE provider calls (both attempts) — honest cost.
    expect(result.usage).toEqual({ inputTokens: 60, outputTokens: 25 });
  });
});

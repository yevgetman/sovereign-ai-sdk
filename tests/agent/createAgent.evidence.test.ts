// tests/agent/createAgent.evidence.test.ts — the vendor-neutral evidence seam
// (attestation evidence, spec 2026-07-19 §3.3/§3.4).
//
// Contract under test (T1):
//   - `ConductProvider.evidenceSink` is called exactly ONCE per completed turn
//     with `{turnId?, input?, candidate?, delivered?}` — candidate is the
//     PRE-substitution text of the final attempt's final assistant message
//     (what guard.onFinal received), delivered is the POST-governor persisted
//     text (what was yielded/persisted);
//   - regenerate: the attempt-0 candidate is NEVER emitted — the pair reflects
//     the FINAL attempt only, and a failed retry never leaks attempt-0 text;
//   - unobserved fields are OMITTED, never '' (an undelivered turn's row must
//     read as undelivered to the verifier);
//   - `PerTurn.turnId` threads into `ConductContext.turnId` verbatim (host turn
//     identity, all-or-none across every hook of the turn) and onto the event;
//   - absent evidenceSink / absent turnId ⇒ byte-identical (the repo
//     discipline); a THROWING sink never breaks a turn (evidence fails OPEN).

import { describe, expect, test } from 'bun:test';
import { createAgent } from '@yevgetman/sov-sdk/agent/createAgent';
import { DEFAULT_CONDUCT_REFUSAL } from '@yevgetman/sov-sdk/core/conductPort';
import type {
  ConductContext,
  ConductEvidenceEvent,
  ConductProvider,
} from '@yevgetman/sov-sdk/core/conductPort';
import type { AssistantMessage, Message, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import type { LLMProvider } from '@yevgetman/sov-sdk/providers/types';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import type { Tool } from '@yevgetman/sov-sdk/tool/types';
import { z } from 'zod';

/** Scripted provider replaying one assistant text reply per stream() call. */
function scriptedProvider(replies: string[]): LLMProvider {
  let callIndex = 0;
  return {
    name: 'scripted',
    async *stream(): AsyncGenerator<StreamEvent> {
      const reply = replies[callIndex] ?? replies[replies.length - 1] ?? '';
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
}

/** Scripted provider replaying explicit event scripts, one per stream() call.
 *  An `undefined` script slot THROWS (models a provider failure). */
function queuedProvider(scripts: (StreamEvent[] | undefined)[]): LLMProvider {
  const queue = [...scripts];
  return {
    name: 'scripted',
    async *stream(): AsyncGenerator<StreamEvent> {
      const script = queue.shift();
      if (!script) throw new Error('scripted provider failure');
      for (const ev of script) yield ev;
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

describe('createAgent evidence seam — once per turn, final pair', () => {
  test('pass verdict: one event with turnId, input, candidate === delivered', async () => {
    const events: ConductEvidenceEvent[] = [];
    const conduct: ConductProvider = {
      preGate: () => ({ action: 'allow' }),
      outputGuard: { onFinal: () => ({ action: 'pass' }) },
      evidenceSink: (e) => events.push(e),
    };
    const agent = createAgent({ provider: scriptedProvider(['clean reply']), model: 'm', conduct });
    await drainRun(agent.run('hello gate', { turnId: 'turn-1' }));
    expect(events).toEqual([
      { turnId: 'turn-1', input: 'hello gate', candidate: 'clean reply', delivered: 'clean reply' },
    ]);
  });

  test('replace verdict: candidate is pre-substitution, delivered is the replacement', async () => {
    const events: ConductEvidenceEvent[] = [];
    const conduct: ConductProvider = {
      outputGuard: { onFinal: () => ({ action: 'replace', text: '[scrubbed]' }) },
      evidenceSink: (e) => events.push(e),
    };
    const agent = createAgent({ provider: scriptedProvider(['dirty reply']), model: 'm', conduct });
    await drainRun(agent.run('hi', { turnId: 'turn-2' }));
    expect(events).toHaveLength(1);
    expect(events[0]?.candidate).toBe('dirty reply');
    expect(events[0]?.delivered).toBe('[scrubbed]');
  });

  test('block without template: delivered is the default refusal, candidate the original', async () => {
    const events: ConductEvidenceEvent[] = [];
    const conduct: ConductProvider = {
      outputGuard: { onFinal: () => ({ action: 'block' }) },
      evidenceSink: (e) => events.push(e),
    };
    const agent = createAgent({ provider: scriptedProvider(['bad reply']), model: 'm', conduct });
    await drainRun(agent.run('hi'));
    expect(events).toHaveLength(1);
    expect(events[0]?.candidate).toBe('bad reply');
    expect(events[0]?.delivered).toBe(DEFAULT_CONDUCT_REFUSAL);
  });

  test('regenerate: sink fires ONCE with the FINAL attempt pair — attempt-0 candidate never emitted', async () => {
    const events: ConductEvidenceEvent[] = [];
    let finals = 0;
    const conduct: ConductProvider = {
      outputGuard: {
        onFinal: () =>
          finals++ === 0 ? { action: 'regenerate', reason: 'r1' } : { action: 'pass' },
      },
      evidenceSink: (e) => events.push(e),
    };
    const agent = createAgent({
      provider: scriptedProvider(['bad reply', 'good reply']),
      model: 'm',
      conduct,
    });
    await drainRun(agent.run('hi', { turnId: 'turn-3' }));
    expect(finals).toBe(2);
    expect(events).toHaveLength(1);
    expect(events[0]?.candidate).toBe('good reply');
    expect(events[0]?.delivered).toBe('good reply');
  });

  test('regenerate then provider failure on the retry: attempt-0 pair does NOT leak', async () => {
    // Attempt 0 is a TOOL-USING drive: an intermediate gated message ('let me
    // check', pass — CAPTURED) precedes the final message ('bad final',
    // regenerate — discarded). Attempt 1's provider THROWS, so the retry never
    // produces a gated message. The emitted event must carry NO candidate /
    // delivered — the captured attempt-0 intermediate must be reset with the
    // discarded attempt, not leak into the evidence row.
    const events: ConductEvidenceEvent[] = [];
    const toolUseMsg: AssistantMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'let me check' },
        { type: 'tool_use', id: 't1', name: 'Echo', input: { text: 'hi' } },
      ],
    };
    const badFinalMsg: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'bad final' }],
    };
    const scripts: (StreamEvent[] | undefined)[] = [
      [
        { type: 'message_start' },
        { type: 'message_stop', stop_reason: 'tool_use' },
        { type: 'assistant_message', message: toolUseMsg },
      ],
      [
        { type: 'message_start' },
        { type: 'text_delta', text: 'bad final' },
        { type: 'message_stop', stop_reason: 'end_turn' },
        { type: 'assistant_message', message: badFinalMsg },
      ],
      undefined, // attempt-1: provider failure
    ];
    const echoTool = buildTool({
      name: 'Echo',
      description: () => 'echo input',
      inputSchema: z.object({ text: z.string() }),
      async call(input) {
        return { data: { echoed: (input as { text: string }).text } };
      },
    }) as unknown as Tool<unknown, unknown>;
    const conduct: ConductProvider = {
      preGate: () => ({ action: 'allow' }),
      outputGuard: {
        onFinal: (message) => {
          if (message.content.some((b) => b.type === 'tool_use')) return { action: 'pass' };
          return { action: 'regenerate', reason: 'r1' };
        },
      },
      evidenceSink: (e) => events.push(e),
    };
    const agent = createAgent({
      provider: queuedProvider(scripts),
      model: 'm',
      conduct,
      tools: [echoTool],
    });
    const { result } = await drainRun(agent.run('hi', { turnId: 'turn-4' }));
    // biome-ignore lint/suspicious/noExplicitAny: structural check
    expect((result as any).terminal.reason).toBe('error');
    // One event, WITHOUT the discarded attempt-0 candidate/delivered:
    expect(events).toEqual([{ turnId: 'turn-4', input: 'hi' }]);
  });

  test('tool loop: one event per turn, pair from the FINAL assistant message', async () => {
    const events: ConductEvidenceEvent[] = [];
    const toolUseMsg: AssistantMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'let me check' },
        { type: 'tool_use', id: 't1', name: 'Echo', input: { text: 'hi' } },
      ],
    };
    const finalMsg: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'final answer' }],
    };
    const scripts: StreamEvent[][] = [
      [
        { type: 'message_start' },
        { type: 'message_stop', stop_reason: 'tool_use' },
        { type: 'assistant_message', message: toolUseMsg },
      ],
      [
        { type: 'message_start' },
        { type: 'text_delta', text: 'final answer' },
        { type: 'message_stop', stop_reason: 'end_turn' },
        { type: 'assistant_message', message: finalMsg },
      ],
    ];
    const echoTool = buildTool({
      name: 'Echo',
      description: () => 'echo input',
      inputSchema: z.object({ text: z.string() }),
      async call(input) {
        return { data: { echoed: (input as { text: string }).text } };
      },
    }) as unknown as Tool<unknown, unknown>;
    const conduct: ConductProvider = {
      outputGuard: { onFinal: () => ({ action: 'pass' }) },
      evidenceSink: (e) => events.push(e),
    };
    const agent = createAgent({
      provider: queuedProvider(scripts),
      model: 'm',
      conduct,
      tools: [echoTool],
    });
    await drainRun(agent.run('use the tool', { turnId: 'turn-5' }));
    expect(events).toHaveLength(1);
    expect(events[0]?.candidate).toBe('final answer');
    expect(events[0]?.delivered).toBe('final answer');
  });

  test("undelivered turn: 'delivered' and 'candidate' keys are OMITTED — never ''", async () => {
    const events: ConductEvidenceEvent[] = [];
    const emptyMsg: AssistantMessage = { role: 'assistant', content: [] };
    const conduct: ConductProvider = {
      preGate: () => ({ action: 'allow' }),
      outputGuard: { onFinal: () => ({ action: 'pass' }) },
      evidenceSink: (e) => events.push(e),
    };
    const agent = createAgent({
      provider: queuedProvider([
        [
          { type: 'message_start' },
          { type: 'message_stop', stop_reason: 'end_turn' },
          { type: 'assistant_message', message: emptyMsg },
        ],
      ]),
      model: 'm',
      conduct,
    });
    await drainRun(agent.run('hi', { turnId: 'turn-6' }));
    expect(events).toHaveLength(1);
    expect('candidate' in (events[0] ?? {})).toBe(false);
    expect('delivered' in (events[0] ?? {})).toBe(false);
    expect(events[0]).toEqual({ turnId: 'turn-6', input: 'hi' });
  });

  test('provider failure before any message: event still fires with input only (delivered omitted)', async () => {
    const events: ConductEvidenceEvent[] = [];
    const conduct: ConductProvider = {
      preGate: () => ({ action: 'allow' }),
      outputGuard: { onFinal: () => ({ action: 'pass' }) },
      evidenceSink: (e) => events.push(e),
    };
    const agent = createAgent({ provider: queuedProvider([undefined]), model: 'm', conduct });
    const { result } = await drainRun(agent.run('doomed turn', { turnId: 'turn-7' }));
    // biome-ignore lint/suspicious/noExplicitAny: structural check
    expect((result as any).terminal.reason).toBe('error');
    expect(events).toEqual([{ turnId: 'turn-7', input: 'doomed turn' }]);
  });
});

describe('createAgent evidence seam — turnId threading', () => {
  test('PerTurn.turnId reaches every capability ctx verbatim (all-or-none per turn)', async () => {
    const seenCtxTurnIds: (string | undefined)[] = [];
    const conduct: ConductProvider = {
      personaSegments: (ctx) => {
        seenCtxTurnIds.push(ctx.turnId);
        return [];
      },
      preGate: (_t, ctx) => {
        seenCtxTurnIds.push(ctx.turnId);
        return { action: 'allow' };
      },
      outputGuard: {
        onFinal: (_m, ctx) => {
          seenCtxTurnIds.push(ctx.turnId);
          return { action: 'pass' };
        },
      },
    };
    const agent = createAgent({ provider: scriptedProvider(['ok']), model: 'm', conduct });
    await drainRun(agent.run('hi', { turnId: 'host-turn-9' }));
    expect(seenCtxTurnIds).toEqual(['host-turn-9', 'host-turn-9', 'host-turn-9']);
  });

  test('absent PerTurn.turnId: ctx carries NO turnId key; event omits turnId', async () => {
    const events: ConductEvidenceEvent[] = [];
    let ctxSeen: ConductContext | undefined;
    const conduct: ConductProvider = {
      preGate: (_t, ctx) => {
        ctxSeen = ctx;
        return { action: 'allow' };
      },
      outputGuard: { onFinal: () => ({ action: 'pass' }) },
      evidenceSink: (e) => events.push(e),
    };
    const agent = createAgent({ provider: scriptedProvider(['ok']), model: 'm', conduct });
    await drainRun(agent.run('hi'));
    expect(ctxSeen !== undefined && 'turnId' in ctxSeen).toBe(false);
    expect('turnId' in (events[0] ?? {})).toBe(false);
  });
});

describe('createAgent evidence seam — fail open + byte-identical', () => {
  test('a throwing evidenceSink never breaks the turn', async () => {
    const conduct: ConductProvider = {
      outputGuard: { onFinal: () => ({ action: 'pass' }) },
      evidenceSink: () => {
        throw new Error('sink exploded');
      },
    };
    const agent = createAgent({ provider: scriptedProvider(['ok']), model: 'm', conduct });
    const { result } = await drainRun(agent.run('hi', { turnId: 'turn-8' }));
    // biome-ignore lint/suspicious/noExplicitAny: structural checks
    const r = result as any;
    expect(r.terminal.reason).toBe('completed');
    expect(r.finalAssistant.content[0].text).toBe('ok');
  });

  test('absent evidenceSink ⇒ byte-identical events and RunResult', async () => {
    const guardOnly: ConductProvider = {
      preGate: () => ({ action: 'allow' }),
      outputGuard: { onFinal: () => ({ action: 'pass' }) },
    };
    const withSink: ConductProvider = { ...guardOnly, evidenceSink: () => {} };
    const run = (conduct: ConductProvider) => {
      const agent = createAgent({
        provider: scriptedProvider(['same reply']),
        model: 'm',
        conduct,
      });
      return drainRun(agent.run('hello', { sessionId: 'evidence-identical' }));
    };
    const [a, b] = [await run(withSink), await run(guardOnly)];
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(JSON.stringify(a.result)).toBe(JSON.stringify(b.result));
  });

  test('turnId with a NULL conduct provider is inert (byte-identical, nothing observes it)', async () => {
    const run = (perTurn: { sessionId: string; turnId?: string }) => {
      const agent = createAgent({ provider: scriptedProvider(['same reply']), model: 'm' });
      return drainRun(agent.run('hello', perTurn));
    };
    const a = await run({ sessionId: 's-1', turnId: 'turn-x' });
    const b = await run({ sessionId: 's-1' });
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(JSON.stringify(a.result)).toBe(JSON.stringify(b.result));
  });
});

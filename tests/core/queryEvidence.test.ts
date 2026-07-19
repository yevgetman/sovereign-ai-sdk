// tests/core/queryEvidence.test.ts — the gate-input capture seam (attestation
// evidence, spec 2026-07-19 §3.4). `QueryParams.onConductGateInput` is the
// vendor-neutral bridge that hands createAgent the EXACT gateText preGate saw
// (post-rewrite, post-injection) so the once-per-turn evidence event can carry
// it as `input`. Contract under test:
//   - called with the exact text preGate received, BEFORE the verdict applies
//     (a rewrite verdict does not change what was captured);
//   - never called when preGate is absent, or on the 'internal' surface
//     (mirror of the preGate run conditions — "what the gate saw", nothing else);
//   - a THROWING capture callback never breaks the turn (observer, fail open);
//   - absent callback ⇒ byte-identical event stream (the repo discipline).

import { describe, expect, test } from 'bun:test';
import type { ConductContext, ConductProvider } from '@yevgetman/sov-sdk/core/conductPort';
import { query } from '@yevgetman/sov-sdk/core/query';
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  Terminal,
} from '@yevgetman/sov-sdk/core/types';
import type { LLMProvider } from '@yevgetman/sov-sdk/providers/types';

/** One-turn scripted provider: replays a single assistant text reply. */
function scriptedProvider(replyText: string, seen?: { requests: Message[][] }): LLMProvider {
  return {
    name: 'scripted',
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    async *stream(req: any): AsyncGenerator<StreamEvent> {
      seen?.requests.push(req.messages as Message[]);
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: replyText }],
      };
      yield { type: 'message_start' };
      yield { type: 'text_delta', text: replyText };
      yield { type: 'assistant_message', message };
      yield { type: 'message_stop', stop_reason: 'end_turn' };
    },
  } as unknown as LLMProvider;
}

const userCtx: ConductContext = {
  sessionId: 'evidence-test',
  surface: 'user',
  model: 'test-model',
  providerName: 'scripted',
};

async function drain(
  gen: AsyncGenerator<StreamEvent | Message, Terminal>,
): Promise<{ events: (StreamEvent | Message)[]; terminal: Terminal }> {
  const events: (StreamEvent | Message)[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { events, terminal: step.value };
    events.push(step.value);
  }
}

function userMsg(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

describe('query() gate-input capture (onConductGateInput)', () => {
  test('captures the exact gateText preGate saw', async () => {
    const captured: string[] = [];
    const gateSaw: string[] = [];
    const conduct: ConductProvider = {
      preGate: (text) => {
        gateSaw.push(text);
        return { action: 'allow' };
      },
    };
    const { terminal } = await drain(
      query({
        provider: scriptedProvider('hi'),
        model: 'test-model',
        messages: [userMsg('hello gate')],
        systemPrompt: [],
        maxTokens: 100,
        conduct,
        conductCtx: userCtx,
        onConductGateInput: (text) => captured.push(text),
      }),
    );
    expect(terminal.reason).toBe('completed');
    expect(captured).toEqual(['hello gate']);
    expect(captured).toEqual(gateSaw); // the capture IS what the gate saw
  });

  test('a rewrite verdict does not alter the captured input (pre-verdict text)', async () => {
    const captured: string[] = [];
    const seen = { requests: [] as Message[][] };
    const conduct: ConductProvider = {
      preGate: () => ({ action: 'rewrite', text: 'rewritten text' }),
    };
    await drain(
      query({
        provider: scriptedProvider('hi', seen),
        model: 'test-model',
        messages: [userMsg('original text')],
        systemPrompt: [],
        maxTokens: 100,
        conduct,
        conductCtx: userCtx,
        onConductGateInput: (text) => captured.push(text),
      }),
    );
    // The gate SAW the original; the model sees the rewrite.
    expect(captured).toEqual(['original text']);
    const modelSaw = seen.requests[0]?.[0]?.content[0];
    expect(modelSaw?.type === 'text' && modelSaw.text).toBe('rewritten text');
  });

  test('captured on a preGate deny too (the gate saw the text before refusing)', async () => {
    const captured: string[] = [];
    const conduct: ConductProvider = {
      preGate: () => ({ action: 'deny', refusalText: 'no.' }),
    };
    const { terminal } = await drain(
      query({
        provider: scriptedProvider('hi'),
        model: 'test-model',
        messages: [userMsg('blocked input')],
        systemPrompt: [],
        maxTokens: 100,
        conduct,
        conductCtx: userCtx,
        onConductGateInput: (text) => captured.push(text),
      }),
    );
    expect(terminal.reason).toBe('completed'); // refusal completes the turn
    expect(captured).toEqual(['blocked input']);
  });

  test('not called when preGate is absent (nothing was "seen by the gate")', async () => {
    const captured: string[] = [];
    const conduct: ConductProvider = {
      outputGuard: { onFinal: () => ({ action: 'pass' }) },
    };
    await drain(
      query({
        provider: scriptedProvider('hi'),
        model: 'test-model',
        messages: [userMsg('hello')],
        systemPrompt: [],
        maxTokens: 100,
        conduct,
        conductCtx: userCtx,
        onConductGateInput: (text) => captured.push(text),
      }),
    );
    expect(captured).toEqual([]);
  });

  test("not called on the 'internal' surface (preGate is 'user'-only)", async () => {
    const captured: string[] = [];
    let gateRan = false;
    const conduct: ConductProvider = {
      preGate: () => {
        gateRan = true;
        return { action: 'allow' };
      },
    };
    await drain(
      query({
        provider: scriptedProvider('hi'),
        model: 'test-model',
        messages: [userMsg('hello')],
        systemPrompt: [],
        maxTokens: 100,
        conduct,
        conductCtx: { ...userCtx, surface: 'internal' },
        onConductGateInput: (text) => captured.push(text),
      }),
    );
    expect(gateRan).toBe(false);
    expect(captured).toEqual([]);
  });

  test('a throwing capture callback never breaks the turn (fails open) and preGate still runs', async () => {
    let gateRan = false;
    const conduct: ConductProvider = {
      preGate: () => {
        gateRan = true;
        return { action: 'allow' };
      },
    };
    const { terminal } = await drain(
      query({
        provider: scriptedProvider('hi'),
        model: 'test-model',
        messages: [userMsg('hello')],
        systemPrompt: [],
        maxTokens: 100,
        conduct,
        conductCtx: userCtx,
        onConductGateInput: () => {
          throw new Error('capture exploded');
        },
      }),
    );
    expect(terminal.reason).toBe('completed');
    expect(gateRan).toBe(true);
  });

  test('absent callback ⇒ byte-identical event stream (with the same conduct bound)', async () => {
    const conduct: ConductProvider = { preGate: () => ({ action: 'allow' }) };
    const run = (withCapture: boolean) =>
      drain(
        query({
          provider: scriptedProvider('hi'),
          model: 'test-model',
          messages: [userMsg('hello')],
          systemPrompt: [],
          maxTokens: 100,
          conduct,
          conductCtx: userCtx,
          ...(withCapture ? { onConductGateInput: () => {} } : {}),
        }),
      );
    const [withCb, without] = await Promise.all([run(true), run(false)]);
    expect(JSON.stringify(withCb.events)).toBe(JSON.stringify(without.events));
    expect(withCb.terminal).toEqual(without.terminal);
  });
});

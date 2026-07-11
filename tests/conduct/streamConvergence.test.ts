// tests/conduct/streamConvergence.test.ts — the SSE reconciliation property
// (1d Task 12). With a HOLD-BY-DEFAULT output governor bound (decorum's
// streaming contract: never release a span until the sentence containing it has
// been screened), the 1b-era caveat — "held deltas can diverge from the final
// message" — is CLOSED BY CONTRACT on the pass path: every released delta is
// verified text, so the concatenation of the released deltas plus the
// onStreamEnd held-tail flush is EXACTLY the final delivered message.
//
// Divergence remains ONLY, and bounded, on the no-retract residue: a whole-turn
// block/regenerate AFTER text was already released. There the client keeps the
// released prefix of the ORIGINAL model text (streamed bytes cannot be
// retracted) while the FINAL delivered + persisted message is the substituted
// refusal — never a prefix of that refusal. This test pins both halves.
//
// The guard below is a SCRIPTED mirror of decorum's `createStreamGovernor`
// (src/output/streamGovernor.ts) — the SDK imports NOTHING from decorum, so the
// hold/release/taint semantics are reproduced inline: accumulate deltas, release
// each complete sentence only once the next has begun (lookahead hold), screen
// each released sentence, and TAINT (release nothing further) on a screen fail.
//
// Counterfactual (self-review): this property would FAIL against a stream-first
// / leak-then-check drive loop — one that yields raw provider deltas and only
// substitutes at onFinal. Such an impl never calls onDelta, so the tainted
// sentence WOULD reach the released stream, breaking the proper-prefix assertion
// in the block-after-taint case. The equality + prefix assertions here therefore
// guard the SDK's hold-routing contract, not merely the guard's own logic.

import { describe, expect, test } from 'bun:test';
import { createAgent } from '@yevgetman/sov-sdk/agent/createAgent';
import { DEFAULT_CONDUCT_REFUSAL } from '@yevgetman/sov-sdk/core/conductPort';
import type { ConductOutputGuard, OutputFinalVerdict } from '@yevgetman/sov-sdk/core/conductPort';
import type { AssistantMessage, Message, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import type { LLMProvider } from '@yevgetman/sov-sdk/providers/types';

/**
 * A scripted hold-by-default output guard mirroring decorum's streaming
 * governor. `verify` is the per-sentence LEAK SCREEN (defaults to always-clean);
 * `onFinal` is the AUTHORITATIVE whole-turn verdict (optional). Sentences are
 * delimited by a period-space boundary, so a sentence is released only once the
 * following one has begun to arrive — the lookahead hold. A `verify` fail TAINTS
 * the stream: nothing further (including the onStreamEnd flush) is released.
 */
function holdStyleGuard(opts: {
  verify?: (sentence: string) => boolean;
  onFinal?: (message: AssistantMessage) => OutputFinalVerdict;
}): ConductOutputGuard {
  const verify = opts.verify ?? (() => true);
  let accumulated = '';
  let tainted = false;

  const drain = (flush: boolean): string => {
    let released = '';
    for (;;) {
      const idx = accumulated.indexOf('. ');
      if (idx === -1) break;
      const complete = accumulated.slice(0, idx + 2); // include the ". " boundary
      const remainder = accumulated.slice(idx + 2);
      if (!verify(complete)) {
        tainted = true;
        accumulated = '';
        return released;
      }
      released += complete;
      accumulated = remainder;
    }
    if (flush && accumulated.length > 0) {
      if (!verify(accumulated)) {
        tainted = true;
        accumulated = '';
        return released;
      }
      released += accumulated;
      accumulated = '';
    }
    return released;
  };

  const guard: ConductOutputGuard = {
    onDelta: (text) => {
      if (tainted) return '';
      accumulated += text;
      return drain(false);
    },
    onStreamEnd: () => {
      if (tainted) {
        accumulated = '';
        return '';
      }
      return drain(true);
    },
  };
  if (opts.onFinal) guard.onFinal = opts.onFinal;
  return guard;
}

/** Drive a scripted multi-delta turn through a bound output guard. The provider
 *  streams `deltas` (raw model chunks) then an assistant_message carrying
 *  `fullText`. Returns the RELEASED stream (concatenated yielded text_deltas),
 *  the FINAL delivered message text, and the persisted messages tail. */
async function driveHeldStream(opts: {
  deltas: string[];
  fullText: string;
  guard: ConductOutputGuard;
}) {
  const provider: LLMProvider = {
    name: 'scripted',
    async *stream(): AsyncGenerator<StreamEvent> {
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: opts.fullText }],
      };
      yield { type: 'message_start' };
      for (const d of opts.deltas) yield { type: 'text_delta', text: d };
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
  let result: any;
  for (;;) {
    const step = await gen.next();
    if (step.done) {
      result = step.value;
      break;
    }
    events.push(step.value);
  }

  const releasedConcat = events
    .filter(
      (e): e is Extract<StreamEvent, { type: 'text_delta' }> =>
        'type' in e && e.type === 'text_delta',
    )
    .map((e) => e.text)
    .join('');

  const finalBlock = result?.finalAssistant?.content.find(
    (b: { type: string }) => b.type === 'text',
  );
  const finalMessageText: string | undefined =
    finalBlock && finalBlock.type === 'text' ? finalBlock.text : undefined;

  const lastMsg = result.messages[result.messages.length - 1];
  const persistedBlock = lastMsg?.content.find((b: { type: string }) => b.type === 'text');
  const persistedText: string | undefined =
    persistedBlock && persistedBlock.type === 'text' ? persistedBlock.text : undefined;

  return { events, releasedConcat, finalMessageText, persistedText, result };
}

// A three-sentence model reply chunked so sentences split ACROSS deltas — the
// worst case for a naive streamer, exactly what the lookahead hold defends.
const DELTAS = ['The sky is ', 'blue. The grass ', 'is green. Water ', 'is wet.'];
const FULL_TEXT = 'The sky is blue. The grass is green. Water is wet.';

describe('SSE reconciliation — released deltas are a verified prefix (1d)', () => {
  test('PASS path: concat(released deltas + flush) === the final delivered message', async () => {
    const { releasedConcat, finalMessageText, persistedText } = await driveHeldStream({
      deltas: DELTAS,
      fullText: FULL_TEXT,
      guard: holdStyleGuard({ onFinal: () => ({ action: 'pass' }) }),
    });
    // Convergence: what streamed is exactly what was delivered + persisted.
    expect(releasedConcat).toBe(FULL_TEXT);
    expect(finalMessageText).toBe(FULL_TEXT);
    expect(persistedText).toBe(FULL_TEXT);
  });

  test('PASS path (no onFinal): held-by-default stream still reconstructs the full text', async () => {
    const { releasedConcat, finalMessageText } = await driveHeldStream({
      deltas: DELTAS,
      fullText: FULL_TEXT,
      guard: holdStyleGuard({}),
    });
    expect(releasedConcat).toBe(FULL_TEXT);
    expect(finalMessageText).toBe(FULL_TEXT);
  });

  test('BLOCK after mid-stream taint: released text is a PROPER prefix of the original, refusal persists', async () => {
    // The leak screen fails on the third sentence; hold-by-default never lets it
    // (or anything after it) reach the client, then the whole-turn verdict blocks.
    const deltas = ['Safe one. ', 'Safe two. ', 'SECRET leak here. ', 'Safe four.'];
    const original = 'Safe one. Safe two. SECRET leak here. Safe four.';
    const { releasedConcat, finalMessageText, persistedText } = await driveHeldStream({
      deltas,
      fullText: original,
      guard: holdStyleGuard({
        verify: (s) => !s.includes('SECRET'),
        onFinal: () => ({ action: 'block' }),
      }),
    });
    // The client saw ONLY the clean, screened head — a proper prefix.
    expect(releasedConcat).toBe('Safe one. Safe two. ');
    expect(original.startsWith(releasedConcat)).toBe(true);
    expect(releasedConcat).not.toBe(original);
    // The tainted sentence NEVER leaked (the property a leak-then-check impl fails).
    expect(releasedConcat.includes('SECRET')).toBe(false);
    // Bounded divergence: released text is a prefix of the ORIGINAL, NEVER of the
    // substituted refusal — and the refusal is what is delivered + persisted.
    expect(DEFAULT_CONDUCT_REFUSAL.startsWith(releasedConcat)).toBe(false);
    expect(finalMessageText).toBe(DEFAULT_CONDUCT_REFUSAL);
    expect(persistedText).toBe(DEFAULT_CONDUCT_REFUSAL);
  });

  test('BLOCK after a clean leak-screen (the no-retract residue): whole original streamed, refusal delivered', async () => {
    // Every sentence passes the per-sentence screen, so the whole original is
    // released — THEN the authoritative whole-turn verdict blocks. This is the
    // honest residue that survives reconciliation (regenerate/block AFTER
    // release): streamed bytes cannot be retracted, so the client keeps the full
    // original as a (whole-string) prefix while the delivered message is the refusal.
    const { releasedConcat, finalMessageText, persistedText } = await driveHeldStream({
      deltas: DELTAS,
      fullText: FULL_TEXT,
      guard: holdStyleGuard({ onFinal: () => ({ action: 'block' }) }),
    });
    expect(releasedConcat).toBe(FULL_TEXT); // client saw the whole original
    expect(FULL_TEXT.startsWith(releasedConcat)).toBe(true); // prefix of the ORIGINAL
    expect(DEFAULT_CONDUCT_REFUSAL.startsWith(releasedConcat)).toBe(false); // not of the refusal
    expect(finalMessageText).toBe(DEFAULT_CONDUCT_REFUSAL);
    expect(persistedText).toBe(DEFAULT_CONDUCT_REFUSAL);
  });

  test('REPLACE after release: released prefix of the original; substituted text is delivered + persisted', async () => {
    const { releasedConcat, finalMessageText, persistedText } = await driveHeldStream({
      deltas: DELTAS,
      fullText: FULL_TEXT,
      guard: holdStyleGuard({ onFinal: () => ({ action: 'replace', text: '[rewritten]' }) }),
    });
    expect(releasedConcat).toBe(FULL_TEXT);
    expect(FULL_TEXT.startsWith(releasedConcat)).toBe(true);
    expect(finalMessageText).toBe('[rewritten]');
    expect(persistedText).toBe('[rewritten]');
  });
});

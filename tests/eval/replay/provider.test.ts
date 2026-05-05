// Phase 10.5 part 2b — ReplayProvider unit tests. Synthesize a fixture,
// drive ReplayProvider directly via stream(), assert it round-trips
// the captured events. Also drive it through query() to verify the
// agent loop runs deterministically against canned events.

import { describe, expect, test } from 'bun:test';
import { query } from '../../../src/core/query.js';
import type { AssistantMessage, Message, StreamEvent, Terminal } from '../../../src/core/types.js';
import { ReplayProvider } from '../../../src/eval/replay/provider.js';
import type { ReplayFixture } from '../../../src/eval/replay/types.js';

const COMPLETED: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'done' }],
};

function singleTurnFixture(): ReplayFixture {
  return {
    meta: {
      sessionId: 'fx-01',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      capturedAt: '2026-05-05T20:00:00.000Z',
    },
    turns: [
      {
        turn: 0,
        providerEvents: [
          { type: 'message_start' },
          { type: 'text_delta', text: 'done' },
          { type: 'usage_delta', usage: { inputTokens: 12, outputTokens: 3 } },
          { type: 'message_stop', stop_reason: 'end_turn' },
          { type: 'assistant_message', message: COMPLETED },
        ],
        toolResults: [],
      },
    ],
  };
}

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

describe('ReplayProvider direct drive', () => {
  test('yields every captured StreamEvent and returns the assistant_message', async () => {
    const provider = new ReplayProvider({ fixture: singleTurnFixture() });
    const events: StreamEvent[] = [];
    let final: AssistantMessage | undefined;
    const gen = provider.stream({ model: 'unused', system: [], messages: [], maxTokens: 100 });
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        final = step.value;
        break;
      }
      events.push(step.value);
    }
    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'text_delta',
      'usage_delta',
      'message_stop',
      'assistant_message',
    ]);
    expect(final?.content[0]).toEqual({ type: 'text', text: 'done' });
  });

  test('throws when the agent requests more turns than were captured', async () => {
    const provider = new ReplayProvider({ fixture: singleTurnFixture() });
    // Consume the only captured turn.
    for await (const _ of provider.stream({
      model: 'unused',
      system: [],
      messages: [],
      maxTokens: 100,
    })) {
      // discard
    }
    expect(provider.isExhausted).toBe(true);
    // A second stream() call should fail loudly.
    const gen = provider.stream({ model: 'unused', system: [], messages: [], maxTokens: 100 });
    await expect(gen.next()).rejects.toThrow(/replay exhausted/);
  });

  test('throws when a turn ends without an assistant_message', async () => {
    const malformed: ReplayFixture = {
      ...singleTurnFixture(),
      turns: [
        {
          turn: 0,
          providerEvents: [
            { type: 'message_start' },
            { type: 'message_stop', stop_reason: 'end_turn' },
            // No assistant_message — fixture is broken.
          ],
          toolResults: [],
        },
      ],
    };
    const provider = new ReplayProvider({ fixture: malformed });
    await expect(
      (async () => {
        const gen = provider.stream({ model: 'unused', system: [], messages: [], maxTokens: 100 });
        for await (const _ of gen) {
          // drain
        }
      })(),
    ).rejects.toThrow(/assistant_message/);
  });

  test('`providerName` opt overrides the surfaced name', () => {
    const provider = new ReplayProvider({
      fixture: singleTurnFixture(),
      providerName: 'anthropic',
    });
    expect(provider.name).toBe('anthropic');
  });
});

describe('ReplayProvider ⊕ query()', () => {
  test('a one-turn replay produces a completed Terminal with the captured assistant content', async () => {
    const provider = new ReplayProvider({ fixture: singleTurnFixture() });
    const gen = query({
      provider,
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      systemPrompt: [],
      maxTokens: 256,
    });
    const { terminal } = await drain(gen);
    expect(terminal.reason).toBe('completed');
    expect(provider.turnsConsumed).toBe(1);
  });
});

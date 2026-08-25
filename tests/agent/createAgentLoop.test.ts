// Progress-aware loop guard (T2) — createAgent threads the `loop` policy into
// QueryParams.
//
// `loop` is consumed by query() to construct the loop detector, so — unlike
// `temperature`/`cacheEnabled` — it never reaches the provider request and has
// no observable turn effect at this layer. These tests therefore assert the
// contract where it actually lives: the QueryParams object createAgent builds.
// A captured-params fake replaces `query()` (bun's mock.module swaps the module
// exports in place, so createAgent's live binding picks it up); the real module
// is reinstalled in afterAll because mock.module persists across FILES in one
// `bun test` run.
//
// The load-bearing assertions mirror the `maxToolCallsBeforeCheckin` cases in
// createAgent.test.ts: per-turn wins over standing config, standing config
// applies alone, and with NEITHER set the key is ABSENT from QueryParams
// (byte-identical to today, so query() keeps its own defaults).
//
// Spec: specs/2026-08-25-progress-aware-loop-guard-design.md §3.4/§3.6

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type {
  AssistantMessage,
  Message,
  QueryParams,
  StreamEvent,
} from '@yevgetman/sov-sdk/core/types';
import type { LoopOptions } from '@yevgetman/sov-sdk/loop/options';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';

/** Every QueryParams object the fake `query()` was handed, newest last. */
const capturedParams: QueryParams[] = [];

const realQueryModule = { ...(await import('@yevgetman/sov-sdk/core/query')) };

/** Captured-params fake: records the QueryParams createAgent assembled and
 *  returns a terminal immediately — no provider call, no turn loop. */
// biome-ignore lint/correctness/useYield: emits zero events by design — the terminal return value is the whole point; the AsyncGenerator signature stands in for query().
async function* fakeQuery(
  params: QueryParams,
): AsyncGenerator<StreamEvent | Message, Record<string, unknown>> {
  capturedParams.push(params);
  return {
    terminal: { reason: 'completed', toolCallCount: 0, turnCount: 1 },
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

mock.module('@yevgetman/sov-sdk/core/query', () => ({ query: fakeQuery }));

const { createAgent } = await import('@yevgetman/sov-sdk/agent/createAgent');

afterAll(() => {
  mock.module('@yevgetman/sov-sdk/core/query', () => realQueryModule);
});

/** A provider that is never actually streamed (the fake query() returns before
 *  any provider call); createAgent still requires one. */
const inertProvider: LLMProvider = {
  name: 'inert',
  // biome-ignore lint/correctness/useYield: unconditional throw — must never run.
  async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
    throw new Error('inertProvider: stream() must not be reached');
  },
};

/** Drive one run to completion and hand back the QueryParams it produced. */
async function runAndCapture(
  config: Parameters<typeof createAgent>[0],
  perTurn?: Parameters<ReturnType<typeof createAgent>['run']>[1],
): Promise<QueryParams> {
  const agent = createAgent(config);
  const gen = perTurn === undefined ? agent.run('hi') : agent.run('hi', perTurn);
  for (;;) {
    const step = await gen.next();
    if (step.done) break;
  }
  const params = capturedParams.at(-1);
  if (params === undefined) throw new Error('runAndCapture: query() was never called');
  return params;
}

const baseConfig = { provider: inertProvider, model: 'fake-model', maxTokens: 256 } as const;

const standingLoop: LoopOptions = { mode: 'warn', noProgressWindow: 12 };
const perTurnLoop: LoopOptions = { mode: 'off' };

describe('createAgent — loop policy plumbing', () => {
  beforeEach(() => {
    capturedParams.length = 0;
  });

  test('standing config loop reaches QueryParams verbatim', async () => {
    const params = await runAndCapture({ ...baseConfig, loop: standingLoop });
    expect(params.loop).toEqual(standingLoop);
  });

  test('a per-turn loop wins over the standing config', async () => {
    const params = await runAndCapture(
      { ...baseConfig, loop: standingLoop },
      { loop: perTurnLoop },
    );
    expect(params.loop).toEqual(perTurnLoop);
  });

  test('a per-turn loop applies when the standing config has none', async () => {
    const params = await runAndCapture(baseConfig, { loop: perTurnLoop });
    expect(params.loop).toEqual(perTurnLoop);
  });

  test('neither set → QueryParams has NO loop key (byte-identical default)', async () => {
    const params = await runAndCapture(baseConfig);
    expect('loop' in params).toBe(false);
    expect(params.loop).toBeUndefined();
  });

  test('the standing config object is not mutated by a per-turn override', async () => {
    const config = { ...baseConfig, loop: standingLoop };
    await runAndCapture(config, { loop: perTurnLoop });
    expect(config.loop).toEqual({ mode: 'warn', noProgressWindow: 12 });
  });
});

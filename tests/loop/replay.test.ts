// Replay acceptance test — the production tailor run the OLD guard killed.
// Spec: specs/2026-08-25-progress-aware-loop-guard-design.md §4 "Replay fixture"
// (goal 1: stuckness, not length).
//
// `fixtures/tailor-009343da.json` is a synthetic reconstruction, shaped from
// session 009343da / run a0a7dc89 (2026-08-25 18:53 UTC): 24 sequential `Bash`
// calls, 24 DISTINCT `resume show <section>/<slug>` inputs, 24 DISTINCT
// non-error results, then a text-only answer. The old `action-stagnation`
// detector counted tool NAMES, saw 24 `Bash` in a row, and aborted the run at
// 12. The progress-aware guard must let it finish untouched.
//
// The second case proves the fixture is a real test and not a tautology: the
// SAME 24 calls with every result identical must fire `no-progress` and abort.

import { describe, expect, test } from 'bun:test';
import { query } from '@yevgetman/sov-sdk/core/query';
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  Terminal,
} from '@yevgetman/sov-sdk/core/types';
import type { LoopOptions } from '@yevgetman/sov-sdk/loop/detector';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import type { Tool, ToolContext } from '@yevgetman/sov-sdk/tool/types';
import type { TraceEvent } from '@yevgetman/sov-sdk/trace/types';
import { z } from 'zod';
import fixture from './fixtures/tailor-009343da.json';

type LoopDetectedEvent = Extract<StreamEvent, { type: 'loop_detected' }>;

const SEED: Message = {
  role: 'user',
  content: [{ type: 'text', text: 'tailor my resume for the platform-lead role' }],
};

const toolCtx: ToolContext = {
  cwd: process.cwd(),
  bundleRoot: process.cwd(),
  sessionId: 'loop-replay-test',
};

/** Replays the fixture's assistant turns: one `Bash` tool_use per recorded
 *  call, in order, then the final text-only answer. */
function fixtureProvider(): LLMProvider {
  let turn = 0;
  return {
    name: 'tailor-replay',
    async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      const call = fixture.calls[turn++];
      const message: AssistantMessage =
        call === undefined
          ? { role: 'assistant', content: [{ type: 'text', text: fixture.finalText }] }
          : {
              role: 'assistant',
              content: [
                { type: 'tool_use', id: call.id, name: fixture.toolName, input: call.input },
              ],
            };
      yield { type: 'message_start' };
      yield { type: 'message_stop', stop_reason: call === undefined ? 'end_turn' : 'tool_use' };
      yield { type: 'assistant_message', message };
      return message;
    },
  };
}

/** The fixture's own result for a command — the productive run. */
function recordedResult(command: string): string {
  return fixture.calls.find((c) => c.input.command === command)?.result ?? '';
}

/** Every command returns the same bytes — the stuck run. */
const IDENTICAL_RESULT = 'name: Entry\nsection: work\nkeywords: []\n';

function makeBashTool(resultFor: (command: string) => string): Tool<unknown, unknown> {
  return buildTool({
    name: fixture.toolName,
    description: () => 'runs a resume CLI command',
    inputSchema: z.object({ command: z.string() }),
    async call(input) {
      return { data: resultFor(input.command) };
    },
  }) as unknown as Tool<unknown, unknown>;
}

type ReplayOutcome = {
  terminal: Terminal;
  loopEvents: LoopDetectedEvent[];
  traceEvents: TraceEvent[];
  timeline: Message[];
  dispatchedCalls: number;
};

async function replay(opts: {
  resultFor: (command: string) => string;
  loop?: LoopOptions;
}): Promise<ReplayOutcome> {
  const traceEvents: TraceEvent[] = [];
  const gen = query({
    provider: fixtureProvider(),
    model: 'glm-5.2',
    messages: [SEED],
    systemPrompt: [],
    tools: [makeBashTool(opts.resultFor)],
    toolContext: toolCtx,
    canUseTool: async () => ({ behavior: 'allow' }),
    maxTokens: 4096,
    maxTurns: 40,
    traceRecorder: (e) => traceEvents.push(e),
    ...(opts.loop !== undefined ? { loop: opts.loop } : {}),
  });

  const events: (StreamEvent | Message)[] = [];
  let terminal: Terminal;
  for (;;) {
    const step = await gen.next();
    if (step.done) {
      terminal = step.value;
      break;
    }
    events.push(step.value);
  }

  const timeline: Message[] = [SEED];
  for (const e of events) {
    if ('type' in e) {
      if (e.type === 'assistant_message') timeline.push(e.message);
      continue;
    }
    timeline.push(e);
  }
  const dispatchedCalls = timeline
    .filter((m) => m.role === 'assistant')
    .reduce((n, m) => n + m.content.filter((b) => b.type === 'tool_use').length, 0);

  return {
    terminal,
    loopEvents: events.filter(
      (e): e is LoopDetectedEvent => 'type' in e && e.type === 'loop_detected',
    ),
    traceEvents,
    timeline,
    dispatchedCalls,
  };
}

describe('replay: tailor-009343da (24 distinct Bash calls)', () => {
  test('completes with ZERO loop_detected events under default policy', async () => {
    // 24 distinct inputs ⇒ consecutive-identical cannot fire.
    // 24 distinct results ⇒ every call is productive ⇒ no-progress cannot fire.
    // No assistant text ⇒ content-loop cannot fire.
    // This is the regression the whole spec exists for: length is not stuckness.
    const outcome = await replay({ resultFor: recordedResult });

    expect(outcome.terminal.reason).toBe('completed');
    expect(outcome.terminal.error).toBeUndefined();
    expect(outcome.loopEvents).toHaveLength(0);
    expect(outcome.traceEvents.filter((t) => t.type === 'loop_detected')).toHaveLength(0);
    // The guard never threw and got silently disabled, either.
    expect(outcome.traceEvents.filter((t) => t.type === 'loop_detector_error')).toHaveLength(0);
    // Every recorded call actually ran — the run was not cut short.
    expect(outcome.dispatchedCalls).toBe(fixture.calls.length);
    expect(fixture.calls.length).toBe(24);
    // The fixture really is 24 DISTINCT inputs and 24 DISTINCT results.
    expect(new Set(fixture.calls.map((c) => c.input.command)).size).toBe(24);
    expect(new Set(fixture.calls.map((c) => c.result)).size).toBe(24);
  });

  test('the same 24 calls with identical results fire no-progress and abort', async () => {
    // Same inputs, same tool, same length — only the RESULTS changed, which is
    // exactly the signal the guard now measures. Count math with the default
    // noProgressWindow = 8 (the ledger is filled post-dispatch, so a verdict
    // lands one turn late — spec §3.3):
    //   turn 0        result is NEW            → productive (priming)
    //   turns 1–8     result already seen      → unproductive
    //   check turn 9  window [t1..t8] all unproductive → strike 1 (guidance)
    //   turns 9–16    unproductive again
    //   check turn 17 window [t9..t16]         → strike 2 = maxStrikes → abort
    const outcome = await replay({
      resultFor: () => IDENTICAL_RESULT,
      loop: { maxStrikes: 2 },
    });

    expect(outcome.terminal.reason).toBe('error');
    expect(outcome.terminal.error?.message).toContain('aborted by loop guard (no-progress):');
    expect(outcome.terminal.error?.message).toContain('returned nothing new');

    expect(outcome.loopEvents).toHaveLength(2);
    expect(outcome.loopEvents[0]?.info.detector).toBe('no-progress');
    expect(outcome.loopEvents[0]?.info.action).toBe('guidance');
    expect(outcome.loopEvents[1]?.info.action).toBe('abort');
    expect(outcome.loopEvents[1]?.info.occurrence).toBe(2);
    expect(outcome.loopEvents[1]?.info.window).toEqual({ size: 8, unproductive: 8 });

    // It stopped BEFORE the fixture ran out, so the abort is the guard's doing.
    expect(outcome.dispatchedCalls).toBeLessThan(fixture.calls.length);

    // The abort path still synthesises a tool_result for the pending tool_use
    // (postmortem loop-detector-orphaned-tool-use.md).
    for (let i = 0; i < outcome.timeline.length; i++) {
      const m = outcome.timeline[i];
      if (!m || m.role !== 'assistant') continue;
      const toolUseIds = m.content.flatMap((b) => (b.type === 'tool_use' ? [b.id] : []));
      if (toolUseIds.length === 0) continue;
      const next = outcome.timeline[i + 1];
      expect(next?.role).toBe('user');
      const resultIds = (next?.content ?? []).flatMap((b) =>
        b.type === 'tool_result' ? [b.tool_use_id] : [],
      );
      for (const id of toolUseIds) {
        expect(resultIds, `tool_use ${id} (asst@${i}) needs a tool_result`).toContain(id);
      }
    }
  });
});

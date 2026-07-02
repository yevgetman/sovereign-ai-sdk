// Phase 16.0b — verifies runMissionWake() is callable headlessly given a
// pre-initialized mission directory and that it respects the overlap lock.
//
// FIX 1 (HIGH) — also asserts the `sov mission run --state-dir <dir>`
// subcommand is registered in the CLI (it was lost in the Phase-16 revert,
// orphaning runMissionWake as dead code) and FIX 1b — that the per-wake turn
// budget bounds the wake's query() maxTurns.

import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgent } from '@yevgetman/sov-sdk/agent/createAgent';
import {
  type MicrocompactConfig,
  buildMicrocompactConfig,
} from '@yevgetman/sov-sdk/compact/microcompact';
import { query } from '@yevgetman/sov-sdk/core/query';
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemSegment,
} from '@yevgetman/sov-sdk/core/types';
import type { CanUseTool } from '@yevgetman/sov-sdk/permissions/types';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import type { Tool, ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { z } from 'zod';
import { runMissionInit } from '../../src/cli/missionInit.js';
import {
  normalizePerWakeTurnBudget,
  resolveWakeMaxTurns,
  runMissionWake,
} from '../../src/cli/missionRun.js';

const MAIN_TS = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/main.ts');

describe('runMissionWake', () => {
  it('exits early without error when the FSM is in a terminal state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mission-wake-'));
    try {
      const init = runMissionInit({ dir, goal: 'test mission' });
      expect(init.ok).toBe(true);

      // Force state to a terminal value. The FSM (src/mission/fsm.ts) treats
      // `complete` and `abandoned` as terminal. The state.json field is
      // `fsmState` (per src/mission/types.ts).
      const stateFile = join(dir, 'state.json');
      const state = JSON.parse(readFileSync(stateFile, 'utf8'));
      state.fsmState = 'complete';
      writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');

      const result = await runMissionWake({ stateDir: dir });
      expect(result.exitedEarly).toBe(true);
      expect(result.reason).toContain('terminal');
      // The lock dir should not be left dangling on the early-exit path.
      expect(existsSync(join(dir, '.lock'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns lockHeld result when a concurrent wake holds the lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mission-wake-lock-'));
    try {
      const init = runMissionInit({ dir, goal: 'test mission' });
      expect(init.ok).toBe(true);

      // Create the lock directory manually to simulate an in-flight wake. It
      // must carry a LIVE owner PID — a bare/no-PID lock is now treated as
      // stale and reclaimed (FIX 2), so to exercise the lockHeld path we stamp
      // this (alive) test process as the holder.
      mkdirSync(join(dir, '.lock'));
      writeFileSync(join(dir, '.lock', 'pid'), String(process.pid), 'utf8');

      const result = await runMissionWake({ stateDir: dir });
      expect(result.lockHeld).toBe(true);
      // The pre-existing lock must NOT be released by the caller that
      // couldn't acquire it (otherwise we'd clobber the actual holder).
      expect(existsSync(join(dir, '.lock'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveWakeMaxTurns (FIX 1b)', () => {
  it('uses the per-wake turn budget when it is below the agent ceiling', () => {
    // Budget 10, agent maxTurns 50 → the budget wins (the bug: query() ignored
    // the budget and defaulted to 100 turns).
    expect(resolveWakeMaxTurns(10, 50)).toBe(10);
  });

  it('caps at the agent ceiling when the budget exceeds it', () => {
    expect(resolveWakeMaxTurns(80, 50)).toBe(50);
  });

  it('falls back to the budget when no agent ceiling is given', () => {
    expect(resolveWakeMaxTurns(10, undefined)).toBe(10);
  });

  it('never returns the 100-turn query default for a default budget', () => {
    // The whole point: a default per-wake budget (10) must bound the wake.
    expect(resolveWakeMaxTurns(10, 50)).not.toBe(100);
    expect(resolveWakeMaxTurns(10, 50)).toBeLessThanOrEqual(10);
  });
});

describe('normalizePerWakeTurnBudget (#39)', () => {
  it('passes through a valid positive integer budget', () => {
    expect(normalizePerWakeTurnBudget(10)).toBe(10);
    expect(normalizePerWakeTurnBudget(1)).toBe(1);
    expect(normalizePerWakeTurnBudget(50)).toBe(50);
  });

  it('floors a fractional budget to a whole number of turns', () => {
    expect(normalizePerWakeTurnBudget(10.9)).toBe(10);
  });

  it('falls back to the default for a 0, negative, NaN, or non-finite budget', () => {
    // The bug: any of these as maxTurns makes query() run ZERO turns while
    // still advancing FSM state — silent forward progress with no work done.
    expect(normalizePerWakeTurnBudget(0)).toBe(10);
    expect(normalizePerWakeTurnBudget(-5)).toBe(10);
    expect(normalizePerWakeTurnBudget(Number.NaN)).toBe(10);
    expect(normalizePerWakeTurnBudget(Number.POSITIVE_INFINITY)).toBe(10);
  });

  it('falls back to the default for a missing / non-numeric budget', () => {
    expect(normalizePerWakeTurnBudget(undefined)).toBe(10);
    expect(normalizePerWakeTurnBudget(null)).toBe(10);
    expect(normalizePerWakeTurnBudget('10')).toBe(10);
    expect(normalizePerWakeTurnBudget({})).toBe(10);
  });
});

describe('resolveWakeMaxTurns — invalid budget (#39)', () => {
  it('never collapses to zero turns when the budget is 0 / NaN', () => {
    // Without the #39 guard, a 0 budget would make Math.min(0, agentMaxTurns)
    // = 0 → query() runs zero turns. The guard substitutes the default 10.
    expect(resolveWakeMaxTurns(0, 50)).toBe(10);
    expect(resolveWakeMaxTurns(Number.NaN, 50)).toBe(10);
  });

  it('still caps the substituted default at a lower agent ceiling', () => {
    expect(resolveWakeMaxTurns(0, 3)).toBe(3);
  });
});

describe('sov mission run — CLI registration (FIX 1)', () => {
  it('registers the `run` subcommand under `mission` (so the wake path is reachable)', () => {
    const res = spawnSync('bun', [MAIN_TS, 'mission', '--help'], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    const out = `${res.stdout}${res.stderr}`;
    // The command group must list `run` alongside `init`.
    expect(out).toMatch(/\brun\b/);
    expect(out).toContain('init');
  });

  it('`mission run --help` documents the required --state-dir option', () => {
    const res = spawnSync('bun', [MAIN_TS, 'mission', 'run', '--help'], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    const out = `${res.stdout}${res.stderr}`;
    expect(out).toContain('--state-dir');
  });

  it('`mission run` without --state-dir fails (required option enforced)', () => {
    const res = spawnSync('bun', [MAIN_TS, 'mission', 'run'], { encoding: 'utf8' });
    // Commander exits non-zero on a missing required option.
    expect(res.status).not.toBe(0);
    expect(`${res.stdout}${res.stderr}`).toContain('state-dir');
  });
});

// ---------------------------------------------------------------------------
// Task 4.1 — field-level parity for the createAgent() re-seat.
//
// `runMissionWake` previously drove its single turn with an inline `query()`;
// it now drives the SAME turn through `createAgent().run()`. These tests pin
// the brief's field-level parity rule — "identical agent loop EXCEPT the
// ratified additions":
//   A. The loop is unchanged: a mission-shaped turn through createAgent yields
//      byte-identical stream events + the same final assistant as a direct
//      query() drive with mission's prior param shape (cacheEnabled omitted —
//      query() defaults it to the `true` mission passed).
//   B. The parity-fix reaches the turn: a settings-derived `microcompactConfig`
//      is HONORED (an aggressive config compacts; a disabled one does not),
//      where the old inline call could only ever use query()'s built-in default.
//   C. No capability is silently gained/lost: mission's bespoke tool-context
//      flows through VERBATIM — an allowed tool still runs, and createAgent
//      grafts on no learning/review the wake didn't already have.
//
// A deterministic scripted LLMProvider (a fresh instance per call — generators
// are single-use) stands in for a real provider: no network, no disk.
// ---------------------------------------------------------------------------

function scriptedProvider(turns: StreamEvent[][]): LLMProvider {
  const queue = [...turns];
  return {
    name: 'fake',
    async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      const events = queue.shift();
      if (!events) throw new Error('scriptedProvider: queue empty');
      let last: AssistantMessage | undefined;
      for (const ev of events) {
        if (ev.type === 'assistant_message') last = ev.message;
        yield ev;
      }
      return last ?? { role: 'assistant', content: [] };
    },
  };
}

const completedAnswer: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'MISSION_TRANSITION=continue done for now' }],
};

const completedTurn: StreamEvent[] = [
  { type: 'message_start' },
  { type: 'text_delta', text: 'MISSION_TRANSITION=continue done for now' },
  { type: 'usage_delta', usage: { inputTokens: 5, outputTokens: 4 } },
  { type: 'message_stop', stop_reason: 'end_turn' },
  { type: 'assistant_message', message: completedAnswer },
];

function readToolUseTurn(id: string): StreamEvent[] {
  const message: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'Read', input: { path: 'a.txt' } }],
  };
  return [
    { type: 'message_start' },
    { type: 'tool_use_delta', id, partial: '{"path":"a.txt"}' },
    { type: 'message_stop', stop_reason: 'tool_use' },
    { type: 'assistant_message', message },
  ];
}

function makeReadTool(onCall?: (ctx: ToolContext) => void): Tool<unknown, unknown> {
  return buildTool({
    name: 'Read',
    description: () => 'read a file',
    inputSchema: z.object({ path: z.string() }),
    async call(_input, ctx) {
      onCall?.(ctx);
      return { data: { content: 'ok' } };
    },
  }) as unknown as Tool<unknown, unknown>;
}

type RunResultLike = ReturnType<typeof createAgent>['run'] extends (
  ...args: never[]
) => AsyncGenerator<unknown, infer R>
  ? R
  : never;

async function drainAgent(
  gen: AsyncGenerator<StreamEvent | Message, RunResultLike>,
): Promise<{ events: (StreamEvent | Message)[]; result: RunResultLike }> {
  const events: (StreamEvent | Message)[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { events, result: step.value };
    events.push(step.value);
  }
}

async function drainEvents(
  gen: AsyncGenerator<StreamEvent | Message, unknown>,
): Promise<(StreamEvent | Message)[]> {
  const events: (StreamEvent | Message)[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return events;
    events.push(step.value);
  }
}

const hasMicrocompactEvent = (events: (StreamEvent | Message)[]): boolean =>
  events.some((e) => 'type' in e && e.type === 'microcompact');

describe('sov mission run — re-seat onto createAgent (Task 4.1 field-level parity)', () => {
  it('A. drives a mission-shaped turn with the SAME stream + final assistant as a direct query() (loop unchanged)', async () => {
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Wake #1: continue your mission.' }] },
    ];
    const systemPrompt: SystemSegment[] = [{ text: 'scheduled-mission agent', cacheable: true }];
    const mc = buildMicrocompactConfig(undefined); // DEFAULT — identical on both sides.

    // BEFORE: the inline query() drive with mission's prior param shape
    // (cacheEnabled: true, as the old surface passed explicitly).
    const directEvents = await drainEvents(
      query({
        provider: scriptedProvider([completedTurn]),
        model: 'fake-model',
        messages: history,
        systemPrompt,
        maxTokens: 4096,
        maxTurns: 10,
        cacheEnabled: true,
        sessionId: 'mission-wake',
        cwd: '/tmp/mission',
        microcompactConfig: mc,
      }),
    );

    // AFTER: the same turn re-seated onto createAgent. `cacheEnabled` is omitted
    // — query() defaults it to `true`, the value mission passed — so the stream
    // must be byte-identical.
    const agent = createAgent({
      provider: scriptedProvider([completedTurn]),
      model: 'fake-model',
      systemPrompt,
      cwd: '/tmp/mission',
      maxTokens: 4096,
      maxTurns: 10,
      microcompactConfig: mc,
    });
    const { events, result } = await drainAgent(agent.run(history, { sessionId: 'mission-wake' }));

    expect(events).toEqual(directEvents);
    expect(result.finalAssistant).toEqual(completedAnswer);
    expect(result.terminal.reason).toBe('completed');
  });

  it('B. honors a settings-derived microcompactConfig that reaches the turn (parity-fix)', async () => {
    // A real second user-prompt boundary (`now read again`) sits after a prior
    // large, compactable Read result — so a tool turn that fires INSIDE the loop
    // exposes that older result to eviction when the config permits it.
    const big = 'X'.repeat(4000);
    const seed = (): Message[] => [
      { role: 'user', content: [{ type: 'text', text: 'first prompt' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { path: 'a' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'r1', content: big, is_error: false }],
      },
      { role: 'user', content: [{ type: 'text', text: 'now read again' }] },
    ];
    const toolContext: ToolContext = { cwd: '/tmp/mission', sessionId: 'mission-wake' };
    const allowAll: CanUseTool = async () => ({ behavior: 'allow' });

    const aggressive: MicrocompactConfig = {
      enabled: true,
      keepRecent: 0,
      triggerThresholdPct: 0,
      compactableTools: new Set(['Read']),
    };

    // Aggressive config → the older Read result is cleared mid-turn.
    const agentOn = createAgent({
      provider: scriptedProvider([readToolUseTurn('r2'), completedTurn]),
      model: 'fake-model',
      tools: [makeReadTool()],
      maxTokens: 4096,
      microcompactConfig: aggressive,
    });
    const { events: onEvents } = await drainAgent(
      agentOn.run(seed(), { toolContext, canUseTool: allowAll, sessionId: 'mission-wake' }),
    );
    expect(hasMicrocompactEvent(onEvents)).toBe(true);

    // Same turn + history, but a DISABLED config must NOT compact — proving the
    // config (not query()'s built-in default) is what's honored.
    const agentOff = createAgent({
      provider: scriptedProvider([readToolUseTurn('r2'), completedTurn]),
      model: 'fake-model',
      tools: [makeReadTool()],
      maxTokens: 4096,
      microcompactConfig: { ...aggressive, enabled: false },
    });
    const { events: offEvents } = await drainAgent(
      agentOff.run(seed(), { toolContext, canUseTool: allowAll, sessionId: 'mission-wake' }),
    );
    expect(hasMicrocompactEvent(offEvents)).toBe(false);
  });

  it('C. passes the bespoke tool-context VERBATIM: an allowed tool runs, no learning/review silently added', async () => {
    let ranWith: ToolContext | undefined;
    const bespoke: ToolContext = { cwd: '/tmp/mission', sessionId: 'mission-wake' };
    const allowAll: CanUseTool = async () => ({ behavior: 'allow' });

    const agent = createAgent({
      provider: scriptedProvider([readToolUseTurn('t1'), completedTurn]),
      model: 'fake-model',
      tools: [
        makeReadTool((ctx) => {
          ranWith = ctx;
        }),
      ],
      maxTokens: 4096,
      microcompactConfig: buildMicrocompactConfig(undefined),
    });
    const { result } = await drainAgent(
      agent.run('go', { toolContext: bespoke, canUseTool: allowAll, sessionId: 'mission-wake' }),
    );

    // The allowed tool actually ran (permission wiring intact) with mission's
    // EXACT bespoke context — the same object, used verbatim.
    expect(ranWith).toBe(bespoke);
    // ...and createAgent grafted on no learning / review capability the wake
    // did not already have.
    expect(ranWith?.learningObserver).toBeUndefined();
    expect(ranWith?.reviewManager).toBeUndefined();
    expect(result.toolCallCount).toBe(1);
    expect(result.distinctToolNames).toEqual(['Read']);
    expect(result.terminal.reason).toBe('completed');
  });
});

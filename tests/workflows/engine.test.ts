// Tests for the deterministic workflow engine (src/workflows/engine.ts).
//
// Strategy: a STUBBED runtime whose `subagentScheduler.delegate` is a recording
// fake. The fake lets each test script the per-agent reply text + an optional
// hold so we can assert the engine's deterministic shape WITHOUT a real
// provider/scheduler:
//   - barrier ordering (phase 2 starts only after phase 1's tasks all settle);
//   - parallel fan-out is actually concurrent (max-concurrent counter > 1);
//   - map over args + over a prior phase's JSON output;
//   - output threading (text + json + the `.field` flatten);
//   - a failing task records `{ error }` and does NOT abort the phase;
//   - arg validation (required / coercion).
// `buildSessionToolContext` runs against the stub (it only reads the fields the
// stub supplies + does FS-free derivation); `loadPermissionSettings` reads the
// tmp HARNESS_HOME so the headless canUseTool builds cleanly.

import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, Terminal } from '@yevgetman/sov-sdk/core/types';
import type { DelegateInput, DelegateResult } from '@yevgetman/sov-sdk/runtime/scheduler';
import type { ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { buildSessionToolContext } from '../../src/server/routes/turns.js';
import type { Runtime } from '../../src/server/runtime.js';
import { runWorkflow, validateArgs } from '../../src/workflows/engine.js';
import type { WorkflowEvent } from '../../src/workflows/events.js';
import type { WorkflowHost } from '../../src/workflows/host.js';
import type { WorkflowDef } from '../../src/workflows/types.js';

/** A scripted reply for one agent: the final text it returns + an optional
 *  hold (ms) so concurrency can be observed. */
type Script = { text: string; terminal?: Terminal['reason']; holdMs?: number };

type DelegateCall = { agentName: string; prompt: string; writeScope?: unknown };

/** A recording delegate fake. Tracks every call + the max number of overlapping
 *  in-flight calls (the concurrency witness). */
function makeRecordingDelegate(scripts: Record<string, Script | Script[]>) {
  const calls: DelegateCall[] = [];
  const counters: Record<string, number> = {};
  let inFlight = 0;
  let maxInFlight = 0;
  const delegate = async (input: DelegateInput): Promise<DelegateResult> => {
    calls.push({
      agentName: input.agentName,
      prompt: input.prompt,
      ...(input.writeScope !== undefined ? { writeScope: input.writeScope } : {}),
    });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const scripted = scripts[input.agentName];
      const idx = counters[input.agentName] ?? 0;
      counters[input.agentName] = idx + 1;
      const script: Script = Array.isArray(scripted)
        ? (scripted[Math.min(idx, scripted.length - 1)] as Script)
        : (scripted ?? { text: '' });
      if (script.holdMs !== undefined) await new Promise((r) => setTimeout(r, script.holdMs));
      const reason: Terminal['reason'] = script.terminal ?? 'completed';
      const finalAssistant: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: script.text }],
      };
      return {
        childSessionId: `child-${calls.length}`,
        agentName: input.agentName,
        resolvedProvider: 'fake',
        resolvedModel: 'm',
        terminal:
          reason === 'completed' || reason === 'max_turns'
            ? { reason }
            : ({ reason, error: new Error(reason) } as Terminal),
        summary: script.text,
        finalAssistant,
        iterationsUsed: 1,
        toolCallCount: 0,
        distinctToolNames: [],
        durationMs: 1,
      };
    } finally {
      inFlight -= 1;
    }
  };
  return {
    delegate,
    calls,
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

/** A minimal Runtime stub: only the fields `buildSessionToolContext` +
 *  `buildWorkflowCanUseTool` dereference. Everything else is cast away. */
/** Every agent name referenced across this file's workflow defs. The stub's
 *  `subagentScheduler.agentNames()` returns these so the engine's semantic gate
 *  (validateWorkflow) passes — a test that adds a new agent name must add it
 *  here (the validation error makes that obvious). */
const STUB_AGENT_NAMES = [
  'a',
  'b',
  'c',
  'rev',
  'finder',
  'verifier',
  'syn',
  'ok1',
  'boom',
  'ok2',
  'w',
];

function makeStubRuntime(
  delegate: (input: DelegateInput) => Promise<DelegateResult>,
  agentNames: string[] = STUB_AGENT_NAMES,
): Runtime {
  const sessionCtx = {
    sessionId: 'wf-parent',
    subdirectoryHintState: { touched: new Set<string>() },
    memoryManager: {},
    projectScope: {},
    trajectoryMetadata: {},
    reviewAbortController: new AbortController(),
  };
  return {
    cwd: process.cwd(),
    harnessHome: process.env.HARNESS_HOME ?? '/tmp',
    toolPool: [],
    agents: { agents: [], byName: new Map() },
    bundle: null,
    taskManager: {},
    laneRegistry: { lookup: () => undefined, entries: () => [] },
    skills: { skills: [], byName: new Map() },
    subagentScheduler: { delegate, agentNames: () => agentNames },
    getSessionContext: () => sessionCtx,
  } as unknown as Runtime;
}

/** Wrap the minimal Runtime stub into the narrow WorkflowHost the engine now
 *  takes (Task 5.2). `buildToolContext` is wired to the SAME
 *  `buildSessionToolContext` resolver the engine used to import + call directly,
 *  so the end-to-end behavior is byte-identical — the engine now just receives
 *  it through the handle instead of reaching into `server/routes/turns.ts`. */
function makeStubHost(
  delegate: (input: DelegateInput) => Promise<DelegateResult>,
  agentNames: string[] = STUB_AGENT_NAMES,
): WorkflowHost {
  const runtime = makeStubRuntime(delegate, agentNames);
  return {
    cwd: runtime.cwd,
    harnessHome: runtime.harnessHome,
    scheduler: runtime.subagentScheduler,
    buildToolContext: (sid, cut, opts) => buildSessionToolContext(runtime, sid, cut, opts),
  };
}

const PARENT = 'wf-parent';

describe('validateArgs', () => {
  test('fills defaults and coerces declared types', () => {
    const out = validateArgs(
      {
        name: { type: 'string', required: true },
        count: { type: 'number' },
        flag: { type: 'boolean', default: true },
        items: { type: 'list' },
      },
      { name: 'x', count: '7', items: 'a, b, c' },
    );
    expect(out).toEqual({ name: 'x', count: 7, flag: true, items: ['a', 'b', 'c'] });
  });

  test('throws on a missing required arg', () => {
    expect(() => validateArgs({ q: { type: 'string', required: true } }, {})).toThrow(
      /'q' is required/,
    );
  });
});

describe('runWorkflow — barrier ordering', () => {
  test('phase 2 starts only after every phase 1 task settles', async () => {
    const events: WorkflowEvent[] = [];
    const fake = makeRecordingDelegate({
      a: { text: 'a-done', holdMs: 40 },
      b: { text: 'b-done', holdMs: 40 },
      c: { text: 'c-done' },
    });
    const def: WorkflowDef = {
      name: 'barrier',
      description: 'd',
      phases: [
        {
          id: 'p1',
          tasks: [
            { agent: 'a', prompt: 'x', output: 'text' },
            { agent: 'b', prompt: 'y', output: 'text' },
          ],
        },
        { id: 'p2', tasks: [{ agent: 'c', prompt: 'z', output: 'text' }] },
      ],
    };
    await runWorkflow({
      host: makeStubHost(fake.delegate),
      def,
      args: {},
      parentSessionId: PARENT,
      onEvent: (e) => events.push(e),
    });
    // c must be called only after a AND b finished (both held 40ms).
    const order = fake.calls.map((c) => c.agentName);
    expect(order.indexOf('c')).toBe(2);
    // The phase_started event for p2 lands after both p1 task_completes.
    const types = events.map((e) => `${e.type}:${'phaseId' in e ? e.phaseId : ''}`);
    const p2Start = types.indexOf('workflow_phase_started:p2');
    const p1Completes = events.filter(
      (e) => e.type === 'workflow_task_complete' && e.phaseId === 'p1',
    ).length;
    expect(p1Completes).toBe(2);
    expect(p2Start).toBeGreaterThan(types.indexOf('workflow_phase_started:p1'));
  });
});

describe('runWorkflow — parallel fan-out is actually concurrent', () => {
  test('two tasks in one phase overlap in flight', async () => {
    const fake = makeRecordingDelegate({
      a: { text: 'a', holdMs: 30 },
      b: { text: 'b', holdMs: 30 },
    });
    const def: WorkflowDef = {
      name: 'fanout',
      description: 'd',
      phases: [
        {
          id: 'p',
          tasks: [
            { agent: 'a', prompt: '1', output: 'text' },
            { agent: 'b', prompt: '2', output: 'text' },
          ],
        },
      ],
    };
    await runWorkflow({
      host: makeStubHost(fake.delegate),
      def,
      args: {},
      parentSessionId: PARENT,
    });
    expect(fake.maxInFlight).toBeGreaterThan(1);
  });
});

describe('runWorkflow — map fan-out', () => {
  test('maps over an args list, binding the loop var into the prompt', async () => {
    const fake = makeRecordingDelegate({ rev: { text: 'ok' } });
    const def: WorkflowDef = {
      name: 'map-args',
      description: 'd',
      args: { dims: { type: 'list', required: true } },
      phases: [
        {
          id: 'find',
          map: { over: 'args.dims', as: 'dimension' },
          task: { agent: 'rev', prompt: 'review {{dimension}}', output: 'text' },
        },
      ],
    };
    await runWorkflow({
      host: makeStubHost(fake.delegate),
      def,
      args: { dims: ['bugs', 'security'] },
      parentSessionId: PARENT,
    });
    expect(fake.calls.map((c) => c.prompt)).toEqual(['review bugs', 'review security']);
  });

  test('maps over a prior phase JSON output via the .field flatten', async () => {
    const fake = makeRecordingDelegate({
      finder: { text: '```json\n{"findings":[{"claim":"c1"},{"claim":"c2"}]}\n```' },
      verifier: { text: 'verified' },
    });
    const def: WorkflowDef = {
      name: 'map-prior',
      description: 'd',
      phases: [
        { id: 'find', tasks: [{ agent: 'finder', prompt: 'go', output: 'json' }] },
        {
          id: 'verify',
          map: { over: 'find.findings', as: 'finding' },
          task: { agent: 'verifier', prompt: 'check {{finding.claim}}', output: 'text' },
        },
      ],
    };
    await runWorkflow({
      host: makeStubHost(fake.delegate),
      def,
      args: {},
      parentSessionId: PARENT,
    });
    const verifyPrompts = fake.calls.filter((c) => c.agentName === 'verifier').map((c) => c.prompt);
    expect(verifyPrompts).toEqual(['check c1', 'check c2']);
  });
});

describe('runWorkflow — output threading', () => {
  test('threads text, parsed json, and flatten into later prompts; finalText is last phase', async () => {
    const fake = makeRecordingDelegate({
      finder: { text: '{"items":[{"v":1},{"v":2}]}' },
      syn: { text: 'final report' },
    });
    const def: WorkflowDef = {
      name: 'thread',
      description: 'd',
      phases: [
        { id: 'find', tasks: [{ agent: 'finder', prompt: 'find', output: 'json' }] },
        {
          id: 'syn',
          tasks: [
            {
              agent: 'syn',
              prompt: 'json={{find.json}} flat={{find.items}} text={{find.text}}',
              output: 'text',
            },
          ],
        },
      ],
    };
    const result = await runWorkflow({
      host: makeStubHost(fake.delegate),
      def,
      args: {},
      parentSessionId: PARENT,
    });
    const synPrompt = fake.calls.find((c) => c.agentName === 'syn')?.prompt ?? '';
    expect(synPrompt).toContain('json={"items":[{"v":1},{"v":2}]}');
    expect(synPrompt).toContain('flat=[{"v":1},{"v":2}]');
    expect(result.finalText).toBe('final report');
    expect(result.ok).toBe(true);
  });

  test('a json task that never parses records an error after one repair retry', async () => {
    // Both the first reply and the repair reply are non-JSON → error recorded,
    // and the repair was actually attempted (two calls).
    const fake = makeRecordingDelegate({
      finder: [{ text: 'not json at all' }, { text: 'still not json' }],
    });
    const def: WorkflowDef = {
      name: 'badjson',
      description: 'd',
      phases: [{ id: 'find', tasks: [{ agent: 'finder', prompt: 'go', output: 'json' }] }],
    };
    const result = await runWorkflow({
      host: makeStubHost(fake.delegate),
      def,
      args: {},
      parentSessionId: PARENT,
    });
    expect(fake.calls).toHaveLength(2); // first + one repair
    expect(result.ok).toBe(false);
    const find = result.phases.find as { kind: string; task: { error?: string } };
    expect(find.task.error).toContain('failed to parse');
  });
});

describe('runWorkflow — failure tolerance + writeScope', () => {
  test('a failing task records error but does NOT abort the phase', async () => {
    const fake = makeRecordingDelegate({
      ok1: { text: 'fine' },
      boom: { text: 'partial', terminal: 'error' },
      ok2: { text: 'also fine' },
    });
    const def: WorkflowDef = {
      name: 'tolerate',
      description: 'd',
      phases: [
        {
          id: 'p',
          tasks: [
            { agent: 'ok1', prompt: '1', output: 'text' },
            { agent: 'boom', prompt: '2', output: 'text' },
            { agent: 'ok2', prompt: '3', output: 'text' },
          ],
        },
      ],
    };
    const result = await runWorkflow({
      host: makeStubHost(fake.delegate),
      def,
      args: {},
      parentSessionId: PARENT,
    });
    expect(fake.calls).toHaveLength(3); // all three ran
    expect(result.ok).toBe(false);
    expect(result.runSummary.phases[0]).toEqual({ phaseId: 'p', total: 3, failed: 1 });
  });

  test('a task with declared writes passes a globs writeScope into delegate', async () => {
    const fake = makeRecordingDelegate({ w: { text: 'wrote' } });
    const def: WorkflowDef = {
      name: 'writes',
      description: 'd',
      phases: [
        {
          id: 'p',
          tasks: [{ agent: 'w', prompt: 'edit', output: 'text', writes: ['src/a/**'] }],
        },
      ],
    };
    await runWorkflow({
      host: makeStubHost(fake.delegate),
      def,
      args: {},
      parentSessionId: PARENT,
    });
    expect(fake.calls[0]?.writeScope).toEqual({ kind: 'globs', globs: ['src/a/**'] });
  });
});

describe('runWorkflow — review-fix regressions', () => {
  // H2 — a phase wider than the scheduler's default per-parent cap (4) must run
  // EVERY task, not silently drop tasks 5+. The stub delegate has no cap, but
  // this asserts the engine fires all of them (and the real maxChildrenOverride
  // lifts the cap end-to-end).
  test('a phase with >4 tasks runs every task (no silent truncation)', async () => {
    const fake = makeRecordingDelegate(
      Object.fromEntries(['a', 'b', 'c', 'finder', 'verifier', 'syn'].map((n) => [n, { text: n }])),
    );
    const def: WorkflowDef = {
      name: 'wide',
      description: 'd',
      phases: [
        {
          id: 'p',
          tasks: [
            { agent: 'a', prompt: '1', output: 'text' },
            { agent: 'b', prompt: '2', output: 'text' },
            { agent: 'c', prompt: '3', output: 'text' },
            { agent: 'finder', prompt: '4', output: 'text' },
            { agent: 'verifier', prompt: '5', output: 'text' },
            { agent: 'syn', prompt: '6', output: 'text' },
          ],
        },
      ],
    };
    const result = await runWorkflow({
      host: makeStubHost(fake.delegate),
      def,
      args: {},
      parentSessionId: PARENT,
    });
    expect(fake.calls).toHaveLength(6);
    expect(result.runSummary.phases[0]).toEqual({ phaseId: 'p', total: 6, failed: 0 });
  });

  test('every delegate call carries the per-call child-cap override (lifts the default cap)', async () => {
    const overrides: Array<number | undefined> = [];
    const def: WorkflowDef = {
      name: 'cap',
      description: 'd',
      phases: [{ id: 'p', tasks: [{ agent: 'a', prompt: 'x', output: 'text' }] }],
    };
    await runWorkflow({
      host: makeStubHost(async (input) => {
        overrides.push(input.maxChildrenOverride);
        return {
          childSessionId: 'c',
          agentName: input.agentName,
          resolvedProvider: 'f',
          resolvedModel: 'm',
          terminal: { reason: 'completed' },
          summary: 'ok',
          iterationsUsed: 1,
          toolCallCount: 0,
          distinctToolNames: [],
          durationMs: 1,
        };
      }),
      def,
      args: {},
      parentSessionId: PARENT,
    });
    expect(overrides[0]).toBeGreaterThan(4);
  });

  // H3 — an upstream task failure (recorded as {error}, json undefined) used in
  // a downstream interpolation must degrade the dependent phase gracefully, NOT
  // throw out of runWorkflow (the per-task degradation contract).
  test('a downstream ref to a failed upstream json degrades gracefully (no crash)', async () => {
    const fake = makeRecordingDelegate({
      a: { text: 'boom', terminal: 'error' }, // phase A fails → json undefined
      b: { text: 'b-done' },
    });
    const def: WorkflowDef = {
      name: 'cascade',
      description: 'd',
      phases: [
        { id: 'a', tasks: [{ agent: 'a', prompt: 'go', output: 'json' }] },
        { id: 'b', tasks: [{ agent: 'b', prompt: 'use {{a.json.value}}', output: 'text' }] },
      ],
    };
    const result = await runWorkflow({
      host: makeStubHost(fake.delegate),
      def,
      args: {},
      parentSessionId: PARENT,
    });
    // No throw; the run completes ok:false with phase b recorded failed.
    expect(result.ok).toBe(false);
    const phaseB = result.runSummary.phases.find((p) => p.phaseId === 'b');
    expect(phaseB?.failed).toBe(1);
  });

  // M4 — validateWorkflow is wired at run start: an unknown agent / bad lane /
  // bad template ref fails fast BEFORE any phase runs.
  test('rejects an unknown agent at run start (no delegate call)', async () => {
    const fake = makeRecordingDelegate({ a: { text: 'a' } });
    const def: WorkflowDef = {
      name: 'badagent',
      description: 'd',
      phases: [{ id: 'p', tasks: [{ agent: 'nonexistent', prompt: 'x', output: 'text' }] }],
    };
    await expect(
      runWorkflow({
        host: makeStubHost(fake.delegate),
        def,
        args: {},
        parentSessionId: PARENT,
      }),
    ).rejects.toThrow(/unknown agent 'nonexistent'/);
    expect(fake.calls).toHaveLength(0);
  });

  test('rejects an unknown lane at run start', async () => {
    const def: WorkflowDef = {
      name: 'badlane',
      description: 'd',
      phases: [{ id: 'p', tasks: [{ agent: 'a', prompt: 'x', output: 'text', lane: 'turbo' }] }],
    };
    await expect(
      runWorkflow({
        host: makeStubHost(async () => {
          throw new Error('should not be called');
        }),
        def,
        args: {},
        parentSessionId: PARENT,
      }),
    ).rejects.toThrow(/unknown lane 'turbo'/);
  });

  // M8 — a list/number default expressed as a string is coerced through the same
  // path as a provided value (so map.over on a default list works).
  test('a list default given as a string is coerced into an array (map.over works)', async () => {
    const fake = makeRecordingDelegate({ rev: { text: 'r' } });
    const def: WorkflowDef = {
      name: 'defaults',
      description: 'd',
      args: { dims: { type: 'list', default: 'bugs,perf,security' } },
      phases: [
        {
          id: 'review',
          map: { over: 'args.dims', as: 'dim' },
          task: { agent: 'rev', prompt: 'check {{dim}}', output: 'text' },
        },
      ],
    };
    await runWorkflow({
      host: makeStubHost(fake.delegate),
      def,
      args: {},
      parentSessionId: PARENT,
    });
    expect(fake.calls.map((c) => c.prompt)).toEqual(['check bugs', 'check perf', 'check security']);
  });

  // M10 — the parent's learning memoryManager is threaded into every delegate
  // input so workflow tasks feed the on_delegation learning hook.
  test('threads the parent memoryManager into each delegate input', async () => {
    let sawMemoryManager = false;
    const def: WorkflowDef = {
      name: 'mem',
      description: 'd',
      phases: [{ id: 'p', tasks: [{ agent: 'a', prompt: 'x', output: 'text' }] }],
    };
    await runWorkflow({
      host: makeStubHost(async (input) => {
        sawMemoryManager = input.memoryManager !== undefined;
        return {
          childSessionId: 'c',
          agentName: input.agentName,
          resolvedProvider: 'f',
          resolvedModel: 'm',
          terminal: { reason: 'completed' },
          summary: 'ok',
          iterationsUsed: 1,
          toolCallCount: 0,
          distinctToolNames: [],
          durationMs: 1,
        };
      }),
      def,
      args: {},
      parentSessionId: PARENT,
    });
    expect(sawMemoryManager).toBe(true);
  });
});

// Task 5.2 — the engine depends ONLY on the narrow WorkflowHost handle, not on a
// Runtime god-object or a `server/routes/turns.ts` reach-around. This test drives
// `runWorkflow` with a HAND-BUILT host: a mock scheduler + a stub
// `buildToolContext` that fabricates a minimal ToolContext directly (no Runtime,
// no `buildSessionToolContext`). If the engine still reached into the server or
// typed its input as Runtime, this would not compile / would not run.
describe('runWorkflow — narrow WorkflowHost handle', () => {
  test('runs a workflow to completion driven only by a hand-built host', async () => {
    const fake = makeRecordingDelegate({ w: { text: 'done' } });
    let toolContextBuilds = 0;
    const host: WorkflowHost = {
      cwd: process.cwd(),
      harnessHome: process.env.HARNESS_HOME ?? '/tmp',
      scheduler: { delegate: fake.delegate, agentNames: () => ['w'] },
      // Fabricated directly — no Runtime, no buildSessionToolContext. The engine
      // only reads optional fields off this (parentToolPool / canUseTool /
      // memoryManager), so a minimal context is sufficient.
      buildToolContext: (_sessionId, canUseTool) => {
        toolContextBuilds += 1;
        return { parentToolPool: [], canUseTool } as unknown as ToolContext;
      },
    };
    const def: WorkflowDef = {
      name: 'narrow',
      description: 'd',
      phases: [{ id: 'p', tasks: [{ agent: 'w', prompt: 'go', output: 'text' }] }],
    };

    const result = await runWorkflow({ host, def, args: {}, parentSessionId: PARENT });

    expect(result.ok).toBe(true);
    expect(result.finalText).toBe('done');
    expect(fake.calls.map((c) => c.agentName)).toEqual(['w']);
    // The engine builds the parent ToolContext exactly once, via the handle.
    expect(toolContextBuilds).toBe(1);
  });
});

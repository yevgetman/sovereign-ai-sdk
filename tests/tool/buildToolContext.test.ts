// Task 5.1 — the OPEN tool-context assembler `buildToolContext`.
//
// Two guards:
//   1. Field-wiring: a hand-built resolved `BuildToolContextInput` produces a
//      `ToolContext` whose every field is wired to the provided input — incl.
//      the derived `activeToolNames` / `activeToolsets` / filtered `skills`,
//      the `parentToolPool === effectivePool` aliasing, and the conditional
//      spreads (optional fields ABSENT when their input is undefined, PRESENT
//      and equal when provided — the exactOptionalPropertyTypes contract).
//   2. Delegation parity: for a real runtime+sessionId, the proprietary
//      `buildSessionToolContext` (which now resolves inputs off the Runtime +
//      SessionContext and delegates to the open assembler) wires the same
//      runtime/session references onto the returned ToolContext — proving the
//      split is faithful. (The existing turns/session/skillScope tests are the
//      primary guard; this pins the resolution→assembly seam directly.)

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanUseTool } from '../../src/permissions/types.js';
import { buildSessionToolContext } from '../../src/server/routes/turns.js';
import { buildRuntime } from '../../src/server/runtime.js';
import type { SkillRegistry } from '../../src/skills/types.js';
import { inferActiveToolsets } from '../../src/skills/visibility.js';
import { type BuildToolContextInput, buildToolContext } from '../../src/tool/buildToolContext.js';
import type { Tool } from '../../src/tool/types.js';

// A trivial canUseTool stand-in — the assembler only records the reference.
const noopCanUseTool: CanUseTool = async () => ({ behavior: 'allow', updatedInput: {} });

/** Build a minimal-but-typed resolved input. The opaque ports (scheduler,
 *  taskManager, laneRegistry, memoryManager, hint state, agents) are stubbed:
 *  the assembler is a pure passthrough, so reference-equality is all that's
 *  asserted against them. */
function makeInput(overrides: Partial<BuildToolContextInput> = {}): BuildToolContextInput {
  const effectivePool = [{ name: 'Bash' }, { name: 'FileRead' }] as unknown as Tool<
    unknown,
    unknown
  >[];
  const skills: SkillRegistry = { skills: [], byName: new Map() };
  return {
    cwd: '/work/dir',
    sessionId: 'sess-1',
    harnessHome: '/harness/home',
    agents: { agents: [], byName: new Map() } as unknown as BuildToolContextInput['agents'],
    subagentScheduler: { id: 'scheduler' } as unknown as BuildToolContextInput['subagentScheduler'],
    taskManager: { id: 'taskmgr' } as unknown as BuildToolContextInput['taskManager'],
    laneRegistry: { id: 'lanes' } as unknown as BuildToolContextInput['laneRegistry'],
    effectivePool,
    skills,
    canUseTool: noopCanUseTool,
    subdirectoryHintState: {
      touched: new Set(),
    } as unknown as BuildToolContextInput['subdirectoryHintState'],
    memoryManager: { id: 'memory' } as unknown as BuildToolContextInput['memoryManager'],
    projectScope: { kind: 'none' },
    ...overrides,
  };
}

describe('buildToolContext (open assembler) — field wiring', () => {
  test('wires every required field + derives visibility from the effective pool', () => {
    const input = makeInput();
    const ctx = buildToolContext(input);

    // Direct passthroughs.
    expect(ctx.cwd).toBe('/work/dir');
    expect(ctx.sessionId).toBe('sess-1');
    expect(ctx.harnessHome).toBe('/harness/home');
    expect(ctx.agents).toBe(input.agents);
    expect(ctx.subagentScheduler).toBe(input.subagentScheduler);
    expect(ctx.taskManager).toBe(input.taskManager);
    expect(ctx.laneRegistry).toBe(input.laneRegistry);
    expect(ctx.canUseTool).toBe(noopCanUseTool);
    expect(ctx.subdirectoryHintState).toBe(input.subdirectoryHintState);
    expect(ctx.memoryManager).toBe(input.memoryManager);
    expect(ctx.projectScope).toBe(input.projectScope);

    // The effective pool is BOTH the parent pool AND the visibility source.
    expect(ctx.parentToolPool).toBe(input.effectivePool);
    expect(ctx.activeToolNames).toEqual(['Bash', 'FileRead']);
    expect(ctx.activeToolsets).toEqual(inferActiveToolsets(['Bash', 'FileRead']));
    // Skills are the FILTERED view (empty registry → empty filtered view).
    expect(ctx.skills?.skills).toEqual([]);
  });

  test('OMITS optional fields when their input is undefined (exactOptional contract)', () => {
    const ctx = buildToolContext(makeInput());
    expect('bundleRoot' in ctx).toBe(false);
    expect('webSearch' in ctx).toBe(false);
    expect('learningObserver' in ctx).toBe(false);
    expect('reviewManager' in ctx).toBe(false);
    expect('userId' in ctx).toBe(false);
    expect('delegationLifecycleRecorder' in ctx).toBe(false);
  });

  test('INCLUDES optional fields when provided', () => {
    const learningObserver = { observe: () => {} } as unknown as NonNullable<
      BuildToolContextInput['learningObserver']
    >;
    const reviewManager = {
      onToolIteration: () => {},
      onChildCompletion: () => {},
    } as unknown as NonNullable<BuildToolContextInput['reviewManager']>;
    const recorder = () => {};
    const ctx = buildToolContext(
      makeInput({
        bundleRoot: '/bundle/root',
        webSearch: { provider: 'tavily' } as unknown as BuildToolContextInput['webSearch'],
        learningObserver,
        reviewManager,
        userId: 'user-42',
        delegationLifecycleRecorder: recorder,
      }),
    );
    expect(ctx.bundleRoot).toBe('/bundle/root');
    expect(ctx.webSearch).toEqual({ provider: 'tavily' });
    expect(ctx.learningObserver).toBe(learningObserver);
    expect(ctx.reviewManager).toBe(reviewManager);
    expect(ctx.userId).toBe('user-42');
    expect(ctx.delegationLifecycleRecorder).toBe(recorder);
  });
});

describe('buildSessionToolContext → buildToolContext delegation parity', () => {
  let tmpHome: string;
  let tmpCwd: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'task51-home-'));
    tmpCwd = mkdtempSync(join(tmpdir(), 'task51-cwd-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  test('wires runtime + SessionContext references faithfully through the split', async () => {
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      preflight: false,
    });
    try {
      const sessionId = 'parity-session';
      const ctx = buildSessionToolContext(runtime, sessionId, noopCanUseTool);
      // getSessionContext is idempotent — the same cached context the wrapper
      // resolved its per-session inputs from.
      const sessionCtx = runtime.getSessionContext(sessionId);

      // Runtime-sourced fields.
      expect(ctx.cwd).toBe(runtime.cwd);
      expect(ctx.harnessHome).toBe(runtime.harnessHome);
      expect(ctx.agents).toBe(runtime.agents);
      expect(ctx.subagentScheduler).toBe(runtime.subagentScheduler);
      expect(ctx.taskManager).toBe(runtime.taskManager);
      expect(ctx.laneRegistry).toBe(runtime.laneRegistry);
      expect(ctx.parentToolPool).toBe(runtime.toolPool);
      expect(ctx.canUseTool).toBe(noopCanUseTool);

      // Per-session (SessionContext) fields — same references, not copies.
      expect(ctx.memoryManager).toBe(sessionCtx.memoryManager);
      expect(ctx.projectScope).toBe(sessionCtx.projectScope);
      expect(ctx.subdirectoryHintState).toBe(sessionCtx.subdirectoryHintState);

      // Derived visibility tracks the runtime pool.
      expect(ctx.activeToolNames).toEqual(runtime.toolPool.map((t) => t.name));
    } finally {
      await runtime.dispose();
    }
  });
});

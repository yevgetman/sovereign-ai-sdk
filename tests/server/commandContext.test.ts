// M11.5 T2 — tests for buildServerCommandContext picker plumbing.
//
// Covers: requestPicker capability is defined in server mode, records
// the payload as a `pickerOpen` side-effect, and throws on double-emit
// within a single dispatch (ADR M11.5-01).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PickerOpenConfig } from '../../src/commands/types.js';
import { __test_resetProjectIdCache } from '../../src/learning/project.js';
import { buildServerCommandContext } from '../../src/server/commandContext.js';
import { type Runtime, buildRuntime } from '../../src/server/runtime.js';

describe('buildServerCommandContext — requestPicker (M11.5 T2)', () => {
  let runtime: Runtime;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m11-5-cmdctx-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    __test_resetProjectIdCache();
    runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
    });
  });

  afterAll(async () => {
    await runtime.dispose();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  const samplePayload: PickerOpenConfig = {
    title: 'switch model',
    subtitle: 'provider: anthropic',
    items: [
      { label: 'claude-haiku-4-5', value: 'claude-haiku-4-5', hint: '(current)' },
      { label: 'claude-sonnet-4-6', value: 'claude-sonnet-4-6' },
    ],
    initial: 0,
    onSelect: { command: 'model' },
  };

  test('requestPicker is defined in server mode', () => {
    const sessionCtx = runtime.getSessionContext('session-stub');
    const { ctx } = buildServerCommandContext(runtime, sessionCtx, 'session-stub');
    expect(typeof ctx.requestPicker).toBe('function');
  });

  test('calling requestPicker records pickerOpen in sideEffects', () => {
    const sessionCtx = runtime.getSessionContext('session-stub-2');
    const { ctx, sideEffects } = buildServerCommandContext(runtime, sessionCtx, 'session-stub-2');
    expect(sideEffects.pickerOpen).toBeUndefined();

    ctx.requestPicker?.(samplePayload);

    expect(sideEffects.pickerOpen).toEqual(samplePayload);
  });

  test('double-emit throws', () => {
    const sessionCtx = runtime.getSessionContext('session-stub-3');
    const { ctx } = buildServerCommandContext(runtime, sessionCtx, 'session-stub-3');
    ctx.requestPicker?.(samplePayload);

    expect(() => ctx.requestPicker?.(samplePayload)).toThrow(
      'a picker is already open for this command dispatch',
    );
  });
});

describe('buildServerCommandContext — setEffort (reasoning depth)', () => {
  let runtime: Runtime;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-effort-cmdctx-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    __test_resetProjectIdCache();
    runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
    });
  });

  afterAll(async () => {
    await runtime.dispose();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('runtime.effort defaults to off (no thinking config)', () => {
    expect(runtime.effort).toBe('off');
  });

  test('ctx.effort reflects the current runtime.effort', () => {
    const sessionCtx = runtime.getSessionContext('effort-stub-1');
    const { ctx } = buildServerCommandContext(runtime, sessionCtx, 'effort-stub-1');
    expect(ctx.effort).toBe(runtime.effort);
    expect(typeof ctx.setEffort).toBe('function');
  });

  test('setEffort mutates runtime.effort and records effortChanged', () => {
    const sessionCtx = runtime.getSessionContext('effort-stub-2');
    const { ctx, sideEffects } = buildServerCommandContext(runtime, sessionCtx, 'effort-stub-2');
    expect(sideEffects.effortChanged).toBeUndefined();

    ctx.setEffort('high');

    expect(runtime.effort).toBe('high');
    expect(sideEffects.effortChanged).toBe('high');

    // Reset so this test doesn't leak the mutated level into the next.
    ctx.setEffort('off');
    expect(runtime.effort).toBe('off');
  });
});

describe('buildServerCommandContext — per-principal scoping (Phase E)', () => {
  let runtime: Runtime;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-phasee-cmdctx-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    __test_resetProjectIdCache();
    runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
    });
  });

  afterAll(async () => {
    await runtime.dispose();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('listSessions returns ONLY the calling principal sessions (no cross-principal leak)', () => {
    // Alice + Bob each own a session; a third session is unowned. The context
    // built for one of Alice's sessions must list ONLY Alice's rows.
    const aliceA = runtime.sessionDb.createSession({
      model: 'mock-haiku',
      provider: 'mock',
      owner: 'alice',
    });
    const aliceB = runtime.sessionDb.createSession({
      model: 'mock-haiku',
      provider: 'mock',
      owner: 'alice',
    });
    runtime.sessionDb.createSession({ model: 'mock-haiku', provider: 'mock', owner: 'bob' });
    runtime.sessionDb.createSession({ model: 'mock-haiku', provider: 'mock' });

    const sessionCtx = runtime.getSessionContext(aliceA);
    const { ctx } = buildServerCommandContext(runtime, sessionCtx, aliceA);
    const ids = ctx.listSessions(50).map((s) => s.sessionId);

    expect(ids).toContain(aliceA);
    expect(ids).toContain(aliceB);
    expect(ids.every((id) => id === aliceA || id === aliceB)).toBe(true);
  });

  test('listSessions returns the full unscoped list in single-principal mode', () => {
    // An unowned session's context (userId undefined) must see ALL rows —
    // byte-identical to pre-Phase-E behavior.
    const unowned = runtime.sessionDb.createSession({ model: 'mock-haiku', provider: 'mock' });
    const sessionCtx = runtime.getSessionContext(unowned);
    const { ctx } = buildServerCommandContext(runtime, sessionCtx, unowned);
    const ids = ctx.listSessions(50).map((s) => s.sessionId);

    // The Alice + Bob rows from the prior test live in the same DB; the
    // unscoped list must include at least one of them.
    expect(ids.length).toBeGreaterThan(1);
    expect(ids).toContain(unowned);
  });

  test('getRoutingStats --all aggregates ONLY the calling principal atoms', () => {
    // Seed routing-atom rows for two principals; --all for Alice must count
    // only Alice's atom.
    const aliceParent = runtime.sessionDb.createSession({
      model: 'mock-haiku',
      provider: 'mock',
      owner: 'alice',
    });
    runtime.sessionDb.createSession({
      model: 'mock-haiku',
      provider: 'mock',
      owner: 'alice',
      metadata: {
        kind: 'routing-atom',
        laneName: 'cheap-task',
        laneProvider: 'mock',
        laneModel: 'mock-haiku',
        parentDelegatorSessionId: aliceParent,
      },
    });
    runtime.sessionDb.createSession({
      model: 'mock-haiku',
      provider: 'mock',
      owner: 'bob',
      metadata: {
        kind: 'routing-atom',
        laneName: 'cheap-task',
        laneProvider: 'mock',
        laneModel: 'mock-haiku',
        parentDelegatorSessionId: 'bob-parent',
      },
    });

    const sessionCtx = runtime.getSessionContext(aliceParent);
    const { ctx } = buildServerCommandContext(runtime, sessionCtx, aliceParent);
    const stats = ctx.getRoutingStats?.({ all: true });

    expect(stats?.totalAtoms).toBe(1);
  });
});

// 2026-06-14 config live-apply (T3) — the reload engine + CommandContext
// closures.
//
// Covers:
//   M1  reresolveProvider swaps the active provider stack (transport + model)
//       so the NEXT turn uses the new provider/model — and the compactor +
//       learning Reason adapter follow because they read the runtime fields by
//       reference. Proven with a MockProvider model swap.
//   #55 refreshRuntimeFromConfig reads from the runtime's resolved harnessHome,
//       not the process-global home — a runtime built with an explicit
//       harnessHome (while $HARNESS_HOME points elsewhere) live-applies against
//       ITS config, not ~/.harness/config.json. RED before the fix (bare
//       readConfig() read the HARNESS_HOME config → default), GREEN after.
//   M4  rebuildRecall re-reads recall config on the ACTIVE SessionContext: an
//       explicit `learning.recall.enabled: false` clears the thunk; flipping it
//       back ON rebuilds it. Founder-reserved default (recall ON) is preserved.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test_resetProjectIdCache } from '../../src/learning/project.js';
import { buildServerCommandContext } from '../../src/server/commandContext.js';
import { type Runtime, buildRuntime } from '../../src/server/runtime.js';

describe('reload engine — reresolveProvider (M1)', () => {
  let runtime: Runtime;
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-reload-prov-'));
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

  afterEach(async () => {
    await runtime.dispose();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('swaps the transport + model so the next turn uses the new model', async () => {
    // Arrange: capture the boot stack.
    const bootTransport = runtime.resolvedProvider.transport;
    expect(runtime.model).toBe('mock-haiku');
    expect(runtime.provider).toBe(bootTransport);

    // Act: re-resolve to a new model (a fresh mock transport instance).
    await runtime.reresolveProvider?.('mock', 'mock-sonnet');

    // Assert: model + resolved record + provider all swapped, atomically.
    expect(runtime.model).toBe('mock-sonnet');
    expect(runtime.resolvedProvider.model).toBe('mock-sonnet');
    // The transport instance is a NEW one (the stack was swapped, not mutated
    // through to the old object identity).
    expect(runtime.resolvedProvider.transport).not.toBe(bootTransport);
    // provider and resolvedProvider.transport stay the SAME object — the next
    // turn (which reads runtime.provider) and the compactor (which reads
    // runtime.resolvedProvider.transport) both see the new stack.
    expect(runtime.provider).toBe(runtime.resolvedProvider.transport);
  });

  test('the compactor is rebuilt on reresolve so it uses the new model (not a stale captured snapshot)', async () => {
    // buildServerCompactor captures `model` as a STRING SNAPSHOT at build time
    // (it does NOT read runtime.model by reference). Its transport DOES follow
    // the in-place `resolved` swap, so without rebuilding the compactor a
    // cross-family reresolve would send the OLD model id to the NEW transport on
    // the compaction path — the "foreign model id to the wrong client" bug this
    // build set out to kill. reresolveProvider must therefore REASSIGN
    // runtime.compact (read live by every caller). Regression guard: the compact
    // closure is a fresh instance after a model swap.
    const bootCompact = runtime.compact;
    await runtime.reresolveProvider?.('mock', 'mock-opus');
    expect(runtime.model).toBe('mock-opus');
    expect(runtime.compact).not.toBe(bootCompact);
  });

  test('rebuilds the learning Reason adapter (layer instance swapped)', async () => {
    const bootLayer = runtime.learningLayer;
    await runtime.reresolveProvider?.('mock', 'mock-sonnet');
    // The layer is rebuilt so its Reason port points at the new transport+model.
    expect(runtime.learningLayer).not.toBe(bootLayer);
  });
});

describe('reload engine — refreshRuntimeFromConfig harnessHome fix (#55-class)', () => {
  let runtimeHome: string;
  let envHome: string;
  let priorEnvHome: string | undefined;
  let priorConfig: string | undefined;
  let runtime: Runtime;

  beforeEach(() => {
    runtimeHome = mkdtempSync(join(tmpdir(), 'sov-reload-rthome-'));
    envHome = mkdtempSync(join(tmpdir(), 'sov-reload-envhome-'));
    priorEnvHome = process.env.HARNESS_HOME;
    priorConfig = process.env.HARNESS_CONFIG;
    // HARNESS_HOME points at a DIFFERENT home than the runtime is built with.
    // The bug read THIS one (bare readConfig → resolveHarnessHome); the fix
    // reads runtimeHome. HARNESS_CONFIG must be unset so it can't override both.
    process.env.HARNESS_HOME = envHome;
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.HARNESS_CONFIG;
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    __test_resetProjectIdCache();
  });

  afterEach(async () => {
    await runtime.dispose();
    if (priorEnvHome === undefined) {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.HARNESS_HOME;
    } else {
      process.env.HARNESS_HOME = priorEnvHome;
    }
    if (priorConfig !== undefined) process.env.HARNESS_CONFIG = priorConfig;
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(runtimeHome, { recursive: true, force: true });
    rmSync(envHome, { recursive: true, force: true });
  });

  test('refreshRuntimeFromConfig reads the runtime harnessHome config, not HARNESS_HOME', async () => {
    // The runtime's OWN home carries a distinctive proactive threshold; the
    // HARNESS_HOME-pointed home does not (→ would default to 0.75).
    writeFileSync(
      join(runtimeHome, 'config.json'),
      JSON.stringify({ compaction: { proactiveThresholdPct: 42 } }),
      'utf8',
    );
    runtime = await buildRuntime({
      cwd: runtimeHome,
      harnessHome: runtimeHome,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
    });
    // Boot already reads runtimeHome (buildRuntime threads harnessHome), so the
    // value is in place. Mutate it on disk, then refresh.
    writeFileSync(
      join(runtimeHome, 'config.json'),
      JSON.stringify({ compaction: { proactiveThresholdPct: 33 } }),
      'utf8',
    );
    const sessionCtx = runtime.getSessionContext('refresh-stub');
    const { ctx } = buildServerCommandContext(runtime, sessionCtx, 'refresh-stub');
    ctx.refreshRuntimeFromConfig?.();
    // 0.33 proves the refresh read runtimeHome (the fix). The bug would read
    // HARNESS_HOME (empty) → 0.75.
    expect(runtime.proactiveCompactThreshold).toBeCloseTo(0.33, 5);
  });
});

describe('reload engine — rebuildRecall re-reads recall config (M4)', () => {
  let tmpHome: string;
  let priorConfig: string | undefined;
  let runtime: Runtime;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-reload-recall-'));
    priorConfig = process.env.HARNESS_CONFIG;
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.HARNESS_CONFIG;
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    __test_resetProjectIdCache();
  });

  afterEach(async () => {
    await runtime.dispose();
    if (priorConfig !== undefined) process.env.HARNESS_CONFIG = priorConfig;
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  async function build(): Promise<Runtime> {
    return buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
    });
  }

  test('flipping learning.recall.enabled false → rebuildRecall clears the thunk', async () => {
    // ON by default (founder-reserved): a fresh SessionContext has a recall thunk.
    runtime = await build();
    const sessionCtx = runtime.getSessionContext('recall-stub');
    expect(typeof sessionCtx.recall).toBe('function');

    // Persist an explicit opt-out, then rebuild this session's recall in place.
    writeFileSync(
      join(tmpHome, 'config.json'),
      JSON.stringify({ learning: { recall: { enabled: false } } }),
      'utf8',
    );
    const { ctx } = buildServerCommandContext(runtime, sessionCtx, 'recall-stub');
    await ctx.rebuildRecall?.();
    expect(sessionCtx.recall).toBeUndefined();
  });

  test('flipping learning.recall.enabled back true → rebuildRecall restores the thunk', async () => {
    writeFileSync(
      join(tmpHome, 'config.json'),
      JSON.stringify({ learning: { recall: { enabled: false } } }),
      'utf8',
    );
    runtime = await build();
    const sessionCtx = runtime.getSessionContext('recall-stub-2');
    // Disabled at boot → no thunk.
    expect(sessionCtx.recall).toBeUndefined();

    writeFileSync(
      join(tmpHome, 'config.json'),
      JSON.stringify({ learning: { recall: { enabled: true } } }),
      'utf8',
    );
    const { ctx } = buildServerCommandContext(runtime, sessionCtx, 'recall-stub-2');
    await ctx.rebuildRecall?.();
    expect(typeof sessionCtx.recall).toBe('function');
  });
});

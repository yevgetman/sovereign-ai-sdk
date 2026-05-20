// Phase 16.1 M8 T1 — server-side router construction (closes backlog #30).
//
// When the user configures provider: 'router' (either via opts.provider or
// userSettings.defaultProvider), buildRuntime must construct a
// RouterProvider wrapping the configured local + frontier providers. The
// existing resolveProvider() does NOT handle the 'router' string — it's
// for single-provider resolution. The router wraps two providers, so the
// runtime has to construct it explicitly.
//
// The subagent scheduler defaults must also specialize: the literal
// 'router' provider name doesn't resolve in the child, so we fall back to
// the frontier lane. Closes backlog #30.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../src/server/runtime.js';

describe('buildRuntime — router server-side construction (M8 T1)', () => {
  let tmpHome: string;
  let tmpCwd: string;
  const prevHarnessHome = process.env.HARNESS_HOME;
  const prevHarnessConfig = process.env.HARNESS_CONFIG;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m8-t1-'));
    tmpCwd = mkdtempSync(join(tmpdir(), 'sov-m8-t1-cwd-'));
    process.env.HARNESS_HOME = tmpHome;
    process.env.HARNESS_CONFIG = join(tmpHome, 'config.json');
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
    if (prevHarnessHome === undefined) {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.HARNESS_HOME;
    } else {
      process.env.HARNESS_HOME = prevHarnessHome;
    }
    if (prevHarnessConfig === undefined) {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.HARNESS_CONFIG;
    } else {
      process.env.HARNESS_CONFIG = prevHarnessConfig;
    }
  });

  test('provider:router with valid router settings constructs RouterProvider', async () => {
    writeFileSync(
      join(tmpHome, 'config.json'),
      JSON.stringify({
        router: {
          localProvider: 'mock',
          frontierProvider: 'mock',
          defaultLane: 'local',
        },
      }),
    );

    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'router',
      preflight: false,
    });

    expect(runtime.resolvedProvider.transport.name).toBe('router');
    expect(runtime.resolvedProvider.metadata.provider).toBe('router');
    expect((runtime.resolvedProvider.metadata as { localProvider?: string }).localProvider).toBe(
      'mock',
    );
    expect(
      (runtime.resolvedProvider.metadata as { frontierProvider?: string }).frontierProvider,
    ).toBe('mock');

    await runtime.dispose();
  });

  test('subagentDefaultProvider/Model specializes to frontier lane (closes backlog #30)', async () => {
    writeFileSync(
      join(tmpHome, 'config.json'),
      JSON.stringify({
        router: {
          localProvider: 'mock',
          localModel: 'mock-local',
          frontierProvider: 'mock',
          frontierModel: 'mock-frontier',
          defaultLane: 'local',
        },
      }),
    );

    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'router',
      preflight: false,
    });

    // The subagent scheduler stores its defaults inside a private `opts`
    // field — reach in via a cast so the test can assert the M8 T1 invariant
    // without changing the scheduler's public surface. If the scheduler
    // ever exposes defaults publicly, this cast simplifies.
    const scheduler = runtime.subagentScheduler as unknown as {
      opts: { defaultProvider: string; defaultModel: string };
    };
    expect(scheduler.opts.defaultProvider).toBe('mock');
    expect(scheduler.opts.defaultModel).toBe('mock-frontier');

    await runtime.dispose();
  });
});

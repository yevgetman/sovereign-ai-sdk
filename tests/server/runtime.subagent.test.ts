// Phase 16.1 M5 T6 — buildRuntime constructs SubagentScheduler +
// LaneSemaphores + write-path Semaphore(1) and exposes them on Runtime.
// T7 wires TaskManager on top; T8 plumbs the trio into toolContext at
// query() time.
//
// M5.1 (backlog items 25/26/27) — extended with assertions that the
// router/provider settings cascade is threaded through from userSettings.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedProvider } from '../../src/providers/resolver.js';
import {
  buildRuntime,
  resolveLaneSemaphoresOpts,
  resolveSubagentArtifactsRoot,
  resolveSubagentAvailableProviders,
} from '../../src/server/runtime.js';

describe('runtime — sub-agent scheduler construction', () => {
  let tmpHome: string;
  let tmpCwd: string;
  const originalHarnessHome = process.env.HARNESS_HOME;
  const originalHarnessConfig = process.env.HARNESS_CONFIG;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'm5-sched-'));
    tmpCwd = mkdtempSync(join(tmpdir(), 'm5-sched-cwd-'));
    // Point readConfig() at the test's tmp config file so per-test
    // settings stay isolated from the user's real ~/.harness/config.json.
    process.env.HARNESS_HOME = tmpHome;
    process.env.HARNESS_CONFIG = join(tmpHome, 'config.json');
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
    // Restore env so other test files don't see lingering overrides.
    if (originalHarnessHome === undefined) {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.HARNESS_HOME;
    } else {
      process.env.HARNESS_HOME = originalHarnessHome;
    }
    if (originalHarnessConfig === undefined) {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.HARNESS_CONFIG;
    } else {
      process.env.HARNESS_CONFIG = originalHarnessConfig;
    }
  });

  test('Runtime exposes subagentScheduler, laneSemaphores, writeLock', async () => {
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      preflight: false,
    });

    expect(runtime.subagentScheduler).toBeDefined();
    expect(runtime.laneSemaphores).toBeDefined();
    expect(runtime.writeLock).toBeDefined();
    expect(typeof runtime.subagentScheduler.delegate).toBe('function');

    await runtime.dispose();
  });

  test('Runtime exposes taskManager wired to sessionDb', async () => {
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      preflight: false,
    });

    expect(runtime.taskManager).toBeDefined();
    expect(typeof runtime.taskManager.create).toBe('function');
    // No tasks have been created — listByParent over any parent id must
    // return an empty array. TaskManager.list returns synchronously; the
    // await is a no-op for forward-compatibility with the future
    // signature change.
    const tasks = await runtime.taskManager.list('any-parent-session-id');
    expect(tasks).toEqual([]);

    await runtime.dispose();
  });
});

describe('runtime — M5.1 settings cascade helpers (backlog 25/26/27)', () => {
  // ----- backlog #25: resolveSubagentAvailableProviders -----

  test('resolveSubagentAvailableProviders returns [providerName] for single-provider mode', () => {
    const resolved = {
      metadata: { provider: 'anthropic' },
    } as unknown as ResolvedProvider;
    expect(resolveSubagentAvailableProviders(resolved)).toEqual(['anthropic']);
  });

  test('resolveSubagentAvailableProviders returns both lanes in router mode', () => {
    // Router metadata mirrors what `buildRouterResolvedProvider`
    // synthesizes — provider == 'router' with
    // localProvider/frontierProvider attached to metadata. Kept in the
    // server helper so server-mode router support is automatic.
    const resolved = {
      metadata: {
        provider: 'router',
        localProvider: 'ollama',
        frontierProvider: 'anthropic',
      },
    } as unknown as ResolvedProvider;
    expect(resolveSubagentAvailableProviders(resolved)).toEqual(['ollama', 'anthropic']);
  });

  test('resolveSubagentAvailableProviders falls back to [providerName] when router metadata incomplete', () => {
    // Defensive: if metadata.provider says 'router' but one of the lane
    // fields is missing, we should not return a partial list.
    const resolved = {
      metadata: { provider: 'router', localProvider: 'ollama' },
    } as unknown as ResolvedProvider;
    expect(resolveSubagentAvailableProviders(resolved)).toEqual(['router']);
  });

  // ----- backlog #26: resolveSubagentArtifactsRoot -----

  test('resolveSubagentArtifactsRoot returns harnessHome when no bundle', () => {
    expect(resolveSubagentArtifactsRoot('/tmp/home', null)).toBe('/tmp/home');
  });

  test('resolveSubagentArtifactsRoot returns <bundle>/state/artifacts for client bundle', () => {
    // A non-default bundle path — anything outside the default bundle's
    // expected locations qualifies. We use a deterministic path that's
    // not the default-bundle path.
    const bundle = { root: '/clients/acme/bundle' } as unknown as Parameters<
      typeof resolveSubagentArtifactsRoot
    >[1];
    expect(resolveSubagentArtifactsRoot('/tmp/home', bundle)).toBe(
      join('/clients/acme/bundle', 'state', 'artifacts'),
    );
  });

  // ----- backlog #27: resolveLaneSemaphoresOpts -----

  test('resolveLaneSemaphoresOpts returns empty when no router settings', () => {
    expect(resolveLaneSemaphoresOpts({})).toEqual({});
  });

  test('resolveLaneSemaphoresOpts threads only configured lane caps', () => {
    expect(
      resolveLaneSemaphoresOpts({
        router: {
          localProvider: 'ollama',
          frontierProvider: 'anthropic',
          maxConcurrentLocal: 2,
        },
      }),
    ).toEqual({ local: 2 });
    expect(
      resolveLaneSemaphoresOpts({
        router: {
          localProvider: 'ollama',
          frontierProvider: 'anthropic',
          maxConcurrentFrontier: 3,
        },
      }),
    ).toEqual({ frontier: 3 });
    expect(
      resolveLaneSemaphoresOpts({
        router: {
          localProvider: 'ollama',
          frontierProvider: 'anthropic',
          maxConcurrentLocal: 2,
          maxConcurrentFrontier: 3,
        },
      }),
    ).toEqual({ local: 2, frontier: 3 });
  });
});

describe('runtime — M5.1 wiring lands at buildRuntime call site', () => {
  let tmpHome: string;
  let tmpCwd: string;
  const originalHarnessHome = process.env.HARNESS_HOME;
  const originalHarnessConfig = process.env.HARNESS_CONFIG;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'm5-1-wire-'));
    tmpCwd = mkdtempSync(join(tmpdir(), 'm5-1-wire-cwd-'));
    process.env.HARNESS_HOME = tmpHome;
    process.env.HARNESS_CONFIG = join(tmpHome, 'config.json');
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
    if (originalHarnessHome === undefined) {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.HARNESS_HOME;
    } else {
      process.env.HARNESS_HOME = originalHarnessHome;
    }
    if (originalHarnessConfig === undefined) {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.HARNESS_CONFIG;
    } else {
      process.env.HARNESS_CONFIG = originalHarnessConfig;
    }
  });

  test('SubagentScheduler receives availableProviders matching resolved provider', async () => {
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      preflight: false,
    });

    // SubagentScheduler stores its opts as `private readonly opts`. Cast
    // through unknown to introspect — we just need to confirm the helper
    // value reached the constructor. The pure-helper tests above pin the
    // value semantics; this test pins the wiring.
    const opts = (
      runtime.subagentScheduler as unknown as {
        opts: { availableProviders?: readonly string[] };
      }
    ).opts;
    expect(opts.availableProviders).toEqual(['mock']);

    await runtime.dispose();
  });

  test('SubagentScheduler receives artifactsRoot pointing at harnessHome', async () => {
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      preflight: false,
    });

    // No client bundle loaded in this test — the resolver should return
    // harnessHome verbatim.
    const opts = (
      runtime.subagentScheduler as unknown as {
        opts: { artifactsRoot?: string };
      }
    ).opts;
    expect(opts.artifactsRoot).toBe(tmpHome);

    await runtime.dispose();
  });

  test('LaneSemaphores cap blocks acquire when local cap exhausted', async () => {
    // Write a config with maxConcurrentLocal: 1 to the test's tmp home.
    // readConfig() picks it up via HARNESS_CONFIG (set in beforeEach).
    writeFileSync(
      join(tmpHome, 'config.json'),
      JSON.stringify({
        router: {
          localProvider: 'ollama',
          frontierProvider: 'anthropic',
          maxConcurrentLocal: 1,
        },
      }),
      'utf8',
    );

    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      preflight: false,
    });

    // Acquire the only local slot — should resolve immediately.
    const release = await runtime.laneSemaphores.acquire('local');

    // A second acquire on the local lane must NOT resolve while the
    // first is held. We race against a short timeout to confirm it
    // suspends; an unbounded semaphore (the pre-M5.1 default) would
    // resolve immediately and fail this assertion.
    const secondAcquire = runtime.laneSemaphores.acquire('local');
    const racer = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), 50);
    });
    const winner = await Promise.race([secondAcquire.then(() => 'acquired' as const), racer]);
    expect(winner).toBe('timeout');

    // Release the first slot — the queued waiter now resolves and we
    // can clean it up so the test doesn't dangle.
    release();
    const secondRelease = await secondAcquire;
    secondRelease();

    await runtime.dispose();
  });

  test('LaneSemaphores frontier lane stays unbounded when frontier cap unset', async () => {
    // Sanity: configuring local-only must not block frontier acquires.
    writeFileSync(
      join(tmpHome, 'config.json'),
      JSON.stringify({
        router: {
          localProvider: 'ollama',
          frontierProvider: 'anthropic',
          maxConcurrentLocal: 1,
        },
      }),
      'utf8',
    );

    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      preflight: false,
    });

    // Multiple frontier acquires must all resolve immediately when the
    // frontier cap is undefined (per LaneSemaphores.acquire fast path).
    const a = await runtime.laneSemaphores.acquire('frontier');
    const b = await runtime.laneSemaphores.acquire('frontier');
    const c = await runtime.laneSemaphores.acquire('frontier');
    a();
    b();
    c();

    await runtime.dispose();
  });
});

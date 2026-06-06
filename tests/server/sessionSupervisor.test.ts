// Phase D T2 — SessionSupervisor: idle-session sweep + live-session count.
//
// Exercises the gateway-scoped supervisor that periodically reclaims idle
// in-memory session state. Buses are minted via getOrCreateBus(id, undefined,
// injectedNow) so the test owns each bus's clock (getLastActivityAt()); the
// supervisor gets its own injected `now` so the TTL comparison is deterministic.
// Bus state is reset per test via __test_resetAllBuses().

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ServerEventBus,
  __test_resetAllBuses,
  getOrCreateBus,
  liveBusSessionIds,
  peekBus,
} from '../../src/server/eventBus.js';
import { buildRuntime } from '../../src/server/runtime.js';
import type { Runtime } from '../../src/server/runtime.js';
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_SWEEP_INTERVAL_MS,
  SessionSupervisor,
} from '../../src/server/sessionSupervisor.js';

const TTL_MS = 1_000;

async function buildMockRuntime(home: string): Promise<Runtime> {
  return buildRuntime({
    cwd: home,
    harnessHome: home,
    provider: 'mock',
    model: 'mock-haiku',
    cronEnabled: false,
    preflight: false,
  });
}

describe('SessionSupervisor (Phase D T2)', () => {
  let home: string;
  let runtime: Runtime;
  // A controllable clock shared by buses + the supervisor.
  let clock: number;
  const now = (): number => clock;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'sov-supervisor-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    __test_resetAllBuses();
    clock = 1_000_000;
    runtime = await buildMockRuntime(home);
  });

  afterEach(async () => {
    await runtime.dispose();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(home, { recursive: true, force: true });
    __test_resetAllBuses();
  });

  function makeSupervisor(overrides?: {
    enabled?: boolean;
    idleSessionTimeoutMs?: number;
    idleSweepIntervalMs?: number;
  }): SessionSupervisor {
    return new SessionSupervisor({
      runtime,
      now,
      idleSessionTimeoutMs: overrides?.idleSessionTimeoutMs ?? TTL_MS,
      ...(overrides?.idleSweepIntervalMs !== undefined
        ? { idleSweepIntervalMs: overrides.idleSweepIntervalMs }
        : {}),
      ...(overrides?.enabled !== undefined ? { enabled: overrides.enabled } : {}),
    });
  }

  test('evicts an idle session (no bus arg to disposeSession)', async () => {
    // Create a bus at clock=1_000_000; it is not turn-active + has 0 subscribers.
    getOrCreateBus('idle-1', undefined, now);
    // Advance the supervisor clock well past the TTL.
    clock += TTL_MS + 1;

    // Wrap disposeSession to capture its args (assert NO bus arg passed).
    const calls: Array<{ id: string; opts: { bus?: ServerEventBus } | undefined }> = [];
    const realDispose = runtime.disposeSession.bind(runtime);
    runtime.disposeSession = async (id: string, opts?: { bus?: ServerEventBus }): Promise<void> => {
      calls.push({ id, opts });
      return realDispose(id, opts);
    };

    const supervisor = makeSupervisor();
    const result = await supervisor.sweep();

    expect(result).toEqual({ evicted: ['idle-1'], skipped: 0 });
    expect(peekBus('idle-1')).toBeUndefined();
    // disposeSession called with the id and NO bus arg.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe('idle-1');
    expect(calls[0]?.opts?.bus).toBeUndefined();
  });

  test('skips a turn-active session', async () => {
    const bus = getOrCreateBus('busy-1', undefined, now);
    bus.markTurnStart(); // no terminal published → turn stays active
    clock += TTL_MS + 1;

    const supervisor = makeSupervisor();
    const result = await supervisor.sweep();

    expect(result.evicted).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(liveBusSessionIds()).toContain('busy-1');
  });

  test('skips a subscribed session', async () => {
    const bus = getOrCreateBus('watched-1', undefined, now);
    bus.subscribe(() => {});
    clock += TTL_MS + 1;

    const supervisor = makeSupervisor();
    const result = await supervisor.sweep();

    expect(result.evicted).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(liveBusSessionIds()).toContain('watched-1');
  });

  test('skips a too-recent session (within TTL)', async () => {
    getOrCreateBus('recent-1', undefined, now);
    // Advance to exactly the TTL boundary — the rule is strict `>` so equal is skipped.
    clock += TTL_MS;

    const supervisor = makeSupervisor();
    const result = await supervisor.sweep();

    expect(result.evicted).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(liveBusSessionIds()).toContain('recent-1');
  });

  test('liveSessionCount() is the union of live buses + sessionContexts', () => {
    getOrCreateBus('bus-only-1', undefined, now);
    getOrCreateBus('shared-1', undefined, now);
    // Seed a context-only id (no bus) to prove the union.
    runtime.getSessionContext('ctx-only-1');
    // And give the shared id a context too so the union de-dupes correctly.
    runtime.getSessionContext('shared-1');

    const supervisor = makeSupervisor();
    const expected = new Set([...liveBusSessionIds(), ...runtime.sessionContexts.keys()]).size;

    expect(supervisor.liveSessionCount()).toBe(expected);
    // Explicit membership: bus-only, ctx-only, shared all counted exactly once.
    expect(expected).toBeGreaterThanOrEqual(3);
  });

  test("start() registers an unref'd timer; firing it sweeps; stop() clears it", async () => {
    // Spy setInterval to capture the scheduled fn + the configured interval,
    // and confirm the returned timer is unref'd.
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    let capturedFn: (() => void) | undefined;
    let capturedMs: number | undefined;
    let unrefCalled = false;
    let cleared = false;
    const fakeTimer = {
      unref(): typeof fakeTimer {
        unrefCalled = true;
        return fakeTimer;
      },
    } as unknown as ReturnType<typeof setInterval>;
    // biome-ignore lint/suspicious/noExplicitAny: test seam to capture scheduling.
    (globalThis as any).setInterval = (
      fn: () => void,
      ms: number,
    ): ReturnType<typeof setInterval> => {
      capturedFn = fn;
      capturedMs = ms;
      return fakeTimer;
    };
    // biome-ignore lint/suspicious/noExplicitAny: test seam to observe clear.
    (globalThis as any).clearInterval = (t: unknown): void => {
      if (t === fakeTimer) cleared = true;
    };

    try {
      // An idle bus that the swept fn should evict.
      getOrCreateBus('timer-idle-1', undefined, now);
      clock += TTL_MS + 1;

      const supervisor = makeSupervisor({ idleSweepIntervalMs: 12_345 });
      supervisor.start();

      expect(capturedMs).toBe(12_345);
      expect(unrefCalled).toBe(true);
      expect(capturedFn).toBeDefined();

      // Fire the captured tick fn → it triggers a sweep. The sweep is async
      // (fire-and-forget inside the interval), so wait a microtask turn.
      capturedFn?.();
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(peekBus('timer-idle-1')).toBeUndefined();

      // Double-start guard: a second start() must not schedule again.
      capturedMs = undefined;
      supervisor.start();
      expect(capturedMs).toBeUndefined();

      supervisor.stop();
      expect(cleared).toBe(true);
    } finally {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    }
  });

  test('start() is a no-op when enabled: false', () => {
    const realSetInterval = globalThis.setInterval;
    let scheduled = false;
    // biome-ignore lint/suspicious/noExplicitAny: test seam.
    (globalThis as any).setInterval = (..._args: unknown[]): ReturnType<typeof setInterval> => {
      scheduled = true;
      return 0 as unknown as ReturnType<typeof setInterval>;
    };
    try {
      const supervisor = makeSupervisor({ enabled: false });
      supervisor.start();
      expect(scheduled).toBe(false);
    } finally {
      globalThis.setInterval = realSetInterval;
    }
  });

  test('a failing eviction does not abort the whole sweep', async () => {
    getOrCreateBus('fails-1', undefined, now);
    getOrCreateBus('ok-1', undefined, now);
    clock += TTL_MS + 1;

    // Make disposeSession reject for one id, succeed for the other.
    const realDispose = runtime.disposeSession.bind(runtime);
    runtime.disposeSession = async (id: string, opts?: { bus?: ServerEventBus }): Promise<void> => {
      if (id === 'fails-1') {
        throw new Error('boom');
      }
      return realDispose(id, opts);
    };

    const supervisor = makeSupervisor();
    // Must NOT throw.
    const result = await supervisor.sweep();

    // The good one was evicted; the failing one is counted as skipped, not thrown.
    expect(result.evicted).toContain('ok-1');
    expect(result.evicted).not.toContain('fails-1');
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(peekBus('ok-1')).toBeUndefined();
  });

  test('stats() reports live / turnActive / subscribed counts', () => {
    const a = getOrCreateBus('s-active', undefined, now);
    a.markTurnStart();
    const b = getOrCreateBus('s-watched', undefined, now);
    b.subscribe(() => {});
    getOrCreateBus('s-idle', undefined, now);

    const supervisor = makeSupervisor();
    const stats = supervisor.stats();

    expect(stats.turnActive).toBe(1);
    expect(stats.subscribed).toBe(1);
    expect(stats.live).toBe(supervisor.liveSessionCount());
  });

  test('exports sane defaults', () => {
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBe(1_800_000);
    expect(DEFAULT_SWEEP_INTERVAL_MS).toBe(300_000);
  });
});

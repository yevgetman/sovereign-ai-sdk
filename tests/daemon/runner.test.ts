import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon } from '../../src/daemon/runner.js';

describe('startDaemon', () => {
  const toClean: string[] = [];
  afterEach(() => {
    for (const d of toClean) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    }
    toClean.length = 0;
  });
  function tmpHome(): string {
    const d = mkdtempSync(join(tmpdir(), 'sov-runner-'));
    toClean.push(d);
    return d;
  }

  test('returns handle with bus, sessionCache, approvalQueue', () => {
    const home = tmpHome();
    const handle = startDaemon({ harnessHome: home });
    expect(handle.bus).toBeDefined();
    expect(handle.sessionCache).toBeDefined();
    expect(handle.approvalQueue).toBeDefined();
    handle.shutdown();
  });

  test('throws with "daemon already running" when lock is held', () => {
    const home = tmpHome();
    const h1 = startDaemon({ harnessHome: home });
    try {
      expect(() => startDaemon({ harnessHome: home })).toThrow('daemon already running');
    } finally {
      h1.shutdown();
    }
  });

  test('can start again after shutdown releases the lock', () => {
    const home = tmpHome();
    const h1 = startDaemon({ harnessHome: home });
    h1.shutdown();
    const h2 = startDaemon({ harnessHome: home });
    h2.shutdown();
    // No throw = lock was released and re-acquired successfully.
  });

  test('shutdown emits daemon_stopping on the bus', () => {
    const home = tmpHome();
    const handle = startDaemon({ harnessHome: home });
    const reasons: string[] = [];
    handle.bus.on('daemon_stopping', (e) => reasons.push(e.reason));
    handle.shutdown();
    expect(reasons).toEqual(['explicit']);
  });
});

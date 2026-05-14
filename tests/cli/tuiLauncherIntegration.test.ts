// End-to-end smoke for runTuiLauncher: real buildRuntime (mock provider)
// + real in-process Hono server + mocked spawn. Asserts the server
// is reachable on the spawned --port while the launcher is parked on
// the child's exit promise. Separate file so the module mocks used by
// the flag-forwarding tests in tuiLauncher.test.ts don't leak.
//
// Why we re-install real modules: bun's mock.module() persists across
// files within the same `bun test` run. The flag-forwarding tests
// in tuiLauncher.test.ts mock `../../src/server/runtime.js` and
// `../../src/server/index.js` with fake implementations; their afterAll
// re-mocks back to the captured real modules, but at least in bun
// 1.3.13 that restoration does not always invalidate the cache for the
// next file. We re-pin our own mock-to-real here (before importing the
// launcher) so the test deterministically gets the real buildRuntime
// + startServer regardless of file ordering.

import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';

describe('runTuiLauncher — end-to-end smoke', () => {
  let prevSovTuiBin: string | undefined;
  let realRuntimeModule: typeof import('../../src/server/runtime.js');
  let realServerModule: typeof import('../../src/server/index.js');
  let realChildProcessModule: typeof import('node:child_process');

  beforeAll(async () => {
    // Capture fresh real-module refs. The file-level afterAll in
    // tuiLauncher.test.ts spread-copies + restores its mocks, so by the
    // time this beforeAll runs the modules are back to real.
    realRuntimeModule = await import('../../src/server/runtime.js');
    realServerModule = await import('../../src/server/index.js');
    realChildProcessModule = await import('node:child_process');
  });

  beforeEach(() => {
    prevSovTuiBin = process.env.SOV_TUI_BIN;
    process.env.SOV_TUI_BIN = '/bin/true';
    // Defensive re-pin: previous test files in the same `bun test` run
    // may have mocked these. mock.module() invalidates the cache, so
    // re-mocking back to the real module forces fresh imports.
    mock.module('../../src/server/runtime.js', () => realRuntimeModule);
    mock.module('../../src/server/index.js', () => realServerModule);
  });

  afterEach(() => {
    if (prevSovTuiBin === undefined) {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.SOV_TUI_BIN;
    } else {
      process.env.SOV_TUI_BIN = prevSovTuiBin;
    }
    // Restore child_process mock so we don't leak to the next file.
    mock.module('node:child_process', () => realChildProcessModule);
    mock.restore();
  });

  test('builds real runtime + server, spawns child with --port and --session-id, server reachable', async () => {
    let spawnedArgs: string[] | null = null;
    let serverPort: number | null = null;

    // Spread the real module first so unrelated imports (execFileSync,
    // spawnSync, etc.) still resolve — buildRuntime pulls these in
    // through context/system.ts + context/references.ts. Override
    // only `spawn`.
    mock.module('node:child_process', () => ({
      ...realChildProcessModule,
      spawn: (_bin: string, args: string[]) => {
        spawnedArgs = args;
        const portIdx = args.indexOf('--port');
        if (portIdx !== -1) {
          const raw = args[portIdx + 1];
          if (raw !== undefined) serverPort = Number(raw);
        }
        const child = new EventEmitter();
        // Defer the exit so we have time to fetch from the live server
        // before runTuiLauncher tears it down.
        setTimeout(() => child.emit('exit', 0), 100);
        return child;
      },
    }));

    const { runTuiLauncher } = await import('../../src/cli/tuiLauncher.js');

    // Fire runTuiLauncher in the background; concurrently fetch the
    // server's /messages route to prove it's bound + responding.
    const launchPromise = runTuiLauncher({ provider: 'mock' });

    // Poll for the spawned-args capture (signals the server is up).
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const t = setInterval(() => {
        if (serverPort !== null && spawnedArgs !== null) {
          clearInterval(t);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(t);
          reject(new Error('server never bound within 5s'));
        }
      }, 10);
    });

    const args = spawnedArgs as unknown as string[];
    const sessionIdIdx = args.indexOf('--session-id');
    const sessionId = args[sessionIdIdx + 1];
    expect(typeof sessionId).toBe('string');

    const res = await fetch(`http://127.0.0.1:${serverPort}/sessions/${sessionId}/messages`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: unknown[] };
    expect(body.messages).toEqual([]);

    const code = await launchPromise;
    expect(code).toBe(0);
    expect(args).toContain('--port');
    expect(args).toContain('--session-id');
  });
});

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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '../../src/providers/mock.js';
import { type ServerEvent, parseServerEvent } from '../../src/server/schema.js';

// Empirically: server bind on loopback takes <10ms on a typical macOS
// dev machine, and the test's fetch round-trip is <50ms. 100ms gives
// the poll loop + fetch ample headroom before the spawn-mock emits
// the synthetic 'exit' event.
const MOCK_CHILD_EXIT_DELAY_MS = 100;

// M5 scenarios that drive a full turn + SSE round-trip need a longer
// keep-alive than the bare-server-up smoke. We park the child for 5s
// (well over a mock-turn's wall-clock cost) so the test can POST a turn,
// drain SSE to turn_complete, optionally POST an approval, and assert
// without racing the launcher's settle/dispose path.
const MOCK_CHILD_M5_TURN_DELAY_MS = 5000;

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
    // TODO(bun>1.3.13): if mock.module() cross-file leakage is fixed
    // upstream, this defensive re-pin becomes safe to remove. The file-
    // scope cleanup in tests/cli/tuiLauncher.test.ts should also be re-
    // evaluated at the same time.
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

  // TODO: this test relies on runTuiLauncher's own settle/dispose path to
  // stop the in-process server. If the poll loop times out or the launch
  // promise hangs, an orphaned server could remain bound on the chosen
  // port for the rest of the test process's lifetime. The 100ms exit
  // timer + 5s poll deadline make this unlikely in practice, but a
  // dedicated harness helper that exposes server lifecycle to the test
  // would be cleaner — defer to a future test infra refactor.
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
        setTimeout(() => child.emit('exit', 0), MOCK_CHILD_EXIT_DELAY_MS);
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

    // biome-ignore lint/style/noNonNullAssertion: poll loop guarantees non-null before reaching here
    const args = spawnedArgs!;
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

// Phase 16.1 M5 T10 — integration smoke for the three user-noticed
// subsystems (hooks, permission modal, sub-agent scheduler). Each test
// boots `runTuiLauncher` with a real `buildRuntime` (mock provider) +
// real Hono server on a free port, then drives a turn end-to-end over
// HTTP. The mocked spawn keeps the child parked for ~5 s so the test
// can POST + drain SSE before the launcher settles.
//
// Why a fresh describe block (rather than extending the existing
// 'end-to-end smoke' suite): the M5 scenarios isolate `HARNESS_HOME` +
// `cwd` to per-test tmp dirs (writing settings.json / allowlist files
// + cleaning up after) — the bare-server-up smoke doesn't need that.
// Keeping the suites separate keeps each set's fixtures small and the
// failure modes legible.

type SseEvent = { event: string; data: ServerEvent | null };

function parseSseBlock(block: string): SseEvent | null {
  let eventName: string | null = null;
  let dataLine: string | null = null;
  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) {
      eventName = line.slice('event: '.length);
    } else if (line.startsWith('data: ')) {
      dataLine = line.slice('data: '.length);
    }
  }
  if (eventName === null) return null;
  const parsed = dataLine !== null ? parseServerEvent(dataLine) : null;
  return { event: eventName, data: parsed };
}

/** Stream SSE events from a live HTTP server (vs `app.request` which is
 *  in-process). Pumps the body in a background async loop so the caller
 *  can POST approvals concurrently; resolves `done` when `stopWhen`
 *  matches or the stream ends. Mirrors the helper in
 *  tests/server/turns.permission.test.ts; not shared because the in-
 *  process variant uses `app.request(...)` and the launcher variant uses
 *  real `fetch(...)`. */
type SseHandle = {
  events: SseEvent[];
  done: Promise<void>;
  onEvent: (cb: (ev: SseEvent) => void) => void;
};

function openLiveSse(url: string, stopWhen: (ev: SseEvent) => boolean): SseHandle {
  const events: SseEvent[] = [];
  const listeners: Array<(ev: SseEvent) => void> = [];
  const done = (async (): Promise<void> => {
    const res = await fetch(url);
    if (res.status !== 200) {
      throw new Error(`SSE GET failed: ${res.status}`);
    }
    if (res.body === null) {
      throw new Error('SSE response has no body');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        let blockEnd = buffer.indexOf('\n\n');
        let stopHit = false;
        while (blockEnd !== -1) {
          const block = buffer.slice(0, blockEnd);
          buffer = buffer.slice(blockEnd + 2);
          const parsed = parseSseBlock(block);
          if (parsed !== null) {
            events.push(parsed);
            for (const fn of listeners) fn(parsed);
            if (stopWhen(parsed)) {
              stopHit = true;
              break;
            }
          }
          blockEnd = buffer.indexOf('\n\n');
        }
        if (stopHit) break;
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore: releaseLock can throw if the reader is already closed
      }
    }
  })();
  return {
    events,
    done,
    onEvent: (cb): void => {
      listeners.push(cb);
    },
  };
}

describe('tuiLauncher integration smoke — M5 subsystems', () => {
  let prevSovTuiBin: string | undefined;
  let prevHarnessHome: string | undefined;
  let prevCwd: string;
  let prevMockEnv: string | undefined;
  let tmpHome: string;
  let tmpCwd: string;
  let realRuntimeModule: typeof import('../../src/server/runtime.js');
  let realServerModule: typeof import('../../src/server/index.js');
  let realChildProcessModule: typeof import('node:child_process');

  beforeAll(async () => {
    realRuntimeModule = await import('../../src/server/runtime.js');
    realServerModule = await import('../../src/server/index.js');
    realChildProcessModule = await import('node:child_process');
  });

  beforeEach(() => {
    prevSovTuiBin = process.env.SOV_TUI_BIN;
    prevHarnessHome = process.env.HARNESS_HOME;
    prevMockEnv = process.env.SOV_TEST_MOCK_PROVIDER;
    prevCwd = process.cwd();
    tmpHome = mkdtempSync(join(tmpdir(), 'm5-t10-home-'));
    tmpCwd = mkdtempSync(join(tmpdir(), 'm5-t10-cwd-'));
    process.env.SOV_TUI_BIN = '/bin/true';
    process.env.HARNESS_HOME = tmpHome;
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    // runTuiLauncher uses process.cwd() (no override option) — chdir so
    // the runtime's per-project settings.json lands at <tmpCwd>/.harness/.
    process.chdir(tmpCwd);
    // Defensive re-pin (matches the bare-server-up suite's rationale —
    // mock.module() leakage in bun 1.3.13).
    mock.module('../../src/server/runtime.js', () => realRuntimeModule);
    mock.module('../../src/server/index.js', () => realServerModule);
  });

  afterEach(() => {
    // Restore cwd before rmSync — Bun on macOS can fail to remove a dir
    // that's still the active cwd.
    process.chdir(prevCwd);
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
    if (prevSovTuiBin === undefined) {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.SOV_TUI_BIN;
    } else {
      process.env.SOV_TUI_BIN = prevSovTuiBin;
    }
    if (prevHarnessHome === undefined) {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.HARNESS_HOME;
    } else {
      process.env.HARNESS_HOME = prevHarnessHome;
    }
    if (prevMockEnv === undefined) {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.SOV_TEST_MOCK_PROVIDER;
    } else {
      process.env.SOV_TEST_MOCK_PROVIDER = prevMockEnv;
    }
    MockProvider.toolUseMode = false;
    mock.module('node:child_process', () => realChildProcessModule);
    mock.restore();
  });

  /** Spawn a fake child that stays alive for `delayMs` and captures
   *  the arg list. Returns refs the caller polls on. */
  function installSpawnMock(delayMs: number): {
    getSpawnedArgs: () => string[] | null;
    getServerPort: () => number | null;
  } {
    let spawnedArgs: string[] | null = null;
    let serverPort: number | null = null;
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
        setTimeout(() => child.emit('exit', 0), delayMs);
        return child;
      },
    }));
    return {
      getSpawnedArgs: () => spawnedArgs,
      getServerPort: () => serverPort,
    };
  }

  /** Poll until the spawn mock captures `--port` + args, signalling the
   *  in-process server is bound. Throws when the deadline elapses. */
  async function waitForServerBind(
    getSpawnedArgs: () => string[] | null,
    getServerPort: () => number | null,
  ): Promise<{ args: string[]; port: number; sessionId: string }> {
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const t = setInterval(() => {
        if (getServerPort() !== null && getSpawnedArgs() !== null) {
          clearInterval(t);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(t);
          reject(new Error('server never bound within 5s'));
        }
      }, 10);
    });
    // biome-ignore lint/style/noNonNullAssertion: poll loop above guarantees non-null.
    const args = getSpawnedArgs()!;
    // biome-ignore lint/style/noNonNullAssertion: poll loop above guarantees non-null.
    const port = getServerPort()!;
    const sessionIdIdx = args.indexOf('--session-id');
    const sessionId = args[sessionIdIdx + 1];
    if (typeof sessionId !== 'string') {
      throw new Error('--session-id arg missing from spawn args');
    }
    return { args, port, sessionId };
  }

  test('hooks fire end-to-end through runTuiLauncher', async () => {
    // Write a UserPromptSubmit hook that echoes "fired" into a trace
    // file. argvSplit is shell:false (no redirection / pipes through
    // the runner), so we wrap the redirection in a real shell script
    // and register its path as the hook command. Mirrors
    // tests/server/turns.hooks.test.ts.
    const traceFile = join(tmpCwd, 'trace.log');
    const hookScript = join(tmpCwd, 'fire.sh');
    writeFileSync(hookScript, `#!/usr/bin/env bash\necho fired > '${traceFile}'\n`, 'utf8');
    chmodSync(hookScript, 0o755);
    const hookCommand = hookScript;
    writeFileSync(
      join(tmpHome, 'settings.json'),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              matcher: '*',
              hooks: [{ type: 'command', command: hookCommand }],
            },
          ],
        },
      }),
    );
    // Pre-consent the command — server-mode is non-interactive (M5-01)
    // and denies by default without an entry. Schema lifted from
    // src/hooks/consent.ts.
    writeFileSync(
      join(tmpHome, 'shell-hooks-allowlist.json'),
      JSON.stringify({
        version: 1,
        decisions: {
          [`UserPromptSubmit:${hookCommand}`]: 'allow',
        },
      }),
    );

    const { getSpawnedArgs, getServerPort } = installSpawnMock(MOCK_CHILD_M5_TURN_DELAY_MS);
    const { runTuiLauncher } = await import('../../src/cli/tuiLauncher.js');
    const launchPromise = runTuiLauncher({ provider: 'mock' });
    const { port, sessionId } = await waitForServerBind(getSpawnedArgs, getServerPort);

    const turnRes = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(turnRes.status).toBe(202);

    const sse = openLiveSse(
      `http://127.0.0.1:${port}/sessions/${sessionId}/events`,
      (ev) => ev.event === 'turn_complete' || ev.event === 'turn_error',
    );
    await sse.done;

    // Hook fired as a side-effect of UserPromptSubmit during the turn.
    expect(existsSync(traceFile)).toBe(true);
    expect(readFileSync(traceFile, 'utf8')).toContain('fired');

    const code = await launchPromise;
    expect(code).toBe(0);
  }, 15_000);

  test('permission round-trip resolves through the launched server', async () => {
    // Drop a project-local `.harness/settings.json` with an ask rule on
    // the exact Bash command the mock provider issues. The settings
    // cascade includes the cwd-local file (see
    // src/config/getPermissionSettingsPaths). Without it Bash's self-
    // check returns `allow` (echo is on the read-only allowlist) and the
    // ask path never fires.
    mkdirSync(join(tmpCwd, '.harness'), { recursive: true });
    writeFileSync(
      join(tmpCwd, '.harness', 'settings.json'),
      JSON.stringify({
        permissions: {
          ask: ['Bash(echo hello-from-mock)'],
          allow: [],
          deny: [],
        },
      }),
      'utf8',
    );
    MockProvider.toolUseMode = true;

    const { getSpawnedArgs, getServerPort } = installSpawnMock(MOCK_CHILD_M5_TURN_DELAY_MS);
    const { runTuiLauncher } = await import('../../src/cli/tuiLauncher.js');
    const launchPromise = runTuiLauncher({ provider: 'mock', permissionMode: 'ask' });
    const { port, sessionId } = await waitForServerBind(getSpawnedArgs, getServerPort);

    const turnRes = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'echo hello' }),
    });
    expect(turnRes.status).toBe(202);

    let approvalSent = false;
    let approvalResponseStatus = 0;
    const sse = openLiveSse(
      `http://127.0.0.1:${port}/sessions/${sessionId}/events`,
      (ev) => ev.event === 'turn_complete' || ev.event === 'turn_error',
    );
    sse.onEvent((ev) => {
      if (approvalSent) return;
      if (ev.event !== 'permission_request') return;
      if (ev.data === null || ev.data.type !== 'permission_request') return;
      approvalSent = true;
      void fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/approvals/${ev.data.requestId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      }).then((res) => {
        approvalResponseStatus = res.status;
      });
    });
    await sse.done;

    expect(approvalSent).toBe(true);
    expect(approvalResponseStatus).toBe(200);

    const permReq = sse.events.find((e) => e.event === 'permission_request');
    expect(permReq).toBeDefined();
    const turnComplete = sse.events.find((e) => e.event === 'turn_complete');
    expect(turnComplete).toBeDefined();
    expect(sse.events.find((e) => e.event === 'turn_error')).toBeUndefined();

    // Ordering: permission_request must arrive before turn_complete.
    const permIdx = sse.events.findIndex((e) => e.event === 'permission_request');
    const completeIdx = sse.events.findIndex((e) => e.event === 'turn_complete');
    expect(permIdx).toBeGreaterThan(-1);
    expect(completeIdx).toBeGreaterThan(permIdx);

    // Tool actually dispatched post-approval — tool_result proves the
    // approval unblocked the gate, not just that the request fired.
    const toolResult = sse.events.find((e) => e.event === 'tool_result');
    expect(toolResult).toBeDefined();

    const code = await launchPromise;
    expect(code).toBe(0);
  }, 15_000);

  test('AgentTool / TaskManager wiring reachable through launched runtime', async () => {
    // Wiring assertion only — no sub-agent dispatch. The contract being
    // verified: buildRuntime constructs SubagentScheduler + LaneSemaphores
    // + writeLock + TaskManager (T6, T7) and the launcher boots without
    // throwing when those fields are present on Runtime. Proof: a fresh
    // turn completes end-to-end through the live server with M5 wiring
    // active. Direct field access happens in tests/server/runtime.subagent
    // .test.ts; that test owns the unit-level invariant.
    const { getSpawnedArgs, getServerPort } = installSpawnMock(MOCK_CHILD_M5_TURN_DELAY_MS);
    const { runTuiLauncher } = await import('../../src/cli/tuiLauncher.js');
    const launchPromise = runTuiLauncher({ provider: 'mock' });
    const { port, sessionId } = await waitForServerBind(getSpawnedArgs, getServerPort);

    const turnRes = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(turnRes.status).toBe(202);

    const sse = openLiveSse(
      `http://127.0.0.1:${port}/sessions/${sessionId}/events`,
      (ev) => ev.event === 'turn_complete' || ev.event === 'turn_error',
    );
    await sse.done;

    // Turn finished cleanly — sub-agent + task-manager construction in
    // buildRuntime didn't crash the launcher's boot path. tool_result
    // need not fire here (this turn doesn't invoke a tool — MockProvider
    // in default mode just emits "Hello world."), but turn_complete must
    // and turn_error must not.
    expect(sse.events.find((e) => e.event === 'turn_complete')).toBeDefined();
    expect(sse.events.find((e) => e.event === 'turn_error')).toBeUndefined();

    const code = await launchPromise;
    expect(code).toBe(0);
  }, 15_000);
});

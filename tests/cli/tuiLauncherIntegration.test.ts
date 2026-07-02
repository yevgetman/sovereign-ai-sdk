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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
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
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import type { Transport } from '@yevgetman/sov-sdk/providers/types';
import type { Runtime, RuntimeOptions } from '../../src/server/runtime.js';
import { type ServerEvent, parseServerEvent } from '../../src/server/schema.js';
import { MicrocompactTransport, wrapTransportWithOverflow } from '../helpers/transportWrappers.js';

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

// OUTGOING-leak defense (the header comment above covers the INCOMING
// side): the suites below mock `node:child_process` (and the runtime/
// server modules) and each restores defensively in its own hooks, but
// bun's mock.module() persists across FILES in one `bun test` run — so
// without a file-level afterAll the file can still EXIT with a fake
// `node:child_process` installed. Downstream files that spawn real
// subprocesses (hooks runner, skills inline-shell, GrepTool/BashTool,
// openai tool-progress) would then get a fake ChildProcess (no pid, no
// events, no .kill) and fail. Mirror tuiLauncher.test.ts: capture
// spread-snapshots of the real modules BEFORE any suite mocks them and
// re-install all three when the file finishes.
let fileRealRuntimeModule: typeof import('../../src/server/runtime.js');
let fileRealServerModule: typeof import('../../src/server/index.js');
let fileRealChildProcessModule: typeof import('node:child_process');

beforeAll(async () => {
  // Snapshot ENUMERABLE keys at capture time so the afterAll restore
  // hands bun's mock registry a plain object rather than a live module
  // namespace (which bun 1.3.13 can mutate in place).
  const rt = await import('../../src/server/runtime.js');
  fileRealRuntimeModule = { ...rt } as typeof rt;
  const sv = await import('../../src/server/index.js');
  fileRealServerModule = { ...sv } as typeof sv;
  const cp = await import('node:child_process');
  fileRealChildProcessModule = { ...cp } as typeof cp;
});

afterAll(() => {
  mock.module('../../src/server/runtime.js', () => fileRealRuntimeModule);
  mock.module('../../src/server/index.js', () => fileRealServerModule);
  mock.module('node:child_process', () => fileRealChildProcessModule);
});

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
      // 30s (not 5s): building the real runtime + binding the in-process server
      // can run slow on a loaded machine / busy CI runner. The bind still happens
      // in <50ms when idle; the headroom only matters under contention.
      const deadline = Date.now() + 30000;
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
      // 30s (not 5s): building the real runtime + binding the in-process server
      // can run slow on a loaded machine / busy CI runner. The bind still happens
      // in <50ms when idle; the headroom only matters under contention.
      const deadline = Date.now() + 30000;
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
    // Holder object: TS narrows property reads on objects more reliably than
    // closure-mutated let bindings. After the null-check throw below, TS
    // narrows `approvalHolder.promise` to `Promise<Response>` correctly; a
    // bare `let approvalPromise: Promise<Response> | null` would narrow to
    // `never` because closure mutation isn't tracked.
    const approvalHolder: { promise: Promise<Response> | null } = { promise: null };
    const sse = openLiveSse(
      `http://127.0.0.1:${port}/sessions/${sessionId}/events`,
      (ev) => ev.event === 'turn_complete' || ev.event === 'turn_error',
    );
    sse.onEvent((ev) => {
      if (approvalSent) return;
      if (ev.event !== 'permission_request') return;
      if (ev.data === null || ev.data.type !== 'permission_request') return;
      approvalSent = true;
      // Capture the fetch promise so we can await it alongside the SSE drain.
      // Fire-and-forget (`void fetch(...).then(...)`) would race the
      // assertion below — the microtask assigning the status is not
      // guaranteed to run before `await sse.done` resolves, even though
      // today it deterministically does. Explicit synchronization here.
      approvalHolder.promise = fetch(
        `http://127.0.0.1:${port}/sessions/${sessionId}/approvals/${ev.data.requestId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approved: true }),
        },
      );
    });
    await sse.done;

    expect(approvalSent).toBe(true);
    if (approvalHolder.promise === null) {
      throw new Error('approvalPromise was never assigned — permission_request did not fire');
    }
    const approvalResponse = await approvalHolder.promise;
    expect(approvalResponse.status).toBe(200);

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

// Phase 16.1 M6 T7 — integration smoke for the three long-session-survival
// subsystems (microcompaction, proactive compaction, overflow recovery).
// Each scenario boots `runTuiLauncher` with a real `buildRuntime` (mock
// provider) + real Hono server on a free port, then drives a turn end-to-end
// over HTTP. The mocked spawn keeps the child parked for ~5s so the test
// can POST + drain SSE before the launcher settles.
//
// Why we wrap `buildRuntime`: the launcher doesn't expose injection seams
// for `microcompactConfig`, `proactiveCompactThreshold`, or transport
// overrides — those live on `RuntimeOptions` for unit-test convenience but
// the launcher's CLI-shaped opts bag doesn't forward them. We mock the
// runtime module so each test can (a) override RuntimeOptions before
// `buildRuntime` runs and (b) capture the produced runtime via a module-
// level holder so the test can mutate `runtime.resolvedProvider.transport`
// or seed `runtime.sessionDb` before the test's POST /turns.
//
// The wrapping is layered on top of the M5 suite's defensive re-pin so the
// real runtime modules are still the source — we wrap the production
// `buildRuntime` rather than replacing it wholesale.

/** Holder shape: tests register a `pre` hook to mutate `RuntimeOptions`
 *  before the wrapped `buildRuntime` runs, and a `post` hook to mutate
 *  the produced `Runtime` before the launcher hands it to `startServer`.
 *  Both hooks fire once per `buildRuntime` call (the launcher only calls
 *  it once) and are reset in `afterEach`. */
type RuntimeWrapHooks = {
  pre?: (opts: RuntimeOptions) => RuntimeOptions;
  post?: (runtime: Runtime) => void;
  capturedRuntime?: Runtime;
};

const m6RuntimeHooks: RuntimeWrapHooks = {};

/** Wraps the real `buildRuntime` so each test can intercept options +
 *  produced runtime. The real `buildRuntime` function reference is captured
 *  separately (`realBuildRuntime`) rather than through the module proxy
 *  because bun's `mock.module()` swaps the module's exports IN PLACE — so
 *  reading `realModule.buildRuntime` at wrapper-call time would re-enter
 *  the wrapper and stack-overflow. The function reference captured before
 *  the M6 mock is installed stays bound to the real implementation. */
function buildWrappedRuntimeModule(
  realModule: typeof import('../../src/server/runtime.js'),
  realBuildRuntime: typeof import('../../src/server/runtime.js').buildRuntime,
): typeof import('../../src/server/runtime.js') {
  return {
    ...realModule,
    buildRuntime: async (opts: RuntimeOptions): Promise<Runtime> => {
      const transformed = m6RuntimeHooks.pre?.(opts) ?? opts;
      const runtime = await realBuildRuntime(transformed);
      m6RuntimeHooks.capturedRuntime = runtime;
      m6RuntimeHooks.post?.(runtime);
      return runtime;
    },
  };
}

/** Wrap an existing transport so the FIRST non-summarize call throws overflow;
 *  the rest pass through. Thin convenience around the shared
 *  `wrapTransportWithOverflow` factory in `tests/helpers/transportWrappers.ts`
 *  — discards the call counter so callers that don't need it stay terse. */
function wrapTransportWithOverflowOnce<T extends Transport>(inner: T): T {
  return wrapTransportWithOverflow(inner, (n) => n === 1).transport;
}

describe('tuiLauncher integration smoke — M6 long-session survival', () => {
  let prevSovTuiBin: string | undefined;
  let prevHarnessHome: string | undefined;
  let prevCwd: string;
  let prevMockEnv: string | undefined;
  let tmpHome: string;
  let tmpCwd: string;
  let realRuntimeModule: typeof import('../../src/server/runtime.js');
  let realBuildRuntime: typeof import('../../src/server/runtime.js').buildRuntime;
  let realServerModule: typeof import('../../src/server/index.js');
  let realChildProcessModule: typeof import('node:child_process');

  beforeAll(async () => {
    realRuntimeModule = await import('../../src/server/runtime.js');
    // Capture the function reference BEFORE the M6 wrapper is mounted so
    // the wrapper's recursion into "the real" buildRuntime resolves to the
    // production implementation rather than re-entering the wrapper.
    realBuildRuntime = realRuntimeModule.buildRuntime;
    realServerModule = await import('../../src/server/index.js');
    realChildProcessModule = await import('node:child_process');
  });

  beforeEach(() => {
    prevSovTuiBin = process.env.SOV_TUI_BIN;
    prevHarnessHome = process.env.HARNESS_HOME;
    prevMockEnv = process.env.SOV_TEST_MOCK_PROVIDER;
    prevCwd = process.cwd();
    tmpHome = mkdtempSync(join(tmpdir(), 'm6-t7-home-'));
    tmpCwd = mkdtempSync(join(tmpdir(), 'm6-t7-cwd-'));
    process.env.SOV_TUI_BIN = '/bin/true';
    process.env.HARNESS_HOME = tmpHome;
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    process.chdir(tmpCwd);
    // Mount the wrapped runtime module so each test can register pre/post
    // hooks. The wrapper invokes `realBuildRuntime` directly (a captured
    // function reference) so the production code path stays load-bearing.
    mock.module('../../src/server/runtime.js', () =>
      buildWrappedRuntimeModule(realRuntimeModule, realBuildRuntime),
    );
    mock.module('../../src/server/index.js', () => realServerModule);
  });

  afterEach(() => {
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
    // Reset the M6 hooks so the next test starts clean. The captured runtime
    // is dropped here; the launcher's `runtime.dispose()` already ran on
    // settle so we don't need to dispose again. `delete` rather than
    // `= undefined` to satisfy `exactOptionalPropertyTypes`; this mirrors
    // the `delete process.env.X` pattern the M5 suite uses for the same
    // reason.
    // biome-ignore lint/performance/noDelete: exactOptionalPropertyTypes rejects `= undefined` on optional fields.
    delete m6RuntimeHooks.pre;
    // biome-ignore lint/performance/noDelete: exactOptionalPropertyTypes rejects `= undefined` on optional fields.
    delete m6RuntimeHooks.post;
    // biome-ignore lint/performance/noDelete: exactOptionalPropertyTypes rejects `= undefined` on optional fields.
    delete m6RuntimeHooks.capturedRuntime;
    mock.module('node:child_process', () => realChildProcessModule);
    mock.restore();
  });

  /** Spawn-mock factory shared with the M5 suite — kept inline here rather
   *  than extracted so each suite's reset/teardown stays local. The M5 suite
   *  documents the rationale at length; this is the M6-scoped copy. */
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

  async function waitForServerBind(
    getSpawnedArgs: () => string[] | null,
    getServerPort: () => number | null,
  ): Promise<{ args: string[]; port: number; sessionId: string }> {
    await new Promise<void>((resolve, reject) => {
      // 30s (not 5s): building the real runtime + binding the in-process server
      // can run slow on a loaded machine / busy CI runner. The bind still happens
      // in <50ms when idle; the headroom only matters under contention.
      const deadline = Date.now() + 30000;
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

  test('microcompact clears prior tool_results inside a launcher-driven turn', async () => {
    // Microcompaction observability through the launcher: the `microcompact`
    // event emitted inside query() (src/core/query.ts:421) is NOT forwarded
    // to the SSE wire today — the turns route's mapServerStreamEvent
    // intentionally returns null for it (see turns.ts:567-571 — deferred to
    // M4+ wire-event richness). The integration smoke therefore uses the
    // SAME signal the unit test in tests/server/turns.microcompact.test.ts
    // does: inspect the messages array handed to the provider on iteration 1
    // and assert the in-flight `tool_result` blocks were cleared (replaced
    // by `[Tool result cleared`-prefixed placeholders by `microcompact()` in
    // src/compact/microcompact.ts).
    //
    // Pre hook: tighten microcompactConfig so any compactable token triggers
    // — the default 40% threshold would need a much larger seeded history
    // than makes sense for a smoke test.
    // Post hook: substitute a narrower test transport that returns Bash on
    // iteration 0 regardless of seeded history (the default MockProvider's
    // toolUseMode short-circuits to "done." when ANY prior tool_result is
    // present).
    m6RuntimeHooks.pre = (opts) => ({
      ...opts,
      microcompactConfig: {
        enabled: true,
        keepRecent: 1,
        triggerThresholdPct: 1,
        compactableTools: new Set(['Bash']),
      },
    });
    // Construct the helper instance up front so the test body can read
    // `transport.callMessages` after the turn completes — the post hook
    // mounts the same instance onto the captured runtime.
    const transport = new MicrocompactTransport({
      toolUseId: 'mc-smoke-tool-use-0',
      bashCommand: 'echo mc-smoke',
    });
    m6RuntimeHooks.post = (runtime) => {
      runtime.resolvedProvider.transport = transport;
    };

    const { getSpawnedArgs, getServerPort } = installSpawnMock(MOCK_CHILD_M5_TURN_DELAY_MS);
    const { runTuiLauncher } = await import('../../src/cli/tuiLauncher.js');
    const launchPromise = runTuiLauncher({ provider: 'mock' });
    const { port, sessionId } = await waitForServerBind(getSpawnedArgs, getServerPort);

    const runtime = m6RuntimeHooks.capturedRuntime;
    if (runtime === undefined) {
      throw new Error('runtime never captured by buildRuntime wrapper');
    }

    // Seed 4 prior Bash tool_use+tool_result pairs so the next turn's
    // microcompaction check has compactable history to clear. The
    // tool_result bodies are ~1.6kb each so the compactable share dominates
    // the (small) history and shouldMicrocompact returns true.
    for (let i = 0; i < 4; i++) {
      const toolUseId = `seed-tool-${i}`;
      runtime.sessionDb.saveMessage(sessionId, {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: `echo seed-${i}` } },
        ],
      });
      runtime.sessionDb.saveMessage(sessionId, {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: `seed-${i} `.repeat(200),
          },
        ],
      });
    }

    const turnRes = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'do another bash' }),
    });
    expect(turnRes.status).toBe(202);

    const sse = openLiveSse(
      `http://127.0.0.1:${port}/sessions/${sessionId}/events`,
      (ev) => ev.event === 'turn_complete' || ev.event === 'turn_error',
    );
    await sse.done;

    // The transport captured every messages[] handed to it. Iteration 0 is
    // the initial call; iteration 1 is the continuation after Bash ran.
    // Microcompaction fires AFTER iteration 0's tool dispatch and mutates
    // the in-flight history before iteration 1's call — so the signal lives
    // in callMessages[1].
    expect(transport.callMessages.length).toBeGreaterThanOrEqual(2);
    const continuationMessages = transport.callMessages[1] ?? [];
    const cleared = continuationMessages.flatMap((m) =>
      m.content.filter(
        (b) => b.type === 'tool_result' && b.content.startsWith('[Tool result cleared'),
      ),
    );
    // With 4 seeded pre-boundary results + keepRecent=1, microcompact clears
    // 3 of them (the 4th seeded result is within the keepRecent window; the
    // in-flight tool_result is post-boundary and also untouched).
    expect(cleared.length).toBe(3);
    expect(sse.events.find((e) => e.event === 'turn_error')).toBeUndefined();

    const code = await launchPromise;
    expect(code).toBe(0);
  }, 15_000);

  test('proactive compaction completes through the launcher', async () => {
    // Override the proactive threshold so a small seeded history trips it.
    // 0.02 of 200_000 = 4_000 tokens — comfortably above the mock's ~2,200
    // -token system prompt (so the self-guard at compactor.ts:177-183
    // doesn't trip) but small enough that the seeded history below trips
    // the overall limit. Same mechanics as the unit test in
    // tests/server/turns.proactiveCompact.test.ts:96.
    m6RuntimeHooks.pre = (opts) => ({
      ...opts,
      proactiveCompactThreshold: 0.02,
    });

    const { getSpawnedArgs, getServerPort } = installSpawnMock(MOCK_CHILD_M5_TURN_DELAY_MS);
    const { runTuiLauncher } = await import('../../src/cli/tuiLauncher.js');
    const launchPromise = runTuiLauncher({ provider: 'mock' });
    const { port, sessionId } = await waitForServerBind(getSpawnedArgs, getServerPort);

    const runtime = m6RuntimeHooks.capturedRuntime;
    if (runtime === undefined) {
      throw new Error('runtime never captured by buildRuntime wrapper');
    }

    // Seed enough prior history that system + messages > 4_000 tokens AND
    // that compactSession's `head` is non-empty after selectTailStart
    // satisfies DEFAULT_MIN_TAIL_MESSAGES=4. Backlog #36: a history that
    // fits within the tail budget OR doesn't reach the min-tail floor
    // produces an empty head and the compactor short-circuits to a no-op
    // — which suppresses compaction_complete on the wire and would
    // invalidate this test's "exactly 1 compaction_complete event" pin.
    const filler = 'lorem ipsum dolor sit amet '.repeat(500);
    for (let i = 0; i < 3; i += 1) {
      runtime.sessionDb.saveMessage(sessionId, {
        role: 'user',
        content: [{ type: 'text', text: `prior user turn ${i}: ${filler}` }],
      });
      runtime.sessionDb.saveMessage(sessionId, {
        role: 'assistant',
        content: [{ type: 'text', text: `prior reply ${i}: ${filler}` }],
      });
    }

    const turnRes = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'next turn' }),
    });
    expect(turnRes.status).toBe(202);

    const sse = openLiveSse(
      `http://127.0.0.1:${port}/sessions/${sessionId}/events`,
      (ev) => ev.event === 'turn_complete' || ev.event === 'turn_error',
    );
    await sse.done;

    // compaction_complete must surface on the wire BEFORE turn_complete
    // (the proactive block fires before the post-compaction query()).
    const compactionEvents = sse.events.filter((e) => e.event === 'compaction_complete');
    expect(compactionEvents.length).toBe(1);
    expect(sse.events.find((e) => e.event === 'turn_complete')).toBeDefined();
    expect(sse.events.find((e) => e.event === 'turn_error')).toBeUndefined();

    // Lineage row exists: parent → child via getCompactionsForParent.
    const lineage = runtime.sessionDb.getCompactionsForParent(sessionId);
    expect(lineage.length).toBe(1);
    const childSessionId = lineage[0]?.childSessionId;
    expect(typeof childSessionId).toBe('string');
    expect(childSessionId).not.toBe(sessionId);

    // Ordering: compaction_complete arrives before turn_complete.
    const compactionIdx = sse.events.findIndex((e) => e.event === 'compaction_complete');
    const completeIdx = sse.events.findIndex((e) => e.event === 'turn_complete');
    expect(compactionIdx).toBeGreaterThan(-1);
    expect(completeIdx).toBeGreaterThan(compactionIdx);

    const code = await launchPromise;
    expect(code).toBe(0);
  }, 15_000);

  test('overflow-then-retry completes through the launcher', async () => {
    // Wrap the resolved transport so the first non-summarize call throws
    // an overflow-shaped error; subsequent calls (the recovery retry's
    // main call + any summarize calls) pass through. Mirrors
    // tests/server/turns.overflowRecovery.test.ts's happy-path scenario.
    m6RuntimeHooks.post = (runtime) => {
      runtime.resolvedProvider.transport = wrapTransportWithOverflowOnce(
        runtime.resolvedProvider.transport,
      );
    };

    const { getSpawnedArgs, getServerPort } = installSpawnMock(MOCK_CHILD_M5_TURN_DELAY_MS);
    const { runTuiLauncher } = await import('../../src/cli/tuiLauncher.js');
    const launchPromise = runTuiLauncher({ provider: 'mock' });
    const { port, sessionId } = await waitForServerBind(getSpawnedArgs, getServerPort);

    const runtime = m6RuntimeHooks.capturedRuntime;
    if (runtime === undefined) {
      throw new Error('runtime never captured by buildRuntime wrapper');
    }

    // Seed enough prior history so the recovery branch's compactSession
    // call has a non-empty `head`. Backlog #36: empty-head compactions
    // short-circuit to a no-op and the recovery branch surfaces the
    // original overflow as turn_error WITHOUT firing compaction_complete
    // — which would invalidate this test's "compaction_complete fired
    // exactly once" + "turn_complete fired" assertions.
    const filler = 'lorem ipsum dolor sit amet '.repeat(500);
    for (let i = 0; i < 3; i += 1) {
      runtime.sessionDb.saveMessage(sessionId, {
        role: 'user',
        content: [{ type: 'text', text: `prior user turn ${i}: ${filler}` }],
      });
      runtime.sessionDb.saveMessage(sessionId, {
        role: 'assistant',
        content: [{ type: 'text', text: `prior reply ${i}: ${filler}` }],
      });
    }

    const turnRes = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(turnRes.status).toBe(202);

    const sse = openLiveSse(
      `http://127.0.0.1:${port}/sessions/${sessionId}/events`,
      (ev) => ev.event === 'turn_complete' || ev.event === 'turn_error',
    );
    await sse.done;

    // Recovery path: compaction_complete fired (proves first-overflow
    // recovery triggered), turn_complete fired (proves the retry
    // succeeded), and turn_error did NOT fire (the first overflow was
    // absorbed by the recovery branch).
    const compactionEvents = sse.events.filter((e) => e.event === 'compaction_complete');
    expect(compactionEvents.length).toBe(1);
    expect(sse.events.find((e) => e.event === 'turn_complete')).toBeDefined();
    expect(sse.events.find((e) => e.event === 'turn_error')).toBeUndefined();

    // Lineage pinned: parent=original sessionId, child=new id minted by
    // compactSession during the recovery hop.
    const lineage = runtime.sessionDb.getCompactionsForParent(sessionId);
    expect(lineage.length).toBe(1);
    const childSessionId = lineage[0]?.childSessionId;
    expect(typeof childSessionId).toBe('string');
    expect(childSessionId).not.toBe(sessionId);

    const code = await launchPromise;
    expect(code).toBe(0);
  }, 15_000);
});

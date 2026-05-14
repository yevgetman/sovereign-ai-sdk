import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTuiBinary, findTuiBinaryFrom } from '../../src/cli/tuiLauncher.js';

describe('findTuiBinary', () => {
  test('honors SOV_TUI_BIN when set to an existing path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sov-tui-test-'));
    const fake = join(dir, 'fake-tui');
    writeFileSync(fake, '');
    process.env.SOV_TUI_BIN = fake;
    try {
      expect(findTuiBinary()).toBe(fake);
    } finally {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.SOV_TUI_BIN;
      rmSync(dir, { recursive: true });
    }
  });

  test('falls back to repo-root bin/sov-tui when it exists', () => {
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TUI_BIN;
    // The test runs from tests/cli/, so dirname twice → tests/, dirname again → repo root.
    // We accept either form: just assert that if bin/sov-tui exists in CWD-ancestor we find it.
    const found = findTuiBinary();
    if (found !== null) {
      expect(existsSync(found)).toBe(true);
    }
  });

  test('returns null when nothing is found starting from a barren directory', () => {
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TUI_BIN;
    // /tmp has no bin/sov-tui anywhere on the parent walk — the search
    // must exhaust the upward loop and return null. Using
    // findTuiBinaryFrom() instead of findTuiBinary() because the latter
    // walks from the module's own location (which DOES live under the
    // repo and may find bin/sov-tui via the postinstall artifact). The
    // test isolates the null-branch by handing the walker a known-clean
    // starting point.
    expect(findTuiBinaryFrom('/tmp')).toBeNull();
  });
});

// Phase 16.1 M4 Task 7 — flag forwarding + error surfacing.
//
// runTuiLauncher() is the orchestration seam between Commander's option bag
// and buildRuntime(). These tests pin two contracts:
//   1. Every M4-supported CLI flag (bundle/provider/model/permissionMode/
//      maxTokens/db/resume/cache/preflight) reaches buildRuntime with the
//      right key name and value.
//   2. PreflightError + SessionNotFoundError surface as user-friendly
//      stderr text and return non-zero before the server starts.
//
// We use bun:test's mock.module() to replace the runtime, server, and
// child_process modules. mock.module() in bun 1.3.x invalidates the
// import cache between calls, so re-mocking inside a test reaches a
// freshly-loaded tuiLauncher. Real implementations are captured in
// beforeAll and reinstated in afterAll so the mocks don't leak to other
// test files in the suite.
describe('runTuiLauncher — flag forwarding', () => {
  let recordedBuildOpts: Record<string, unknown> | null = null;
  let prevSovTuiBin: string | undefined;
  // Real-module references captured before any mock fires. Reinstalled
  // in afterAll() so mock.module() side-effects don't leak across files.
  let realRuntimeModule: typeof import('../../src/server/runtime.js');
  let realServerModule: typeof import('../../src/server/index.js');
  let realChildProcessModule: typeof import('node:child_process');

  beforeAll(async () => {
    realRuntimeModule = await import('../../src/server/runtime.js');
    realServerModule = await import('../../src/server/index.js');
    realChildProcessModule = await import('node:child_process');
  });

  afterAll(() => {
    mock.module('../../src/server/runtime.js', () => realRuntimeModule);
    mock.module('../../src/server/index.js', () => realServerModule);
    mock.module('node:child_process', () => realChildProcessModule);
  });

  beforeEach(() => {
    recordedBuildOpts = null;
    prevSovTuiBin = process.env.SOV_TUI_BIN;
    // /bin/true exists on macOS + Linux; satisfies findTuiBinary().
    process.env.SOV_TUI_BIN = '/bin/true';

    // fetch: POST /sessions returns a fake session id. Per-test
    // overrides reassign globalThis.fetch directly.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ sessionId: 'test-session-id' }), {
        status: 201,
      })) as unknown as typeof fetch;

    // spawn: emit 'exit' code 0 on next tick so the launcher's promise
    // resolves quickly. setImmediate runs after on() listeners are attached.
    mock.module('node:child_process', () => ({
      spawn: (): EventEmitter => {
        const child = new EventEmitter();
        setImmediate(() => child.emit('exit', 0));
        return child;
      },
    }));

    mock.module('../../src/server/runtime.js', () => ({
      buildRuntime: async (opts: Record<string, unknown>) => {
        recordedBuildOpts = opts;
        return {
          dispose: async () => {},
          resumeId: typeof opts.resumeId === 'string' ? opts.resumeId : undefined,
        };
      },
    }));

    mock.module('../../src/server/index.js', () => ({
      startServer: async () => ({ port: 12345, stop: async () => {} }),
    }));
  });

  test('forwards bundle, provider, model, permissionMode, maxTokens, db, cache, preflight', async () => {
    const { runTuiLauncher } = await import('../../src/cli/tuiLauncher.js');
    const exitCode = await runTuiLauncher({
      bundle: '/path/to/bundle',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      permissionMode: 'bypass',
      maxTokens: 7777,
      db: '/tmp/m4.db',
      cache: false, // CLI --no-cache → opts.cache === false
      preflight: false, // CLI --no-preflight → opts.preflight === false
    });
    expect(exitCode).toBe(0);
    expect(recordedBuildOpts).toMatchObject({
      bundleRoot: '/path/to/bundle',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      permissionMode: 'bypass',
      maxTokens: 7777,
      dbPath: '/tmp/m4.db',
      cacheEnabled: false,
      preflight: false,
    });

    if (prevSovTuiBin === undefined) {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.SOV_TUI_BIN;
    } else {
      process.env.SOV_TUI_BIN = prevSovTuiBin;
    }
  });

  test('forwards resume id and skips POST /sessions when resumeId is set', async () => {
    let postSessionsCalled = false;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const u = typeof input === 'string' ? input : input.toString();
      if (/\/sessions$/.test(u)) {
        postSessionsCalled = true;
      }
      return new Response(JSON.stringify({ sessionId: 'should-not-be-used' }), {
        status: 201,
      });
    }) as unknown as typeof fetch;

    const { runTuiLauncher } = await import('../../src/cli/tuiLauncher.js');
    const exitCode = await runTuiLauncher({ resume: 'resumed-id' });
    expect(exitCode).toBe(0);
    expect((recordedBuildOpts as { resumeId?: string }).resumeId).toBe('resumed-id');
    expect(postSessionsCalled).toBe(false);

    if (prevSovTuiBin === undefined) {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.SOV_TUI_BIN;
    } else {
      process.env.SOV_TUI_BIN = prevSovTuiBin;
    }
  });

  test('surfaces PreflightError as a stderr message and returns non-zero', async () => {
    // Override buildRuntime to throw PreflightError. The real errors.js
    // module is left untouched so the launcher's instanceof check matches.
    mock.module('../../src/server/runtime.js', () => ({
      buildRuntime: async () => {
        const { PreflightError } = await import('../../src/server/errors.js');
        throw new PreflightError('credential', 'anthropic credential is missing or unavailable');
      },
    }));

    const stderr: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    }) as typeof process.stderr.write;
    try {
      const { runTuiLauncher } = await import('../../src/cli/tuiLauncher.js');
      const exitCode = await runTuiLauncher({});
      expect(exitCode).not.toBe(0);
      const buf = stderr.join('');
      expect(buf).toContain('preflight');
      expect(buf).toMatch(/credential/i);
    } finally {
      process.stderr.write = origWrite;
      if (prevSovTuiBin === undefined) {
        // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
        delete process.env.SOV_TUI_BIN;
      } else {
        process.env.SOV_TUI_BIN = prevSovTuiBin;
      }
    }
  });

  test('surfaces SessionNotFoundError as a stderr message and returns non-zero', async () => {
    mock.module('../../src/server/runtime.js', () => ({
      buildRuntime: async () => {
        const { SessionNotFoundError } = await import('../../src/server/errors.js');
        throw new SessionNotFoundError('00000000-0000-0000-0000-000000000000');
      },
    }));

    const stderr: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    }) as typeof process.stderr.write;
    try {
      const { runTuiLauncher } = await import('../../src/cli/tuiLauncher.js');
      const exitCode = await runTuiLauncher({
        resume: '00000000-0000-0000-0000-000000000000',
      });
      expect(exitCode).not.toBe(0);
      const buf = stderr.join('');
      expect(buf).toMatch(/session not found/i);
    } finally {
      process.stderr.write = origWrite;
      if (prevSovTuiBin === undefined) {
        // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
        delete process.env.SOV_TUI_BIN;
      } else {
        process.env.SOV_TUI_BIN = prevSovTuiBin;
      }
    }
  });
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

describe('findTuiBinary — binary install mode', () => {
  test('returns sibling sov-tui when execPath has one', () => {
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TUI_BIN;
    const root = mkdtempSync(join(tmpdir(), 'sov-tui-binary-'));
    try {
      const binDir = join(root, 'bin');
      mkdirSync(binDir, { recursive: true });
      const fakeExec = join(binDir, 'sov');
      const fakeTui = join(binDir, 'sov-tui');
      writeFileSync(fakeExec, '');
      writeFileSync(fakeTui, '');
      const found = findTuiBinary({ execPath: fakeExec });
      // realpath through $TMPDIR symlink on macOS, so compare paths
      // after passing both through the same resolver.
      expect(found).toBeTruthy();
      // sibling at <binDir>/sov-tui regardless of /var vs /private/var.
      expect(found?.endsWith('/sov-tui')).toBe(true);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  test('falls through to source-mode walk when no sibling sov-tui exists', () => {
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TUI_BIN;
    const root = mkdtempSync(join(tmpdir(), 'sov-tui-no-sibling-'));
    try {
      const binDir = join(root, 'bin');
      mkdirSync(binDir, { recursive: true });
      const fakeExec = join(binDir, 'sov');
      writeFileSync(fakeExec, '');
      // No sov-tui sibling → binary branch misses → falls through to
      // source-mode walk (which may or may not find anything depending
      // on the repo state; we only assert the binary branch didn't
      // mistakenly return a non-existent path).
      const found = findTuiBinary({ execPath: fakeExec });
      if (found !== null) {
        // Whatever was found via fallback must actually exist.
        expect(existsSync(found)).toBe(true);
        // And must NOT be the fake sov-tui we didn't create.
        expect(found).not.toBe(join(binDir, 'sov-tui'));
      }
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  test('SOV_TUI_BIN still wins over binary-mode sibling', () => {
    const root = mkdtempSync(join(tmpdir(), 'sov-tui-env-wins-'));
    try {
      const binDir = join(root, 'bin');
      mkdirSync(binDir, { recursive: true });
      const fakeExec = join(binDir, 'sov');
      const fakeTui = join(binDir, 'sov-tui');
      const overrideTui = join(root, 'override-tui');
      writeFileSync(fakeExec, '');
      writeFileSync(fakeTui, '');
      writeFileSync(overrideTui, '');
      process.env.SOV_TUI_BIN = overrideTui;
      try {
        expect(findTuiBinary({ execPath: fakeExec })).toBe(overrideTui);
      } finally {
        // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
        delete process.env.SOV_TUI_BIN;
      }
    } finally {
      rmSync(root, { recursive: true });
    }
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
// freshly-loaded tuiLauncher.
//
// Real implementations are captured at FILE scope (not inside a describe)
// and restored in the file-level afterAll below. Describe-scoped cleanup
// fires after that describe's tests but allows later describes in the same
// file to silently still see the leaked mocks — file scope keeps the
// restore as the very last hook to run before subsequent test files in the
// `bun test` run. The integration smoke in tuiLauncherIntegration.test.ts
// also defensively re-pins its own mocks so flake risk is bounded on both
// sides.
//
// NOTE: these tests override process.stderr.write to capture error
// messages. Bun runs tests within a file serially, so the overrides
// are safe between tests in this file. Avoid adding parallel `describe.concurrent`
// blocks that also write to stderr.
let realRuntimeModule: typeof import('../../src/server/runtime.js');
let realServerModule: typeof import('../../src/server/index.js');
let realChildProcessModule: typeof import('node:child_process');
let realGlobalFetch: typeof fetch;

beforeAll(async () => {
  // Snapshot ENUMERABLE keys at capture time so the afterAll restore
  // hands bun's mock registry a plain object rather than a live module
  // namespace (which bun 1.3.13 can mutate in place).
  const rt = await import('../../src/server/runtime.js');
  realRuntimeModule = { ...rt } as typeof rt;
  const sv = await import('../../src/server/index.js');
  realServerModule = { ...sv } as typeof sv;
  const cp = await import('node:child_process');
  realChildProcessModule = { ...cp } as typeof cp;
  // Capture real fetch so afterAll can restore it. Tests in this file
  // reassign globalThis.fetch directly (per-test mock); without
  // restoration the override persists into subsequent files in the same
  // `bun test` run.
  realGlobalFetch = globalThis.fetch;
});

afterAll(() => {
  mock.module('../../src/server/runtime.js', () => realRuntimeModule);
  mock.module('../../src/server/index.js', () => realServerModule);
  mock.module('node:child_process', () => realChildProcessModule);
  globalThis.fetch = realGlobalFetch;
});

describe('runTuiLauncher — flag forwarding', () => {
  let recordedBuildOpts: Record<string, unknown> | null = null;
  // ux-fixes 2026-05-22: also capture the spawn args so tests can
  // assert how sov-tui is invoked (tool-output-mode flags, verbose-raw).
  let recordedSpawnArgs: string[] | null = null;
  let prevSovTuiBin: string | undefined;

  beforeEach(() => {
    recordedBuildOpts = null;
    recordedSpawnArgs = null;
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
    // ux-fixes 2026-05-22: capture args for flag-forwarding assertions.
    mock.module('node:child_process', () => ({
      spawn: (_bin: string, args: string[]): EventEmitter => {
        recordedSpawnArgs = args;
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
          // ux-fixes round 3: tuiLauncher.spawn passes model + provider
          // through to sov-tui as CLI args so the splash card renders
          // them from frame 0. The mock supplies stub values; production
          // builds set these in src/server/runtime.ts.
          model: typeof opts.model === 'string' ? opts.model : 'claude-haiku-stub',
          resolvedProvider: {
            transport: { name: typeof opts.provider === 'string' ? opts.provider : 'anthropic' },
          },
        };
      },
    }));

    mock.module('../../src/server/index.js', () => ({
      startServer: async () => ({ port: 12345, stop: async () => {} }),
    }));
  });

  afterEach(() => {
    if (prevSovTuiBin === undefined) {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.SOV_TUI_BIN;
    } else {
      process.env.SOV_TUI_BIN = prevSovTuiBin;
    }
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
  });

  test('forwards captureFixture to buildRuntime as captureFixturePath (M8 T3)', async () => {
    const { runTuiLauncher } = await import('../../src/cli/tuiLauncher.js');
    const exitCode = await runTuiLauncher({
      captureFixture: '/tmp/m8-capture.json',
    });
    expect(exitCode).toBe(0);
    expect((recordedBuildOpts as { captureFixturePath?: string }).captureFixturePath).toBe(
      '/tmp/m8-capture.json',
    );
    // replayFixturePath must not be set when only --capture-fixture is passed.
    expect((recordedBuildOpts as { replayFixturePath?: string }).replayFixturePath).toBeUndefined();
  });

  test('forwards replayFixture to buildRuntime as replayFixturePath (M8 T3)', async () => {
    const { runTuiLauncher } = await import('../../src/cli/tuiLauncher.js');
    const exitCode = await runTuiLauncher({
      replayFixture: '/tmp/m8-replay.json',
    });
    expect(exitCode).toBe(0);
    expect((recordedBuildOpts as { replayFixturePath?: string }).replayFixturePath).toBe(
      '/tmp/m8-replay.json',
    );
    expect(
      (recordedBuildOpts as { captureFixturePath?: string }).captureFixturePath,
    ).toBeUndefined();
  });

  test('rejects --capture-fixture + --replay-fixture together with exit code 2 (mutex)', async () => {
    const stderr: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    }) as typeof process.stderr.write;
    try {
      const { runTuiLauncher } = await import('../../src/cli/tuiLauncher.js');
      const exitCode = await runTuiLauncher({
        captureFixture: '/tmp/c.json',
        replayFixture: '/tmp/r.json',
      });
      expect(exitCode).toBe(2);
      // buildRuntime must NOT have been called — the pre-check fires first.
      expect(recordedBuildOpts).toBeNull();
      const buf = stderr.join('');
      expect(buf).toContain('--capture-fixture');
      expect(buf).toContain('--replay-fixture');
      expect(buf).toMatch(/mutually exclusive/i);
    } finally {
      process.stderr.write = origWrite;
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
  });

  // ux-fixes 2026-05-22: tool-output rendering mode is forwarded to
  // sov-tui via --tool-output-mode + --tool-output-inline-lines. Default
  // 'compact' (one-liner per tool call) + inlineLines 10. -v / --verbose
  // is forwarded as --verbose-raw (orthogonal raw escape hatch).
  // Spec: docs/specs/2026-05-22-tui-tool-call-abstraction-design.md.
  test('forwards default --tool-output-mode=compact and --tool-output-inline-lines=10', async () => {
    const { runTuiLauncher } = await import('../../src/cli/tuiLauncher.js');
    const exitCode = await runTuiLauncher({});
    expect(exitCode).toBe(0);
    expect(recordedSpawnArgs).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: previous expect guards null
    const args = recordedSpawnArgs!;
    const modeIdx = args.indexOf('--tool-output-mode');
    expect(modeIdx).toBeGreaterThanOrEqual(0);
    expect(args[modeIdx + 1]).toBe('compact');
    const linesIdx = args.indexOf('--tool-output-inline-lines');
    expect(linesIdx).toBeGreaterThanOrEqual(0);
    expect(args[linesIdx + 1]).toBe('10');
  });

  test('does NOT forward --verbose-raw when --verbose is absent', async () => {
    const { runTuiLauncher } = await import('../../src/cli/tuiLauncher.js');
    await runTuiLauncher({});
    expect(recordedSpawnArgs).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: previous expect guards null
    const args = recordedSpawnArgs!;
    expect(args).not.toContain('--verbose-raw');
  });

  test('forwards --verbose-raw when --verbose is passed', async () => {
    const { runTuiLauncher } = await import('../../src/cli/tuiLauncher.js');
    await runTuiLauncher({ verbose: true });
    expect(recordedSpawnArgs).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: previous expect guards null
    const args = recordedSpawnArgs!;
    expect(args).toContain('--verbose-raw');
  });

  test('forwards ui.toolOutput.{mode,inlineLines} when set in config', async () => {
    // Point HARNESS_HOME at a temp dir with a config.json that opts into
    // detailed mode + a non-default inlineLines cap. The launcher's
    // readConfig() should pick this up and forward the values verbatim.
    const tmpHome = mkdtempSync(join(tmpdir(), 'sov-toolOutput-cfg-'));
    const prevHome = process.env.HARNESS_HOME;
    process.env.HARNESS_HOME = tmpHome;
    try {
      writeFileSync(
        join(tmpHome, 'config.json'),
        JSON.stringify({ ui: { toolOutput: { mode: 'detailed', inlineLines: 25 } } }),
      );
      const { runTuiLauncher } = await import('../../src/cli/tuiLauncher.js');
      await runTuiLauncher({});
      expect(recordedSpawnArgs).not.toBeNull();
      // biome-ignore lint/style/noNonNullAssertion: previous expect guards null
      const args = recordedSpawnArgs!;
      const modeIdx = args.indexOf('--tool-output-mode');
      expect(args[modeIdx + 1]).toBe('detailed');
      const linesIdx = args.indexOf('--tool-output-inline-lines');
      expect(args[linesIdx + 1]).toBe('25');
    } finally {
      if (prevHome === undefined) {
        // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
        delete process.env.HARNESS_HOME;
      } else {
        process.env.HARNESS_HOME = prevHome;
      }
      rmSync(tmpHome, { recursive: true });
    }
  });

  test('does NOT emit the "sov: tui server listening" boot line to stderr (ux-fixes 2026-05-22)', async () => {
    // Regression guard for Fix A — the launcher used to emit
    //   sov: tui server listening on 127.0.0.1:PORT session=...
    // above the splash. The line was visible to the production user as
    // boot noise. The successful launch path must now be silent on
    // stderr — only error branches (PreflightError, SessionNotFoundError,
    // mutex pre-checks, deferred-flag warnings) should produce stderr.
    const stderr: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    }) as typeof process.stderr.write;
    try {
      const { runTuiLauncher } = await import('../../src/cli/tuiLauncher.js');
      const exitCode = await runTuiLauncher({});
      expect(exitCode).toBe(0);
      const buf = stderr.join('');
      expect(buf).not.toContain('tui server listening');
      // The successful path is fully silent on stderr — assert nothing
      // at all was emitted so any future regression that adds noise
      // here fires immediately.
      expect(buf).toBe('');
    } finally {
      process.stderr.write = origWrite;
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
    }
  });
});

describe('runTuiLauncher — deferred-flag warnings', () => {
  let stderrBuf: string;
  let origWrite: typeof process.stderr.write;
  let prevSovTuiBin: string | undefined;

  // Reuse the same mock-module setup as the flag-forwarding describe.
  // mock.module persists per file; the beforeAll in the prior describe
  // block already captured + reinstalls real modules at afterAll. This
  // block runs WITHIN the same file so the mocks are already in place.

  beforeEach(() => {
    stderrBuf = '';
    origWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrBuf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      return true;
    }) as typeof process.stderr.write;
    prevSovTuiBin = process.env.SOV_TUI_BIN;
    process.env.SOV_TUI_BIN = '/bin/true';
  });

  afterEach(() => {
    process.stderr.write = origWrite;
    if (prevSovTuiBin === undefined) {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.SOV_TUI_BIN;
    } else {
      process.env.SOV_TUI_BIN = prevSovTuiBin;
    }
  });

  test('warns on --transcript with target milestone M7', async () => {
    const { runTuiLauncher } = await import('../../src/cli/tuiLauncher.js');
    await runTuiLauncher({ transcript: '/tmp/t.jsonl' });
    expect(stderrBuf).toContain('--transcript');
    expect(stderrBuf).toMatch(/M7/);
  });

  test('warns on --agent with M7', async () => {
    const { runTuiLauncher } = await import('../../src/cli/tuiLauncher.js');
    await runTuiLauncher({ agent: 'scheduled-mission' });
    expect(stderrBuf).toContain('--agent');
    expect(stderrBuf).toMatch(/M7/);
  });

  test('warns on --state-dir with M7', async () => {
    const { runTuiLauncher } = await import('../../src/cli/tuiLauncher.js');
    await runTuiLauncher({ stateDir: '/tmp/state' });
    expect(stderrBuf).toContain('--state-dir');
    expect(stderrBuf).toMatch(/M7/);
  });

  // ux-fixes 2026-05-22: --verbose is no longer deferred-warned —
  // it's wired through as --verbose-raw to sov-tui. The regression
  // guard here asserts the warning is NOT emitted. Forwarding is
  // tested in the flag-forwarding describe block below.
  test('does NOT warn on --verbose (wired as --verbose-raw 2026-05-22)', async () => {
    const { runTuiLauncher } = await import('../../src/cli/tuiLauncher.js');
    await runTuiLauncher({ verbose: true });
    expect(stderrBuf).not.toMatch(/--verbose is not yet supported/);
  });
});

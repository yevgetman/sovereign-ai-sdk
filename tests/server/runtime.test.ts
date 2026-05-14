// Phase 16.1 M3.3 — server-side runtime construction.
// buildRuntime() mirrors terminalRepl's boot sequence in a parallel,
// additive form (terminalRepl is untouched per Postmortem Rule 1).

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '../../src/providers/mock.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('buildRuntime', () => {
  test('constructs a runtime with sessionDb, toolPool, systemSegments, provider', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sov-runtime-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    try {
      const rt = await buildRuntime({
        harnessHome: home,
        cwd: process.cwd(),
        provider: 'mock',
        model: 'mock-haiku',
      });
      expect(rt.sessionDb).toBeDefined();
      expect(rt.toolPool.length).toBeGreaterThan(0);
      expect(rt.systemSegments.length).toBeGreaterThan(0);
      expect(rt.provider).toBeDefined();
      expect(rt.model).toBe('mock-haiku');
      expect(rt.canUseTool).toBeDefined();
      expect(typeof rt.canUseTool).toBe('function');
      await rt.dispose();
    } finally {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.SOV_TEST_MOCK_PROVIDER;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('honors permissionMode=bypass from user config.json when no option is passed', async () => {
    // Permission cascade: explicit option → layered permission settings →
    // user config.json `permissionMode`. The user-config branch is the
    // one that was missing in M3 and let the TUI hang on tool-using turns.
    const home = mkdtempSync(join(tmpdir(), 'sov-runtime-cfg-'));
    const configPath = join(home, 'config.json');
    writeFileSync(configPath, JSON.stringify({ permissionMode: 'bypass' }), 'utf8');
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    process.env.HARNESS_CONFIG = configPath;
    try {
      const rt = await buildRuntime({
        harnessHome: home,
        cwd: home,
        provider: 'mock',
        model: 'mock-haiku',
      });
      expect(rt.permissionMode).toBe('bypass');
      await rt.dispose();
    } finally {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.SOV_TEST_MOCK_PROVIDER;
      // biome-ignore lint/performance/noDelete: same.
      delete process.env.HARNESS_CONFIG;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('explicit permissionMode option overrides user config.json', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sov-runtime-override-'));
    const configPath = join(home, 'config.json');
    writeFileSync(configPath, JSON.stringify({ permissionMode: 'bypass' }), 'utf8');
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    process.env.HARNESS_CONFIG = configPath;
    try {
      const rt = await buildRuntime({
        harnessHome: home,
        cwd: home,
        provider: 'mock',
        model: 'mock-haiku',
        permissionMode: 'ask',
      });
      // Explicit non-default option wins over the bypass set in config.json.
      expect(rt.permissionMode).toBe('ask');
      await rt.dispose();
    } finally {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.SOV_TEST_MOCK_PROVIDER;
      // biome-ignore lint/performance/noDelete: same.
      delete process.env.HARNESS_CONFIG;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('falls through to default when neither option nor config sets permissionMode', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sov-runtime-default-'));
    // Empty config file (no permissionMode).
    const configPath = join(home, 'config.json');
    writeFileSync(configPath, JSON.stringify({}), 'utf8');
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    process.env.HARNESS_CONFIG = configPath;
    try {
      const rt = await buildRuntime({
        harnessHome: home,
        cwd: home,
        provider: 'mock',
        model: 'mock-haiku',
      });
      expect(rt.permissionMode).toBe('default');
      await rt.dispose();
    } finally {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.SOV_TEST_MOCK_PROVIDER;
      // biome-ignore lint/performance/noDelete: same.
      delete process.env.HARNESS_CONFIG;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('buildRuntime — Task 1 — on-disk SessionDb', () => {
  test('opens sessionDb at opts.dbPath when supplied (persists across opens)', async () => {
    const home = join(tmpdir(), `m4-task1-${Date.now()}`);
    const dbPath = join(home, 'custom.db');
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
        dbPath,
      });
      const sessionId = runtime.sessionDb.createSession({
        model: 'mock',
        provider: 'mock',
        systemPrompt: [],
        metadata: {},
      });
      await runtime.dispose();
      runtime = null;
      const { SessionDb } = await import('../../src/agent/sessionDb.js');
      const reopened = SessionDb.open({ path: dbPath });
      try {
        expect(reopened.getSession(sessionId)?.sessionId).toBe(sessionId);
      } finally {
        reopened.close();
      }
    } finally {
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('falls back to <harnessHome>/sessions.db when dbPath omitted', async () => {
    const home = join(tmpdir(), `m4-task1b-${Date.now()}`);
    const prevEnv = process.env.HARNESS_HOME;
    process.env.HARNESS_HOME = home;
    try {
      const runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
      });
      try {
        runtime.sessionDb.createSession({
          model: 'mock',
          provider: 'mock',
          systemPrompt: [],
          metadata: {},
        });
        expect(existsSync(join(home, 'sessions.db'))).toBe(true);
      } finally {
        await runtime.dispose();
      }
    } finally {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      if (prevEnv === undefined) delete process.env.HARNESS_HOME;
      else process.env.HARNESS_HOME = prevEnv;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('runs cleanupPhantomReviews at boot', async () => {
    const home = join(tmpdir(), `m4-task1c-${Date.now()}`);
    const runtime = await buildRuntime({
      cwd: process.cwd(),
      provider: 'mock',
      harnessHome: home,
    });
    try {
      // No assertions on count — the DB is fresh and has zero phantoms.
      // The test pins that cleanupPhantomReviews() is reachable (no
      // throw) at boot. Subsequent calls return 0 against a clean DB.
      expect(runtime.sessionDb.cleanupPhantomReviews()).toBe(0);
    } finally {
      await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('buildRuntime — resume validation', () => {
  test('with valid resumeId, returns runtime with resumeId echoed', async () => {
    const home = join(tmpdir(), `m4-task2a-${Date.now()}`);
    const dbPath = join(home, 'sessions.db');
    // Seed a session in a sibling DB instance, then open via buildRuntime.
    const { SessionDb } = await import('../../src/agent/sessionDb.js');
    const seed = SessionDb.open({ path: dbPath });
    const seededId = seed.createSession({
      model: 'mock',
      provider: 'mock',
      systemPrompt: [],
      metadata: {},
    });
    seed.close();

    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
        dbPath,
        resumeId: seededId,
      });
      expect(runtime.resumeId).toBe(seededId);
    } finally {
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('with unknown resumeId, throws SessionNotFoundError', async () => {
    const home = join(tmpdir(), `m4-task2b-${Date.now()}`);
    const unknownId = '00000000-0000-0000-0000-000000000000';
    try {
      const { SessionNotFoundError } = await import('../../src/server/errors.js');
      const err = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
        resumeId: unknownId,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SessionNotFoundError);
      expect((err as InstanceType<typeof SessionNotFoundError>).sessionId).toBe(unknownId);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('without resumeId, runtime.resumeId is undefined', async () => {
    const home = join(tmpdir(), `m4-task2c-${Date.now()}`);
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
      });
      expect(runtime.resumeId).toBeUndefined();
    } finally {
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('buildRuntime — maxTokens echo', () => {
  test('echoes opts.maxTokens on runtime', async () => {
    const home = join(tmpdir(), `m4-task5a-${Date.now()}`);
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
        maxTokens: 8000,
      });
      expect(runtime.maxTokens).toBe(8000);
    } finally {
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('falls back to 12000 when maxTokens omitted', async () => {
    const home = join(tmpdir(), `m4-task5b-${Date.now()}`);
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
      });
      expect(runtime.maxTokens).toBe(12000);
    } finally {
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('buildRuntime — preflight execution', () => {
  test('runs preflight against the resolved provider by default', async () => {
    const home = join(tmpdir(), `m4-task6a-${Date.now()}`);
    MockProvider.streamCalls = 0;
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
      });
      // MockProvider.stream() increments streamCalls on every call.
      // The preflight call should fire exactly once (before any user
      // turn runs).
      const props = MockProvider as typeof MockProvider;
      const calls: number = props.streamCalls;
      expect(calls).toBeGreaterThanOrEqual(1);
    } finally {
      MockProvider.streamCalls = 0;
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('skips preflight when opts.preflight === false', async () => {
    const home = join(tmpdir(), `m4-task6b-${Date.now()}`);
    MockProvider.streamCalls = 0;
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
        preflight: false,
      });
      const props = MockProvider as typeof MockProvider;
      const calls: number = props.streamCalls;
      expect(calls).toBe(0);
    } finally {
      MockProvider.streamCalls = 0;
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('throws PreflightError when preflight fails', async () => {
    const home = join(tmpdir(), `m4-task6c-${Date.now()}`);
    MockProvider.preflightShouldFail = true;
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      const { PreflightError } = await import('../../src/server/errors.js');
      const result = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
      }).catch((e: unknown) => e);
      if (!(result instanceof Error)) {
        // defensive: should never reach here — buildRuntime throws PreflightError
        runtime = result as Awaited<ReturnType<typeof buildRuntime>>;
      }
      expect(result).toBeInstanceOf(PreflightError);
    } finally {
      MockProvider.preflightShouldFail = false;
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('PreflightError — cause chaining', () => {
  test('PreflightError preserves cause when supplied', async () => {
    const { PreflightError } = await import('../../src/server/errors.js');
    const inner = new Error('inner error');
    const err = new PreflightError('credential', 'auth failed', inner);
    expect(err.cause).toBe(inner);
    expect(err.kind).toBe('credential');
    expect(err.message).toBe('auth failed');
  });

  test('PreflightError cause is undefined when not supplied', async () => {
    const { PreflightError } = await import('../../src/server/errors.js');
    const err = new PreflightError('unknown', 'something failed');
    expect(err.cause).toBeUndefined();
    expect(err.kind).toBe('unknown');
  });
});

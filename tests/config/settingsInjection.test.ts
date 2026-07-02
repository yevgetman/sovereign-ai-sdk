// Task 2.3 — `RuntimeOptions.settings` injection: a validated `Settings` object
// can be injected through `buildRuntime` so an embedded agent (Phase-3 SDK
// `createAgent`) needs no config file. These tests prove the injected object
// fully BYPASSES disk — both the `config.json` provider config and the layered
// `settings.json` (permissions / mcp / hooks) — and that the omitted case still
// reads disk exactly as before (behavior-preserving).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadHookSettings,
  loadMcpServerSettings,
  loadPermissionSettings,
} from '@yevgetman/sov-sdk/config/settings';
import { buildRuntime } from '../../src/server/runtime.js';

describe('Settings injection — layered settings.json loaders bypass disk when injected', () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'inject-loaders-home-'));
    cwd = mkdtempSync(join(tmpdir(), 'inject-loaders-cwd-'));
    // A user-layer settings.json with permission rules + an mcp server + a hook.
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({
        permissionMode: 'ask',
        permissions: { deny: ['Bash'] },
        mcpServers: { demo: { command: 'echo' } },
        hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'true' }] }] },
      }),
    );
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  test('loadPermissionSettings reads disk when omitted, returns empty when settings injected', () => {
    const fromDisk = loadPermissionSettings({ cwd, harnessHome: home });
    expect(fromDisk.mode).toBe('ask');
    expect(fromDisk.layers.length).toBeGreaterThan(0);
    expect(fromDisk.sources.length).toBeGreaterThan(0);

    const injected = loadPermissionSettings({ cwd, harnessHome: home, settings: {} });
    expect(injected.mode).toBe('default');
    expect(injected.layers).toEqual([]);
    expect(injected.sources).toEqual([]);
  });

  test('loadMcpServerSettings reads disk when omitted, returns empty when settings injected', () => {
    const fromDisk = loadMcpServerSettings({ cwd, harnessHome: home });
    expect(Object.keys(fromDisk.servers)).toContain('demo');

    const injected = loadMcpServerSettings({ cwd, harnessHome: home, settings: {} });
    expect(injected.servers).toEqual({});
    expect(injected.sources).toEqual([]);
  });

  test('loadHookSettings reads disk when omitted, returns empty when settings injected', () => {
    const fromDisk = loadHookSettings({ cwd, harnessHome: home });
    expect(fromDisk.hooksByEvent.PreToolUse.length).toBeGreaterThan(0);

    const injected = loadHookSettings({ cwd, harnessHome: home, settings: {} });
    expect(injected.hooksByEvent.PreToolUse).toEqual([]);
    expect(injected.sources).toEqual([]);
  });
});

describe('Settings injection — buildRuntime threads the injected object, bypassing config.json + settings.json', () => {
  let home: string;
  let cwd: string;
  const prevConfig = process.env.HARNESS_CONFIG;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'inject-rt-home-'));
    cwd = mkdtempSync(join(tmpdir(), 'inject-rt-cwd-'));
    // Ensure readConfig({ harnessHome }) resolves to <home>/config.json, not an
    // ambient HARNESS_CONFIG-pointed file.
    Reflect.deleteProperty(process.env, 'HARNESS_CONFIG');
    // On-disk config: a DISK default model (config.json) + a DISK permission
    // mode (the layered user settings.json). The injected object below differs
    // from BOTH, so a value matching the injected one proves disk was bypassed.
    writeFileSync(join(home, 'config.json'), JSON.stringify({ defaultModel: 'disk-model' }));
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ permissionMode: 'ask' }));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    if (prevConfig === undefined) Reflect.deleteProperty(process.env, 'HARNESS_CONFIG');
    else process.env.HARNESS_CONFIG = prevConfig;
  });

  test('injected settings win over disk (config.json model + settings.json permissionMode bypassed)', async () => {
    const runtime = await buildRuntime({
      harnessHome: home,
      cwd,
      provider: 'ollama', // keyless; no network when preflight is off
      preflight: false,
      cronEnabled: false,
      settings: { defaultModel: 'injected-model', permissionMode: 'bypass' },
    });
    try {
      // config.json's `disk-model` was bypassed — the injected model resolved.
      expect(runtime.model).toBe('injected-model');
      // settings.json's `ask` was bypassed — the injected config.json
      // permissionMode flows through the cascade's userSettings fallback.
      expect(runtime.permissionMode).toBe('bypass');
      // The injected object is echoed for the per-turn ToolContext webSearch source.
      expect(runtime.injectedSettings?.defaultModel).toBe('injected-model');
    } finally {
      await runtime.dispose();
    }
  });

  test('control — without injection, disk is read exactly as before', async () => {
    const runtime = await buildRuntime({
      harnessHome: home,
      cwd,
      provider: 'ollama',
      preflight: false,
      cronEnabled: false,
    });
    try {
      expect(runtime.model).toBe('disk-model');
      expect(runtime.permissionMode).toBe('ask');
      expect(runtime.injectedSettings).toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });
});

// Task 4.3 — the scheduler's child-provider resolution + the four live-reload
// closures (reresolveProvider / reloadHooks / reloadMcpServers /
// rebuildTaskRouting) must RE-APPLY the injected settings instead of reading
// disk, so an injected-settings embed that delegates sub-agents or live-reloads
// stays fully disk-free. Technique: the on-disk config.json + settings.json are
// MALFORMED JSON, and HARNESS_CONFIG points at the malformed config.json so
// BOTH config-read fallbacks (readConfig's harnessHome fallback AND
// resolveProvider→loadSettings' env fallback) would throw a parse error on any
// read — success IS the proof that disk was never touched. The no-injection
// controls prove the closures still read disk exactly as before.
describe('Settings injection — scheduler + live-reload closures are disk-free when injected', () => {
  let home: string;
  let cwd: string;
  const prevConfig = process.env.HARNESS_CONFIG;

  // The scheduler stores its construction opts as `private readonly opts`.
  // Cast through unknown to invoke the resolveProvider closure buildRuntime
  // wired in — same introspection precedent as runtime.subagent.test.ts.
  type SchedulerInternals = {
    opts: { resolveProvider: (name: string, model: string | undefined) => { model: string } };
  };

  const INJECTED = {
    defaultModel: 'injected-model',
    router: { localProvider: 'ollama', frontierProvider: 'ollama' },
  };

  const corruptDisk = (): void => {
    writeFileSync(join(home, 'config.json'), '{ this is not json');
    writeFileSync(join(home, 'settings.json'), '{ this is not json');
  };

  const buildInjected = (): ReturnType<typeof buildRuntime> =>
    buildRuntime({
      harnessHome: home,
      cwd,
      provider: 'ollama', // keyless; no network when preflight is off
      preflight: false,
      cronEnabled: false,
      settings: INJECTED,
    });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'inject-reload-home-'));
    cwd = mkdtempSync(join(tmpdir(), 'inject-reload-cwd-'));
    process.env.HARNESS_CONFIG = join(home, 'config.json');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    if (prevConfig === undefined) Reflect.deleteProperty(process.env, 'HARNESS_CONFIG');
    else process.env.HARNESS_CONFIG = prevConfig;
  });

  test('boot with injected settings succeeds despite malformed disk config (disk-free boot)', async () => {
    corruptDisk();
    const runtime = await buildInjected();
    try {
      expect(runtime.model).toBe('injected-model');
    } finally {
      await runtime.dispose();
    }
  });

  test('scheduler child-provider resolution resolves from injected settings, never disk', async () => {
    corruptDisk();
    const runtime = await buildInjected();
    try {
      const { opts } = runtime.subagentScheduler as unknown as SchedulerInternals;
      // The closure buildRuntime handed the scheduler — the exact seam a
      // delegated sub-agent's provider resolution goes through.
      const resolved = opts.resolveProvider('ollama', undefined);
      expect(resolved.model).toBe('injected-model');
    } finally {
      await runtime.dispose();
    }
  });

  test('reresolveProvider() re-applies injected settings (single-provider branch, no disk read)', async () => {
    corruptDisk();
    const runtime = await buildInjected();
    try {
      expect(runtime.reresolveProvider).toBeDefined();
      await runtime.reresolveProvider?.();
      expect(runtime.model).toBe('injected-model');
    } finally {
      await runtime.dispose();
    }
  });

  test('reresolveProvider("router") resolves lanes from injected settings (router branch, no disk read)', async () => {
    corruptDisk();
    const runtime = await buildInjected();
    try {
      await runtime.reresolveProvider?.('router');
      // Both lanes resolve their model from the injected defaultModel — the
      // synthetic "<local> | <frontier>" model string proves it.
      expect(runtime.model).toBe('injected-model | injected-model');
    } finally {
      await runtime.dispose();
    }
  });

  test('reloadHooks() with injected settings never reads settings.json', async () => {
    corruptDisk();
    const runtime = await buildInjected();
    try {
      const before = runtime.hookRunner;
      await runtime.reloadHooks?.();
      expect(runtime.hookRunner).toBeDefined();
      expect(runtime.hookRunner).not.toBe(before);
    } finally {
      await runtime.dispose();
    }
  });

  test('reloadMcpServers() with injected settings never reads disk', async () => {
    corruptDisk();
    const runtime = await buildInjected();
    try {
      await runtime.reloadMcpServers?.();
      expect(runtime.toolPool.length).toBeGreaterThan(0);
    } finally {
      await runtime.dispose();
    }
  });

  test('rebuildTaskRouting() with injected settings never reads disk', async () => {
    corruptDisk();
    const runtime = await buildInjected();
    try {
      await runtime.rebuildTaskRouting();
      expect(runtime.toolPool.length).toBeGreaterThan(0);
    } finally {
      await runtime.dispose();
    }
  });

  test('control — without injection every closure still reads disk (throws on malformed config)', async () => {
    // Boot against a VALID disk config, then corrupt it: each closure's
    // subsequent throw proves its disk read is structurally unchanged.
    writeFileSync(join(home, 'config.json'), JSON.stringify({ defaultModel: 'disk-model' }));
    writeFileSync(join(home, 'settings.json'), JSON.stringify({}));
    const runtime = await buildRuntime({
      harnessHome: home,
      cwd,
      provider: 'ollama',
      preflight: false,
      cronEnabled: false,
    });
    try {
      expect(runtime.model).toBe('disk-model');
      corruptDisk();
      await expect(runtime.rebuildTaskRouting()).rejects.toThrow();
      await expect(runtime.reresolveProvider?.()).rejects.toThrow();
      await expect(runtime.reloadHooks?.()).rejects.toThrow();
      await expect(runtime.reloadMcpServers?.()).rejects.toThrow();
      const { opts } = runtime.subagentScheduler as unknown as SchedulerInternals;
      expect(() => opts.resolveProvider('ollama', undefined)).toThrow();
    } finally {
      await runtime.dispose();
    }
  });
});

// Task 4.3b — SESSION CREATION must be disk-free too. `buildSessionContext`
// (the DEFAULT sessionContextFactory buildRuntime wires) read config.json
// unconditionally for the per-session learning/review/recall wiring, so the
// FIRST TURN of an injected-settings embed silently ignored the injected
// learning/review settings (no config on disk) or THREW on a malformed
// config.json. Same technique as Task 4.3 above: poisoned config.json +
// HARNESS_CONFIG pointed at it — session-construction success IS the proof
// disk was never read, and the injected learning values governing the wiring
// proves the injected object (not schema defaults) was applied. The
// no-injection control proves the disk path is structurally unchanged.
describe('Settings injection — session creation (buildSessionContext) is disk-free when injected', () => {
  let home: string;
  let cwd: string;
  const prevConfig = process.env.HARNESS_CONFIG;

  const corruptDisk = (): void => {
    writeFileSync(join(home, 'config.json'), '{ this is not json');
    writeFileSync(join(home, 'settings.json'), '{ this is not json');
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'inject-session-home-'));
    cwd = mkdtempSync(join(tmpdir(), 'inject-session-cwd-'));
    process.env.HARNESS_CONFIG = join(home, 'config.json');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    if (prevConfig === undefined) Reflect.deleteProperty(process.env, 'HARNESS_CONFIG');
    else process.env.HARNESS_CONFIG = prevConfig;
  });

  const buildInjected = (settings: NonNullable<Parameters<typeof buildRuntime>[0]['settings']>) =>
    buildRuntime({
      harnessHome: home,
      cwd,
      provider: 'ollama', // keyless; no network when preflight is off
      preflight: false,
      cronEnabled: false,
      settings,
    });

  test('first session builds despite malformed disk config; default wiring (recall/observer/review) is on', async () => {
    corruptDisk();
    const runtime = await buildInjected({ defaultModel: 'injected-model' });
    try {
      const sessionId = runtime.sessionDb.createSession({
        model: runtime.model,
        provider: 'ollama',
      });
      // RED against pre-4.3b code: buildSessionContext's unconditional
      // readConfig throws on the poisoned config.json.
      const ctx = runtime.getSessionContext(sessionId);
      expect(ctx.sessionId).toBe(sessionId);
      // Defaults (recall ON, learning ON, review ON) — all built without disk.
      expect(ctx.recall).toBeDefined();
      expect(ctx.learningObserver).toBeDefined();
      expect(ctx.reviewManager).toBeDefined();
    } finally {
      await runtime.dispose();
    }
  });

  test('injected learning settings GOVERN the session wiring (recall off + learning disabled honored)', async () => {
    corruptDisk();
    const runtime = await buildInjected({
      defaultModel: 'injected-model',
      learning: {
        disabled: true,
        recall: { enabled: false, maxLessons: 8, tokenBudget: 1200 },
      },
    });
    try {
      const sessionId = runtime.sessionDb.createSession({
        model: runtime.model,
        provider: 'ollama',
      });
      const ctx = runtime.getSessionContext(sessionId);
      // The injected values — NOT the ON-by-default fallbacks — shaped the
      // session: observer + recall thunk both absent.
      expect(ctx.learningObserver).toBeUndefined();
      expect(ctx.recall).toBeUndefined();
      // Review left at its default (injected object carries no review block).
      expect(ctx.reviewManager).toBeDefined();
    } finally {
      await runtime.dispose();
    }
  });

  test('control — without injection, session creation still reads disk (throws on malformed config)', async () => {
    // Boot against a VALID disk config, then corrupt it: the session-creation
    // throw proves buildSessionContext's disk read is structurally unchanged.
    writeFileSync(join(home, 'config.json'), JSON.stringify({ defaultModel: 'disk-model' }));
    writeFileSync(join(home, 'settings.json'), JSON.stringify({}));
    const runtime = await buildRuntime({
      harnessHome: home,
      cwd,
      provider: 'ollama',
      preflight: false,
      cronEnabled: false,
    });
    try {
      corruptDisk();
      const sessionId = runtime.sessionDb.createSession({
        model: runtime.model,
        provider: 'ollama',
      });
      expect(() => runtime.getSessionContext(sessionId)).toThrow();
    } finally {
      await runtime.dispose();
    }
  });
});

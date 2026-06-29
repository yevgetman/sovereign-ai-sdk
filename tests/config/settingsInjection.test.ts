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
} from '../../src/config/settings.js';
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

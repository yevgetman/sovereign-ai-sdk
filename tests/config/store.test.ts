import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatValue,
  getAt,
  parseValueLiteral,
  readConfig,
  redactSecrets,
  resolveConfigPath,
  setAt,
  unsetAt,
  writeConfig,
} from '../../src/config/store.js';

describe('config store', () => {
  let dir: string;
  let path: string;
  const prevEnv = process.env.HARNESS_CONFIG;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harness-cfg-'));
    path = join(dir, 'config.json');
    process.env.HARNESS_CONFIG = path;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevEnv === undefined) Reflect.deleteProperty(process.env, 'HARNESS_CONFIG');
    else process.env.HARNESS_CONFIG = prevEnv;
  });

  test('readConfig returns empty when file missing', () => {
    // Missing file → the bare `{}` early-return. Every field on `Settings` is
    // optional, so `{}` IS a valid Settings and no `thinking` block is forged.
    expect(readConfig()).toEqual({});
  });

  test('writeConfig + readConfig round-trip and validate against schema', () => {
    writeConfig({ defaultProvider: 'ollama' });
    // `thinking` is an OPTIONAL block now — an absent block parses to absent,
    // so neither the on-disk JSON nor the re-read config materializes it.
    expect(readConfig()).toEqual({ defaultProvider: 'ollama' });
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    expect(onDisk).toEqual({ defaultProvider: 'ollama' });
  });

  test('setAt creates intermediate objects and validates result', () => {
    const next = setAt({}, 'providers.ollama.model', 'qwen2.5:7b');
    expect(next.providers?.ollama?.model).toBe('qwen2.5:7b');
  });

  test('setAt rejects invalid values via zod', () => {
    expect(() => setAt({}, 'permissionMode', 'loud')).toThrow();
  });

  test('setAt is immutable on input', () => {
    const original = { defaultProvider: 'anthropic' };
    setAt(original, 'defaultProvider', 'ollama');
    expect(original.defaultProvider).toBe('anthropic');
  });

  test('getAt walks dot-paths and returns undefined for missing', () => {
    const settings = setAt({}, 'providers.ollama.model', 'qwen2.5:7b');
    expect(getAt(settings, 'providers.ollama.model')).toBe('qwen2.5:7b');
    expect(getAt(settings, 'providers.openai.model')).toBeUndefined();
    expect(getAt(settings, 'nope')).toBeUndefined();
  });

  test('unsetAt removes the leaf and prunes empty parents', () => {
    let settings = setAt({}, 'providers.ollama.model', 'qwen2.5:7b');
    settings = unsetAt(settings, 'providers.ollama.model');
    // `thinking` is optional now — the schema re-parse materializes nothing,
    // so the pruned result is exactly `{}`.
    expect(settings).toEqual({});
  });

  test('unsetAt is a no-op when path missing', () => {
    const settings = setAt({}, 'defaultProvider', 'ollama');
    expect(unsetAt(settings, 'providers.ollama.model')).toEqual(settings);
  });

  test('parseValueLiteral coerces booleans, numbers, JSON, and strings', () => {
    expect(parseValueLiteral('true')).toBe(true);
    expect(parseValueLiteral('false')).toBe(false);
    expect(parseValueLiteral('null')).toBeNull();
    expect(parseValueLiteral('42')).toBe(42);
    expect(parseValueLiteral('3.14')).toBe(3.14);
    expect(parseValueLiteral('{"a":1}')).toEqual({ a: 1 });
    expect(parseValueLiteral('hello')).toBe('hello');
  });

  test('redactSecrets replaces apiKey, apiKeys, and credentials apiKey', () => {
    const settings = {
      providers: {
        anthropic: { apiKey: 'sk-secret', apiKeys: ['a', 'b'] },
        openai: { credentials: [{ id: 'one', apiKey: 'sk-x' }] },
      },
    };
    const out = redactSecrets(settings);
    expect(out.providers?.anthropic?.apiKey).toBe('***');
    expect(out.providers?.anthropic?.apiKeys).toEqual(['***', '***']);
    expect(out.providers?.openai?.credentials?.[0]?.apiKey).toBe('***');
    // Original unchanged.
    expect(settings.providers.anthropic.apiKey).toBe('sk-secret');
  });

  test('formatValue renders strings and JSON', () => {
    expect(formatValue('ollama')).toBe('ollama');
    expect(formatValue(undefined)).toBe('(unset)');
    expect(formatValue(42)).toBe('42');
    expect(formatValue({ a: 1 })).toContain('"a": 1');
  });

  // Audit 2026-06-10 — channel secrets were schema-valid but unredacted, so
  // `sov config show` / any config dump printed them in clear.
  test('redactSecrets masks channel secrets (botToken/signingSecret/authToken/secret)', () => {
    const settings = {
      gateway: {
        channels: {
          slack: { botToken: 'xoxb-real', signingSecret: 'sign-real' },
          telegram: { botToken: 'tg-real' },
          webhook: { secret: 'hook-real' },
          sms: { accountSid: 'AC123', authToken: 'auth-real' },
        },
      },
    } as Record<string, unknown>;
    const out = redactSecrets(settings);
    const pick = (...path: string[]): unknown => getAt(out, path.join('.'));
    expect(pick('gateway', 'channels', 'slack', 'botToken')).toBe('***');
    expect(pick('gateway', 'channels', 'slack', 'signingSecret')).toBe('***');
    expect(pick('gateway', 'channels', 'telegram', 'botToken')).toBe('***');
    expect(pick('gateway', 'channels', 'webhook', 'secret')).toBe('***');
    expect(pick('gateway', 'channels', 'sms', 'authToken')).toBe('***');
  });

  // Audit 2026-06-10 — a __proto__/constructor/prototype dotpath segment must
  // never traverse into Object.prototype (prototype pollution).
  test('setAt rejects prototype-pollution dotpaths', () => {
    expect(() => setAt({}, '__proto__.polluted', 'PWNED')).toThrow();
    expect(() => setAt({}, 'a.constructor.x', 1)).toThrow();
    expect(() => setAt({}, 'prototype.x', 1)).toThrow();
    // Pollution did NOT happen.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('unsetAt rejects prototype-pollution dotpaths', () => {
    expect(() => unsetAt({}, '__proto__.hasOwnProperty')).toThrow();
    // hasOwnProperty still works on a fresh object.
    expect(Object.prototype.hasOwnProperty.call({ a: 1 }, 'a')).toBe(true);
  });

  test('writeConfig is atomic — failure leaves no partial file', () => {
    expect(() => writeConfig({ permissionMode: 'loud' as never })).toThrow();
    expect(existsSync(path)).toBe(false);
  });

  test('rejected set never touches disk', () => {
    writeConfig({ defaultProvider: 'ollama' });
    expect(() => {
      const next = setAt(readConfig(), 'permissionMode', 'loud');
      writeConfig(next);
    }).toThrow();
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    expect(onDisk).toEqual({ defaultProvider: 'ollama' });
  });

  test('refuses to traverse into arrays', () => {
    writeFileSync(
      path,
      JSON.stringify({ providers: { anthropic: { credentials: [{ apiKey: 'x' }] } } }),
    );
    expect(() => setAt(readConfig(), 'providers.anthropic.credentials.0.apiKey', 'y')).toThrow();
  });
});

// Backlog #55 — config home isolation. resolveConfigPath / readConfig must
// honor a caller-supplied harnessHome for the FALLBACK location (when no
// explicit path and no HARNESS_CONFIG env), instead of always defaulting to
// the global resolveHarnessHome(). These tests clear HARNESS_HOME +
// HARNESS_CONFIG so they assert the threading, not the env fallback.
describe('config store — harnessHome isolation (#55)', () => {
  let dir: string;
  const prevHome = process.env.HARNESS_HOME;
  const prevConfig = process.env.HARNESS_CONFIG;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harness-cfg-home-'));
    // biome-ignore lint/performance/noDelete: must truly unset so the fallback can't accidentally match.
    delete process.env.HARNESS_HOME;
    // biome-ignore lint/performance/noDelete: same — no explicit config override.
    delete process.env.HARNESS_CONFIG;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevHome === undefined) Reflect.deleteProperty(process.env, 'HARNESS_HOME');
    else process.env.HARNESS_HOME = prevHome;
    if (prevConfig === undefined) Reflect.deleteProperty(process.env, 'HARNESS_CONFIG');
    else process.env.HARNESS_CONFIG = prevConfig;
  });

  test('resolveConfigPath falls back to <harnessHome>/config.json', () => {
    expect(resolveConfigPath(undefined, dir)).toBe(join(dir, 'config.json'));
  });

  test('readConfig({ harnessHome }) reads <harnessHome>/config.json', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ defaultProvider: 'ollama' }));
    expect(readConfig({ harnessHome: dir })).toEqual({ defaultProvider: 'ollama' });
  });

  test('explicit HARNESS_CONFIG still wins over harnessHome', () => {
    // The home config says ollama; the explicit override says anthropic.
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ defaultProvider: 'ollama' }));
    const overrideDir = mkdtempSync(join(tmpdir(), 'harness-cfg-ovr-'));
    const overridePath = join(overrideDir, 'config.json');
    writeFileSync(overridePath, JSON.stringify({ defaultProvider: 'anthropic' }));
    process.env.HARNESS_CONFIG = overridePath;
    try {
      // The explicit env override takes precedence over the harnessHome fallback.
      expect(resolveConfigPath(undefined, dir)).toBe(overridePath);
      expect(readConfig({ harnessHome: dir })).toEqual({ defaultProvider: 'anthropic' });
    } finally {
      // biome-ignore lint/performance/noDelete: unset before afterEach restores the saved value.
      delete process.env.HARNESS_CONFIG;
      rmSync(overrideDir, { recursive: true, force: true });
    }
  });

  test('explicit path arg still wins over harnessHome', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ defaultProvider: 'ollama' }));
    const explicitDir = mkdtempSync(join(tmpdir(), 'harness-cfg-exp-'));
    const explicitPath = join(explicitDir, 'config.json');
    writeFileSync(explicitPath, JSON.stringify({ defaultProvider: 'openai' }));
    try {
      expect(resolveConfigPath(explicitPath, dir)).toBe(explicitPath);
      expect(readConfig({ path: explicitPath, harnessHome: dir })).toEqual({
        defaultProvider: 'openai',
      });
    } finally {
      rmSync(explicitDir, { recursive: true, force: true });
    }
  });
});

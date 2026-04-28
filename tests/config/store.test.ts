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
    expect(readConfig()).toEqual({});
  });

  test('writeConfig + readConfig round-trip and validate against schema', () => {
    writeConfig({ defaultProvider: 'ollama' });
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

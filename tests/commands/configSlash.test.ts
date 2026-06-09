import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchSlashCommand } from '../../src/commands/registry.js';
import { makeCtx } from './_makeCtx.js';

describe('/config slash command', () => {
  let dir: string;
  let path: string;
  const prevEnv = process.env.HARNESS_CONFIG;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harness-cfg-slash-'));
    path = join(dir, 'config.json');
    process.env.HARNESS_CONFIG = path;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevEnv === undefined) Reflect.deleteProperty(process.env, 'HARNESS_CONFIG');
    else process.env.HARNESS_CONFIG = prevEnv;
  });

  test('show on missing file returns empty object', async () => {
    const result = await dispatchSlashCommand('/config show', makeCtx());
    expect(result.kind).toBe('local');
    if (result.kind === 'local') expect(result.output).toBe('{}');
  });

  test('set writes to disk and re-reads', async () => {
    await dispatchSlashCommand('/config set defaultProvider ollama', makeCtx());
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    expect(onDisk).toEqual({ defaultProvider: 'ollama' });

    const get = await dispatchSlashCommand('/config get defaultProvider', makeCtx());
    if (get.kind === 'local') expect(get.output).toBe('ollama');
  });

  test('set parses value literals (boolean)', async () => {
    await dispatchSlashCommand('/config set microcompaction.enabled false', makeCtx());
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    expect(onDisk.microcompaction.enabled).toBe(false);
  });

  test('unset removes the value and prunes parents', async () => {
    await dispatchSlashCommand('/config set providers.ollama.model qwen2.5:7b', makeCtx());
    await dispatchSlashCommand('/config unset providers.ollama.model', makeCtx());
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    // The pruned providers parent is gone; `thinking` is optional so nothing
    // is forged — disk is exactly `{}`.
    expect(onDisk).toEqual({});
  });

  test('schema rejection surfaces a config error', async () => {
    const result = await dispatchSlashCommand('/config set permissionMode loud', makeCtx());
    if (result.kind === 'local') expect(result.output).toContain('config error');
  });

  // 2026-05-24 — bare `/config` now opens the catalog picker rather than
  // dumping JSON. The legacy JSON-dump path is preserved as `/config show`.
  test('show explicitly returns persisted JSON', async () => {
    await dispatchSlashCommand('/config set defaultProvider ollama', makeCtx());
    const result = await dispatchSlashCommand('/config show', makeCtx());
    if (result.kind === 'local') expect(result.output).toContain('ollama');
  });

  test('get redacts secrets', async () => {
    await dispatchSlashCommand('/config set providers.anthropic.apiKey sk-secret', makeCtx());
    const result = await dispatchSlashCommand('/config get providers.anthropic.apiKey', makeCtx());
    if (result.kind === 'local') expect(result.output).toBe('***');
  });
});

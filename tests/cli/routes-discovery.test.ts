import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { UNKNOWN_CONTEXT_TOKENS } from '@yevgetman/sov-sdk/providers/modelLimits';
import { findModel } from '@yevgetman/sov-sdk/providers/models/index';
import { readModelCatalogSnapshot } from '../../src/cli/modelDiscovery.js';
const cli = resolve('src/main.ts');
describe('route CLI discovery in an isolated home', () => {
  test('machine probes emit only versioned non-secret JSON and require no credential', async () => {
    const home = await mkdtemp(join(tmpdir(), 'sov-routes-cli-'));
    try {
      await writeFile(
        join(home, 'config.json'),
        JSON.stringify({ providers: { openai: { apiKey: 'FAKE-SECRET-KEY', model: 'gpt-4o' } } }),
      );
      for (const args of [
        ['capabilities'],
        ['routes'],
        ['models', '--route', 'openrouter-api'],
        ['models', '--route', 'grok-subscription'],
        ['auth', 'status', '--route', 'openai-api'],
      ]) {
        const child = Bun.spawn([process.execPath, cli, ...args, '--json'], {
          env: { PATH: process.env.PATH, HOME: home, HARNESS_HOME: home },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const stdout = await new Response(child.stdout).text();
        expect(await child.exited).toBe(0);
        expect(stdout.trim().split('\n')).toHaveLength(1);
        const value = JSON.parse(stdout);
        expect(value.schemaVersion).toBe(1);
        expect(stdout).not.toContain('FAKE-SECRET-KEY');
        if (args[0] === 'routes') expect(value.routes).toHaveLength(6);
        if (args[0] === 'auth')
          expect(value).toMatchObject({
            route: 'openai-api',
            provider: 'openai',
            auth: 'api_key',
            credentialState: 'present',
            refreshable: false,
          });
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('an empty grok subscription cache still returns the fresh pin', () => {
    const home = mkdtempSync(join(tmpdir(), 'sov-grok-pin-'));
    try {
      const catalog = readModelCatalogSnapshot('grok-subscription', {}, home);
      const current = findModel(catalog, 'grok-4.7');
      expect(current.metadata).toMatchObject({ source: 'xai-docs-2026-10-10', stale: false });
      expect(current.contextWindow).toBe(500_000);
      const older = findModel(catalog, 'grok-4.6');
      expect(older.contextWindow).toBeUndefined();
      expect(older.metadata.stale).toBe(false);
      expect(UNKNOWN_CONTEXT_TOKENS).toBe(32_768);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

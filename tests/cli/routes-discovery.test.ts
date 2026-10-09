import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
});

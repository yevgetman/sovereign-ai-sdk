import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// Every probe starts a fresh module cache. Suite ordering must not conceal a TDZ.
const entries = ['resolver', 'models', 'modelReasoning', 'routes/catalog', 'models/ownerRegistry'];
for (const engine of ['bun', 'node'] as const) {
  for (const entry of entries) {
    test(`${engine} provider modules initialize when ${entry} is imported first`, () => {
      const root =
        engine === 'bun' ? './packages/sdk/src/providers' : './packages/sdk/dist/providers';
      const extension = engine === 'bun' ? 'ts' : 'js';
      const modulePath = (name: string) => JSON.stringify(`${root}/${name}.${extension}`);
      const code = `
        await import(${modulePath(entry)});
        const { PROVIDER_REGISTRY } = await import(${modulePath('models')});
        const { listRoutes } = await import(${modulePath('routes/catalog')});
        const { reasoningControlFor } = await import(${modulePath('modelReasoning')});
        const { validateOwnerGrokRegistry } = await import(${modulePath('models/ownerRegistry')});
        if (!PROVIDER_REGISTRY.anthropic.defaultModel || listRoutes().length !== 6 ||
            reasoningControlFor('grok', 'grok-4.6').parameter !== 'grok' ||
            typeof validateOwnerGrokRegistry !== 'function') throw new Error('Provider initialization incomplete');
        process.stdout.write('provider-startup-ok');
      `;
      const result = spawnSync(
        engine === 'bun' ? process.execPath : 'node',
        engine === 'bun' ? ['-e', code] : ['--input-type=module', '-e', code],
        {
          cwd: join(import.meta.dir, '../..'),
          encoding: 'utf8',
          timeout: 10000,
          env: { ...process.env, FORCE_COLOR: undefined },
        },
      );
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('provider-startup-ok');
    });
  }
}

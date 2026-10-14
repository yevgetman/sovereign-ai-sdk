import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionMode } from '@yevgetman/sov-sdk/permissions/types';
import { buildRuntime } from '../../src/server/runtime.js';

const modes = ['default', 'ask', 'bypass'] as const;
const layers = ['config', 'injected', 'user', 'project', 'local'] as const;

for (const layer of layers) {
  for (const configured of modes) {
    for (const requested of [undefined, ...modes]) {
      test(`${layer} ${configured}: requested ${requested ?? 'omitted'} wins when explicit`, async () => {
        const home = mkdtempSync(join(tmpdir(), 'runtime-permission-'));
        const cwd = join(home, 'project');
        mkdirSync(join(cwd, '.harness'), { recursive: true });
        const priorConfig = process.env.HARNESS_CONFIG;
        // Keep the entire configuration fixture in temporary storage.
        process.env.HARNESS_CONFIG = join(home, 'config.json');
        const path =
          layer === 'config'
            ? join(home, 'config.json')
            : layer === 'user'
              ? join(home, 'settings.json')
              : join(cwd, '.harness', layer === 'local' ? 'settings.local.json' : 'settings.json');
        if (layer !== 'injected')
          writeFileSync(path, JSON.stringify({ permissionMode: configured }));
        const runtime = await buildRuntime({
          cwd,
          harnessHome: home,
          provider: 'mock',
          preflight: false,
          cronEnabled: false,
          ...(layer === 'injected' ? { settings: { permissionMode: configured } } : {}),
          ...(requested !== undefined ? { permissionMode: requested as PermissionMode } : {}),
        });
        try {
          expect(runtime.permissionMode).toBe(requested ?? configured);
        } finally {
          await runtime.dispose();
          if (priorConfig === undefined) Reflect.deleteProperty(process.env, 'HARNESS_CONFIG');
          else process.env.HARNESS_CONFIG = priorConfig;
          rmSync(home, { recursive: true, force: true });
        }
      });
    }
  }
}

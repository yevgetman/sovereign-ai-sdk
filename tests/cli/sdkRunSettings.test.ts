import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionPersistenceError } from '@yevgetman/sov-sdk/providers/errors';
import { getRoute } from '@yevgetman/sov-sdk/providers/routes/index';
import { SessionDb } from '../../src/agent/sessionDb.js';
import { SOV_ROUTE_CAPABILITIES } from '../../src/cli/routesCommands.js';
import { runSdkRunCommand } from '../../src/cli/sdkRunCommand.js';
import type { SdkRunDependencies } from '../../src/cli/sdkRunCommand.js';
import type { RuntimeOptions } from '../../src/server/runtime.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const options = {
  json: true,
  stdin: true,
  route: 'openai-api',
  inputFormat: 'json',
  toolset: 'chat',
};
function isolated() {
  const root = mkdtempSync(join(tmpdir(), 'native-settings-'));
  dirs.push(root);
  const home = join(root, 'profile');
  const cwd = join(root, 'node');
  mkdirSync(home);
  mkdirSync(join(cwd, '.harness'), { recursive: true });
  const oldCwd = process.cwd();
  const oldHome = process.env.HARNESS_HOME;
  const oldConfig = process.env.HARNESS_CONFIG;
  process.env.HARNESS_HOME = home;
  process.env.HARNESS_CONFIG = join(home, 'config.json');
  process.chdir(cwd);
  return {
    root,
    home,
    cwd,
    restore() {
      process.chdir(oldCwd);
      if (oldHome === undefined) Reflect.deleteProperty(process.env, 'HARNESS_HOME');
      else process.env.HARNESS_HOME = oldHome;
      if (oldConfig === undefined) Reflect.deleteProperty(process.env, 'HARNESS_CONFIG');
      else process.env.HARNESS_CONFIG = oldConfig;
    },
  };
}
function capture() {
  const events: Record<string, unknown>[] = [];
  return {
    events,
    io: {
      readStdin: async () => JSON.stringify({ inputVersion: 1, text: 'hello' }),
      writeStdout: (line: string) => events.push(JSON.parse(line)),
    },
  };
}
const resolve: NonNullable<SdkRunDependencies['resolve']> = async () => ({
  route: getRoute('openai-api', {}),
  model: 'gpt-4.1',
  effort: 'off',
  provider: {} as never,
  resolved: {} as never,
});

for (const contents of [
  '{broken SECRET_SENTINEL',
  JSON.stringify({
    mcpServers: {
      'private-alias': { type: 'http', url: 'https://example.invalid' },
      private_alias: { type: 'http', url: 'https://example.invalid' },
    },
  }),
  JSON.stringify({ skills: { discovery: { allowedLinkRoots: 'SECRET_SENTINEL' } } }),
  JSON.stringify({ skills: { discovery: { allowedLinkRoots: [], unknown: 'SECRET_SENTINEL' } } }),
]) {
  test('native settings validation precedes credentials and preserves an existing resume target', async () => {
    const f = isolated();
    try {
      const dbPath = join(f.home, 'sessions.db');
      const db = SessionDb.open({ path: dbPath });
      const sessionId = db.createSession({ provider: 'openai', model: 'gpt-4.1' });
      db.saveMessage(sessionId, { role: 'user', content: [{ type: 'text', text: 'keep me' }] });
      db.close();
      const before = readFileSync(dbPath);
      writeFileSync(join(f.cwd, '.harness', 'settings.local.json'), contents);
      let credentialCalls = 0;
      let bootCalls = 0;
      const c = capture();
      const result = await runSdkRunCommand({ ...options, db: dbPath, resume: sessionId }, c.io, {
        resolve: async () => {
          credentialCalls++;
          throw new Error('credentials must not be read');
        },
        runtime: async () => {
          bootCalls++;
          throw new Error('runtime must not start');
        },
      });
      expect(result).toBe(1);
      expect(credentialCalls).toBe(0);
      expect(bootCalls).toBe(0);
      expect(c.events).toEqual([
        expect.objectContaining({
          type: 'turn.error',
          code: 'configuration_invalid',
          reason: 'configuration_invalid',
          nextAction: 'check_configuration',
          sessionId: null,
          recoverable: false,
        }),
      ]);
      expect(JSON.stringify(c.events)).not.toContain('SECRET_SENTINEL');
      expect(JSON.stringify(c.events)).not.toContain(f.root);
      expect(readFileSync(dbPath)).toEqual(before);
    } finally {
      f.restore();
    }
  });
}

test('native validates host approval input before credential access', async () => {
  const f = isolated();
  try {
    const c = capture();
    let calls = 0;
    expect(
      await runSdkRunCommand(
        { ...options, skillApprovalFile: join(f.root, 'missing.json') },
        c.io,
        {
          resolve: async () => {
            calls++;
            throw new Error('must not resolve');
          },
        },
      ),
    ).toBe(1);
    expect(calls).toBe(0);
    expect(c.events).toEqual([
      expect.objectContaining({ code: 'configuration_invalid', nextAction: 'check_configuration' }),
    ]);
  } finally {
    f.restore();
  }
});

test('native forwards its precredential snapshot and exact host approval input', async () => {
  const f = isolated();
  try {
    const approval = join(f.home, 'settings.json');
    writeFileSync(approval, JSON.stringify({ skills: { discovery: { allowedLinkRoots: [] } } }));
    let received: RuntimeOptions | undefined;
    const c = capture();
    expect(
      await runSdkRunCommand({ ...options, skillApprovalFile: approval }, c.io, {
        resolve,
        runtime: async (opts) => {
          received = opts;
          throw new Error('stop at boot');
        },
      }),
    ).toBe(1);
    expect(received?.skillApprovalFile).toBe(approval);
    expect(received?.settingsSnapshot?.discovery.allowedLinkRoots).toEqual([]);
    expect(received?.settingsSnapshot?.config).toEqual({});
    expect(c.events).toEqual([
      expect.objectContaining({ code: 'runtime_start_failed', sessionId: null }),
    ]);
  } finally {
    f.restore();
  }
});

for (const [error, code, nextAction] of [
  [new Error('PRIVATE_BOOT_SENTINEL'), 'runtime_start_failed', 'repair_request'],
  [
    new SessionPersistenceError(new Error('PRIVATE_STORAGE_SENTINEL')),
    'storage_failed',
    'inspect_storage',
  ],
] as const) {
  test(`native boot error remains ${code}`, async () => {
    const f = isolated();
    try {
      const c = capture();
      expect(
        await runSdkRunCommand(options, c.io, {
          resolve,
          runtime: async () => {
            throw error;
          },
        }),
      ).toBe(1);
      expect(c.events).toEqual([expect.objectContaining({ code, nextAction, sessionId: null })]);
      expect(JSON.stringify(c.events)).not.toContain('SENTINEL');
    } finally {
      f.restore();
    }
  });
}

test('capabilities advertise the exact skill settings contract offline', () => {
  expect(SOV_ROUTE_CAPABILITIES.skillSettings).toEqual({
    schemaVersion: 1,
    sources: ['node-local', 'profile-settings', 'profile-config'],
    listPolicy: 'replace',
    approvalFileOption: '--skill-approval-file',
    doctorSchemaVersion: 1,
  });
});

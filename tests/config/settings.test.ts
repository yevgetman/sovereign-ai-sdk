import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendProjectLocalPermissionRule,
  loadHookSettings,
  loadMcpServerSettings,
  loadPermissionSettings,
} from '../../src/config/settings.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-settings-test-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('loadPermissionSettings', () => {
  test('loads local, project, user layers in precedence order', () => {
    const root = tempRoot();
    const cwd = join(root, 'project');
    const harnessHome = join(root, 'home');
    writeJson(join(harnessHome, 'settings.json'), {
      permissionMode: 'ask',
      permissions: { deny: ['Bash(rm *)'] },
    });
    writeJson(join(cwd, '.harness', 'settings.json'), {
      permissions: { allow: ['Write(project.txt)'] },
    });
    writeJson(join(cwd, '.harness', 'settings.local.json'), {
      permissionMode: 'bypass',
      permissions: { allow: ['Bash(pwd)'] },
    });

    const loaded = loadPermissionSettings({ cwd, harnessHome });
    expect(loaded.mode).toBe('bypass');
    expect(loaded.layers.map((l) => l.source)).toEqual([
      join(cwd, '.harness', 'settings.local.json'),
      join(cwd, '.harness', 'settings.json'),
      join(harnessHome, 'settings.json'),
    ]);
    expect(loaded.layers.map((l) => l.rules.map((r) => r.raw))).toEqual([
      ['Bash(pwd)'],
      ['Write(project.txt)'],
      ['Bash(rm *)'],
    ]);
  });

  test('rejects unknown keys', () => {
    const root = tempRoot();
    const cwd = join(root, 'project');
    const harnessHome = join(root, 'home');
    writeJson(join(cwd, '.harness', 'settings.json'), { nope: true });
    expect(() => loadPermissionSettings({ cwd, harnessHome })).toThrow();
  });
});

describe('appendProjectLocalPermissionRule', () => {
  test('creates project-local settings and deduplicates allow rules', () => {
    const root = tempRoot();
    const cwd = join(root, 'project');
    appendProjectLocalPermissionRule({ cwd, rule: 'FileWrite(note.txt)', behavior: 'allow' });
    appendProjectLocalPermissionRule({ cwd, rule: 'FileWrite(note.txt)', behavior: 'allow' });

    const raw = JSON.parse(
      readFileSync(join(cwd, '.harness', 'settings.local.json'), 'utf8'),
    ) as unknown;
    expect(raw).toEqual({
      permissions: {
        allow: ['FileWrite(note.txt)'],
        deny: [],
        ask: [],
      },
    });
  });
});

describe('loadMcpServerSettings', () => {
  test('concatenates servers across layers', () => {
    const root = tempRoot();
    const cwd = join(root, 'project');
    const harnessHome = join(root, 'home');
    writeJson(join(harnessHome, 'settings.json'), {
      mcpServers: { user_fs: { command: 'fsd' } },
    });
    writeJson(join(cwd, '.harness', 'settings.json'), {
      mcpServers: { project_db: { command: 'dbd', args: ['--port', '5432'] } },
    });

    const loaded = loadMcpServerSettings({ cwd, harnessHome });
    expect(Object.keys(loaded.servers).sort()).toEqual(['project_db', 'user_fs']);
    const projectDb = loaded.servers.project_db;
    if (projectDb?.type !== 'stdio') throw new Error('expected stdio variant');
    expect(projectDb.args).toEqual(['--port', '5432']);
    expect(loaded.sources).toHaveLength(2);
  });

  test('returns empty when no settings declare mcpServers', () => {
    const root = tempRoot();
    const cwd = join(root, 'project');
    const harnessHome = join(root, 'home');
    writeJson(join(cwd, '.harness', 'settings.json'), { permissions: { allow: ['Bash(ls)'] } });
    const loaded = loadMcpServerSettings({ cwd, harnessHome });
    expect(loaded.servers).toEqual({});
    expect(loaded.sources).toEqual([]);
  });

  test('duplicate aliases across layers throws', () => {
    const root = tempRoot();
    const cwd = join(root, 'project');
    const harnessHome = join(root, 'home');
    writeJson(join(harnessHome, 'settings.json'), {
      mcpServers: { fs: { command: 'fs-user' } },
    });
    writeJson(join(cwd, '.harness', 'settings.json'), {
      mcpServers: { fs: { command: 'fs-project' } },
    });
    expect(() => loadMcpServerSettings({ cwd, harnessHome })).toThrow(/fs/);
  });

  test('aliases that normalize to the same SOV_MCP_* env var throw', () => {
    const root = tempRoot();
    const cwd = join(root, 'project');
    const harnessHome = join(root, 'home');
    // `foo-bar` and `foo_bar` both normalize to SOV_MCP_FOO_BAR_TOKEN, so a
    // single env var would be applied to two different hosts — reject it.
    writeJson(join(cwd, '.harness', 'settings.json'), {
      mcpServers: {
        'foo-bar': { type: 'http', url: 'https://a.example.com' },
        foo_bar: { type: 'http', url: 'https://b.example.com' },
      },
    });
    expect(() => loadMcpServerSettings({ cwd, harnessHome })).toThrow(
      /SOV_MCP_FOO_BAR|env var|collid/i,
    );
  });

  test('rejects unknown keys inside server config', () => {
    const root = tempRoot();
    const cwd = join(root, 'project');
    const harnessHome = join(root, 'home');
    writeJson(join(cwd, '.harness', 'settings.json'), {
      mcpServers: { fs: { command: 'fs', bogus: true } },
    });
    expect(() => loadMcpServerSettings({ cwd, harnessHome })).toThrow();
  });

  // Remote transport (HTTP/SSE) — config union back-compat + new variants.

  test('legacy stdio config (no type) parses unchanged and gains type:stdio', () => {
    const root = tempRoot();
    const cwd = join(root, 'project');
    const harnessHome = join(root, 'home');
    writeJson(join(cwd, '.harness', 'settings.json'), {
      mcpServers: { fs: { command: 'fsd', args: ['--x'] } },
    });
    const loaded = loadMcpServerSettings({ cwd, harnessHome });
    const fs = loaded.servers.fs;
    expect(fs?.type).toBe('stdio');
    if (fs?.type !== 'stdio') throw new Error('expected stdio variant');
    expect(fs.command).toBe('fsd');
    expect(fs.args).toEqual(['--x']);
  });

  test('empty config object yields no servers (defeats nested-default gotcha)', () => {
    const root = tempRoot();
    const cwd = join(root, 'project');
    const harnessHome = join(root, 'home');
    writeJson(join(cwd, '.harness', 'settings.json'), {});
    const loaded = loadMcpServerSettings({ cwd, harnessHome });
    expect(loaded.servers).toEqual({});
  });

  test('http variant parses with url + headers + bearerToken', () => {
    const root = tempRoot();
    const cwd = join(root, 'project');
    const harnessHome = join(root, 'home');
    writeJson(join(cwd, '.harness', 'settings.json'), {
      mcpServers: {
        remote: {
          type: 'http',
          url: 'https://mcp.example.com/v1',
          headers: { 'X-Tenant': 'acme' },
          bearerToken: 'tok',
        },
      },
    });
    const loaded = loadMcpServerSettings({ cwd, harnessHome });
    const remote = loaded.servers.remote;
    expect(remote?.type).toBe('http');
    if (remote?.type !== 'http') throw new Error('expected http variant');
    expect(remote.url).toBe('https://mcp.example.com/v1');
    expect(remote.headers).toEqual({ 'X-Tenant': 'acme' });
    expect(remote.bearerToken).toBe('tok');
  });

  test('sse variant parses with url + apiKey', () => {
    const root = tempRoot();
    const cwd = join(root, 'project');
    const harnessHome = join(root, 'home');
    writeJson(join(cwd, '.harness', 'settings.json'), {
      mcpServers: { legacy: { type: 'sse', url: 'https://sse.example.com/v1', apiKey: 'k' } },
    });
    const loaded = loadMcpServerSettings({ cwd, harnessHome });
    const legacy = loaded.servers.legacy;
    expect(legacy?.type).toBe('sse');
    if (legacy?.type !== 'sse') throw new Error('expected sse variant');
    expect(legacy.url).toBe('https://sse.example.com/v1');
    expect(legacy.apiKey).toBe('k');
  });

  test('http variant without url throws', () => {
    const root = tempRoot();
    const cwd = join(root, 'project');
    const harnessHome = join(root, 'home');
    writeJson(join(cwd, '.harness', 'settings.json'), {
      mcpServers: { remote: { type: 'http' } },
    });
    expect(() => loadMcpServerSettings({ cwd, harnessHome })).toThrow();
  });

  test('mixed command + url throws (strict, ambiguous)', () => {
    const root = tempRoot();
    const cwd = join(root, 'project');
    const harnessHome = join(root, 'home');
    writeJson(join(cwd, '.harness', 'settings.json'), {
      mcpServers: { bad: { command: 'fsd', url: 'https://x.example.com' } },
    });
    expect(() => loadMcpServerSettings({ cwd, harnessHome })).toThrow();
  });

  test('url without type throws with a friendly message', () => {
    const root = tempRoot();
    const cwd = join(root, 'project');
    const harnessHome = join(root, 'home');
    writeJson(join(cwd, '.harness', 'settings.json'), {
      mcpServers: { remote: { url: 'https://x.example.com' } },
    });
    expect(() => loadMcpServerSettings({ cwd, harnessHome })).toThrow(/type.*http.*sse/i);
  });

  test('http variant rejects unknown keys', () => {
    const root = tempRoot();
    const cwd = join(root, 'project');
    const harnessHome = join(root, 'home');
    writeJson(join(cwd, '.harness', 'settings.json'), {
      mcpServers: { remote: { type: 'http', url: 'https://x.example.com', bogus: 1 } },
    });
    expect(() => loadMcpServerSettings({ cwd, harnessHome })).toThrow();
  });
});

describe('loadHookSettings', () => {
  test('concatenates hooks from local, project, user — local first', () => {
    const root = tempRoot();
    const cwd = join(root, 'project');
    const harnessHome = join(root, 'home');
    writeJson(join(harnessHome, 'settings.json'), {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'user.sh' }] }],
      },
    });
    writeJson(join(cwd, '.harness', 'settings.json'), {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'project.sh' }] }],
        PostToolUse: [{ hooks: [{ type: 'command', command: 'audit.sh' }] }],
      },
    });
    writeJson(join(cwd, '.harness', 'settings.local.json'), {
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'local.sh' }] }],
      },
    });

    const loaded = loadHookSettings({ cwd, harnessHome });
    expect(loaded.hooksByEvent.PreToolUse.map((c) => c.hooks[0]?.command)).toEqual([
      'local.sh',
      'project.sh',
      'user.sh',
    ]);
    expect(loaded.hooksByEvent.PostToolUse.map((c) => c.hooks[0]?.command)).toEqual(['audit.sh']);
    expect(loaded.hooksByEvent.UserPromptSubmit).toEqual([]);
    expect(loaded.hooksByEvent.Stop).toEqual([]);
    expect(loaded.sources).toEqual([
      join(cwd, '.harness', 'settings.local.json'),
      join(cwd, '.harness', 'settings.json'),
      join(harnessHome, 'settings.json'),
    ]);
  });

  test('returns empty hooksByEvent when no settings declare hooks', () => {
    const root = tempRoot();
    const cwd = join(root, 'project');
    const harnessHome = join(root, 'home');
    writeJson(join(cwd, '.harness', 'settings.json'), { permissions: { allow: ['Bash(ls)'] } });

    const loaded = loadHookSettings({ cwd, harnessHome });
    expect(loaded.hooksByEvent.PreToolUse).toEqual([]);
    expect(loaded.sources).toEqual([]);
  });

  test('rejects unknown event names', () => {
    const root = tempRoot();
    const cwd = join(root, 'project');
    const harnessHome = join(root, 'home');
    writeJson(join(cwd, '.harness', 'settings.json'), {
      hooks: { Notification: [{ hooks: [{ type: 'command', command: 'x.sh' }] }] },
    });
    expect(() => loadHookSettings({ cwd, harnessHome })).toThrow();
  });
});

function writeJson(path: string, value: unknown): void {
  const dir = path.slice(0, path.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

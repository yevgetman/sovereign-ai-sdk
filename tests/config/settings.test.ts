import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RuntimeSettingsSchema,
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

  test('two REMOTE aliases that normalize to the same SOV_MCP_* env var throw', () => {
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

  test('a stdio alias colliding on env-fragment with a remote alias does NOT throw', () => {
    const root = tempRoot();
    const cwd = join(root, 'project');
    const harnessHome = join(root, 'home');
    // `foo-bar` (stdio) and `foo_bar` (http) collapse to the same env
    // fragment, but a stdio config never reads SOV_MCP_* auth env — so there
    // is no real collision and boot must NOT hard-fail.
    writeJson(join(cwd, '.harness', 'settings.json'), {
      mcpServers: {
        'foo-bar': { command: 'fsd' },
        foo_bar: { type: 'http', url: 'https://b.example.com' },
      },
    });
    const loaded = loadMcpServerSettings({ cwd, harnessHome });
    expect(Object.keys(loaded.servers).sort()).toEqual(['foo-bar', 'foo_bar']);
    const stdio = loaded.servers['foo-bar'];
    expect(stdio?.type).toBe('stdio');
  });

  test('two stdio aliases that normalize to the same env fragment do NOT throw', () => {
    const root = tempRoot();
    const cwd = join(root, 'project');
    const harnessHome = join(root, 'home');
    writeJson(join(cwd, '.harness', 'settings.json'), {
      mcpServers: {
        'foo-bar': { command: 'a' },
        foo_bar: { command: 'b' },
      },
    });
    const loaded = loadMcpServerSettings({ cwd, harnessHome });
    expect(Object.keys(loaded.servers).sort()).toEqual(['foo-bar', 'foo_bar']);
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

  test('http variant without url throws a single clear error mentioning url', () => {
    const root = tempRoot();
    const cwd = join(root, 'project');
    const harnessHome = join(root, 'home');
    writeJson(join(cwd, '.harness', 'settings.json'), {
      mcpServers: { remote: { type: 'http' } },
    });
    expect(() => loadMcpServerSettings({ cwd, harnessHome })).toThrow(/url/i);
    const issues = mcpServerIssues({ type: 'http' });
    expect(issues.length).toBe(1);
    expect(issues.some((i) => i.path.includes('url'))).toBe(true);
    expect(issues.some((i) => i.code === 'invalid_union')).toBe(false);
  });

  test('mixed command + url throws an unrecognized-key error with NO double-error', () => {
    const root = tempRoot();
    const cwd = join(root, 'project');
    const harnessHome = join(root, 'home');
    writeJson(join(cwd, '.harness', 'settings.json'), {
      mcpServers: { bad: { command: 'fsd', url: 'https://x.example.com' } },
    });
    expect(() => loadMcpServerSettings({ cwd, harnessHome })).toThrow();
    // The preprocess injects type:'stdio' (command present, no type), so the
    // stray `url` surfaces as a single unrecognized-key error — never the
    // legacy custom-issue + invalid_union pair.
    const issues = mcpServerIssues({ command: 'fsd', url: 'https://x.example.com' });
    expect(issues.length).toBe(1);
    expect(issues[0]?.code).toBe('unrecognized_keys');
    expect(issues.some((i) => i.code === 'invalid_union')).toBe(false);
  });

  test('url without type throws a single discriminator error (no double-error)', () => {
    const root = tempRoot();
    const cwd = join(root, 'project');
    const harnessHome = join(root, 'home');
    writeJson(join(cwd, '.harness', 'settings.json'), {
      mcpServers: { remote: { url: 'https://x.example.com' } },
    });
    expect(() => loadMcpServerSettings({ cwd, harnessHome })).toThrow();
    const issues = mcpServerIssues({ url: 'https://x.example.com' });
    expect(issues.length).toBe(1);
    expect(issues[0]?.code).toBe('invalid_union_discriminator');
    // The native discriminator error names the valid transports + targets the
    // `type` field by path — clear and singular.
    expect(issues[0]?.path).toContain('type');
    expect(issues[0]?.message).toMatch(/http.*sse|sse.*http/i);
    expect(issues.some((i) => i.code === 'invalid_union')).toBe(false);
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

  test('sse variant without url throws a single clear error mentioning url', () => {
    const issues = mcpServerIssues({ type: 'sse' });
    expect(issues.length).toBe(1);
    expect(issues.some((i) => i.path.includes('url'))).toBe(true);
  });

  test('strict still rejects an unknown key on a legacy stdio config', () => {
    const issues = mcpServerIssues({ command: 'fsd', bogus: true });
    expect(issues.length).toBe(1);
    expect(issues[0]?.code).toBe('unrecognized_keys');
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

/** Parse a single mcpServers entry through the runtime schema and return the
 *  Zod issues (path relative to the server config, so the `mcpServers.<alias>`
 *  prefix is stripped). Lets F8 tests assert exactly one issue of a given
 *  code — proving the double-error is gone. */
function mcpServerIssues(cfg: unknown): Array<{ code: string; path: string[]; message: string }> {
  const result = RuntimeSettingsSchema.safeParse({ mcpServers: { x: cfg } });
  if (result.success) return [];
  return result.error.issues.map((issue) => ({
    code: issue.code,
    // Drop the leading `mcpServers`, `x` segments to focus on the config shape.
    path: issue.path.slice(2).map(String),
    message: issue.message,
  }));
}

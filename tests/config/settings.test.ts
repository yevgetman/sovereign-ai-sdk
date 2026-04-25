import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendProjectLocalPermissionRule,
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

function writeJson(path: string, value: unknown): void {
  const dir = path.slice(0, path.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

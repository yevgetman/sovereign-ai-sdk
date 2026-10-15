import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ConfigurationError,
  loadRuntimeSettingsSnapshot,
} from '@yevgetman/sov-sdk/config/settings';
import { SessionPersistenceError } from '@yevgetman/sov-sdk/providers/errors';
import { DEFAULT_SKILL_DISCOVERY_LIMITS } from '@yevgetman/sov-sdk/skills/discovery';
import { SessionDb } from '../../src/agent/sessionDb.js';
import { runSkillsDoctor } from '../../src/cli/skillsDoctorCommand.js';
import { buildRuntime } from '../../src/server/runtime.js';

const roots: string[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sov-settings-contract-')));
  roots.push(root);
  const cwd = join(root, 'node');
  const harnessHome = join(root, 'profile');
  mkdirSync(join(cwd, '.git'), { recursive: true });
  mkdirSync(harnessHome);
  for (const name of ['config-root', 'profile-root', 'host-root']) mkdirSync(join(root, name));
  return { root, cwd, harnessHome };
}
function json(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
const approvals = (allowedLinkRoots: string[]) => ({ skills: { discovery: { allowedLinkRoots } } });
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('shared skill settings snapshot', () => {
  test('replacement precedence and explicit empty lists across all disk scopes', () => {
    const f = fixture();
    json(join(f.harnessHome, 'config.json'), approvals([join(f.root, 'config-root')]));
    expect(loadRuntimeSettingsSnapshot(f).discovery.allowedLinkRoots).toEqual([
      join(f.root, 'config-root'),
    ]);
    json(join(f.harnessHome, 'settings.json'), approvals([join(f.root, 'profile-root')]));
    expect(loadRuntimeSettingsSnapshot(f).discovery.allowedLinkRoots).toEqual([
      join(f.root, 'profile-root'),
    ]);
    json(join(f.cwd, '.harness/settings.local.json'), approvals([]));
    expect(loadRuntimeSettingsSnapshot(f).skillSettings).toMatchObject({
      source: 'node-local',
      explicitEmpty: true,
      acceptedEntries: 0,
    });
    expect(loadRuntimeSettingsSnapshot(f).discovery.allowedLinkRoots).toEqual([]);
    expect(
      loadRuntimeSettingsSnapshot({
        ...f,
        skillDiscovery: { allowedLinkRoots: [join(f.root, 'host-root')] },
      }).discovery.allowedLinkRoots,
    ).toEqual([join(f.root, 'host-root')]);
    const host = join(f.harnessHome, 'settings.json');
    json(host, approvals([]));
    expect(
      loadRuntimeSettingsSnapshot({ ...f, skillApprovalFile: host }).skillSettings.source,
    ).toBe('host-approval-file');
    expect(
      loadRuntimeSettingsSnapshot({
        ...f,
        skillApprovalFile: host,
        skillDiscovery: { allowedLinkRoots: [join(f.root, 'host-root')] },
      }).discovery.allowedLinkRoots,
    ).toEqual([]);
  });
  test('absence inherits, named homes stay separate, and injection skips every disk layer', () => {
    const f = fixture();
    json(join(f.harnessHome, 'settings.json'), approvals([join(f.root, 'profile-root')]));
    json(join(f.cwd, '.harness/settings.local.json'), { permissions: { allow: ['Read'] } });
    expect(loadRuntimeSettingsSnapshot(f).discovery.allowedLinkRoots).toEqual([
      join(f.root, 'profile-root'),
    ]);
    expect(
      loadRuntimeSettingsSnapshot({ ...f, harnessHome: join(f.root, 'other') }).discovery
        .allowedLinkRoots,
    ).toBeUndefined();
    writeFileSync(join(f.cwd, '.harness/settings.local.json'), 'bad JSON');
    expect(
      loadRuntimeSettingsSnapshot({ ...f, settings: {}, skillApprovalFile: '/missing' }).layers,
    ).toEqual([]);
  });
  test('project files cannot grant approval or redefine project root', () => {
    const f = fixture();
    json(join(f.cwd, '.harness/settings.json'), approvals(['/external']));
    expect(() => loadRuntimeSettingsSnapshot(f)).toThrow(ConfigurationError);
    json(join(f.cwd, '.harness/settings.json'), {
      skills: { discovery: { projectRoot: '/escape' } },
    });
    expect(() => loadRuntimeSettingsSnapshot(f)).toThrow(ConfigurationError);
  });
  test('rejects malformed JSON, wrong types, unknown fields, list and byte bounds safely', () => {
    const f = fixture();
    const path = join(f.cwd, '.harness/settings.local.json');
    for (const value of [
      approvals(['x', ...Array(DEFAULT_SKILL_DISCOVERY_LIMITS.maxRoots).fill('x')]),
      { skills: { discovery: { allowedLinkRoots: 'secret-sentinel' } } },
      { secretSentinel: 'never-show' },
    ]) {
      json(path, value);
      try {
        loadRuntimeSettingsSnapshot(f);
        throw new Error('unexpected success');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigurationError);
        expect(String(error)).not.toContain('secret');
        expect(String(error)).not.toContain('never-show');
      }
    }
    writeFileSync(path, '{private-sentinel');
    expect(() => loadRuntimeSettingsSnapshot(f)).toThrow(ConfigurationError);
    writeFileSync(path, ' '.repeat(DEFAULT_SKILL_DISCOVERY_LIMITS.maxFileBytes + 1));
    expect(() => loadRuntimeSettingsSnapshot(f)).toThrow(ConfigurationError);
    json(path, {});
    expect(() => loadRuntimeSettingsSnapshot({ ...f, skillApprovalFile: path })).toThrow(
      'explicit list required',
    );
  });
  test('MCP collisions fail the complete snapshot before children or credentials', () => {
    const f = fixture();
    json(join(f.harnessHome, 'settings.json'), {
      mcpServers: { privateAlias: { command: 'must-not-run' } },
    });
    json(join(f.cwd, '.harness/settings.local.json'), {
      mcpServers: { privateAlias: { command: 'also-must-not-run' } },
    });
    expect(() => loadRuntimeSettingsSnapshot(f)).toThrow(ConfigurationError);
    try {
      loadRuntimeSettingsSnapshot(f);
    } catch (error) {
      expect(String(error)).not.toContain('privateAlias');
      expect(String(error)).not.toContain('must-not-run');
    }
  });
  test('boot database cleanup faults retain typed persistence identity', async () => {
    const f = fixture();
    const cleanup = spyOn(SessionDb.prototype, 'cleanupPhantomReviews').mockImplementation(() => {
      throw new Error('private-database-fault');
    });
    try {
      await expect(
        buildRuntime({ ...f, provider: 'mock', model: 'mock-haiku', preflight: false }),
      ).rejects.toBeInstanceOf(SessionPersistenceError);
    } finally {
      cleanup.mockRestore();
    }
  });
  test('an unavailable approval cannot authorize a link created after the snapshot', async () => {
    const f = fixture();
    const missing = join(f.root, 'missing');
    const sibling = join(f.root, 'sibling');
    mkdirSync(sibling);
    writeFileSync(
      join(sibling, 'SKILL.md'),
      '---\nname: sibling\ndescription: Sibling guidance\n---\nSafe body.',
    );
    mkdirSync(join(f.cwd, '.agents/skills'), { recursive: true });
    symlinkSync(sibling, join(f.cwd, '.agents/skills/sibling'));
    json(join(f.cwd, '.harness/settings.local.json'), approvals([missing]));
    const settingsSnapshot = loadRuntimeSettingsSnapshot(f);
    expect(settingsSnapshot.unavailableApprovalRoots).toEqual([missing]);
    expect(settingsSnapshot.discovery.allowedLinkRoots).toEqual([]);
    symlinkSync(sibling, missing);
    const rt = await buildRuntime({
      ...f,
      settingsSnapshot,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
    });
    try {
      expect(rt.skillRegistryManager.snapshot().registry.byName.has('sibling')).toBe(false);
    } finally {
      await rt.dispose();
    }
  });
  test('a host approval file fixes the seat project boundary despite inherited profile projectRoot', async () => {
    const f = fixture();
    const outside = join(f.root, 'outside');
    mkdirSync(join(outside, '.agents/skills/unrelated'), { recursive: true });
    writeFileSync(
      join(outside, '.agents/skills/unrelated/SKILL.md'),
      '---\nname: unrelated\ndescription: Private other project\n---\nSafe body.',
    );
    json(join(f.harnessHome, 'config.json'), {
      skills: { discovery: { projectRoot: outside, allowedLinkRoots: [outside] } },
    });
    const file = join(f.harnessHome, 'settings.json');
    json(file, approvals([]));
    const snapshot = loadRuntimeSettingsSnapshot({ ...f, skillApprovalFile: file });
    expect(snapshot.discovery.projectRoot).toBe(f.cwd);
    let output = '';
    expect(
      await runSkillsDoctor({ ...f, skillApprovalFile: file, json: true }, (value) => {
        output = value;
      }),
    ).toBe(0);
    expect(
      JSON.parse(output).skills.some((skill: { name: string }) => skill.name === 'unrelated'),
    ).toBe(false);
  });
  test('redirected local trust files and parents never authorize their targets', () => {
    const f = fixture();
    const target = join(f.root, 'external.json');
    json(target, approvals(['/external']));
    mkdirSync(join(f.cwd, '.harness'));
    const path = join(f.cwd, '.harness/settings.local.json');
    symlinkSync(target, path);
    expect(() => loadRuntimeSettingsSnapshot(f)).toThrow(ConfigurationError);
    rmSync(join(f.cwd, '.harness'), { recursive: true });
    const redirected = join(f.root, 'redirected');
    json(join(redirected, 'settings.local.json'), approvals(['/external']));
    symlinkSync(redirected, join(f.cwd, '.harness'));
    expect(() => loadRuntimeSettingsSnapshot(f)).toThrow(ConfigurationError);
  });
  test('valid unchanged disk settings load approved exact packages in runtime and doctor', async () => {
    const f = fixture();
    for (const name of ['approved', 'sibling']) {
      const packageRoot = join(f.root, 'packages', name);
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(
        join(packageRoot, 'SKILL.md'),
        `---\nname: ${name}\ndescription: Safe fixture\n---\nRead resource.txt.\n`,
      );
      writeFileSync(join(packageRoot, 'resource.txt'), 'bounded fixture');
      mkdirSync(join(f.cwd, '.agents/skills'), { recursive: true });
      symlinkSync(packageRoot, join(f.cwd, '.agents/skills', name));
    }
    json(join(f.cwd, '.harness/settings.local.json'), {
      ...approvals([join(f.root, 'packages/approved')]),
      permissions: { allow: ['Read'] },
      mcpServers: {},
    });
    const rt = await buildRuntime({
      ...f,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
    });
    try {
      expect(rt.skillRegistryManager.snapshot().registry.byName.has('approved')).toBe(true);
      expect(rt.skillRegistryManager.snapshot().registry.byName.has('sibling')).toBe(false);
      expect((await rt.skillRuntime.inspect('approved', 'resource.txt')).content).toBe(
        'bounded fixture',
      );
      await expect(rt.skillRuntime.inspect('approved', '../sibling/SKILL.md')).rejects.toThrow();
      json(join(f.cwd, '.harness/settings.local.json'), approvals([]));
      await rt.skillRuntime.refresh();
      expect(rt.skillRegistryManager.snapshot().registry.byName.has('approved')).toBe(false);
      json(
        join(f.cwd, '.harness/settings.local.json'),
        approvals([join(f.root, 'packages/approved')]),
      );
      await rt.skillRuntime.refresh();
      const generation = rt.skillRegistryManager.snapshot().generation;
      writeFileSync(join(f.cwd, '.harness/settings.local.json'), 'bad JSON');
      await expect(rt.skillRuntime.refresh()).rejects.toBeInstanceOf(ConfigurationError);
      expect(rt.skillRegistryManager.snapshot().generation).toBe(generation);
      expect(rt.skillRegistryManager.snapshot().registry.byName.has('approved')).toBe(true);
    } finally {
      await rt.dispose();
    }
    json(
      join(f.cwd, '.harness/settings.local.json'),
      approvals([join(f.root, 'packages/approved')]),
    );
    let output = '';
    expect(
      await runSkillsDoctor({ ...f, json: true }, (text) => {
        output = text;
      }),
    ).toBe(0);
    const report = JSON.parse(output);
    expect(report.skillSettings).toMatchObject({
      valid: true,
      source: 'node-local',
      schemaVersion: 1,
    });
    expect(report.skills).toContainEqual({
      name: 'approved',
      root: join(f.root, 'packages/approved'),
    });
    expect(report.skills.some((skill: { name: string }) => skill.name === 'sibling')).toBe(false);
    writeFileSync(join(f.cwd, '.harness/settings.local.json'), 'bad JSON');
    expect(
      await runSkillsDoctor({ ...f, json: true }, (text) => {
        output = text;
      }),
    ).toBe(1);
    expect(JSON.parse(output).skillSettings.valid).toBe(false);
  });
});

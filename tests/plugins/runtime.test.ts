// Plugin-runtime helper tests (T8) — `loadPluginRuntime` is the single
// async entry point both `buildRuntime` (server/TUI/`sov drive`) and
// `dispatchCommand` (CLI/headless) call to turn the plugins-config block +
// harness home into `{ plugins, contributions }`. It composes the T3 loader
// (`loadPlugins`) and the T4 compose (`composePluginContributions`) so the
// two call sites can't drift.
//
// These pin:
//   - a consented, in-tree plugin → discovered AND its skill contributes a
//     skillRoot (so buildRuntime's loadSkills extraRoots picks it up);
//   - an un-consented plugin → discovered (listed in `plugins` as needsConsent)
//     but contributes NOTHING (no skillRoots/commands);
//   - an absent plugins dir → `{ plugins: [], contributions: empty }` (no throw);
//   - the disabled allow-list (config.disabled) suppresses contribution but the
//     plugin is still discovered.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConsentRecord, writeConsent } from '../../src/plugins/consent.js';
import { hashPluginTree } from '../../src/plugins/integrity.js';
import { loadPluginRuntime } from '../../src/plugins/runtime.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'plugin-runtime-helper-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const FIXED_TS = '2026-06-09T12:00:00.000Z';

function installDirOf(name: string): string {
  return join(home, 'plugins', name);
}

function writeManifest(installDir: string, manifest: Record<string, unknown>): void {
  const metaDir = join(installDir, '.claude-plugin');
  mkdirSync(metaDir, { recursive: true });
  writeFileSync(join(metaDir, 'plugin.json'), JSON.stringify(manifest), 'utf8');
}

function skillMarkdown(name: string, body: string): string {
  return `---
name: ${name}
description: the ${name} skill
whenToUse: User asks for the ${name} workflow
---
${body}`;
}

function writeSkillFile(installDir: string, dir: string, file: string, name: string): void {
  mkdirSync(join(installDir, dir), { recursive: true });
  writeFileSync(join(installDir, dir, `${file}.md`), skillMarkdown(name, 'body'), 'utf8');
}

function consent(installDir: string, pluginId: string): void {
  const record = buildConsentRecord({
    pluginId,
    version: '1.0.0',
    treeHash: hashPluginTree(installDir),
    decisions: { skills: true, commands: true },
    consentedAt: FIXED_TS,
  });
  writeConsent(installDir, record);
}

describe('loadPluginRuntime', () => {
  test('a consented in-tree plugin is discovered AND contributes its skillRoot', async () => {
    const installDir = installDirOf('alpha');
    writeManifest(installDir, { name: 'alpha', version: '1.0.0', description: 'alpha plugin' });
    writeSkillFile(installDir, 'skills', 'alpha', 'alpha');
    consent(installDir, 'alpha');

    const { plugins, contributions } = await loadPluginRuntime({ harnessHome: home, config: {} });

    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.id).toBe('alpha');
    expect(plugins[0]?.needsConsent).toBe(false);
    expect(contributions.skillRoots.map((r) => r.path)).toEqual([join(installDir, 'skills')]);
  });

  test('an un-consented plugin is discovered (needsConsent) but contributes nothing', async () => {
    const installDir = installDirOf('beta');
    writeManifest(installDir, { name: 'beta', version: '1.0.0', description: 'beta plugin' });
    writeSkillFile(installDir, 'skills', 'beta', 'beta');
    // NO consent written.

    const { plugins, contributions } = await loadPluginRuntime({ harnessHome: home, config: {} });

    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.id).toBe('beta');
    expect(plugins[0]?.needsConsent).toBe(true);
    expect(contributions.skillRoots).toEqual([]);
    expect(contributions.commands).toEqual([]);
  });

  test('an absent plugins dir yields empty plugins + empty contributions (no throw)', async () => {
    const { plugins, contributions } = await loadPluginRuntime({ harnessHome: home, config: {} });
    expect(plugins).toEqual([]);
    expect(contributions.skillRoots).toEqual([]);
    expect(contributions.commands).toEqual([]);
    expect(contributions.disclosedHooks).toEqual([]);
    expect(contributions.disclosedMcp).toEqual([]);
    expect(contributions.ignored).toEqual([]);
  });

  test('config.disabled suppresses contribution but the plugin stays discovered', async () => {
    const installDir = installDirOf('gamma');
    writeManifest(installDir, { name: 'gamma', version: '1.0.0', description: 'gamma plugin' });
    writeSkillFile(installDir, 'skills', 'gamma', 'gamma');
    consent(installDir, 'gamma');

    const { plugins, contributions } = await loadPluginRuntime({
      harnessHome: home,
      config: { disabled: ['gamma'] },
    });

    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.enabled).toBe(false);
    expect(contributions.skillRoots).toEqual([]);
  });
});

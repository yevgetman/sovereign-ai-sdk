// Plugin config block (T7) — the opt-in `plugins: { enabled?, disabled? }`
// settings block plus its end-to-end opt-in semantics driven through the T3
// loader. The schema assertions pin parse + strict-rejection; the loader
// assertions pin the M2 precedence the loader documents but the config block
// finalizes: when `enabled` is set, a consented plugin NOT listed is inert; and
// `enabled` + `disabled` both present → disabled wins.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsSchema } from '@yevgetman/sov-sdk/config/schema';
import { buildConsentRecord, writeConsent } from '../../src/plugins/consent.js';
import { hashPluginTree } from '../../src/plugins/integrity.js';
import { isPluginActive, loadPlugins } from '../../src/plugins/loader.js';

describe('SettingsSchema — plugins block', () => {
  test('parses { enabled, disabled } arrays', () => {
    const parsed = SettingsSchema.parse({
      plugins: { enabled: ['a', 'b'], disabled: ['c'] },
    });
    expect(parsed.plugins).toEqual({ enabled: ['a', 'b'], disabled: ['c'] });
  });

  test('both fields are optional (empty block parses)', () => {
    expect(() => SettingsSchema.parse({ plugins: {} })).not.toThrow();
  });

  test('omitting the block entirely parses (opt-in)', () => {
    const parsed = SettingsSchema.parse({});
    expect(parsed.plugins).toBeUndefined();
  });

  test('strict — an unknown key inside plugins is rejected', () => {
    expect(() => SettingsSchema.parse({ plugins: { bogus: true } })).toThrow();
  });

  test('rejects a non-array enabled', () => {
    expect(() => SettingsSchema.parse({ plugins: { enabled: 'a' } })).toThrow();
  });
});

describe('plugins opt-in semantics via loadPlugins (M2)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plugin-config-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /** Seed a consented, untampered, content-bearing plugin under the test home. */
  function seedConsented(name: string): void {
    const installDir = join(home, 'plugins', name);
    const skillsDir = join(installDir, 'skills', name);
    mkdirSync(join(installDir, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(installDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name, version: '1.0.0', description: `the ${name} plugin` }),
      'utf8',
    );
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'SKILL.md'), `# ${name}\nbody`, 'utf8');
    writeConsent(
      installDir,
      buildConsentRecord({
        pluginId: name,
        version: '1.0.0',
        treeHash: hashPluginTree(installDir),
        decisions: { skills: true, commands: true },
        consentedAt: '2026-06-09T12:00:00.000Z',
      }),
    );
  }

  function statusOf(name: string, config: { enabled?: string[]; disabled?: string[] }) {
    const plugins = loadPlugins({ harnessHome: home, config });
    const plugin = plugins.find((p) => p.id === name);
    if (!plugin) throw new Error(`expected plugin ${name} to be discovered`);
    return { enabled: plugin.enabled, active: isPluginActive(plugin) };
  }

  test('no allow-list → a consented plugin is enabled + active', () => {
    seedConsented('alpha');
    expect(statusOf('alpha', {})).toEqual({ enabled: true, active: true });
  });

  test('enabled set but plugin NOT listed → disabled + inert', () => {
    seedConsented('alpha');
    seedConsented('beta');
    // Only beta is in the allow-list, so alpha is opt-OUT (inert) even though
    // it is consented + untampered.
    expect(statusOf('alpha', { enabled: ['beta'] })).toEqual({ enabled: false, active: false });
    expect(statusOf('beta', { enabled: ['beta'] })).toEqual({ enabled: true, active: true });
  });

  test('enabled AND disabled both list the same plugin → disabled wins', () => {
    seedConsented('alpha');
    expect(statusOf('alpha', { enabled: ['alpha'], disabled: ['alpha'] })).toEqual({
      enabled: false,
      active: false,
    });
  });
});

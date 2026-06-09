// Plugin loader tests (T3) — the load-time consent/integrity gate (S1), the
// load-bearing security control of the whole feature. The gate enforces: a
// plugin contributes/activates ONLY when a valid consent record exists whose
// `pluginId` matches the manifest name AND whose recorded tree hash still
// matches the live tree (`verifyConsent`). Directory presence may *discover* a
// plugin (so it can be listed) but NEVER *enable* it — even one dropped into
// the plugins dir by hand with no install. These tests pin every inert verdict
// (no-consent / tamper / pluginId-mismatch / empty-tree / disabled / not in the
// opt-in allow-list) plus the happy active path, the skip-with-warn manifest
// policy, deterministic ordering, and the absent-dir no-crash case.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConsentRecord, writeConsent } from '../../src/plugins/consent.js';
import { hashPluginTree } from '../../src/plugins/integrity.js';
import { isPluginActive, loadPlugins } from '../../src/plugins/loader.js';
import type { LoadedPlugin } from '../../src/plugins/types.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'plugin-loader-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const FIXED_TS = '2026-06-09T12:00:00.000Z';

/** Absolute install dir for a plugin named `name` under the test home. */
function installDirOf(name: string): string {
  return join(home, 'plugins', name);
}

/** Write a `.claude-plugin/plugin.json` manifest into `installDir`. */
function writeManifest(installDir: string, manifest: Record<string, unknown>): void {
  const metaDir = join(installDir, '.claude-plugin');
  mkdirSync(metaDir, { recursive: true });
  writeFileSync(join(metaDir, 'plugin.json'), JSON.stringify(manifest), 'utf8');
}

/** Seed a discoverable plugin with a manifest + a non-empty `skills/` dir so it
 *  passes the empty-tree guard. Returns the install dir. */
function seedPlugin(name: string, manifest: Record<string, unknown> = {}): string {
  const installDir = installDirOf(name);
  writeManifest(installDir, {
    name,
    version: '1.0.0',
    description: `the ${name} plugin`,
    ...manifest,
  });
  const skillsDir = join(installDir, 'skills', name);
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(join(skillsDir, 'SKILL.md'), `# ${name}\nbody`, 'utf8');
  return installDir;
}

/** Stamp a valid, hash-matching consent record into `installDir` for `pluginId`. */
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

function collectWarnings(): { warn: (m: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (m: string) => messages.push(m), messages };
}

/** Assert exactly-one-loaded and return the narrowed plugin (avoids the
 *  non-null `[0]!` smell — a missing element throws a clear test failure). */
function onlyPlugin(result: LoadedPlugin[]): LoadedPlugin {
  expect(result).toHaveLength(1);
  const [plugin] = result;
  if (!plugin) throw new Error('expected exactly one loaded plugin');
  return plugin;
}

describe('loadPlugins — discovery', () => {
  test('returns [] when the plugins dir does not exist (no crash)', () => {
    expect(loadPlugins({ harnessHome: home, config: {} })).toEqual([]);
  });

  test('returns [] when the plugins dir is empty', () => {
    mkdirSync(join(home, 'plugins'), { recursive: true });
    expect(loadPlugins({ harnessHome: home, config: {} })).toEqual([]);
  });

  test('skips a subdir with no .claude-plugin/plugin.json (optionally warns)', () => {
    mkdirSync(join(home, 'plugins', 'not-a-plugin'), { recursive: true });
    writeFileSync(join(home, 'plugins', 'not-a-plugin', 'README.md'), 'hi', 'utf8');
    const { warn } = collectWarnings();
    expect(loadPlugins({ harnessHome: home, config: {}, warn })).toEqual([]);
  });

  test('derives the plugins dir from the passed harnessHome (not a global home)', () => {
    // A plugin under the PASSED home is found; nothing under any other home is.
    const installDir = seedPlugin('threaded');
    consent(installDir, 'threaded');
    const result = loadPlugins({ harnessHome: home, config: {} });
    expect(result.map((p) => p.id)).toEqual(['threaded']);
  });
});

describe('loadPlugins — C1 consent-bypass (headline security test)', () => {
  test('a plugin dropped in WITHOUT any .consent.json is discovered but inert (needsConsent, not active)', () => {
    seedPlugin('dropped-in'); // no consent written
    const { warn, messages } = collectWarnings();
    const result = loadPlugins({ harnessHome: home, config: {}, warn });

    const plugin = onlyPlugin(result);
    expect(plugin.id).toBe('dropped-in');
    expect(plugin.needsConsent).toBe(true);
    expect(plugin.tampered).toBe(false);
    // The crux: discovered, but NEVER active without a valid consent record.
    expect(isPluginActive(plugin)).toBe(false);
    // Actionable warning naming the plugin + the remedy.
    expect(messages.some((m) => m.includes('dropped-in') && m.includes('consent'))).toBe(true);
  });
});

describe('loadPlugins — H4 TOCTOU / tamper', () => {
  test('a consented plugin whose tree was edited after consent is tampered + inert (not active)', () => {
    const installDir = seedPlugin('edited-after');
    consent(installDir, 'edited-after');
    // Tamper AFTER consent: edit a file in the tree.
    writeFileSync(join(installDir, 'skills', 'edited-after', 'SKILL.md'), 'INJECTED', 'utf8');

    const { warn, messages } = collectWarnings();
    const result = loadPlugins({ harnessHome: home, config: {}, warn });

    const plugin = onlyPlugin(result);
    expect(plugin.tampered).toBe(true);
    expect(plugin.needsConsent).toBe(false);
    expect(isPluginActive(plugin)).toBe(false);
    expect(messages.some((m) => m.includes('edited-after') && m.includes('changed'))).toBe(true);
  });

  test('a consented plugin with a NEW file added after consent is tampered + inert', () => {
    const installDir = seedPlugin('added-after');
    consent(installDir, 'added-after');
    writeFileSync(join(installDir, 'skills', 'added-after', 'evil.md'), 'injected', 'utf8');

    const result = loadPlugins({ harnessHome: home, config: {} });
    const plugin = onlyPlugin(result);
    expect(plugin.tampered).toBe(true);
    expect(isPluginActive(plugin)).toBe(false);
  });
});

describe('loadPlugins — pluginId mismatch', () => {
  test('a .consent.json whose pluginId != manifest name is not active (needsConsent)', () => {
    const installDir = seedPlugin('real-name');
    // Consent record for a DIFFERENT identity, but a correct (matching) hash.
    const record = buildConsentRecord({
      pluginId: 'some-other-name',
      version: '1.0.0',
      treeHash: hashPluginTree(installDir),
      decisions: { skills: true },
      consentedAt: FIXED_TS,
    });
    writeConsent(installDir, record);

    const result = loadPlugins({ harnessHome: home, config: {} });
    const plugin = onlyPlugin(result);
    expect(plugin.needsConsent).toBe(true);
    // A mismatched record is treated as "no valid consent", not "tampered".
    expect(plugin.tampered).toBe(false);
    expect(isPluginActive(plugin)).toBe(false);
  });
});

describe('loadPlugins — happy path', () => {
  test('a properly consented + enabled plugin is active', () => {
    const installDir = seedPlugin('good');
    consent(installDir, 'good');

    const result = loadPlugins({ harnessHome: home, config: {} });
    const plugin = onlyPlugin(result);
    expect(plugin.id).toBe('good');
    expect(plugin.needsConsent).toBe(false);
    expect(plugin.tampered).toBe(false);
    expect(plugin.enabled).toBe(true);
    expect(isPluginActive(plugin)).toBe(true);
    expect(plugin.manifest.name).toBe('good');
    expect(plugin.installDir).toBe(installDir);
  });

  test('a plugin carrying only a commands/ dir (no skills) is active', () => {
    const installDir = installDirOf('cmd-only');
    writeManifest(installDir, {
      name: 'cmd-only',
      version: '1.0.0',
      description: 'commands only',
    });
    const cmdDir = join(installDir, 'commands');
    mkdirSync(cmdDir, { recursive: true });
    writeFileSync(join(cmdDir, 'hello.md'), '# hello', 'utf8');
    consent(installDir, 'cmd-only');

    const result = loadPlugins({ harnessHome: home, config: {} });
    expect(isPluginActive(onlyPlugin(result))).toBe(true);
  });
});

describe('loadPlugins — opt-in enable/disable', () => {
  test('a consented plugin in config.disabled is enabled:false and not active (not needsConsent)', () => {
    const installDir = seedPlugin('switch-off');
    consent(installDir, 'switch-off');

    const result = loadPlugins({ harnessHome: home, config: { disabled: ['switch-off'] } });
    const plugin = onlyPlugin(result);
    expect(plugin.enabled).toBe(false);
    expect(plugin.needsConsent).toBe(false);
    expect(plugin.tampered).toBe(false);
    expect(isPluginActive(plugin)).toBe(false);
  });

  test('with config.enabled set, a plugin NOT listed is not active', () => {
    const installDir = seedPlugin('not-listed');
    consent(installDir, 'not-listed');

    const result = loadPlugins({ harnessHome: home, config: { enabled: ['something-else'] } });
    const plugin = onlyPlugin(result);
    expect(plugin.enabled).toBe(false);
    expect(isPluginActive(plugin)).toBe(false);
  });

  test('with config.enabled set, a listed (consented) plugin is active', () => {
    const installDir = seedPlugin('on-the-list');
    consent(installDir, 'on-the-list');

    const result = loadPlugins({ harnessHome: home, config: { enabled: ['on-the-list'] } });
    const plugin = onlyPlugin(result);
    expect(plugin.enabled).toBe(true);
    expect(isPluginActive(plugin)).toBe(true);
  });

  test('disabled wins over enabled when a plugin is in both lists', () => {
    const installDir = seedPlugin('both');
    consent(installDir, 'both');

    const result = loadPlugins({
      harnessHome: home,
      config: { enabled: ['both'], disabled: ['both'] },
    });
    const plugin = onlyPlugin(result);
    expect(plugin.enabled).toBe(false);
    expect(isPluginActive(plugin)).toBe(false);
  });
});

describe('loadPlugins — empty-tree guard (M2 carry-forward)', () => {
  test('a consented plugin with NO skills and NO commands dir is inert (not active)', () => {
    // A manifest-only tree: consentable + hash-matching, but contributes nothing.
    const installDir = installDirOf('hollow');
    writeManifest(installDir, {
      name: 'hollow',
      version: '1.0.0',
      description: 'no components',
    });
    consent(installDir, 'hollow');

    const { warn } = collectWarnings();
    const result = loadPlugins({ harnessHome: home, config: {}, warn });
    const plugin = onlyPlugin(result);
    expect(plugin.needsConsent).toBe(true);
    expect(isPluginActive(plugin)).toBe(false);
  });

  test('a plugin with an EMPTY skills dir (no files) is inert', () => {
    const installDir = installDirOf('empty-skills');
    writeManifest(installDir, {
      name: 'empty-skills',
      version: '1.0.0',
      description: 'empty skills dir',
    });
    mkdirSync(join(installDir, 'skills'), { recursive: true });
    consent(installDir, 'empty-skills');

    const result = loadPlugins({ harnessHome: home, config: {} });
    const plugin = onlyPlugin(result);
    expect(isPluginActive(plugin)).toBe(false);
    expect(plugin.needsConsent).toBe(true);
  });
});

describe('loadPlugins — malformed / missing manifest skip-with-warn', () => {
  test('a manifest that fails to parse is skipped with a warn (does not crash the scan)', () => {
    // Bad manifest: name violates the slug rule.
    const badDir = installDirOf('bad');
    writeManifest(badDir, { name: 'BAD UPPER', version: '1.0.0', description: 'x' });
    mkdirSync(join(badDir, 'skills'), { recursive: true });

    // A sibling good plugin must still load — one bad plugin can't sink the scan.
    const goodDir = seedPlugin('alright');
    consent(goodDir, 'alright');

    const { warn, messages } = collectWarnings();
    const result = loadPlugins({ harnessHome: home, config: {}, warn });
    expect(result.map((p) => p.id)).toEqual(['alright']);
    expect(messages.some((m) => m.toLowerCase().includes('skip'))).toBe(true);
  });

  test('a manifest that is invalid JSON is skipped with a warn', () => {
    const badDir = installDirOf('badjson');
    mkdirSync(join(badDir, '.claude-plugin'), { recursive: true });
    writeFileSync(join(badDir, '.claude-plugin', 'plugin.json'), 'not json {{{', 'utf8');

    const { warn } = collectWarnings();
    expect(() => loadPlugins({ harnessHome: home, config: {}, warn })).not.toThrow();
    expect(loadPlugins({ harnessHome: home, config: {}, warn })).toEqual([]);
  });
});

describe('loadPlugins — hostile-tree DoS guard (never-crash-the-scan contract)', () => {
  test('a symlink-to-directory in ONE consented plugin does not sink the scan; the healthy sibling still loads', () => {
    // Hostile plugin: a symlink-to-dir dropped into its tree. Pre-fix, the
    // integrity walk readFileSync'd the symlink-to-dir → EISDIR propagated out
    // of loadPlugins entirely, taking down every healthy sibling (a boot-time
    // DoS once T8 wires this into buildRuntime).
    const hostileDir = seedPlugin('hostile');
    const realSub = join(hostileDir, 'skills', 'hostile');
    symlinkSync(realSub, join(hostileDir, 'skills', 'loop'), 'dir');
    consent(hostileDir, 'hostile');

    // A healthy, properly-consented sibling that MUST survive.
    const healthyDir = seedPlugin('healthy');
    consent(healthyDir, 'healthy');

    const { warn } = collectWarnings();
    let result: LoadedPlugin[] = [];
    expect(() => {
      result = loadPlugins({ harnessHome: home, config: {}, warn });
    }).not.toThrow();

    // The headline assertion: the healthy sibling still loads and is active.
    const healthy = result.find((p) => p.id === 'healthy');
    expect(healthy).toBeDefined();
    if (!healthy) throw new Error('healthy plugin missing from scan');
    expect(isPluginActive(healthy)).toBe(true);
  });

  test('a symlink-to-directory in a self-consented plugin degrades to skip/inert without throwing', () => {
    // Even when the hostile tree is the ONLY plugin, the scan must not throw.
    const hostileDir = seedPlugin('lonely-hostile');
    const realSub = join(hostileDir, 'skills', 'lonely-hostile');
    symlinkSync(realSub, join(hostileDir, 'skills', 'loop'), 'dir');
    consent(hostileDir, 'lonely-hostile');

    const { warn } = collectWarnings();
    expect(() => loadPlugins({ harnessHome: home, config: {}, warn })).not.toThrow();
  });
});

describe('loadPlugins — out-of-tree liveness scope (strong rec)', () => {
  test('a consented manifest pointing skills at out-of-tree content is NOT active', () => {
    // Out-of-tree content must not satisfy the liveness probe: the probe and
    // the tree hash must agree on the install-tree boundary.
    const escapeContent = join(home, 'plugins', 'escape');
    mkdirSync(escapeContent, { recursive: true });
    writeFileSync(join(escapeContent, 'SKILL.md'), '# out of tree', 'utf8');

    // A manifest-only install dir (no in-tree skills/commands) whose `skills`
    // override points UP and OUT to the sibling content above.
    const installDir = installDirOf('escaper');
    writeManifest(installDir, {
      name: 'escaper',
      version: '1.0.0',
      description: 'points skills out of tree',
      skills: '../escape',
    });
    consent(installDir, 'escaper');

    const result = loadPlugins({ harnessHome: home, config: {} });
    const plugin = result.find((p) => p.id === 'escaper');
    expect(plugin).toBeDefined();
    if (!plugin) throw new Error('escaper plugin missing from scan');
    // Out-of-tree content does not satisfy liveness → inert (empty-tree guard).
    expect(plugin.needsConsent).toBe(true);
    expect(isPluginActive(plugin)).toBe(false);
  });
});

describe('loadPlugins — deterministic order', () => {
  test('returns plugins sorted alphabetically by name', () => {
    for (const name of ['zebra', 'alpha', 'mike']) {
      const installDir = seedPlugin(name);
      consent(installDir, name);
    }
    const result = loadPlugins({ harnessHome: home, config: {} });
    expect(result.map((p) => p.id)).toEqual(['alpha', 'mike', 'zebra']);
  });

  test('ties on name fall back to a stable secondary key (installDir), not readdir order', () => {
    // Two manifests declaring the SAME name must still sort deterministically.
    // (Duplicate-id dedupe is T4's job; this only pins the ORDER is stable.)
    for (const seg of ['b-dir', 'a-dir']) {
      const installDir = installDirOf(seg);
      writeManifest(installDir, { name: 'dup', version: '1.0.0', description: 'x' });
      const skillsDir = join(installDir, 'skills', seg);
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(join(skillsDir, 'SKILL.md'), '# dup', 'utf8');
      consent(installDir, 'dup');
    }
    const result = loadPlugins({ harnessHome: home, config: {} });
    // Both share id 'dup'; the secondary installDir key orders a-dir before b-dir.
    expect(result.map((p) => p.installDir)).toEqual([installDirOf('a-dir'), installDirOf('b-dir')]);
  });
});

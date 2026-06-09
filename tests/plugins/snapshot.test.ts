// Plugin HarnessInfo-snapshot builder tests (T8) — `buildPluginSnapshots`
// turns the discovered `LoadedPlugin[]` into the `HarnessInfoSnapshot['plugins']`
// disclosure rows: name + version + status + skill/command counts + the
// declared-but-inert hook/mcp counts + ignored CC-only keys. The disclosure
// surface (HarnessInfo) lists ALL discovered plugins, including inert ones.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConsentRecord, writeConsent } from '../../src/plugins/consent.js';
import { hashPluginTree } from '../../src/plugins/integrity.js';
import { loadPlugins } from '../../src/plugins/loader.js';
import { buildPluginSnapshots, statusOfPlugin } from '../../src/plugins/snapshot.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'plugin-snapshot-'));
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

function skillMarkdown(name: string): string {
  return `---
name: ${name}
description: the ${name} skill
whenToUse: User asks for the ${name} workflow
---
body`;
}

function writeSkillFile(installDir: string, dir: string, file: string, name: string): void {
  mkdirSync(join(installDir, dir), { recursive: true });
  writeFileSync(join(installDir, dir, `${file}.md`), skillMarkdown(name), 'utf8');
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

describe('statusOfPlugin', () => {
  test('tampered wins over everything', () => {
    const status = statusOfPlugin({ needsConsent: false, tampered: true, enabled: true } as never);
    expect(status).toBe('tampered');
  });

  test('needs-consent before disabled', () => {
    const status = statusOfPlugin({ needsConsent: true, tampered: false, enabled: false } as never);
    expect(status).toBe('needs-consent');
  });

  test('disabled when consented but not enabled', () => {
    const status = statusOfPlugin({
      needsConsent: false,
      tampered: false,
      enabled: false,
    } as never);
    expect(status).toBe('disabled');
  });

  test('active when consented, untampered, enabled', () => {
    const status = statusOfPlugin({ needsConsent: false, tampered: false, enabled: true } as never);
    expect(status).toBe('active');
  });
});

describe('buildPluginSnapshots', () => {
  test('an active plugin with a skill + declared inert hooks/mcp + ignored keys', () => {
    const installDir = installDirOf('rich');
    writeManifest(installDir, {
      name: 'rich',
      version: '2.1.0',
      description: 'rich plugin',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }],
      },
      mcpServers: { db: { command: 'mcp-db', args: [] } },
      agents: ['a'],
      keywords: ['k'],
    });
    writeSkillFile(installDir, 'skills', 'richskill', 'richskill');
    writeSkillFile(installDir, 'commands', 'richcmd', 'richcmd');
    consent(installDir, 'rich');

    const plugins = loadPlugins({ harnessHome: home, config: {} });
    const snaps = buildPluginSnapshots(plugins);

    expect(snaps).toHaveLength(1);
    const snap = snaps[0];
    expect(snap?.name).toBe('rich');
    expect(snap?.version).toBe('2.1.0');
    expect(snap?.status).toBe('active');
    expect(snap?.skillCount).toBe(1);
    expect(snap?.commandCount).toBe(1);
    expect(snap?.disclosedHookCount).toBe(1);
    expect(snap?.disclosedMcpCount).toBe(1);
    expect(snap?.ignoredKeys).toEqual(expect.arrayContaining(['agents', 'keywords']));
  });

  test('an un-consented plugin is listed as needs-consent with its component counts', () => {
    const installDir = installDirOf('unconsented');
    writeManifest(installDir, {
      name: 'unconsented',
      version: '1.0.0',
      description: 'never consented',
    });
    writeSkillFile(installDir, 'skills', 'sk', 'sk');
    // NO consent.

    const plugins = loadPlugins({ harnessHome: home, config: {} });
    const snaps = buildPluginSnapshots(plugins);

    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.status).toBe('needs-consent');
    // Counts reflect what's on disk regardless of consent (disclosure is honest).
    expect(snaps[0]?.skillCount).toBe(1);
    expect(snaps[0]?.commandCount).toBe(0);
    expect(snaps[0]?.disclosedHookCount).toBe(0);
    expect(snaps[0]?.ignoredKeys).toEqual([]);
  });
});

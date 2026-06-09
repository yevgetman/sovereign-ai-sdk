// T8 — buildRuntime wires plugin contributions into the live runtime.
//
// A CONSENTED, in-tree plugin's skill must (a) enter `runtime.skills` (so it
// reaches the system prompt + is invocable as a `/skillname`), and (b) its
// plugin commands must land on `runtime.pluginCommands`. The HarnessInfo
// snapshot must list every DISCOVERED plugin with its status + disclosed/
// ignored components. An un-consented plugin must NOT contribute but MUST be
// listed as `needs-consent`. An empty/absent plugins dir must be a no-op.
//
// Mirrors tests/server/runtime.skills.test.ts (skills wiring) + the consent
// fixtures in tests/plugins/compose.test.ts.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConsentRecord, writeConsent } from '../../src/plugins/consent.js';
import { hashPluginTree } from '../../src/plugins/integrity.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

const FIXED_TS = '2026-06-09T12:00:00.000Z';

function pluginsDirOf(home: string): string {
  return join(home, 'plugins');
}

function installDirOf(home: string, name: string): string {
  return join(pluginsDirOf(home), name);
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

function writeSkillFile(
  installDir: string,
  dir: string,
  file: string,
  name: string,
  body = 'body',
): void {
  mkdirSync(join(installDir, dir), { recursive: true });
  writeFileSync(join(installDir, dir, `${file}.md`), skillMarkdown(name, body), 'utf8');
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

describe('buildRuntime — plugin contributions wired (T8)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-t8-plugins-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('a consented plugin skill enters runtime.skills + is invocable as /skillname', async () => {
    const installDir = installDirOf(tmpHome, 'greeter');
    writeManifest(installDir, { name: 'greeter', version: '1.0.0', description: 'greeter plugin' });
    // A skill that interpolates ${CLAUDE_PLUGIN_ROOT} so we prove the plugin
    // root threads through the loadSkills extraRoots path.
    writeSkillFile(
      installDir,
      'skills',
      'plughello',
      'plughello',
      'Hello from a plugin. Config at ${CLAUDE_PLUGIN_ROOT}/data.json.',
    );
    consent(installDir, 'greeter');

    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    try {
      // (a) the plugin skill is in the registry.
      const skill = runtime.skills.byName.get('plughello');
      expect(skill).toBeDefined();
      expect(skill?.source).toBe('plugin');
      expect(skill?.pluginRoot).toBe(installDir);

      // (b) invocable as /plughello via the live server, with the plugin-root
      //     interpolation resolved to the install dir (not left literal).
      const app = buildAppWithRuntime(runtime);
      const createRes = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '/plughello', kind: 'skill' }),
      });
      expect(turnRes.status).toBe(202);
      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      await eventsRes.text();

      const messages = runtime.sessionDb.loadMessages(sessionId);
      const userText = JSON.stringify(messages[0]?.content);
      expect(userText).toContain('Hello from a plugin.');
      expect(userText).toContain(`${installDir}/data.json`);
      expect(userText).not.toContain('${CLAUDE_PLUGIN_ROOT}');
    } finally {
      await runtime.dispose();
    }
  });

  test('a plugin command lands on runtime.pluginCommands (NOT in runtime.skills)', async () => {
    const installDir = installDirOf(tmpHome, 'cmdplug');
    writeManifest(installDir, {
      name: 'cmdplug',
      version: '1.0.0',
      description: 'commands plugin',
    });
    writeSkillFile(installDir, 'commands', 'plugcmd', 'plugcmd', 'A plugin command body.');
    consent(installDir, 'cmdplug');

    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    try {
      const cmd = runtime.pluginCommands.find((c) => c.name === 'plugcmd');
      expect(cmd).toBeDefined();
      expect(cmd?.type).toBe('prompt');
      // Commands are slash-only — they must NOT be added to the skill registry
      // (so they never reach the skill system-prompt injection — CC semantics).
      expect(runtime.skills.byName.get('plugcmd')).toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });

  test('HarnessInfo snapshot lists an installed plugin with status + disclosed/ignored components', async () => {
    const installDir = installDirOf(tmpHome, 'discloser');
    writeManifest(installDir, {
      name: 'discloser',
      version: '3.0.0',
      description: 'declares inert blocks',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }],
      },
      mcpServers: { db: { command: 'mcp-db', args: [] } },
      agents: ['a'],
      keywords: ['k'],
    });
    writeSkillFile(installDir, 'skills', 'dskill', 'dskill');
    consent(installDir, 'discloser');

    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    try {
      const harnessInfo = runtime.toolPool.find((t) => t.name === 'HarnessInfo');
      expect(harnessInfo).toBeDefined();
      const result = await harnessInfo?.call({ section: 'plugins' }, {} as never);
      const data = (result as { data: { plugins?: Array<Record<string, unknown>> } }).data;
      const row = data.plugins?.find((p) => p.name === 'discloser');
      expect(row).toBeDefined();
      expect(row?.status).toBe('active');
      expect(row?.version).toBe('3.0.0');
      expect(row?.skillCount).toBe(1);
      expect(row?.disclosedHookCount).toBe(1);
      expect(row?.disclosedMcpCount).toBe(1);
      expect(row?.ignoredKeys).toEqual(expect.arrayContaining(['agents', 'keywords']));
    } finally {
      await runtime.dispose();
    }
  });

  test('an un-consented plugin is NOT in skills but IS listed in HarnessInfo as needs-consent', async () => {
    const installDir = installDirOf(tmpHome, 'pending');
    writeManifest(installDir, {
      name: 'pending',
      version: '1.0.0',
      description: 'never consented',
    });
    writeSkillFile(installDir, 'skills', 'pendingskill', 'pendingskill');
    // NO consent written → needsConsent → inert.

    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    try {
      // Inert: contributes no skill (not in the registry).
      expect(runtime.skills.byName.get('pendingskill')).toBeUndefined();
      // But discovered: present on runtime.plugins with the needs-consent verdict.
      const discovered = runtime.plugins.find((p) => p.id === 'pending');
      expect(discovered).toBeDefined();
      expect(discovered?.needsConsent).toBe(true);

      // And surfaced in the HarnessInfo snapshot as needs-consent.
      const harnessInfo = runtime.toolPool.find((t) => t.name === 'HarnessInfo');
      const result = await harnessInfo?.call({ section: 'plugins' }, {} as never);
      const data = (result as { data: { plugins?: Array<Record<string, unknown>> } }).data;
      const row = data.plugins?.find((p) => p.name === 'pending');
      expect(row?.status).toBe('needs-consent');
    } finally {
      await runtime.dispose();
    }
  });

  test('an absent plugins dir builds a runtime with no plugin contributions (no regression)', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    try {
      expect(runtime.plugins).toEqual([]);
      expect(runtime.pluginCommands).toEqual([]);
      // The bundle-default skills still load normally (no regression).
      expect(runtime.skills.skills.length).toBeGreaterThan(0);
    } finally {
      await runtime.dispose();
    }
  });
});

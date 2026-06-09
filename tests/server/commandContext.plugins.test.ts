// T8 — buildServerCommandContext spreads the runtime's plugin commands into the
// dispatch registry (built-ins win; then plugin commands; then skill-derived),
// and leaves `ctx.confirm` UNDEFINED (the server/TUI has no TTY, so
// `/plugins install` correctly refuses).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConsentRecord, writeConsent } from '../../src/plugins/consent.js';
import { hashPluginTree } from '../../src/plugins/integrity.js';
import { buildServerCommandContext } from '../../src/server/commandContext.js';
import { buildRuntime } from '../../src/server/runtime.js';

const FIXED_TS = '2026-06-09T12:00:00.000Z';

function installDirOf(home: string, name: string): string {
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
description: the ${name} command
whenToUse: User asks for the ${name} workflow
---
${body}`;
}

function writeCommandFile(installDir: string, file: string, name: string, body: string): void {
  mkdirSync(join(installDir, 'commands'), { recursive: true });
  writeFileSync(join(installDir, 'commands', `${file}.md`), skillMarkdown(name, body), 'utf8');
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

describe('buildServerCommandContext — plugin commands (T8)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-t8-cmdctx-plugins-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('a plugin command is in the dispatch registry; ctx.confirm is undefined', async () => {
    const installDir = installDirOf(tmpHome, 'cmdplug');
    writeManifest(installDir, { name: 'cmdplug', version: '1.0.0', description: 'has a command' });
    writeCommandFile(installDir, 'plugverb', 'plugverb', 'Plugin command body.');
    consent(installDir, 'cmdplug');

    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    try {
      const sessionCtx = runtime.getSessionContext('sess-cmdctx');
      const { ctx } = buildServerCommandContext(runtime, sessionCtx, 'sess-cmdctx');

      // The plugin command is dispatchable through the registry.
      expect(ctx.registry.get('plugverb')).toBeDefined();
      expect(ctx.registry.get('plugverb')?.type).toBe('prompt');

      // Server/TUI has no TTY → confirm is absent → /plugins install refuses.
      expect(ctx.confirm).toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });

  test('a built-in command always wins over a same-named plugin command', async () => {
    // A plugin contributing a command named `help` must NOT shadow the built-in
    // /help (built-ins are spread FIRST; buildCommandRegistry is first-wins).
    const installDir = installDirOf(tmpHome, 'shadower');
    writeManifest(installDir, {
      name: 'shadower',
      version: '1.0.0',
      description: 'tries to shadow',
    });
    writeCommandFile(installDir, 'help', 'help', 'EVIL PLUGIN HELP');
    consent(installDir, 'shadower');

    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    try {
      // The plugin DID contribute a `help` command...
      expect(runtime.pluginCommands.find((c) => c.name === 'help')).toBeDefined();

      const sessionCtx = runtime.getSessionContext('sess-shadow');
      const { ctx } = buildServerCommandContext(runtime, sessionCtx, 'sess-shadow');
      // ...but the registry's `help` is the built-in (a local command), not the
      // plugin's prompt command.
      const help = ctx.registry.get('help');
      expect(help).toBeDefined();
      expect(help?.type).toBe('local');
    } finally {
      await runtime.dispose();
    }
  });
});

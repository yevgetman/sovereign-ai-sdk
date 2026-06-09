// T8 — `sov dispatch` plugin wiring (subprocess e2e). Drives the real
// `runDispatch` stdin loop in a child process with piped stdin (a non-TTY), so
// it pins the two contracts that matter on the headless surface:
//   1. a CONSENTED plugin's slash command is dispatchable through the registry
//      (proves `loadPluginRuntime` → command threading in dispatch);
//   2. `/plugins install` REFUSES on a non-TTY stdin (no `confirm`), and the
//      normal dispatch protocol (READY/TURN_SEPARATOR) still works around it.
//
// The interactive TTY-consent install path (confirm → y) is proven manually +
// by the buildDispatchConfirm unit test; a child process can't be made a TTY
// here without a pty, so it is out of scope for this CI test.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConsentRecord, writeConsent } from '../../src/plugins/consent.js';
import { hashPluginTree } from '../../src/plugins/integrity.js';

const MAIN = join(import.meta.dir, '..', '..', 'src', 'main.ts');

function installDirOf(home: string, name: string): string {
  return join(home, 'plugins', name);
}

function writeManifest(installDir: string, manifest: Record<string, unknown>): void {
  const metaDir = join(installDir, '.claude-plugin');
  mkdirSync(metaDir, { recursive: true });
  writeFileSync(join(metaDir, 'plugin.json'), JSON.stringify(manifest), 'utf8');
}

function writeCommandFile(installDir: string, file: string, name: string): void {
  mkdirSync(join(installDir, 'commands'), { recursive: true });
  writeFileSync(
    join(installDir, 'commands', `${file}.md`),
    `---\nname: ${name}\ndescription: the ${name} command\nwhenToUse: User asks for ${name}\n---\nbody`,
    'utf8',
  );
}

function consent(installDir: string, pluginId: string): void {
  writeConsent(
    installDir,
    buildConsentRecord({
      pluginId,
      version: '1.0.0',
      treeHash: hashPluginTree(installDir),
      decisions: { skills: true, commands: true },
      consentedAt: '2026-06-09T12:00:00.000Z',
    }),
  );
}

/** Run `sov dispatch` with the given stdin lines; return combined stdout. */
async function runDispatchStdin(home: string, lines: string[]): Promise<string> {
  const proc = Bun.spawn(['bun', MAIN, 'dispatch'], {
    stdin: new TextEncoder().encode(lines.map((l) => `${l}\n`).join('')),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, HARNESS_HOME: home, SOV_TEST_MOCK_PROVIDER: '1' },
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout;
}

describe('sov dispatch — plugin wiring (T8)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-t8-dispatch-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('a consented plugin command is dispatchable via /help (and runs as a prompt)', async () => {
    const installDir = installDirOf(home, 'cmdplug');
    writeManifest(installDir, { name: 'cmdplug', version: '1.0.0', description: 'has a command' });
    writeCommandFile(installDir, 'plugverb', 'plugverb');
    consent(installDir, 'cmdplug');

    const out = await runDispatchStdin(home, ['/help', '/plugverb', '/quit']);
    // The plugin command shows in /help...
    expect(out).toContain('plugverb');
    // ...and dispatching it routes through the prompt-command path (dispatch
    // mode can't run a model turn, so it reports the skip — proving the command
    // resolved as a PromptCommand from the plugin, not "unknown command").
    expect(out).toContain("prompt commands ('plugverb')");
  });

  test('/plugins install refuses on a non-TTY stdin; the protocol still works', async () => {
    const src = mkdtempSync(join(tmpdir(), 'sov-t8-src-'));
    try {
      writeManifest(src, { name: 'srcplug', version: '1.0.0', description: 'src plugin' });
      writeCommandFile(src, 'srcverb', 'srcverb');

      const out = await runDispatchStdin(home, [`/plugins install ${src}`, '/quit']);
      expect(out).toContain('requires a terminal');
      // Nothing landed under the home's plugins dir.
      const out2 = await runDispatchStdin(home, ['/plugins list', '/quit']);
      expect(out2).toContain('no plugins installed');
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });
});

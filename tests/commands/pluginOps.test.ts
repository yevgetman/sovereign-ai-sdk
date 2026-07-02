// `/plugins` command (T7). The operator-facing surface over the T3 loader, T6
// install/uninstall, and the plugins config block. Tests drive each verb
// through the real registry (`dispatchSlashCommand`) so registration is
// exercised too. Fixtures are built on disk under a temp harness home: a
// consented+active plugin, an un-consented (needs-consent) plugin, a tampered
// plugin, and a disabled plugin, so `list`/`info` render every status. `install`
// is driven against a source dir with an injected `confirm`; the missing-confirm
// refusal (non-TTY surfaces) is pinned. `enable`/`disable` assert the config's
// plugins block is mutated + persisted immutably.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandContext } from '@yevgetman/sov-sdk/commands/types';
import { dispatchSlashCommand } from '../../src/commands/registry.js';
import { buildConsentRecord, writeConsent } from '../../src/plugins/consent.js';
import { hashPluginTree } from '../../src/plugins/integrity.js';
import { makeCtx } from './_makeCtx.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'plugin-ops-'));
  // Point the config store at this home's config.json (readConfig/writeConfig
  // resolve `HARNESS_CONFIG` first), so enable/disable round-trips are isolated.
  process.env.HARNESS_CONFIG = join(home, 'config.json');
});

afterEach(() => {
  process.env.HARNESS_CONFIG = undefined;
  rmSync(home, { recursive: true, force: true });
});

function pluginsRoot(): string {
  return join(home, 'plugins');
}

/** Seed a plugin tree (manifest + a skill) under the home. Optionally consents
 *  + optionally tampers (mutates a file AFTER consent so the hash mismatches). */
function seedPlugin(
  name: string,
  opts: {
    manifest?: Record<string, unknown>;
    consent?: boolean;
    tamper?: boolean;
  } = {},
): string {
  const installDir = join(pluginsRoot(), name);
  mkdirSync(join(installDir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(installDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({
      name,
      version: '2.1.0',
      description: `the ${name} plugin`,
      author: 'Ada',
      ...opts.manifest,
    }),
    'utf8',
  );
  const skillDir = join(installDir, 'skills', name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}-skill\ndescription: a skill\n---\nbody`,
    'utf8',
  );
  if (opts.consent) {
    writeConsent(
      installDir,
      buildConsentRecord({
        pluginId: name,
        version: '2.1.0',
        treeHash: hashPluginTree(installDir),
        decisions: { skills: true, commands: true },
        consentedAt: '2026-06-09T12:00:00.000Z',
      }),
    );
  }
  if (opts.tamper) {
    // Edit a file AFTER consent so verifyConsent's recomputed hash mismatches.
    writeFileSync(join(skillDir, 'SKILL.md'), 'tampered after consent', 'utf8');
  }
  return installDir;
}

/** Build a plugin SOURCE dir (for install) under a separate source root. */
function makeSource(name: string): string {
  const source = join(home, 'sources', name);
  mkdirSync(join(source, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(source, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, version: '1.0.0', description: `source ${name}` }),
    'utf8',
  );
  const skillDir = join(source, 'skills', name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}-skill\ndescription: d\n---\nbody`,
    'utf8',
  );
  return source;
}

function ctx(overrides: Partial<CommandContext> = {}): CommandContext {
  return makeCtx({ harnessHome: home, ...overrides });
}

async function run(input: string, overrides: Partial<CommandContext> = {}): Promise<string> {
  const result = await dispatchSlashCommand(input, ctx(overrides));
  if (result.kind === 'prompt') throw new Error('expected a local command result');
  return result.output;
}

describe('/plugins list', () => {
  test('renders every status: active / needs-consent / tampered / disabled', async () => {
    seedPlugin('active-one', { consent: true });
    seedPlugin('unconsented', { consent: false });
    seedPlugin('tampered-one', { consent: true, tamper: true });
    seedPlugin('disabled-one', { consent: true });
    // Disable one via config.
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ plugins: { disabled: ['disabled-one'] } }),
      'utf8',
    );

    const out = await run('/plugins list');

    expect(out).toContain('active-one');
    expect(out).toContain('active');
    expect(out).toContain('unconsented');
    expect(out).toContain('needs-consent');
    expect(out).toContain('tampered-one');
    expect(out).toContain('tampered');
    expect(out).toContain('disabled-one');
    expect(out).toContain('disabled');
  });

  test('reports version + skill/command counts for an active plugin', async () => {
    seedPlugin('counted', { consent: true });
    const out = await run('/plugins list');
    expect(out).toContain('counted');
    expect(out).toContain('2.1.0');
    // one skill, zero commands
    expect(out).toMatch(/\b1\b/);
  });

  test('no plugins installed → a friendly empty message', async () => {
    const out = await run('/plugins list');
    expect(out.toLowerCase()).toContain('no plugins');
  });
});

describe('/plugins info <name>', () => {
  test('shows the manifest fields (name/version/description/author)', async () => {
    seedPlugin('infoplug', { consent: true });
    const out = await run('/plugins info infoplug');
    expect(out).toContain('infoplug');
    expect(out).toContain('2.1.0');
    expect(out).toContain('the infoplug plugin');
    expect(out).toContain('Ada');
  });

  test('discloses inert hooks/mcp + ignored CC-only keys', async () => {
    seedPlugin('discloser', {
      consent: true,
      manifest: {
        hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
        mcpServers: { db: { type: 'http', url: 'https://mcp.example.com' } },
        agents: ['ignored-cc-feature'],
      },
      // re-consent over the manifest with the extra blocks below
    });
    // The manifest changed after the default seed wrote consent → re-consent.
    const installDir = join(pluginsRoot(), 'discloser');
    writeConsent(
      installDir,
      buildConsentRecord({
        pluginId: 'discloser',
        version: '2.1.0',
        treeHash: hashPluginTree(installDir),
        decisions: { skills: true, commands: true, hooks: false, mcpServers: false },
        consentedAt: '2026-06-09T12:00:00.000Z',
      }),
    );

    const out = await run('/plugins info discloser');
    expect(out.toLowerCase()).toContain('inert');
    expect(out).toMatch(/hook/i);
    expect(out).toMatch(/mcp/i);
    expect(out.toLowerCase()).toContain('agents');
  });

  test('unknown plugin → a friendly not-found message', async () => {
    const out = await run('/plugins info nope');
    expect(out.toLowerCase()).toContain('not');
  });

  test('rejects an unsafe name', async () => {
    const out = await run('/plugins info ../etc');
    expect(out.toLowerCase()).toMatch(/invalid|not/);
  });
});

describe('/plugins install <dir>', () => {
  test('calls installPlugin with ctx.confirm and reports success', async () => {
    const source = makeSource('fresh');
    let prompted = false;
    const out = await run(`/plugins install ${source}`, {
      confirm: async () => {
        prompted = true;
        return true;
      },
    });
    expect(prompted).toBe(true);
    expect(out.toLowerCase()).toContain('installed');
    // The tree landed under the home's plugins root.
    expect(
      readFileSync(join(pluginsRoot(), 'fresh', '.claude-plugin', 'plugin.json'), 'utf8'),
    ).toContain('fresh');
  });

  test('a declined consent reports declined and installs nothing', async () => {
    const source = makeSource('declineme');
    const out = await run(`/plugins install ${source}`, {
      confirm: async () => false,
    });
    expect(out.toLowerCase()).toContain('declin');
  });

  test('refuses with a clear terminal message when ctx.confirm is undefined', async () => {
    const source = makeSource('noconfirm');
    // ctx.confirm absent (default makeCtx) — non-TTY surface.
    const out = await run(`/plugins install ${source}`);
    expect(out.toLowerCase()).toContain('terminal');
    // Nothing installed.
    expect(() =>
      readFileSync(join(pluginsRoot(), 'noconfirm', '.claude-plugin', 'plugin.json')),
    ).toThrow();
  });

  test('missing source dir → a friendly error (never throws)', async () => {
    const out = await run(`/plugins install ${join(home, 'does-not-exist')}`, {
      confirm: async () => true,
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out.toLowerCase()).toMatch(/not a plugin|not found/);
  });
});

describe('/plugins uninstall <name>', () => {
  test('removes an installed plugin and reports it', async () => {
    seedPlugin('removeme', { consent: true });
    const out = await run('/plugins uninstall removeme');
    expect(out.toLowerCase()).toContain('removeme');
    expect(() =>
      readFileSync(join(pluginsRoot(), 'removeme', '.claude-plugin', 'plugin.json')),
    ).toThrow();
  });

  test('uninstalling an absent plugin → a friendly error', async () => {
    const out = await run('/plugins uninstall ghost');
    expect(out.toLowerCase()).toMatch(/not installed|ghost/);
  });
});

describe('/plugins enable / disable (config mutation)', () => {
  test('disable adds to disabled[] + persists, with a restart hint', async () => {
    seedPlugin('toggle', { consent: true });
    const out = await run('/plugins disable toggle');
    expect(out.toLowerCase()).toContain('restart');

    const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as {
      plugins?: { disabled?: string[]; enabled?: string[] };
    };
    expect(cfg.plugins?.disabled).toContain('toggle');
  });

  test('enable adds to enabled[] AND removes from disabled[]', async () => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ plugins: { disabled: ['toggle'] } }),
      'utf8',
    );
    seedPlugin('toggle', { consent: true });

    const out = await run('/plugins enable toggle');
    expect(out.toLowerCase()).toContain('restart');

    const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as {
      plugins?: { disabled?: string[]; enabled?: string[] };
    };
    expect(cfg.plugins?.enabled).toContain('toggle');
    expect(cfg.plugins?.disabled ?? []).not.toContain('toggle');
  });

  test('disable removes from enabled[] when previously enabled (disabled wins)', async () => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ plugins: { enabled: ['toggle', 'other'] } }),
      'utf8',
    );
    const out = await run('/plugins disable toggle');
    expect(out.toLowerCase()).toContain('restart');

    const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as {
      plugins?: { disabled?: string[]; enabled?: string[] };
    };
    expect(cfg.plugins?.disabled).toContain('toggle');
    expect(cfg.plugins?.enabled ?? []).not.toContain('toggle');
    // an unrelated entry is preserved
    expect(cfg.plugins?.enabled).toContain('other');
  });

  test('enable rejects an unsafe name (no config write)', async () => {
    const out = await run('/plugins enable ../evil');
    expect(out.toLowerCase()).toContain('invalid');
  });
});

describe('/plugins (no / unknown subcommand)', () => {
  test('bare /plugins prints a usage string', async () => {
    const out = await run('/plugins');
    expect(out.toLowerCase()).toContain('usage');
    expect(out).toContain('list');
    expect(out).toContain('install');
  });

  test('unknown subcommand prints usage', async () => {
    const out = await run('/plugins frobnicate');
    expect(out.toLowerCase()).toMatch(/usage|unknown/);
  });
});

// Plugin compose tests (T4) — turning the GATED `LoadedPlugin[]` from T3's
// loader into the `PluginContributions` shape T8 wires into the runtime. The
// design intent these tests pin:
//   - skills/ feed the skill REGISTRY (system prompt + slash commands) via
//     `skillRoots` (spliced into loadSkills' extraRoots);
//   - commands/ become slash-commands ONLY — built via the buildSkillCommands
//     path and returned in `commands`, NOT added to the skill registry (so they
//     never reach the skill system-prompt injection — CC command semantics);
//   - hooks/mcpServers/ignored are DISCLOSED (informational), producing NO
//     skillRoot/command/behaviour (the whole point: v1 discloses + defers them);
//   - ONLY active plugins contribute (an inert plugin contributes nothing);
//   - M1 containment: a manifest dir override escaping the install tree is
//     rejected (no root) + warned;
//   - cross-plugin dedupe: a same-named command resolves deterministically
//     (first plugin alphabetically wins) + warns, never crashes;
//   - ${CLAUDE_PLUGIN_ROOT} resolves to the plugin install dir on expansion.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composePluginContributions } from '../../src/plugins/compose.js';
import { buildConsentRecord, writeConsent } from '../../src/plugins/consent.js';
import { hashPluginTree } from '../../src/plugins/integrity.js';
import { loadPlugins } from '../../src/plugins/loader.js';
import type { LoadedPlugin } from '../../src/plugins/types.js';
import { expandSkillPrompt, loadSkills } from '../../src/skills/loader.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'plugin-compose-'));
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

/** A minimal valid skill/command markdown body with frontmatter. */
function skillMarkdown(name: string, body: string): string {
  return `---
name: ${name}
description: the ${name} skill
whenToUse: User asks for the ${name} workflow
---
${body}`;
}

/** Write a skill `.md` under `<installDir>/<dir>/<sub?>/<file>.md`. */
function writeSkillFile(
  installDir: string,
  dir: string,
  file: string,
  name: string,
  body = 'body',
): void {
  const target = join(installDir, dir, `${file}.md`);
  mkdirSync(join(installDir, dir), { recursive: true });
  writeFileSync(target, skillMarkdown(name, body), 'utf8');
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

/** Seed + consent a plugin carrying a `skills/<skillName>.md`. Returns installDir. */
function seedSkillPlugin(name: string, skillName = name): string {
  const installDir = installDirOf(name);
  writeManifest(installDir, { name, version: '1.0.0', description: `the ${name} plugin` });
  writeSkillFile(installDir, 'skills', skillName, skillName);
  consent(installDir, name);
  return installDir;
}

/** Load the gated plugins for the current home. */
function load(): LoadedPlugin[] {
  return loadPlugins({ harnessHome: home, config: {} });
}

describe('composePluginContributions — skillRoots', () => {
  test('two active plugins each with a skill → both skillRoots produced, tagged plugin/community + pluginRoot', async () => {
    const dirA = seedSkillPlugin('alpha');
    const dirB = seedSkillPlugin('bravo');
    const plugins = load();

    const { warn } = collectWarnings();
    const contributions = await composePluginContributions(plugins, { warn });

    expect(contributions.skillRoots).toHaveLength(2);
    for (const root of contributions.skillRoots) {
      expect(root.source).toBe('plugin');
      expect(root.trustTier).toBe('community');
    }
    // Each root points at its plugin's contained skills/ dir + carries its
    // install dir as pluginRoot (for ${CLAUDE_PLUGIN_ROOT}).
    const byPath = new Map(contributions.skillRoots.map((r) => [r.path, r]));
    expect(byPath.get(join(dirA, 'skills'))?.pluginRoot).toBe(dirA);
    expect(byPath.get(join(dirB, 'skills'))?.pluginRoot).toBe(dirB);
  });

  test('honours the manifest skills-dir override (contained)', async () => {
    const installDir = installDirOf('custom');
    writeManifest(installDir, {
      name: 'custom',
      version: '1.0.0',
      description: 'custom skills dir',
      skills: 'my-skills',
    });
    writeSkillFile(installDir, 'my-skills', 'custom', 'custom');
    consent(installDir, 'custom');

    const contributions = await composePluginContributions(load(), {});
    expect(contributions.skillRoots.map((r) => r.path)).toEqual([join(installDir, 'my-skills')]);
  });

  test('produces NO skillRoot when the skills dir is absent', async () => {
    // A commands-only plugin: no skills/ dir → no skillRoot, but it IS active.
    const installDir = installDirOf('cmd-only');
    writeManifest(installDir, { name: 'cmd-only', version: '1.0.0', description: 'commands only' });
    writeSkillFile(installDir, 'commands', 'hello', 'hello');
    consent(installDir, 'cmd-only');

    const contributions = await composePluginContributions(load(), {});
    expect(contributions.skillRoots).toEqual([]);
  });
});

describe('composePluginContributions — commands (slash-only via buildSkillCommands)', () => {
  test('a plugin commands/ dir → its command appears in contributions.commands as a PromptCommand', async () => {
    const installDir = installDirOf('cmdplug');
    writeManifest(installDir, { name: 'cmdplug', version: '1.0.0', description: 'has commands' });
    writeSkillFile(installDir, 'commands', 'greet', 'greet', 'Hello from the command.');
    consent(installDir, 'cmdplug');

    const contributions = await composePluginContributions(load(), {});

    const greet = contributions.commands.find((c) => c.name === 'greet');
    expect(greet).toBeDefined();
    if (!greet) throw new Error('greet command missing');
    expect(greet.type).toBe('prompt');

    // The command's prompt expands (no shell, since plugin) — plain text out.
    const blocks = await greet.getPromptForCommand('', {
      cwd: home,
      sessionId: 'sess-1',
    } as never);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('Hello from the command.');
  });

  test('a plugin commands/ body does NOT run inline shell (plugin source)', async () => {
    const installDir = installDirOf('shellcmd');
    writeManifest(installDir, { name: 'shellcmd', version: '1.0.0', description: 'shell cmd' });
    writeSkillFile(installDir, 'commands', 'danger', 'danger', 'OUT=`!echo PWNED`');
    consent(installDir, 'shellcmd');

    const contributions = await composePluginContributions(load(), {});
    const danger = contributions.commands.find((c) => c.name === 'danger');
    if (!danger) throw new Error('danger command missing');

    const blocks = await danger.getPromptForCommand('', { cwd: home, sessionId: 's' } as never);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    // Shell never ran: the literal survives, the output was never substituted.
    expect(text).toContain('`!echo PWNED`');
    expect(text).not.toContain('OUT=PWNED');
  });

  test('produces NO command when the commands dir is absent', async () => {
    seedSkillPlugin('skills-only'); // only a skills/ dir
    const contributions = await composePluginContributions(load(), {});
    expect(contributions.commands).toEqual([]);
  });
});

describe('composePluginContributions — ${CLAUDE_PLUGIN_ROOT} threading (through loadSkills)', () => {
  test('a plugin skill body with ${CLAUDE_PLUGIN_ROOT} resolves to the install dir on expansion', async () => {
    const installDir = installDirOf('rooted');
    writeManifest(installDir, { name: 'rooted', version: '1.0.0', description: 'uses root var' });
    writeSkillFile(
      installDir,
      'skills',
      'rooted',
      'rooted',
      'See ${CLAUDE_PLUGIN_ROOT}/data.json for config.',
    );
    consent(installDir, 'rooted');

    const contributions = await composePluginContributions(load(), {});
    // Drive the produced skillRoots through the REAL skill loader (extraRoots),
    // then expand — the same path T8 wires.
    const registry = await loadSkills({
      harnessHome: home,
      cwd: home,
      extraRoots: contributions.skillRoots,
    });
    const skill = registry.byName.get('rooted');
    expect(skill).toBeDefined();
    if (!skill) throw new Error('rooted skill missing from registry');

    const expanded = await expandSkillPrompt(skill, { cwd: home });
    expect(expanded).toContain(`See ${installDir}/data.json for config.`);
    // Not left literal.
    expect(expanded).not.toContain('${CLAUDE_PLUGIN_ROOT}');
  });
});

describe('composePluginContributions — disclosures (inert)', () => {
  test('declared hooks/mcpServers + ignored keys are disclosed, producing NO behaviour', async () => {
    const installDir = installDirOf('discloser');
    writeManifest(installDir, {
      name: 'discloser',
      version: '1.0.0',
      description: 'declares inert blocks',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }],
      },
      mcpServers: { db: { command: 'mcp-db', args: [] } },
      // CC-only keys the harness ignores.
      agents: ['a'],
      keywords: ['k'],
      // Real content so the plugin is active (the disclosure path needs an
      // ACTIVE plugin).
      skills: 'skills',
    });
    writeSkillFile(installDir, 'skills', 'discloser', 'discloser');
    consent(installDir, 'discloser');

    const contributions = await composePluginContributions(load(), {});

    // Disclosed (with pluginId), but inert.
    expect(contributions.disclosedHooks).toHaveLength(1);
    expect(contributions.disclosedHooks[0]?.pluginId).toBe('discloser');
    expect(contributions.disclosedMcp).toHaveLength(1);
    expect(contributions.disclosedMcp[0]?.pluginId).toBe('discloser');

    // ignored[] keys surfaced per-plugin.
    const ignoredEntry = contributions.ignored.find((d) => d.pluginId === 'discloser');
    expect(ignoredEntry).toBeDefined();
    expect(ignoredEntry?.value).toEqual(expect.arrayContaining(['agents', 'keywords']));

    // The disclosure produced NO command from hooks/mcp (only the real skill).
    expect(contributions.commands).toEqual([]);
    // The only skillRoot is the real skills/ dir — hooks/mcp contribute none.
    expect(contributions.skillRoots.map((r) => r.path)).toEqual([join(installDir, 'skills')]);
  });

  test('a plugin with NO hooks/mcp/ignored discloses nothing for those', async () => {
    seedSkillPlugin('plain');
    const contributions = await composePluginContributions(load(), {});
    expect(contributions.disclosedHooks).toEqual([]);
    expect(contributions.disclosedMcp).toEqual([]);
    // No ignored keys for this plugin.
    expect(contributions.ignored.find((d) => d.pluginId === 'plain')).toBeUndefined();
  });
});

describe('composePluginContributions — inactive plugins contribute nothing', () => {
  test('an un-consented (needsConsent) plugin contributes no skillRoots/commands/disclosures', async () => {
    const installDir = installDirOf('inert');
    writeManifest(installDir, {
      name: 'inert',
      version: '1.0.0',
      description: 'never consented',
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo x' }] }] },
      agents: ['a'],
    });
    writeSkillFile(installDir, 'skills', 'inert', 'inert');
    writeSkillFile(installDir, 'commands', 'cmd', 'cmd');
    // NO consent written → needsConsent → inactive.

    const plugins = load();
    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.needsConsent).toBe(true);

    const contributions = await composePluginContributions(plugins, {});
    expect(contributions.skillRoots).toEqual([]);
    expect(contributions.commands).toEqual([]);
    expect(contributions.disclosedHooks).toEqual([]);
    expect(contributions.disclosedMcp).toEqual([]);
    expect(contributions.ignored).toEqual([]);
  });

  test('a disabled plugin contributes nothing', async () => {
    seedSkillPlugin('off');
    const plugins = loadPlugins({ harnessHome: home, config: { disabled: ['off'] } });
    const contributions = await composePluginContributions(plugins, {});
    expect(contributions.skillRoots).toEqual([]);
  });
});

describe('composePluginContributions — M1 containment', () => {
  test('a skills override escaping the install tree → no skillRoot + warn', async () => {
    // Seed real in-tree content so the plugin is ACTIVE (commands/), then point
    // skills OUT of tree. The escaping skills dir must be rejected.
    const installDir = installDirOf('escaper');
    writeManifest(installDir, {
      name: 'escaper',
      version: '1.0.0',
      description: 'points skills out of tree',
      skills: '../escape',
    });
    // Out-of-tree content the override points at.
    const escapeDir = join(home, 'plugins', 'escape');
    mkdirSync(escapeDir, { recursive: true });
    writeFileSync(join(escapeDir, 'evil.md'), skillMarkdown('evil', 'PWNED'), 'utf8');
    // In-tree command so the plugin passes liveness + is active.
    writeSkillFile(installDir, 'commands', 'ok', 'ok');
    consent(installDir, 'escaper');

    const plugins = load();
    const escaper = plugins.find((p) => p.id === 'escaper');
    expect(escaper).toBeDefined();

    const { warn, messages } = collectWarnings();
    const contributions = await composePluginContributions(plugins, { warn });

    // No skillRoot produced for the out-of-tree dir + a warn naming the plugin.
    expect(contributions.skillRoots).toEqual([]);
    expect(messages.some((m) => m.includes('escaper'))).toBe(true);
  });
});

describe('composePluginContributions — cross-plugin command dedupe', () => {
  test('two active plugins contributing a same-named command → first alphabetically wins + warn', async () => {
    // alpha + bravo each contribute a command named 'dup'. Alpha (alphabetical
    // first) wins; bravo's is dropped with a provenance-stamped warn.
    const dirA = installDirOf('alpha');
    writeManifest(dirA, { name: 'alpha', version: '1.0.0', description: 'alpha' });
    writeSkillFile(dirA, 'commands', 'dup', 'dup', 'FROM ALPHA');
    consent(dirA, 'alpha');

    const dirB = installDirOf('bravo');
    writeManifest(dirB, { name: 'bravo', version: '1.0.0', description: 'bravo' });
    writeSkillFile(dirB, 'commands', 'dup', 'dup', 'FROM BRAVO');
    consent(dirB, 'bravo');

    const { warn, messages } = collectWarnings();
    const contributions = await composePluginContributions(load(), { warn });

    const dups = contributions.commands.filter((c) => c.name === 'dup');
    expect(dups).toHaveLength(1);
    // The winner is alpha's (alphabetically first), not bravo's — verify by
    // expanding the surviving command and checking whose body it carries.
    const blocks = await dups[0]?.getPromptForCommand('', { cwd: home, sessionId: 's' } as never);
    const text = (blocks ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('FROM ALPHA');
    expect(text).not.toContain('FROM BRAVO');
    // A warn names the dropped plugin (bravo) + the command.
    expect(messages.some((m) => m.includes('bravo') && m.includes('dup'))).toBe(true);
    // No crash on a second compose either (the await would reject on a throw).
    const second = await composePluginContributions(load(), {});
    expect(second.commands.filter((c) => c.name === 'dup')).toHaveLength(1);
  });
});

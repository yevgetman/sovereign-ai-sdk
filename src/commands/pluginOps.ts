// `/plugins` command (T7) — the operator-facing surface over the plugin system:
// the T3 loader (discovery + the consent/integrity gate), T6 install/uninstall
// (the TTY disclose-and-consent flow), and the opt-in `plugins` config block.
//
// This command is UI-agnostic (a `LocalCommand` returning display text) and
// NEVER throws out of a verb — every failure becomes a friendly message. The
// security-load-bearing pieces stay where they belong: the loader owns the
// consent gate (so `list`/`info` only DISCLOSE verdicts, never bypass them), and
// `installPlugin` owns the up-front safety gates + the consent mint. `install`
// requires an injected TTY `confirm` (S3) — absent on server/TUI surfaces, where
// it refuses with a clear "install requires a terminal" message.

import { join } from 'node:path';
import type { CommandContext, LocalCommand, SlashCommand } from '@yevgetman/sov-sdk/commands/types';
import type { PluginsConfig, Settings } from '@yevgetman/sov-sdk/config/schema';
import { readConfig, resolveConfigPath, writeConfig } from '@yevgetman/sov-sdk/config/store';
import { countHooks, describeMcpHosts, plural } from '../plugins/disclosure.js';
import {
  type InstallPluginResult,
  type UninstallPluginResult,
  installPlugin,
  uninstallPlugin,
} from '../plugins/install.js';
import { type PluginLoaderConfig, loadPlugins } from '../plugins/loader.js';
import { countPluginComponents, statusOfPlugin } from '../plugins/snapshot.js';
import type { LoadedPlugin } from '../plugins/types.js';

/** A plugin name must be a lowercase hyphen-separated slug — matches the
 *  manifest regex + the install/uninstall path-traversal guard. Used here to
 *  reject an unsafe `<name>` argument before it reaches the filesystem. */
const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]*$/;

const USAGE = [
  'usage: /plugins <subcommand>',
  '  list                 list installed plugins + status',
  '  info <name>          show a plugin manifest + disclosed/inert blocks',
  '  install <dir>        install a plugin from a local dir (requires a terminal)',
  '  uninstall <name>     remove an installed plugin',
  '  enable <name>        add a plugin to the opt-in allow-list (restart to apply)',
  '  disable <name>       turn a plugin off (restart to apply)',
].join('\n');

export const pluginsCommand: LocalCommand = {
  type: 'local',
  name: 'plugins',
  description: 'List, inspect, install, and enable/disable harness plugins.',
  usage: '/plugins [list|info <name>|install <dir>|uninstall <name>|enable <name>|disable <name>]',
  call: async (args, ctx) => dispatchPluginsCommand(args, ctx),
};

export const PLUGIN_OPS_COMMANDS: SlashCommand[] = [pluginsCommand];

/** Route a `/plugins` invocation to its subcommand. Never throws — every path
 *  returns display text. */
async function dispatchPluginsCommand(args: string, ctx: CommandContext): Promise<string> {
  const { verb, rest } = splitVerb(args);
  switch (verb) {
    case '':
      return USAGE;
    case 'list':
      return runList(ctx);
    case 'info':
      return runInfo(rest, ctx);
    case 'install':
      return runInstall(rest, ctx);
    case 'uninstall':
      return runUninstall(rest, ctx);
    case 'enable':
      return runToggle(rest, ctx, 'enable');
    case 'disable':
      return runToggle(rest, ctx, 'disable');
    default:
      return `unknown subcommand: ${verb}\n\n${USAGE}`;
  }
}

// ──────────────────────────────────────────────────────────────────────
// list
// ──────────────────────────────────────────────────────────────────────

function runList(ctx: CommandContext): string {
  const home = ctx.harnessHome;
  if (!home) return 'plugins unavailable: no harness home in this context.';

  const plugins = loadPlugins({ harnessHome: home, config: readPluginsConfig(home) });
  if (plugins.length === 0) {
    return `no plugins installed (looked under ${join(home, 'plugins')}).`;
  }

  const rows = plugins.map((p) => {
    const counts = countPluginComponents(p);
    return {
      name: p.id,
      version: p.manifest.version,
      status: statusOfPlugin(p),
      skills: counts.skills,
      commands: counts.commands,
    };
  });

  const nameW = Math.max(4, ...rows.map((r) => r.name.length));
  const verW = Math.max(7, ...rows.map((r) => r.version.length));
  const statusW = Math.max(6, ...rows.map((r) => r.status.length));

  const header = `${pad('NAME', nameW)}  ${pad('VERSION', verW)}  ${pad('STATUS', statusW)}  COMPONENTS`;
  const lines = rows.map(
    (r) =>
      `${pad(r.name, nameW)}  ${pad(r.version, verW)}  ${pad(r.status, statusW)}  ` +
      `${plural(r.skills, 'skill')}, ${plural(r.commands, 'command')}`,
  );
  return [header, ...lines].join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// info
// ──────────────────────────────────────────────────────────────────────

function runInfo(rest: string, ctx: CommandContext): string {
  const home = ctx.harnessHome;
  if (!home) return 'plugins unavailable: no harness home in this context.';

  const name = rest.trim();
  if (!PLUGIN_NAME_RE.test(name)) {
    return `invalid plugin name: ${name || '(none)'} — must be a lowercase hyphen-separated slug.`;
  }

  const plugins = loadPlugins({ harnessHome: home, config: readPluginsConfig(home) });
  const plugin = plugins.find((p) => p.id === name);
  if (!plugin) {
    return `plugin '${name}' is not installed (looked under ${join(home, 'plugins')}).`;
  }

  const { manifest } = plugin;
  const lines: string[] = [];
  lines.push(
    `${manifest.name} v${manifest.version}${manifest.author ? ` by ${manifest.author}` : ''}`,
  );
  lines.push(manifest.description);
  lines.push(`status: ${statusOfPlugin(plugin)}`);
  lines.push(`installed at: ${plugin.installDir}`);

  const counts = countPluginComponents(plugin);
  lines.push(
    `contributes: ${plural(counts.skills, 'skill')}, ${plural(counts.commands, 'command')}`,
  );

  const inert = describeInert(manifest.hooks, manifest.mcpServers);
  if (inert) lines.push(`declares (INERT in v1 — disclosed, never run): ${inert}`);

  if (manifest.ignored.length > 0) {
    lines.push(`ignores CC-only feature(s): ${manifest.ignored.join(', ')}`);
  }

  // The per-component guard verdict (disabled-by-policy) is surfaced at install
  // time in the consent disclosure; if this plugin is inert, say why here.
  if (plugin.needsConsent) {
    lines.push('disabled by guard: needs consent — run `/plugins install <dir>` to (re)consent.');
  } else if (plugin.tampered) {
    lines.push('disabled by guard: tree changed since consent (tampered) — reinstall.');
  } else if (!plugin.enabled) {
    lines.push(`disabled by guard: turned off via config — \`/plugins enable ${name}\`.`);
  }

  return lines.join('\n');
}

/** A compact "Declares (INERT…)" clause from the manifest's hooks + mcpServers,
 *  or '' when neither is declared. Reuses `disclosure.ts`'s count/host primitives
 *  so this inspect surface and the install consent disclosure derive the same
 *  facts from ONE place — only the (terser) format here is local. */
function describeInert(
  hooks: LoadedPlugin['manifest']['hooks'],
  mcpServers: LoadedPlugin['manifest']['mcpServers'],
): string {
  const parts: string[] = [];
  const hookCount = countHooks(hooks);
  if (hookCount > 0) parts.push(`${plural(hookCount, 'hook')}`);
  const mcpCount = mcpServers ? Object.keys(mcpServers).length : 0;
  if (mcpCount > 0) {
    parts.push(`${plural(mcpCount, 'MCP server')} (${describeMcpHosts(mcpServers)})`);
  }
  return parts.join('; ');
}

// ──────────────────────────────────────────────────────────────────────
// install
// ──────────────────────────────────────────────────────────────────────

async function runInstall(rest: string, ctx: CommandContext): Promise<string> {
  const home = ctx.harnessHome;
  if (!home) return 'plugins unavailable: no harness home in this context.';

  const dir = rest.trim();
  if (!dir) return 'usage: /plugins install <dir>';

  // S3 — install is TTY-only. A non-TTY surface (server / TUI) has no injected
  // consent prompt, so we refuse rather than silently consenting.
  if (!ctx.confirm) {
    return 'plugin install requires a terminal (run `/plugins install` from the CLI / `sov drive`, not the server / TUI).';
  }
  const confirm = ctx.confirm;

  let result: InstallPluginResult;
  try {
    result = await installPlugin({
      source: dir,
      pluginsRoot: join(home, 'plugins'),
      confirm: (disclosure) => confirm(disclosure),
      now: new Date().toISOString(),
    });
  } catch (err) {
    return `plugin install failed: ${errorMessage(err)}`;
  }

  if (result.ok) {
    return [
      `installed plugin '${result.name}' → ${result.installedAt}`,
      `  ${plural(result.skillCount, 'skill')}, ${plural(result.commandCount, 'command')}`,
      'restart to apply (plugins load at boot).',
    ].join('\n');
  }
  if ('declined' in result) {
    return 'install declined — nothing was installed.';
  }
  return `install refused: ${result.reason}`;
}

// ──────────────────────────────────────────────────────────────────────
// uninstall
// ──────────────────────────────────────────────────────────────────────

async function runUninstall(rest: string, ctx: CommandContext): Promise<string> {
  const home = ctx.harnessHome;
  if (!home) return 'plugins unavailable: no harness home in this context.';

  const name = rest.trim();
  if (!PLUGIN_NAME_RE.test(name)) {
    return `invalid plugin name: ${name || '(none)'} — must be a lowercase hyphen-separated slug.`;
  }

  let result: UninstallPluginResult;
  try {
    result = await uninstallPlugin({ name, pluginsRoot: join(home, 'plugins') });
  } catch (err) {
    return `plugin uninstall failed: ${errorMessage(err)}`;
  }
  if (result.ok) {
    return `uninstalled plugin '${result.name}' (removed ${result.removedFrom}).`;
  }
  return `uninstall failed: ${result.reason}`;
}

// ──────────────────────────────────────────────────────────────────────
// enable / disable
// ──────────────────────────────────────────────────────────────────────

/** Mutate the config's `plugins` block (immutably) + persist it. `enable` adds
 *  the name to `enabled` and removes it from `disabled`; `disable` adds it to
 *  `disabled` and removes it from `enabled`. Plugins load at boot, so the change
 *  takes effect on the next session — surfaced as a "restart to apply" note. */
function runToggle(rest: string, ctx: CommandContext, op: 'enable' | 'disable'): string {
  const home = ctx.harnessHome;
  if (!home) return 'plugins unavailable: no harness home in this context.';

  const name = rest.trim();
  if (!PLUGIN_NAME_RE.test(name)) {
    return `invalid plugin name: ${name || '(none)'} — must be a lowercase hyphen-separated slug.`;
  }

  // Read + write the SAME resolved config path so the round-trip is consistent
  // regardless of HARNESS_CONFIG / the global-home fallback.
  const path = resolveConfigPath(undefined, home);
  let settings: Settings;
  try {
    settings = readConfig({ path });
  } catch (err) {
    return `could not read config: ${errorMessage(err)}`;
  }

  const current = settings.plugins ?? {};
  const enabledSet = new Set(current.enabled ?? []);
  const disabledSet = new Set(current.disabled ?? []);
  if (op === 'enable') {
    enabledSet.add(name);
    disabledSet.delete(name);
  } else {
    disabledSet.add(name);
    enabledSet.delete(name);
  }

  // Build a NEW plugins block (immutable update). Omit an array that ends up
  // empty so the persisted config stays tidy — conditional spreads keep each
  // key absent (never an explicit `undefined`) under exactOptionalPropertyTypes.
  const nextPlugins: PluginsConfig = {
    ...(enabledSet.size > 0 ? { enabled: [...enabledSet] } : {}),
    ...(disabledSet.size > 0 ? { disabled: [...disabledSet] } : {}),
  };
  const next: Settings = { ...settings, plugins: nextPlugins };

  try {
    writeConfig(next, path);
  } catch (err) {
    return `could not write config: ${errorMessage(err)}`;
  }

  const verb = op === 'enable' ? 'enabled' : 'disabled';
  return `${verb} plugin '${name}'. Restart to apply (plugins load at boot).`;
}

// ──────────────────────────────────────────────────────────────────────
// shared helpers
// ──────────────────────────────────────────────────────────────────────

/** Read the `plugins` config block from `<home>` (the #55-safe form), normalized
 *  into the loader's `PluginLoaderConfig` shape (only present keys included, so
 *  an absent list stays absent). Falls back to an empty block when the file is
 *  absent or unreadable — best-effort; a bad config must not break
 *  `/plugins list`. */
function readPluginsConfig(home: string): PluginLoaderConfig {
  let block: PluginsConfig = {};
  try {
    block = readConfig({ harnessHome: home }).plugins ?? {};
  } catch {
    block = {};
  }
  return {
    ...(block.enabled ? { enabled: block.enabled } : {}),
    ...(block.disabled ? { disabled: block.disabled } : {}),
  };
}

function splitVerb(args: string): { verb: string; rest: string } {
  const trimmed = args.trim();
  if (!trimmed) return { verb: '', rest: '' };
  const firstSpace = trimmed.search(/\s/);
  if (firstSpace === -1) return { verb: trimmed.toLowerCase(), rest: '' };
  return {
    verb: trimmed.slice(0, firstSpace).toLowerCase(),
    rest: trimmed.slice(firstSpace + 1).trim(),
  };
}

function pad(value: string, width: number): string {
  return value + ' '.repeat(Math.max(0, width - value.length));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

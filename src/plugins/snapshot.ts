// Plugin disclosure-snapshot builder (T8) — the shared, I/O-light projection of
// the discovered `LoadedPlugin[]` into the per-plugin rows the disclosure
// surfaces render: HarnessInfo's `plugins` section (T8) and the `/plugins list`
// table (T7). Owning the status precedence + the component counting in ONE
// place keeps the two surfaces from drifting (a `/plugins list` STATUS column
// and a HarnessInfo `status` field must mean the same thing).
//
// Pure aside from the component-count filesystem walk (which mirrors the
// loader's per-component view: a directory-skill counts as ONE, loose `.md`
// files count individually). Mutates no input.

import { type Dirent, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { countHooks } from './disclosure.js';
import type { LoadedPlugin } from './types.js';

/** One discovered plugin's status, in disclosure precedence: a tampered tree is
 *  the most urgent, then needs-consent, then opt-out (disabled), then active.
 *  Only `active` plugins contribute skills/commands. */
export type PluginStatus = 'active' | 'needs-consent' | 'tampered' | 'disabled';

/** A single discovered plugin's disclosure row. */
export type PluginSnapshot = {
  name: string;
  version: string;
  status: PluginStatus;
  skillCount: number;
  commandCount: number;
  /** Declared-but-INERT hook commands (disclosed, never run in v1). */
  disclosedHookCount: number;
  /** Declared-but-INERT MCP servers (disclosed, never connected in v1). */
  disclosedMcpCount: number;
  /** Unknown / CC-only top-level manifest keys the harness ignores. */
  ignoredKeys: string[];
};

/** The disclosure-precedence status for a discovered plugin. The single
 *  derivation both `/plugins` and HarnessInfo consult — do NOT re-derive
 *  inline elsewhere. */
export function statusOfPlugin(plugin: LoadedPlugin): PluginStatus {
  if (plugin.tampered) return 'tampered';
  if (plugin.needsConsent) return 'needs-consent';
  if (!plugin.enabled) return 'disabled';
  return 'active';
}

/** Light component count for a plugin: the skill components under its
 *  (manifest-declared) `skills/` dir and the command components under its
 *  `commands/` dir. A directory-skill (a dir holding `SKILL.md`) counts as ONE;
 *  loose `.md` files count individually — mirroring the loader's per-component
 *  view. Best-effort: an unreadable / absent dir contributes 0. */
export function countPluginComponents(plugin: LoadedPlugin): {
  skills: number;
  commands: number;
} {
  return {
    skills: countComponentDir(join(plugin.installDir, plugin.manifest.skills)),
    commands: countComponentDir(join(plugin.installDir, plugin.manifest.commands)),
  };
}

/** Project every discovered plugin into its disclosure row. Lists ALL
 *  discovered plugins (active AND inert) — the disclosure must be honest about
 *  what is present and WHY it is inert. */
export function buildPluginSnapshots(plugins: readonly LoadedPlugin[]): PluginSnapshot[] {
  return plugins.map((plugin) => {
    const counts = countPluginComponents(plugin);
    const { manifest } = plugin;
    return {
      name: plugin.id,
      version: manifest.version,
      status: statusOfPlugin(plugin),
      skillCount: counts.skills,
      commandCount: counts.commands,
      disclosedHookCount: countHooks(manifest.hooks),
      disclosedMcpCount: manifest.mcpServers ? Object.keys(manifest.mcpServers).length : 0,
      ignoredKeys: manifest.ignored,
    };
  });
}

// NOTE: this walk mirrors the skill loader's `listMarkdownFiles`/`walk`
// semantics (`src/skills/loader.ts`): a dir holding `SKILL.md` is ONE component
// (no descent), otherwise recurse and count each loose `.md`. The sibling
// `walkComponentFiles` in `src/plugins/install.ts` implements the same rule but
// async + collecting file paths (vs this sync count); the sync/async + shape
// split is why they are not a single shared helper. Keep all three in sync.
function countComponentDir(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  const walk = (d: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    const skillMd = entries.find((e) => e.isFile() && e.name.toLowerCase() === 'skill.md');
    if (skillMd) {
      // Directory-skill: one component; do not descend.
      count += 1;
      return;
    }
    for (const entry of entries) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) count += 1;
    }
  };
  walk(dir);
  return count;
}

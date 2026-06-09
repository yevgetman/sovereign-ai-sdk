// Plugin compose (T4) — turn the GATED `LoadedPlugin[]` from T3's loader into
// the `PluginContributions` shape T8 splices into the runtime. Pure aggregation:
// NO consent logic (T3 owns the gate), NO install (T6), NO runtime wiring (T8).
//
// The design intent encoded here:
//   - skills/ feed the skill REGISTRY (system prompt + slash commands) via
//     `skillRoots` (spliced into loadSkills' `extraRoots` at T8). They become
//     real Skills — prompt-injected AND dispatchable.
//   - commands/ become slash-commands ONLY: loaded through the SAME skill
//     machinery (`loadSkillFromPath` per `.md` → a `SkillRegistry` →
//     `buildSkillCommands`) and returned in `commands`, but NEVER added to
//     `runtime.skills` (T8) — so they do NOT reach the skill system-prompt
//     injection. This matches CC's command semantics (skills/ are the
//     prompt-injected ones; commands/ are pure slash-commands).
//   - hooks/mcpServers/ignored are DISCLOSED (informational, per-plugin),
//     producing NO actual hook/mcp behaviour — the whole point of v1 is to
//     disclose + defer them.
//   - ONLY ACTIVE plugins contribute (`isPluginActive`): an un-consented,
//     tampered, or disabled plugin contributes NOTHING.
//
// Async because the command path reuses the (async) skill-loading machinery
// rather than re-implementing markdown parsing — DRY over a synchronous return.
// T8 already composes inside an async boot (it awaits `loadSkills`).

import { type Dirent, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { PromptCommand } from '../commands/types.js';
import { buildSkillCommands } from '../skills/commands.js';
import { loadSkillFromPath } from '../skills/loader.js';
import type { SkillRoot } from '../skills/loader.js';
import type { Skill } from '../skills/types.js';
import { isPluginActive } from './loader.js';
import type { DisclosedComponent, LoadedPlugin, PluginContributions } from './types.js';

export type ComposeOptions = {
  /** Provenance-stamped warnings for rejected (out-of-tree) dirs + dropped
   *  (duplicate-name) commands. Never thrown — composition is best-effort. */
  readonly warn?: (message: string) => void;
};

/** The trust classification every plugin-sourced skill/command carries. */
const PLUGIN_CLASSIFICATION = { source: 'plugin', trustTier: 'community' } as const;

/**
 * Compose the aggregate `PluginContributions` from the gated plugins. Iterates
 * the (alphabetically-sorted, per T3) plugins so cross-plugin dedupe is
 * deterministic (first plugin alphabetically wins). Only active plugins
 * contribute; everything else (inert/disabled) is skipped silently here (the
 * loader already warned about WHY it's inert).
 */
export async function composePluginContributions(
  plugins: readonly LoadedPlugin[],
  opts: ComposeOptions,
): Promise<PluginContributions> {
  const active = plugins.filter(isPluginActive);

  const skillRoots: SkillRoot[] = [];
  const commands: PromptCommand[] = [];
  const disclosedHooks: DisclosedComponent<NonNullable<LoadedPlugin['manifest']['hooks']>>[] = [];
  const disclosedMcp: DisclosedComponent<NonNullable<LoadedPlugin['manifest']['mcpServers']>>[] =
    [];
  const ignored: DisclosedComponent<string[]>[] = [];

  // First-wins-by-name dedupe for the commands array we build ourselves (the
  // skill loader's byName handles skill-name collisions once spliced; commands
  // are not spliced, so we own their dedupe). Deterministic because `active` is
  // alphabetically ordered by plugin id.
  const commandNames = new Set<string>();

  for (const plugin of active) {
    const skillRoot = composeSkillRoot(plugin, opts.warn);
    if (skillRoot) skillRoots.push(skillRoot);

    for (const command of await composeCommands(plugin, opts.warn)) {
      if (commandNames.has(command.name)) {
        opts.warn?.(
          `plugin ${plugin.id}: command '${command.name}' shadowed by an earlier plugin — dropped`,
        );
        continue;
      }
      commandNames.add(command.name);
      commands.push(command);
    }

    collectDisclosures(plugin, disclosedHooks, disclosedMcp, ignored);
  }

  return { skillRoots, commands, disclosedHooks, disclosedMcp, ignored };
}

/**
 * One `SkillRoot` for the plugin's (contained) `skills/` dir, or null when the
 * dir is out-of-tree (M1) or absent. Honours the manifest's `skills` override
 * but CONTAINS it: `resolve(installDir, manifest.skills)` must stay under the
 * install root (mirrors the T3 loader's `isWithin` boundary so the skill set
 * matches the hash-covered tree). An out-of-tree override is rejected + warned.
 */
function composeSkillRoot(plugin: LoadedPlugin, warn?: (m: string) => void): SkillRoot | null {
  const dir = containedDir(plugin.installDir, plugin.manifest.skills, 'skills', plugin.id, warn);
  if (dir === null || !existsSync(dir)) return null;
  return { ...PLUGIN_CLASSIFICATION, path: dir, pluginRoot: plugin.installDir };
}

/**
 * The plugin's (contained) `commands/` markdown loaded into `PromptCommand`s via
 * the existing skill machinery: each `.md` → `loadSkillFromPath` (classified
 * `plugin`/`community`, carrying the plugin install dir as `${CLAUDE_PLUGIN_ROOT}`
 * provenance) → a `SkillRegistry` → `buildSkillCommands`. Returns [] when the
 * dir is out-of-tree (M1), absent, or holds no loadable command. These become
 * slash-commands ONLY (T8 does NOT add them to `runtime.skills`).
 */
async function composeCommands(
  plugin: LoadedPlugin,
  warn?: (m: string) => void,
): Promise<PromptCommand[]> {
  const dir = containedDir(
    plugin.installDir,
    plugin.manifest.commands,
    'commands',
    plugin.id,
    warn,
  );
  if (dir === null || !existsSync(dir)) return [];

  const skills: Skill[] = [];
  const byName = new Map<string, Skill>();
  for (const file of await listMarkdownFiles(dir)) {
    const skill = await loadSkillFromPath(file, PLUGIN_CLASSIFICATION, warn, plugin.installDir);
    if (!skill) continue;
    // Within a single plugin's commands dir, first-loaded (sorted) wins a name
    // collision — same first-wins contract the skill loader uses.
    if (byName.has(skill.name)) {
      warn?.(`plugin ${plugin.id}: duplicate command name '${skill.name}' within plugin — dropped`);
      continue;
    }
    byName.set(skill.name, skill);
    skills.push(skill);
  }
  return buildSkillCommands({ skills, byName });
}

/**
 * Resolve `<installDir>/<rel>` and require it to stay under the install root
 * (M1 containment). Returns the absolute dir, or null (+ warn) when it escapes.
 * Mirrors the T3 loader's `hasRealContent` containment so the contribution set
 * agrees with the tamper-hashed tree boundary.
 */
function containedDir(
  installDir: string,
  rel: string,
  kind: 'skills' | 'commands',
  pluginId: string,
  warn?: (m: string) => void,
): string | null {
  const candidate = join(installDir, rel);
  if (!isWithin(installDir, candidate)) {
    warn?.(`plugin ${pluginId}: ${kind} dir '${rel}' escapes the install tree — ignored`);
    return null;
  }
  return resolve(candidate);
}

/** Push the plugin's declared-but-inert hooks/mcp blocks + ignored CC-only keys
 *  onto the disclosure accumulators, each stamped with the plugin id. Absent /
 *  empty blocks contribute nothing. Purely informational — NO behaviour. */
function collectDisclosures(
  plugin: LoadedPlugin,
  disclosedHooks: DisclosedComponent<NonNullable<LoadedPlugin['manifest']['hooks']>>[],
  disclosedMcp: DisclosedComponent<NonNullable<LoadedPlugin['manifest']['mcpServers']>>[],
  ignored: DisclosedComponent<string[]>[],
): void {
  const { manifest } = plugin;
  if (manifest.hooks !== undefined) {
    disclosedHooks.push({ pluginId: plugin.id, value: manifest.hooks });
  }
  if (manifest.mcpServers !== undefined) {
    disclosedMcp.push({ pluginId: plugin.id, value: manifest.mcpServers });
  }
  if (manifest.ignored.length > 0) {
    ignored.push({ pluginId: plugin.id, value: manifest.ignored });
  }
}

/** True when `candidate` resolves to a path at or under `root`. The trailing
 *  separator on the prefix avoids the `/foo` vs `/foobar` sibling-prefix bug.
 *  Mirrors the identical guard in the T3 loader (kept local — no cross-module
 *  coupling for a four-line predicate). */
function isWithin(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (resolvedCandidate === resolvedRoot) return true;
  return resolvedCandidate.startsWith(resolvedRoot + sep);
}

/** The immediate `.md` files under `dir`, sorted for deterministic load order.
 *  Shallow (no recursion): a plugin commands dir is a flat set of command files
 *  (CC convention), and a flat scan keeps command identity = filename-stem-free
 *  (the skill frontmatter `name` is the command name). A read failure degrades
 *  to no commands rather than crashing the compose. */
async function listMarkdownFiles(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.md')
    .map((entry) => join(dir, entry.name))
    .sort();
}

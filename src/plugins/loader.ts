// Plugin loader (T3) — discovery + manifest validation + the load-time
// consent/integrity gate (S1), the load-bearing security control of the whole
// feature. It scans `<harnessHome>/plugins/*/`, validates each manifest, and
// returns the GATED `LoadedPlugin[]`. Producing `PluginContributions` /
// assembling the `PluginRegistry` is T4/T8's job — this module deliberately
// does NOT build skillRoots/commands.
//
// The security model (enforced HERE, independent of the install path): directory
// presence may *discover* a plugin (so it can be listed) but NEVER *enable* it.
// A plugin contributes/activates ONLY when ALL hold:
//   1. `readConsent(installDir)` returns a non-null record,
//   2. that record's `pluginId` matches the manifest `name` (the identity),
//   3. `verifyConsent` is true (recomputed tree hash matches the recorded one),
//   4. the plugin actually carries a non-empty `skills/` or `commands/` dir
//      (the empty-tree guard — an empty tree hashes to a stable digest and must
//      not count as a meaningful active plugin), AND
//   5. it is enabled by the opt-in allow-list (disabled-wins precedence).
// Anything short of (1)–(4) makes it discovered-but-inert and flagged
// (`needsConsent` / `tampered`); (5) only flips `enabled`. Even a plugin dropped
// into the dir by hand (no install) is therefore inert.
//
// Robustness: a bad plugin (missing/malformed manifest) is SKIPPED with a warn —
// it must never crash the whole load (mirrors the skill loader's skip policy).
// Pure aside from reads: this module reads the filesystem and mutates no input.

import { type Dirent, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readConsent, verifyConsent } from './consent.js';
import { type PluginManifest, parsePluginManifest } from './manifest.js';
import { isWithin } from './pathContainment.js';
import type { LoadedPlugin } from './types.js';

/** The opt-in enable/disable config the loader consults. Both lists hold plugin
 *  names (manifest `name`). Sourced from settings in a later task; passed in
 *  here so the loader stays decoupled from the config schema. */
export type PluginLoaderConfig = {
  readonly enabled?: readonly string[];
  readonly disabled?: readonly string[];
};

export type LoadPluginsOptions = {
  /** Harness home whose `plugins/` subdir is scanned. ALWAYS the passed home —
   *  never a global `homedir()`/env default (regression guard for #55). */
  readonly harnessHome: string;
  readonly config: PluginLoaderConfig;
  readonly warn?: (message: string) => void;
};

/** The component dirs whose non-empty presence makes a plugin meaningful. A
 *  plugin must carry at least one of these (with real content) to be active —
 *  see the empty-tree guard. */
const COMPONENT_DIRS = ['skills', 'commands'] as const;

/** True only when the plugin is consented, untampered, carries real content,
 *  AND is enabled — i.e. it actually contributes downstream. The single
 *  predicate T4 (compose) should consult; do not re-derive this inline. */
export function isPluginActive(plugin: LoadedPlugin): boolean {
  return !plugin.needsConsent && !plugin.tampered && plugin.enabled;
}

/**
 * Discover, validate, and gate every plugin under `<harnessHome>/plugins/*`.
 * Returns the gated `LoadedPlugin[]` sorted alphabetically by id. Never throws
 * for a bad plugin — discovery is best-effort and skips with `warn`.
 */
export function loadPlugins(opts: LoadPluginsOptions): LoadedPlugin[] {
  const pluginsDir = join(opts.harnessHome, 'plugins');
  if (!existsSync(pluginsDir)) return [];

  const loaded: LoadedPlugin[] = [];
  for (const installDir of listInstallDirs(pluginsDir, opts.warn)) {
    const plugin = loadOne(installDir, opts.config, opts.warn);
    if (plugin) loaded.push(plugin);
  }

  // Deterministic, platform-independent ordering by identity, with installDir as
  // a secondary key so two manifests declaring the same `name` still sort
  // stably (rather than falling back to platform readdir order). Duplicate-id
  // dedupe / collision handling is T4's job — this only pins a stable order.
  loaded.sort((a, b) => a.id.localeCompare(b.id) || a.installDir.localeCompare(b.installDir));
  return loaded;
}

/** List the candidate install dirs (immediate subdirectories) under the plugins
 *  dir. A read failure degrades to "no plugins" rather than crashing the load. */
function listInstallDirs(pluginsDir: string, warn?: (m: string) => void): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(pluginsDir, { withFileTypes: true });
  } catch (err) {
    warn?.(`plugins dir unreadable (${pluginsDir}): ${errorMessage(err)}`);
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(pluginsDir, entry.name));
}

/** Load + gate a single candidate. Returns null (skip) when the dir is not a
 *  plugin (no manifest) or its manifest is malformed; otherwise a gated
 *  `LoadedPlugin` (which may be inert). */
function loadOne(
  installDir: string,
  config: PluginLoaderConfig,
  warn?: (m: string) => void,
): LoadedPlugin | null {
  const manifest = readManifest(installDir, warn);
  if (!manifest) return null;

  const id = manifest.name;
  const gate = evaluateGateSafe(installDir, manifest, warn);
  const enabled = isEnabled(id, config);

  return {
    id,
    manifest,
    installDir,
    needsConsent: gate.needsConsent,
    tampered: gate.tampered,
    enabled,
  };
}

/**
 * Defense-in-depth wrapper around `evaluateGate` (layer 2 of the never-crash
 * contract). ANY unexpected error — a file turning unreadable mid-scan, a
 * permission error, an exotic FS entry layer 1 (the integrity walk) didn't
 * anticipate — degrades THIS plugin to a flagged-inert verdict
 * (`needsConsent`), never propagating out of `loadPlugins` to sink healthy
 * siblings. The plugin stays discoverable (so it's listed + actionable) but
 * contributes nothing — fail-closed.
 */
function evaluateGateSafe(
  installDir: string,
  manifest: PluginManifest,
  warn?: (m: string) => void,
): GateVerdict {
  try {
    return evaluateGate(installDir, manifest, warn);
  } catch (err) {
    warn?.(`plugin ${manifest.name} could not be evaluated — inert: ${errorMessage(err)}`);
    return { needsConsent: true, tampered: false };
  }
}

/** Read + parse `<installDir>/.claude-plugin/plugin.json`. Returns null (skip)
 *  when the manifest is absent (the dir is not a plugin) or fails to parse
 *  (malformed) — both warned, never thrown (mirrors the skill loader). */
function readManifest(installDir: string, warn?: (m: string) => void): PluginManifest | null {
  const manifestPath = join(installDir, '.claude-plugin', 'plugin.json');
  if (!existsSync(manifestPath)) {
    // A subdir without a manifest is simply not a plugin — quiet skip is fine,
    // but a warn aids debugging a mis-laid-out install dir.
    warn?.(`plugin skipped (${installDir}): no .claude-plugin/plugin.json`);
    return null;
  }
  try {
    return parsePluginManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
  } catch (err) {
    warn?.(`plugin skipped (${manifestPath}): ${errorMessage(err)}`);
    return null;
  }
}

type GateVerdict = { needsConsent: boolean; tampered: boolean };

/**
 * The consent/integrity gate (the crux). A valid consent record requires a
 * non-null record whose `pluginId` matches the manifest identity AND a
 * recomputed-hash match (`verifyConsent`). The empty-tree guard additionally
 * requires real content. Distinguishes the inert reasons:
 *   - no record / pluginId mismatch / empty tree → `needsConsent` (re-install).
 *   - record present + identity matches but hash mismatches → `tampered`.
 */
function evaluateGate(
  installDir: string,
  manifest: PluginManifest,
  warn?: (m: string) => void,
): GateVerdict {
  const id = manifest.name;

  // Empty-tree guard: an empty / component-less tree hashes to a stable digest;
  // it must never count as a meaningful active plugin even if "consented".
  if (!hasRealContent(installDir, manifest)) {
    warn?.(`plugin ${id} carries no skills/ or commands/ content — inert; reinstall with content`);
    return { needsConsent: true, tampered: false };
  }

  const record = readConsent(installDir);
  if (record === null || record.pluginId !== id) {
    warn?.(`plugin ${id} needs consent — run \`/plugins install\``);
    return { needsConsent: true, tampered: false };
  }

  // Record present + identity matches: the only remaining failure is a tree
  // edited after consent (TOCTOU H4).
  if (!verifyConsent(installDir, record)) {
    warn?.(`plugin ${id} tree changed since consent — reinstall`);
    return { needsConsent: false, tampered: true };
  }

  return { needsConsent: false, tampered: false };
}

/** True when the plugin carries at least one component dir (`skills`/`commands`,
 *  honouring the manifest's overrides) that is WITHIN the install tree and
 *  contains at least one file. Guards against the empty-tree / manifest-only
 *  "active but contributes nothing" case.
 *
 *  Containment (strong-rec fix): the liveness probe MUST agree with the tree
 *  hash on the install-tree boundary. `hashPluginTree` only ever hashes the real
 *  install tree, so a manifest override pointing OUT of the tree (e.g.
 *  `skills: '../sibling'`) is neither hash-covered nor content-bounded and must
 *  NOT satisfy liveness — otherwise a manifest-only plugin redirected at
 *  out-of-tree content would falsely count as active. Each candidate dir is
 *  resolved and required to stay under the install root before probing. */
function hasRealContent(installDir: string, manifest: PluginManifest): boolean {
  const dirs = new Set<string>([manifest.skills, manifest.commands, ...COMPONENT_DIRS]);
  for (const rel of dirs) {
    const candidate = join(installDir, rel);
    if (!isWithin(installDir, candidate)) continue; // out-of-tree ⇒ not liveness content
    if (dirHasFile(candidate)) return true;
  }
  return false;
}

/** True when `dir` exists and contains at least one regular file anywhere
 *  beneath it. A dir that is absent, empty, or holds only empty subdirectories
 *  is treated as no content. */
function dirHasFile(dir: string): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false; // absent or unreadable ⇒ no content
  }
  for (const entry of entries) {
    if (entry.isFile()) return true;
    if (entry.isDirectory() && dirHasFile(join(dir, entry.name))) return true;
  }
  return false;
}

/**
 * Resolve the opt-in allow-list decision for `id` (S4). Precedence:
 *   - `disabled` includes it → not enabled (disabled wins);
 *   - else if `enabled` is DEFINED → only listed plugins are enabled;
 *   - else (no allow-list) → enabled (consented plugins active by default).
 * The disabled-first order yields disabled-wins when a name is in both lists
 * (finalized + tested in T7).
 */
function isEnabled(id: string, config: PluginLoaderConfig): boolean {
  if (config.disabled?.includes(id)) return false;
  if (config.enabled !== undefined) return config.enabled.includes(id);
  return true;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

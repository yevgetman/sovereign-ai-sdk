// Plugin data shapes (T1) shared by the loader (T3), compose (T4), install
// (T6), and the `/plugins` command (T7). Pure types — no I/O, no behaviour.
//
// The security model these shapes encode (enforced later, not here): a plugin
// contributes NOTHING unless a valid consent record with a matching tree-hash
// exists (S1). `needsConsent`/`tampered` carry that verdict from the loader to
// the disclosure surface; an un-consented or tampered plugin is discovered (so
// it can be listed) but its contributions are withheld. `enabled` carries the
// opt-in allow-list decision (S4). Unknown CC-only manifest keys are disclosed
// via `ignored`, never silently dropped.

import type { PromptCommand } from '../commands/types.js';
import type { SkillRoot } from '../skills/loader.js';
import type { PluginManifest } from './manifest.js';

/** A plugin discovered on disk, with its parsed manifest and the load-time
 *  verdict. A plugin may be discovered (present in the install dir) yet inert:
 *  `needsConsent`/`tampered` gate whether its contributions are surfaced, and
 *  `enabled` reflects the opt-in allow-list. Only a plugin that is enabled,
 *  consented (`!needsConsent`), and untampered (`!tampered`) contributes. */
export type LoadedPlugin = {
  /** The plugin's identity — its install-dir segment and inter-plugin sort key. */
  readonly id: string;
  /** Parsed, validated manifest (identity + component dirs + disclosed-inert blocks). */
  readonly manifest: PluginManifest;
  /** Absolute path to the plugin's install root (`~/.harness/plugins/<id>/`).
   *  Aliased to `${CLAUDE_PLUGIN_ROOT}` when the plugin's content interpolates. */
  readonly installDir: string;
  /** True when no valid consent record exists for this plugin (S1): the
   *  operator has not run `/plugins install`, or the record is absent. Inert. */
  readonly needsConsent: boolean;
  /** True when a consent record exists but the recomputed tree hash no longer
   *  matches the hash recorded at consent (S1 TOCTOU): the tree was edited
   *  after consent. Inert + flagged. */
  readonly tampered: boolean;
  /** True when the plugin is in the opt-in allow-list (S4). A disabled plugin
   *  is discovered + listed but contributes nothing. */
  readonly enabled: boolean;
};

/** The aggregate contributions composed from every active plugin, in the seam
 *  shapes the loaders consume. `skillRoots` splice into `loadSkills`; `commands`
 *  spread into the slash-command registry. `disclosedHooks`/`disclosedMcp` are
 *  the declared-but-inert blocks surfaced for the consent disclosure (never
 *  executed in v1); `ignored` aggregates every unknown CC-only key across
 *  plugins for the same disclosure. */
export type PluginContributions = {
  /** Extra skill roots spliced into the skill loader (after user, before bundle). */
  readonly skillRoots: SkillRoot[];
  /** Plugin-contributed slash commands (built-ins always win; inter-plugin
   *  order deterministic by plugin id). */
  readonly commands: PromptCommand[];
  /** Declared-but-inert hook blocks, per contributing plugin, for disclosure. */
  readonly disclosedHooks: DisclosedComponent<NonNullable<PluginManifest['hooks']>>[];
  /** Declared-but-inert MCP-server blocks, per contributing plugin, for disclosure. */
  readonly disclosedMcp: DisclosedComponent<NonNullable<PluginManifest['mcpServers']>>[];
  /** Unknown CC-only top-level keys, per contributing plugin, for disclosure. */
  readonly ignored: DisclosedComponent<string[]>[];
};

/** A declared-but-inert manifest block tagged with the plugin that declared it,
 *  so the disclosure can attribute "plugin X declares (inert) …". */
export type DisclosedComponent<T> = {
  readonly pluginId: string;
  readonly value: T;
};

/** What the loader (T3) returns and compose (T4) populates: the discovered
 *  plugins (each with its load verdict) plus their aggregate contributions. */
export type PluginRegistry = {
  readonly plugins: LoadedPlugin[];
  readonly contributions: PluginContributions;
};

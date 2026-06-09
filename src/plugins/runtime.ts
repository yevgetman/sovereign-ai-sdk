// Plugin runtime-load helper (T8) — the single async entry point that turns a
// harness home + the opt-in `plugins` config block into the pair the two boot
// surfaces need: the DISCOVERED `LoadedPlugin[]` (for the disclosure surface —
// `/plugins`, HarnessInfo) and the composed `PluginContributions` (the
// skillRoots + slash-commands the active plugins contribute).
//
// Exists so `buildRuntime` (server / TUI / `sov drive`) and `dispatchCommand`
// (CLI / headless) compose the loader (T3) + compose (T4) the SAME way and can
// never drift. Fail-soft is inherited: `loadPlugins` skips a bad plugin with a
// warn (never throws), `composePluginContributions` is best-effort, and an
// absent `plugins/` dir yields `{ plugins: [], contributions: empty }`.

import { composePluginContributions } from './compose.js';
import { type PluginLoaderConfig, loadPlugins } from './loader.js';
import type { LoadedPlugin, PluginContributions } from './types.js';

/** The opt-in allow-list the helper accepts. Mirrors the `plugins` config block
 *  (`PluginsConfig`) shape directly — optional keys MAY be `undefined` (what
 *  `readConfig(...).plugins ?? {}` yields under `exactOptionalPropertyTypes`).
 *  Normalized to the loader's strict `PluginLoaderConfig` before use, so both
 *  call sites can pass the raw config block without their own normalization. */
export type PluginRuntimeConfig = {
  readonly enabled?: readonly string[] | undefined;
  readonly disabled?: readonly string[] | undefined;
};

export type LoadPluginRuntimeOptions = {
  /** Harness home whose `plugins/` subdir is scanned. ALWAYS the runtime's
   *  resolved home — never a global `homedir()`/env default (regression guard
   *  for backlog #55). */
  readonly harnessHome: string;
  /** The opt-in enable/disable allow-list (the `plugins` config block). */
  readonly config: PluginRuntimeConfig;
  /** Provenance-stamped diagnostics sink (no `console.log`). Threaded into
   *  BOTH the loader (skip reasons / inert verdicts) and compose (rejected
   *  out-of-tree dirs / dropped duplicate commands). */
  readonly warn?: (message: string) => void;
};

/** Drop `undefined`-valued optional keys so the strict `PluginLoaderConfig`
 *  (keys are `readonly string[]`, NOT `| undefined`) is satisfied under
 *  `exactOptionalPropertyTypes`. An absent list stays absent. */
function normalizeLoaderConfig(config: PluginRuntimeConfig): PluginLoaderConfig {
  return {
    ...(config.enabled !== undefined ? { enabled: config.enabled } : {}),
    ...(config.disabled !== undefined ? { disabled: config.disabled } : {}),
  };
}

export type LoadedPluginRuntime = {
  /** Every DISCOVERED plugin with its load verdict (active / needs-consent /
   *  tampered / disabled) — the disclosure surface lists ALL of these. */
  readonly plugins: LoadedPlugin[];
  /** The aggregate contributions from the ACTIVE plugins only (skillRoots +
   *  slash-commands; declared-inert hooks/mcp + ignored keys disclosed). */
  readonly contributions: PluginContributions;
};

/**
 * Discover + gate plugins (T3) and compose their contributions (T4) in one
 * call. Pure aside from the loader's filesystem reads; never throws for a bad
 * plugin (the loader fails-soft per plugin and an absent dir returns empty).
 */
export async function loadPluginRuntime(
  opts: LoadPluginRuntimeOptions,
): Promise<LoadedPluginRuntime> {
  const plugins = loadPlugins({
    harnessHome: opts.harnessHome,
    config: normalizeLoaderConfig(opts.config),
    ...(opts.warn ? { warn: opts.warn } : {}),
  });
  const contributions = await composePluginContributions(plugins, {
    ...(opts.warn ? { warn: opts.warn } : {}),
  });
  return { plugins, contributions };
}

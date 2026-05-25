// Config catalog live-apply hooks (v0, 2026-05-24 — see
// docs/specs/2026-05-24-config-ux-rebuild-design.md).
//
// A live-apply hook fires after a successful persist (writeConfig) when the
// runtime exposes a way to reflect the change in the active session without
// a restart. Each hook returns:
//   - 'applied'        — runtime state was updated; toast says
//                        "saved — applied to current session"
//   - 'persisted-only' — runtime can't reflect the change in-process; toast
//                        says "saved — effective next session"
//
// Hooks MUST handle `ctx.commandCtx === undefined` (the `sov config`
// standalone mode where no active session exists) by returning
// 'persisted-only'. Per-hook notes below capture WHY a given field is or
// isn't read-on-demand by its consumer.

import type { CommandContext } from '../commands/types.js';
import { setTheme } from '../ui/theme.js';

/**
 * Snapshot of effects a live-apply hook may emit beyond mutating
 * CommandContext state (which already has its own setters like setModel).
 * `themeChanged` / `verboseChanged` flow back to the TUI as SSE
 * side-effects so the renderer can update its in-process state — the
 * TS-side singleton (setTheme) has no effect on the Go renderer.
 */
export type LiveApplySideEffect = {
  themeChanged?: string;
  verboseChanged?: boolean;
  taskRouterChanged?: string;
};

/**
 * Context passed to every live-apply hook. `commandCtx` is undefined when
 * the hook runs from `sov config` standalone mode (no active session).
 * `recordSideEffect` is the closure the slash dispatcher provides for
 * fields whose change must be relayed to the TUI as an SSE side-effect.
 */
export type LiveApplyContext = {
  commandCtx?: CommandContext;
  recordSideEffect?: (effect: LiveApplySideEffect) => void;
};

/**
 * Signature: receives the about-to-be-persisted value and the live-apply
 * context. Returns `'applied'` when the runtime reflects the change in the
 * active session, `'persisted-only'` otherwise.
 */
export type LiveApplyHook = (
  newValue: unknown,
  ctx: LiveApplyContext,
) => Promise<'applied' | 'persisted-only'>;

// ──────────────────────────────────────────────────────────────────────
// Individual hooks
// ──────────────────────────────────────────────────────────────────────

/**
 * `theme` — `setTheme(name)` mutates the TS-side singleton; the side-effect
 * relays the name to the Go renderer so it updates its in-process state
 * too. Matches the existing `/theme <name>` protocol.
 */
const themeHook: LiveApplyHook = async (newValue, ctx) => {
  // Standalone `sov config` mode — no active session to apply against.
  // Skip the singleton mutation (we're a transient editor process, the
  // TS theme singleton is unused here) and report persisted-only.
  // The Go TUI in standalone mode is config-only; it doesn't render
  // themed content beyond the picker chrome itself. 2026-05-24 review #2.
  if (ctx.commandCtx === undefined) return 'persisted-only';

  if (newValue === undefined || newValue === null) {
    // Unsetting theme — restore default. The Go renderer reads the
    // side-effect; the empty string signals "no override".
    try {
      setTheme('dark');
    } catch {
      // best-effort; the persist already succeeded so we still apply
    }
    ctx.recordSideEffect?.({ themeChanged: 'dark' });
    return 'applied';
  }
  const name = String(newValue);
  try {
    setTheme(name);
  } catch {
    // unknown theme name — the persist already succeeded (zod accepts
    // any string for `theme`); the renderer falls back. Return
    // persisted-only so the toast doesn't claim a clean apply.
    return 'persisted-only';
  }
  ctx.recordSideEffect?.({ themeChanged: name });
  return 'applied';
};

/**
 * `defaultModel` — calls `commandCtx.setModel(value)` so the active
 * session's model switches without a restart.
 */
const defaultModelHook: LiveApplyHook = async (newValue, ctx) => {
  if (ctx.commandCtx === undefined) return 'persisted-only';
  if (newValue === undefined || newValue === null) {
    // Unsetting defaultModel doesn't disturb the active session — keep
    // the current model live. Toast: persisted-only.
    return 'persisted-only';
  }
  ctx.commandCtx.setModel(String(newValue));
  return 'applied';
};

/**
 * `providers.<x>.model` — only fires `setModel` when `<x>` matches the
 * active session's provider. Otherwise persisted-only (the operator
 * meant to change a non-active provider's default; no in-session effect).
 */
function makeProviderModelHook(providerName: string): LiveApplyHook {
  return async (newValue, ctx) => {
    if (ctx.commandCtx === undefined) return 'persisted-only';
    if (ctx.commandCtx.providerName !== providerName) return 'persisted-only';
    if (newValue === undefined || newValue === null) return 'persisted-only';
    ctx.commandCtx.setModel(String(newValue));
    return 'applied';
  };
}

/**
 * `maxTurns` — VERIFIED NOT LIVE-APPLY (2026-05-24): server-mode turns
 * (`src/server/routes/turns.ts`) and AgentRunner (`src/runtime/agentRunner.ts`)
 * both pass `maxTurns` into `query()` at call time from the runtime's
 * captured value, NOT from a per-call readConfig(). Changing the on-disk
 * config doesn't reach a running session. Downgraded to persisted-only;
 * absence of a hook in `LIVE_APPLY_HOOKS` means the catalog item gets the
 * `⟳ next session` badge automatically. See the spec's verification
 * requirement (§"v0 live-apply set").
 *
 * Kept here as a no-op for documentation purposes only — `LIVE_APPLY_HOOKS`
 * does NOT include it.
 */

/**
 * `verbose` — relayed as a side-effect so the TUI flips its toolcard
 * render mode (compact one-liner vs. full bordered output). The TS-side
 * doesn't render the TUI, so there's nothing to mutate in-process here;
 * the side-effect is the entire applied effect.
 */
const verboseHook: LiveApplyHook = async (newValue, ctx) => {
  if (ctx.commandCtx === undefined) return 'persisted-only';
  ctx.recordSideEffect?.({ verboseChanged: Boolean(newValue) });
  return 'applied';
};

/**
 * `permissionMode` — mutates `runtime.permissionMode` via the
 * `setPermissionMode` closure on CommandContext. The turns route reads
 * `runtime.permissionMode` per-request (`src/server/routes/turns.ts:471`)
 * so the new mode applies starting with the next turn. No TUI side-
 * effect — the mode isn't surfaced in the chrome.
 *
 * Unset → fall back to `'default'`, mirroring the cascade in
 * `buildRuntime` (option → settings → 'default'). 2026-05-24 patch.
 */
const permissionModeHook: LiveApplyHook = async (newValue, ctx) => {
  if (ctx.commandCtx === undefined) return 'persisted-only';
  if (ctx.commandCtx.setPermissionMode === undefined) return 'persisted-only';
  const next = newValue === undefined || newValue === null ? 'default' : String(newValue);
  if (next !== 'default' && next !== 'ask' && next !== 'bypass') {
    // Schema validation should already have caught this; defensive.
    return 'persisted-only';
  }
  ctx.commandCtx.setPermissionMode(next);
  return 'applied';
};

/**
 * `microcompaction.*` and `compaction.proactiveThresholdPct` — call
 * `commandCtx.refreshRuntimeFromConfig()` to re-read the persisted
 * config and rebuild the runtime's cached fields. The turns route
 * reads `runtime.microcompactConfig` and `runtime.proactiveCompactThreshold`
 * per-request, so the next turn picks up the new values.
 *
 * One shared closure for all four fields — the underlying refresh
 * pulls the whole microcompaction block + the proactive threshold
 * in a single read, so changing any one re-syncs the rest. 2026-05-24
 * patch.
 */
const runtimeConfigRefreshHook: LiveApplyHook = async (_newValue, ctx) => {
  if (ctx.commandCtx === undefined) return 'persisted-only';
  if (ctx.commandCtx.refreshRuntimeFromConfig === undefined) return 'persisted-only';
  ctx.commandCtx.refreshRuntimeFromConfig();
  return 'applied';
};

/**
 * `taskRouting.*` (except savedPresets) — call
 * `commandCtx.rebuildTaskRouting()` to:
 *   1. Rebuild the lane registry from the new config (so the scheduler's
 *      resolveLane closure picks up the new mapping for subsequent
 *      atom dispatches).
 *   2. Reassemble the smart-router system prompt segment (adds /
 *      removes it based on the new `enabled` value; reads the
 *      `trivialFastPath` clause based on its flag).
 *
 * The next turn sees the new state. Prompt-cache invalidation is the
 * trade-off the user opts into by hot-toggling routing config.
 *
 * `taskRouting.savedPresets.*` does NOT trigger this — those are pure
 * persistence with no runtime effect.
 *
 * 2026-05-24 — taskRouting hot-reload patch.
 */
const taskRoutingHotReloadHook: LiveApplyHook = async (_newValue, ctx) => {
  if (ctx.commandCtx === undefined) return 'persisted-only';
  if (ctx.commandCtx.rebuildTaskRouting === undefined) return 'persisted-only';
  await ctx.commandCtx.rebuildTaskRouting();
  const { readConfig } = await import('./store.js');
  const { detectActivePreset } = await import('./presets.js');
  const fresh = readConfig();
  const preset = detectActivePreset(fresh) ?? '';
  ctx.recordSideEffect?.({ taskRouterChanged: preset });
  return 'applied';
};

/**
 * `webSearch.*` — VERIFIED read-on-demand. `src/tools/WebSearchTool.ts:61`
 * calls `readConfig()` at invoke time, so any change to
 * `webSearch.provider` / `webSearch.apiKey` / `webSearch.maxResults` is
 * picked up by the next tool invocation without restart. Hook just
 * confirms applied.
 */
const webSearchHook: LiveApplyHook = async (_newValue, ctx) => {
  if (ctx.commandCtx === undefined) return 'persisted-only';
  return 'applied';
};

/**
 * The v0 live-apply registry. Keys are dotpaths into Settings; values are
 * the hook fns. Catalog items reference these hooks by importing this
 * map — the catalog itself doesn't need to know how to apply any given
 * field, just whether one exists (the presence of a hook drives the
 * `live` badge).
 */
export const LIVE_APPLY_HOOKS: Readonly<Record<string, LiveApplyHook>> = Object.freeze({
  theme: themeHook,
  defaultModel: defaultModelHook,
  'providers.anthropic.model': makeProviderModelHook('anthropic'),
  'providers.openai.model': makeProviderModelHook('openai'),
  'providers.openrouter.model': makeProviderModelHook('openrouter'),
  'providers.ollama.model': makeProviderModelHook('ollama'),
  verbose: verboseHook,
  'webSearch.provider': webSearchHook,
  'webSearch.apiKey': webSearchHook,
  'webSearch.maxResults': webSearchHook,
  permissionMode: permissionModeHook,
  'microcompaction.enabled': runtimeConfigRefreshHook,
  'microcompaction.keepRecent': runtimeConfigRefreshHook,
  'microcompaction.triggerThresholdPct': runtimeConfigRefreshHook,
  'compaction.proactiveThresholdPct': runtimeConfigRefreshHook,
  // 2026-05-24 — taskRouting hot-reload. Every non-savedPresets path
  // triggers a runtime rebuild (lane registry + smart-router prompt
  // segment). savedPresets is pure persistence; no hook needed.
  'taskRouting.enabled': taskRoutingHotReloadHook,
  'taskRouting.trivialFastPath': taskRoutingHotReloadHook,
  'taskRouting.delegator.model': taskRoutingHotReloadHook,
  'taskRouting.lanes.cheap-task.provider': taskRoutingHotReloadHook,
  'taskRouting.lanes.cheap-task.model': taskRoutingHotReloadHook,
  'taskRouting.lanes.cheap-task.timeoutMs': taskRoutingHotReloadHook,
  'taskRouting.lanes.moderate-task.provider': taskRoutingHotReloadHook,
  'taskRouting.lanes.moderate-task.model': taskRoutingHotReloadHook,
  'taskRouting.lanes.moderate-task.timeoutMs': taskRoutingHotReloadHook,
  'taskRouting.lanes.frontier-task.provider': taskRoutingHotReloadHook,
  'taskRouting.lanes.frontier-task.model': taskRoutingHotReloadHook,
  'taskRouting.lanes.frontier-task.timeoutMs': taskRoutingHotReloadHook,
});

/**
 * The set of dotpaths that have a live-apply hook. The catalog renders the
 * `live` badge for any item whose path appears here; everything else gets
 * `⟳ next session`.
 */
export function hasLiveApply(path: string): boolean {
  return Object.hasOwn(LIVE_APPLY_HOOKS, path);
}

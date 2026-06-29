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
import type { ReasoningEffort } from '../providers/effort.js';
import type { ApiMode } from '../providers/types.js';
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
  // 2026-06-14 config live-apply (M6) — chrome-reflection relays so the Go
  // renderer reflects live changes the user just made. Each is threaded
  // through all five wire seams (collector, hasSideEffects, pickSideEffects,
  // schema, Go decoder).
  permissionModeChanged?: string;
  toolOutputChanged?: { mode?: string; inlineLines?: number };
  footerChanged?: boolean;
  contextMeterChanged?: { warnAtPercent?: number; dangerAtPercent?: number };
  diffRenderChanged?: boolean;
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
 * Infer the wire family a model id belongs to from its prefix. A trivial,
 * stable heuristic that lets a model hook decide whether switching to it is a
 * SAME-family change (cheap `setModel`) or a CROSS-family change (needs a full
 * provider re-resolve so the transport/contextLength/compactor/learning-reason
 * follow). Returns null when the prefix is unrecognized (custom / local model
 * id) — the hook then treats it conservatively (re-resolve when crossing, since
 * we can't prove it's same-family). Mirrors the private `modelFamily` in
 * `src/openai/modelResolution.ts`; kept local to avoid coupling `src/config/`
 * to the server layer for a 2-line heuristic (KISS over speculative DRY).
 */
function inferModelFamily(model: string): ApiMode | null {
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gpt-')) return 'openai';
  return null;
}

/**
 * True when switching the active session to `model` crosses the active
 * provider's wire family — meaning the whole provider stack (transport,
 * context length, compactor model, learning Reason) must re-resolve, not just
 * the model string. A same-family change is satisfied by `setModel` alone.
 * An unrecognized family is treated as a cross when it differs from the active
 * apiMode (we can't prove same-family), so the stack re-resolves rather than
 * silently sending a foreign id to the wrong transport.
 */
function isCrossFamilyModel(model: string, activeApiMode: ApiMode): boolean {
  const family = inferModelFamily(model);
  return family !== activeApiMode;
}

/**
 * `defaultModel` — switches the active session's model without a restart.
 * A SAME-family change is the cheap path (`setModel`, returns 'applied'). A
 * CROSS-family change re-resolves the whole provider stack via
 * `reresolveProvider` so the transport/contextLength/compactor/learning-reason
 * follow the new model (returns 'applied'; degrades to 'persisted-only' when
 * `reresolveProvider` is unavailable — a non-server surface — so the badge
 * never over-claims). Declared `live-reload` in SETTING_SCOPES.
 */
const defaultModelHook: LiveApplyHook = async (newValue, ctx) => {
  if (ctx.commandCtx === undefined) return 'persisted-only';
  if (newValue === undefined || newValue === null) {
    // Unsetting defaultModel doesn't disturb the active session — keep
    // the current model live. Toast: persisted-only.
    return 'persisted-only';
  }
  const model = String(newValue);
  if (isCrossFamilyModel(model, ctx.commandCtx.apiMode)) {
    if (ctx.commandCtx.reresolveProvider === undefined) return 'persisted-only';
    await ctx.commandCtx.reresolveProvider(undefined, model);
    return 'applied';
  }
  ctx.commandCtx.setModel(model);
  return 'applied';
};

/**
 * `providers.<x>.model` — three honest cases, all green when applied:
 *   - `<x>` is the active provider, SAME family → cheap `setModel` ('applied').
 *   - `<x>` is the active provider, CROSS family → `reresolveProvider` so the
 *     stack follows the new model ('applied'; degrades to 'persisted-only'
 *     when reresolve is unavailable).
 *   - `<x>` is NOT the active provider → the edit persists and takes effect the
 *     moment that provider is selected (selection itself reresolves). We report
 *     'applied' so the green badge is HONEST — the value is durably the new
 *     default for that provider; there is no in-flight transport to disturb.
 */
function makeProviderModelHook(providerName: string): LiveApplyHook {
  return async (newValue, ctx) => {
    if (ctx.commandCtx === undefined) return 'persisted-only';
    if (newValue === undefined || newValue === null) return 'persisted-only';
    const model = String(newValue);
    if (ctx.commandCtx.providerName !== providerName) {
      // Future default for a non-active provider — persisted; honestly green
      // because switching to that provider will pick it up via re-resolution.
      return 'applied';
    }
    if (isCrossFamilyModel(model, ctx.commandCtx.apiMode)) {
      if (ctx.commandCtx.reresolveProvider === undefined) return 'persisted-only';
      await ctx.commandCtx.reresolveProvider(providerName, model);
      return 'applied';
    }
    ctx.commandCtx.setModel(model);
    return 'applied';
  };
}

/**
 * `defaultProvider` / `providers.<x>.{apiKey,baseUrl}` — a credential or
 * endpoint or default-provider change re-resolves the active provider stack so
 * the live conversation uses the new transport from the next turn. Routes
 * through `reresolveProvider()` (M1, T3). Returns 'applied' on a successful
 * re-resolve; degrades to 'persisted-only' when the runtime doesn't expose the
 * mechanism (non-server surface) so the badge stays honest. Declared
 * `live-reload` (defaultProvider exact; the `providers.` prefix covers the
 * apiKey/baseUrl fields).
 */
const reresolveProviderHook: LiveApplyHook = async (_newValue, ctx) => {
  if (ctx.commandCtx === undefined) return 'persisted-only';
  if (ctx.commandCtx.reresolveProvider === undefined) return 'persisted-only';
  await ctx.commandCtx.reresolveProvider();
  return 'applied';
};

/**
 * `router.*` lane fields (defaultLane / localProvider / localModel /
 * frontierProvider / frontierModel / escalationMode) — re-resolve so the
 * RouterProvider's lanes pick up the new mapping for the live conversation.
 * Same mechanism + degrade contract as `reresolveProviderHook`. The
 * `router.maxConcurrent{Local,Frontier}` caps are DELIBERATELY excluded — the
 * LaneSemaphores are sized at construction with no resize API, so those stay
 * hookless and honestly 'restart' (see SETTING_SCOPES).
 */
const routerLaneHook: LiveApplyHook = reresolveProviderHook;

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
 * so the new mode applies starting with the next turn. Now ALSO records a
 * `permissionModeChanged` side-effect (M6) so the Go renderer can surface a
 * loud chrome indicator — important for `bypass`, where auto-allow is a safety-
 * relevant posture the user should always see.
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
  ctx.recordSideEffect?.({ permissionModeChanged: next });
  return 'applied';
};

/**
 * `thinking.effort` — applies the reasoning-depth level to the ACTIVE session
 * via `commandCtx.setEffort` (mutating `sessionCtx.effort`, read per-turn, and
 * emitting `effortChanged` for the status chrome) — exactly what the `/effort`
 * slash command does. This is the single clearest pre-fix silent no-op: editing
 * it previously reached neither `sessionCtx.effort` nor `runtime.effort`.
 *
 * The boot-seed `runtime.effort` is deliberately NOT updated here: per backlog
 * #57 it is the per-session ISOLATION default for cron/channel/other-principal
 * turns, and mutating it from one session's /config edit would re-introduce the
 * cross-surface leak #57 closed. The edit still persists to config, so future
 * PROCESS restarts pick it up. Same-process effect is per-session, which is the
 * correct multi-user behavior.
 */
const REASONING_EFFORTS: readonly ReasoningEffort[] = ['off', 'low', 'medium', 'high', 'max'];
const effortHook: LiveApplyHook = async (newValue, ctx) => {
  if (ctx.commandCtx === undefined) return 'persisted-only';
  const next = newValue === undefined || newValue === null ? 'off' : String(newValue);
  if (!REASONING_EFFORTS.includes(next as ReasoningEffort)) {
    return 'persisted-only'; // schema should have caught it; defensive
  }
  ctx.commandCtx.setEffort(next as ReasoningEffort);
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
 * `webSearch.*` — read-on-demand, preserved across Task 2.3. WebSearchTool no
 * longer does an ambient `readConfig()`; it reads `ctx.webSearch`, which the
 * per-turn ToolContext builder (`buildSessionToolContext`) re-reads from
 * `config.json` each turn (unless an in-memory Settings was injected). So a
 * change to `webSearch.provider` / `webSearch.apiKey` / `webSearch.maxResults`
 * is still picked up by the next turn without restart. Hook just confirms applied.
 */
const webSearchHook: LiveApplyHook = async (_newValue, ctx) => {
  if (ctx.commandCtx === undefined) return 'persisted-only';
  return 'applied';
};

/**
 * `learning.disabled` + the synthesis-cadence fields (`synthesizerEveryN`,
 * `synthesizerEveryNToolIterations`) + `learning.recall.*` — rebuild the ACTIVE
 * SessionContext's recall thunk + learning observer in place from fresh config
 * (M4, T3 `rebuildRecall`) so the change applies to the LIVE conversation. Only
 * re-reads the user's persisted values — never changes recall/synthesis
 * semantics (founder-reserved: recall ON by default stays ON). Returns
 * 'applied' on a successful rebuild; degrades to 'persisted-only' when the
 * runtime doesn't expose the mechanism. Declared `live-reload`.
 *
 * NOT all of `learning.*` routes here: the confidence/reinforcement tunables go
 * through `learningTuningHook` (read-on-demand, no rebuild needed);
 * `observationBufferSize` is allocated at SessionContext build (hookless →
 * 'restart'); the prune knobs + `crossProjectMinConfidence` are consumed by the
 * separate `sov learning prune` command / are unwired in-session (hookless →
 * 'restart' overrides in SETTING_SCOPES).
 */
const learningRecallHook: LiveApplyHook = async (_newValue, ctx) => {
  if (ctx.commandCtx === undefined) return 'persisted-only';
  if (ctx.commandCtx.rebuildRecall === undefined) return 'persisted-only';
  await ctx.commandCtx.rebuildRecall();
  return 'applied';
};

/**
 * `learning` confidence/reinforcement tunables (`reinforcementCurveK`,
 * `evidenceSaturation`, `contradictionDelta`, `confidenceCap`,
 * `initialConfidenceBaseline`) — VERIFIED read-on-demand (2026-06-14):
 * `InstinctProposeTool.call` / `InstinctUpdateConfidenceTool.call` invoke
 * `loadConfidenceTuning()` (which reads disk) on EVERY invocation, so the next
 * confidence computation picks up the new value with no rebuild. A sentinel
 * 'applied' — the persist itself is the entire applied effect. Declared
 * `live-reload` under the `learning.` prefix (green; both colors agree).
 */
const learningTuningHook: LiveApplyHook = async (_newValue, ctx) => {
  if (ctx.commandCtx === undefined) return 'persisted-only';
  return 'applied';
};

/**
 * `providers.ollama.numCtx` — folded into provider resolution
 * (`resolveProvider` reads `providerConfig.numCtx` and constructs the
 * OllamaProvider with it), so it applies to the live conversation via
 * `reresolveProvider` (M1) when Ollama is the active provider. Same green
 * mechanism + degrade contract as the other provider fields.
 */
const numCtxHook: LiveApplyHook = reresolveProviderHook;

/**
 * `ui.*` chrome fields (`footer.enabled`, `contextMeter.{warnAtPercent,
 * dangerAtPercent}`, `diffRender.enabled`, `toolOutput.{mode,inlineLines}`) —
 * the TS side renders no TUI; the change is relayed to the Go renderer as an
 * SSE side-effect (M6), exactly like `verbose`/`theme`. The side-effect IS the
 * entire applied effect, so each hook records the matching M6
 * `LiveApplySideEffect` and returns 'applied'. The Go renderer (T6) decodes +
 * applies it live. Declared `live` under the `ui.` prefix.
 *
 * Each hook is a thin closure over `recordSideEffect`; the field-specific
 * factory below builds the side-effect payload from the persisted value so the
 * renderer receives a typed, named change.
 */
type UiSideEffectBuilder = (value: unknown) => LiveApplySideEffect;

function makeUiHook(buildEffect: UiSideEffectBuilder): LiveApplyHook {
  return async (newValue, ctx) => {
    if (ctx.commandCtx === undefined) return 'persisted-only';
    ctx.recordSideEffect?.(buildEffect(newValue));
    return 'applied';
  };
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

const uiFooterHook: LiveApplyHook = makeUiHook((value) => ({
  footerChanged: Boolean(value),
}));

const uiDiffRenderHook: LiveApplyHook = makeUiHook((value) => ({
  diffRenderChanged: Boolean(value),
}));

const uiToolOutputModeHook: LiveApplyHook = makeUiHook((value) => {
  const mode = value === undefined || value === null ? undefined : String(value);
  return { toolOutputChanged: { ...(mode !== undefined ? { mode } : {}) } };
});

const uiToolOutputInlineLinesHook: LiveApplyHook = makeUiHook((value) => {
  const inlineLines = toFiniteNumber(value);
  return { toolOutputChanged: { ...(inlineLines !== undefined ? { inlineLines } : {}) } };
});

const uiContextMeterWarnHook: LiveApplyHook = makeUiHook((value) => {
  const warnAtPercent = toFiniteNumber(value);
  return { contextMeterChanged: { ...(warnAtPercent !== undefined ? { warnAtPercent } : {}) } };
});

const uiContextMeterDangerHook: LiveApplyHook = makeUiHook((value) => {
  const dangerAtPercent = toFiniteNumber(value);
  return { contextMeterChanged: { ...(dangerAtPercent !== undefined ? { dangerAtPercent } : {}) } };
});

/**
 * The v0 live-apply registry. Keys are dotpaths into Settings; values are
 * the hook fns. Catalog items reference these hooks by importing this
 * map — the catalog itself doesn't need to know how to apply any given
 * field, just whether one exists (the presence of a hook drives the
 * `live` badge).
 */
export const LIVE_APPLY_HOOKS: Readonly<Record<string, LiveApplyHook>> = Object.freeze({
  theme: themeHook,
  // `ui.theme` is the legacy alias of the canonical `theme` key; route it
  // through the same hook so editing either applies live (records the
  // themeChanged side-effect the Go renderer reads). Without this the
  // `ui.` prefix's green badge would lie for ui.theme.
  'ui.theme': themeHook,
  defaultModel: defaultModelHook,
  defaultProvider: reresolveProviderHook,
  'providers.anthropic.model': makeProviderModelHook('anthropic'),
  'providers.openai.model': makeProviderModelHook('openai'),
  'providers.openrouter.model': makeProviderModelHook('openrouter'),
  'providers.ollama.model': makeProviderModelHook('ollama'),
  'providers.sov.model': makeProviderModelHook('sov'),
  // 2026-06-14 — credential / endpoint changes re-resolve the active provider
  // stack so the live conversation uses the new transport (M1).
  'providers.anthropic.apiKey': reresolveProviderHook,
  'providers.openai.apiKey': reresolveProviderHook,
  'providers.openai.baseUrl': reresolveProviderHook,
  'providers.openrouter.apiKey': reresolveProviderHook,
  'providers.ollama.baseUrl': reresolveProviderHook,
  'providers.ollama.numCtx': numCtxHook,
  'providers.sov.baseUrl': reresolveProviderHook,
  verbose: verboseHook,
  'webSearch.provider': webSearchHook,
  'webSearch.apiKey': webSearchHook,
  'webSearch.maxResults': webSearchHook,
  permissionMode: permissionModeHook,
  'thinking.effort': effortHook,
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
  // 2026-06-14 — router lane hot-reload via reresolveProvider (M1). The
  // maxConcurrent* caps are deliberately hookless (LaneSemaphores has no
  // resize API → honestly 'restart' in SETTING_SCOPES).
  'router.defaultLane': routerLaneHook,
  'router.localProvider': routerLaneHook,
  'router.localModel': routerLaneHook,
  'router.frontierProvider': routerLaneHook,
  'router.frontierModel': routerLaneHook,
  'router.escalationMode': routerLaneHook,
  // 2026-06-14 — learning recall/observer rebuild on the active SessionContext
  // (M4). Only the recall- and synthesis-cadence fields; the tunables route
  // through learningTuningHook (read-on-demand); prune knobs +
  // crossProjectMinConfidence + observationBufferSize are hookless ('restart').
  'learning.disabled': learningRecallHook,
  'learning.synthesizerEveryN': learningRecallHook,
  'learning.synthesizerEveryNToolIterations': learningRecallHook,
  'learning.recall.enabled': learningRecallHook,
  'learning.recall.maxLessons': learningRecallHook,
  'learning.recall.tokenBudget': learningRecallHook,
  // 2026-06-14 — confidence/reinforcement tunables are read-on-demand by the
  // instinct tools (loadConfidenceTuning() per invoke) → sentinel 'applied'.
  'learning.reinforcementCurveK': learningTuningHook,
  'learning.evidenceSaturation': learningTuningHook,
  'learning.contradictionDelta': learningTuningHook,
  'learning.confidenceCap': learningTuningHook,
  'learning.initialConfidenceBaseline': learningTuningHook,
  // 2026-06-14 — ui chrome relays to the Go renderer via M6 side-effects.
  'ui.footer.enabled': uiFooterHook,
  'ui.diffRender.enabled': uiDiffRenderHook,
  'ui.toolOutput.mode': uiToolOutputModeHook,
  'ui.toolOutput.inlineLines': uiToolOutputInlineLinesHook,
  'ui.contextMeter.warnAtPercent': uiContextMeterWarnHook,
  'ui.contextMeter.dangerAtPercent': uiContextMeterDangerHook,
});

/**
 * The set of dotpaths that have a live-apply hook. The catalog renders the
 * `live` badge for any item whose path appears here; everything else gets
 * `⟳ next session`.
 */
export function hasLiveApply(path: string): boolean {
  return Object.hasOwn(LIVE_APPLY_HOOKS, path);
}

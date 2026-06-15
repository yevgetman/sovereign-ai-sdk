// Apply-scope taxonomy for /config settings (2026-06-14 — see
// docs/specs/2026-06-14-config-live-apply-design.md).
//
// Replaces the old binary "hook present ⇒ live, else next session" model.
// Every setting declares ONE canonical scope here; the picker badge AND the
// save toast both derive from it (and from the scope a live-apply hook
// actually achieves), so the two can never disagree.
//
// The four scopes collapse to two user-facing colors:
//   green  (applied to this session):  'live' | 'live-reload'
//   amber  (saved, not applied here):  'other-process' | 'restart'
// 'live' vs 'live-reload' is an internal distinction (which mechanism the
// hook uses); both read as a green "applied" to the user.

export type ApplyScope =
  // Applies from the next turn this session — a per-turn-read runtime/session
  // field is mutated directly (permissionMode, microcompaction, effort, …).
  | 'live'
  // Applies this session via a bounded between-turns reload — reresolveProvider
  // / reloadHooks / reloadMcpServers / rebuildTaskRouting / rebuildRecall.
  | 'live-reload'
  // Consumed only by a SEPARATE `sov gateway` / `sov serve` process. Editing it
  // from this TUI has no effect on this session; that process must restart.
  | 'other-process'
  // Genuinely needs restarting THIS process (no in-process reload API). Used
  // only where justified in the map below.
  | 'restart';

export type ScopeBadge = 'live' | 'reload' | 'other' | 'restart';

export interface ScopeMessage {
  /** True when the change took effect in the running session. */
  applied: boolean;
  /** Picker / InputCard badge token (the Go TUI maps each to a color+glyph). */
  badge: ScopeBadge;
  /** User-facing save toast, naming the setting. */
  toast: (path: string) => string;
}

/** True when a scope means "took effect in this session" (green). */
export function scopeIsImmediate(scope: ApplyScope): boolean {
  return scope === 'live' || scope === 'live-reload';
}

/** The single source of truth mapping a scope to its badge + toast copy. */
export function describeScope(scope: ApplyScope): ScopeMessage {
  switch (scope) {
    case 'live':
    case 'live-reload':
      return {
        applied: true,
        badge: 'live',
        toast: (p) => `saved — ${p} applied to this session`,
      };
    case 'other-process':
      return {
        applied: false,
        badge: 'other',
        toast: (p) =>
          `saved — ${p} applies to the sov gateway/serve process, not this session (restart that process to take effect)`,
      };
    case 'restart':
      return {
        applied: false,
        badge: 'restart',
        toast: (p) => `saved — restart sov for ${p} to take effect`,
      };
  }
}

// ──────────────────────────────────────────────────────────────────────
// SETTING_SCOPES — dotpath (exact) or prefix (trailing '.') → canonical scope.
// scopeFor() resolves exact match first, then the LONGEST matching prefix,
// then defaults to 'restart' (the conservative legacy "next session").
//
// Keep this in sync with LIVE_APPLY_HOOKS: every 'live'/'live-reload' path
// MUST have a hook that achieves a green scope in the live-TUI surface.
// ──────────────────────────────────────────────────────────────────────

const SETTING_SCOPES: Readonly<Record<string, ApplyScope>> = Object.freeze({
  // ── green: live (per-turn read, mutated directly) ──
  permissionMode: 'live',
  verbose: 'live',
  theme: 'live',
  'thinking.effort': 'live',
  'microcompaction.': 'live',
  'compaction.': 'live',
  'webSearch.': 'live',
  'ui.': 'live', // toolOutput / footer / contextMeter / diffRender / theme — relayed to the Go renderer (M6)

  // ── green: live-reload (bounded between-turns reload) ──
  defaultModel: 'live-reload',
  defaultProvider: 'live-reload',
  'providers.': 'live-reload', // <x>.{model,apiKey,baseUrl,numCtx} via reresolveProvider (M1)
  'taskRouting.': 'live-reload', // lane registry + smart-router prompt segment hot-reload
  'learning.': 'live-reload', // recall thunk + observer rebuilt on the active SessionContext (M4)
  'router.': 'live-reload', // re-resolve the RouterProvider lanes (M1)
  // NOTE: mcpServers / hooks live in settings.json, not the /config field UI.
  // runtime.reloadHooks / reloadMcpServers exist (M2) but no /config hook drives
  // them, so they default to 'restart' here — honest for the /config surface.

  // ── amber: other-process (separate gateway/serve process) ──
  'gateway.': 'other-process',
  'openaiServer.': 'other-process',

  // ── amber: restart (no in-process reload API — justified by read-site
  //    VERIFICATION 2026-06-14, T4 — each consumer captures the value at
  //    boot/construction and never re-reads it for the live TUI turn) ──
  'debugMode.': 'restart', // transcript writer opened at session start
  // The TranscriptStore is built once at runtime boot (resolveTranscriptsConfig
  // at buildRuntime); a new session picks up a config change only after restart.
  'transcripts.': 'restart',
  // maxTurns + behavior.* are NOT passed to query() by the live-TUI turns
  // route (src/server/routes/turns.ts); AgentRunner/query capture them at
  // construction — boot-captured, not per-turn. Honest 'restart'.
  maxTurns: 'restart',
  'behavior.': 'restart',
  // ReviewManager captures its cadence thresholds + enabled flag at the
  // SessionContext-build constructor and never refreshes them. 'restart'.
  'review.': 'restart',
  // The SubagentScheduler captures subscriptionExecutor config at
  // construction (and the role-exclusion at runtime build); a live-apply
  // hook would be half-applied. Hookless → honest 'restart'.
  'subscriptionExecutor.': 'restart',
  'learning.observationBufferSize': 'restart', // ring buffer allocated at SessionContext build
  // Consumed only by the separate `sov learning prune` CLI command (not the
  // live session) / unwired in-session → no in-session effect. 'restart'.
  'learning.pruneBelowConfidence': 'restart',
  'learning.pruneAgeDays': 'restart',
  'learning.crossProjectMinConfidence': 'restart',
  'router.maxConcurrentLocal': 'restart', // LaneSemaphores sized at construction (no resize API)
  'router.maxConcurrentFrontier': 'restart',
});

/**
 * Resolve a setting's canonical apply-scope. Exact match wins; otherwise the
 * longest registered prefix (an entry ending in '.'); otherwise 'restart'.
 */
export function scopeFor(path: string): ApplyScope {
  const exact = SETTING_SCOPES[path];
  if (exact !== undefined) return exact;
  let best: { len: number; scope: ApplyScope } | undefined;
  for (const [key, scope] of Object.entries(SETTING_SCOPES)) {
    if (
      key.endsWith('.') &&
      path.startsWith(key) &&
      (best === undefined || key.length > best.len)
    ) {
      best = { len: key.length, scope };
    }
  }
  return best?.scope ?? 'restart';
}

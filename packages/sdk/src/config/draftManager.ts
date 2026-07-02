// Phase 2.5 follow-up — config draft manager.
//
// The /config picker chain now supports explicit "Save & Exit" (S) and
// "Cancel & Exit" (Esc) semantics. To deliver real cancel semantics
// against a system where every `/config set` previously wrote to disk
// immediately, we layer a per-session DRAFT on top:
//
//   1. The user opens /config → snapshot current config as `baseline`.
//   2. set / unset / apply-preset / save-preset / delete-preset all
//      continue to write through to disk AND record the modified path
//      in the draft.
//   3. /config commit → drop the draft state. The on-disk config is
//      already the latest; nothing else to do.
//   4. /config discard → restore the baseline to disk, re-fire live-
//      apply hooks for each modified path so runtime state reverts too,
//      then drop the draft.
//
// Drafts are keyed by sessionId so concurrent /config sessions in
// different TUIs (rare but possible) don't bleed.
//
// 2026-05-24 patch (v0.5.8 follow-up to v0.5.7).

import type { Settings } from './schema.js';

/** Per-session draft state. */
export type ConfigDraft = {
  /** Settings snapshot captured when the draft opened. Used by
   *  discard() to roll back. */
  baseline: Settings;
  /** Dotpaths that have been modified during this draft. Used by the
   *  commit / discard summary toast + by discard() to know which
   *  live-apply hooks need to re-fire with the pre-modification value. */
  modifiedPaths: Set<string>;
};

/**
 * Drafts are kept in a per-process map keyed by sessionId. The TUI
 * sends the sessionId as part of every dispatch (it's in the URL of
 * POST /sessions/:id/commands), so the slash handler can look up the
 * right draft.
 */
const drafts = new Map<string, ConfigDraft>();

/**
 * Open a draft for `sessionId` if one isn't already active. Captures
 * the current settings as the rollback baseline.
 *
 * Called from /config (no args / root menu open). Subsequent /config
 * dispatches in the same session re-enter the SAME draft — they don't
 * re-snapshot — so the rollback baseline stays correct even if the
 * user navigates around.
 */
export function ensureDraft(sessionId: string, currentSettings: Settings): ConfigDraft {
  let draft = drafts.get(sessionId);
  if (draft === undefined) {
    draft = {
      baseline: structuredClone(currentSettings),
      modifiedPaths: new Set<string>(),
    };
    drafts.set(sessionId, draft);
  }
  return draft;
}

/** Look up the active draft, if any. */
export function getDraft(sessionId: string): ConfigDraft | undefined {
  return drafts.get(sessionId);
}

/**
 * Record that `path` was modified during the active draft. No-op when
 * no draft is open (e.g., the user invoked /config set directly via
 * the dispatch CLI without ever entering the picker — in that case
 * commit/discard verbs aren't meaningful).
 */
export function recordModification(sessionId: string, path: string): void {
  const draft = drafts.get(sessionId);
  if (draft === undefined) return;
  draft.modifiedPaths.add(path);
}

/**
 * Drop the draft state for `sessionId`. Returns the modified-path
 * count so the caller can surface "saved N changes" in the toast.
 */
export function commitDraft(sessionId: string): number {
  const draft = drafts.get(sessionId);
  if (draft === undefined) return 0;
  drafts.delete(sessionId);
  return draft.modifiedPaths.size;
}

/**
 * Take the snapshotted baseline + drop the draft. Returns the
 * baseline + the set of modified paths so the caller can:
 *  - writeConfig(baseline)
 *  - re-fire live-apply hooks for each modified path with the value
 *    from the baseline (which is now back on disk)
 *
 * The caller, not the manager, performs disk + hook side-effects.
 * That keeps this module pure-data (easy to test, no fs/import-cycle).
 */
export function takeBaselineForDiscard(
  sessionId: string,
): { baseline: Settings; modifiedPaths: string[] } | undefined {
  const draft = drafts.get(sessionId);
  if (draft === undefined) return undefined;
  drafts.delete(sessionId);
  return {
    baseline: draft.baseline,
    modifiedPaths: [...draft.modifiedPaths],
  };
}

/**
 * Test seam — drop ALL drafts. Used in tests that share the module-
 * level Map across cases.
 */
export function __resetAllDrafts(): void {
  drafts.clear();
}

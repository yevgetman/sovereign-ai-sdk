// Fence-breakout neutralization for memory + recall bodies before they are
// spliced into the injected user-message fences (memory/injection.ts,
// core/recallInjection.ts). Untrusted content — a repo's MEMORY.md/USER.md, a
// project MEMORY.md, or a recalled lesson persisted during a prior (possibly
// poisoned) session — must not be able to:
//   (a) close the surrounding fence and re-appear as a top-level instruction,
//   (b) forge the `[System note:]` preamble marker, or
//   (c) smuggle invisible unicode past a human reviewer.
//
// This is the ONE place memory/recall content is screened. It routes every body
// through the SAME screenContextFile() the local-context paths use, but with
// `applyThreatPatterns: false`. Memory/recall content is USER-OWNED and already
// presented as informational inside a fence, so the prose THREAT_PATTERNS
// (ignore-previous-instructions, developer-mode, curl|sh, ...) must NOT be a
// whole-block kill-switch here — a personal MEMORY.md/USER.md that merely
// MENTIONS such a phrase, or stores a `curl … | sh` install snippet, would
// otherwise have its entire content silently dropped. Only the
// security-load-bearing screens still apply: invisible-unicode (rejected as a
// blockPlaceholder), plus fence-close-token and `[System note:]` preamble
// neutralization performed below. The local-context paths (AGENTS.md etc. —
// repo-supplied, lower trust) keep the full THREAT_PATTERNS kill-switch.
//
// NOTE: `learned-context` is deliberately NOT in the escaped set. The
// proprietary recall formatter emits a legitimate <learned-context> block and
// the host prepends it verbatim (pinned by tests). The distinct OUTER
// <recall-context> fence — whose closing token IS escaped here — is what
// contains any breakout inside a recalled body, so the legit inner fence
// survives untouched while the body still cannot escape.

import { blockPlaceholder, screenContextFile } from './injectionDefense.js';

// Closing tokens for every fence the memory/recall injectors wrap a body in.
// Optional internal whitespace is tolerated (`</MEMORY.md >`, `</memory-context\n>`):
// the module never emits those variants, but an LLM is a lenient parser and may
// still honor a whitespace-padded close as a real fence break, so they must be
// neutralized too.
const FENCE_CLOSE_TAGS =
  /<\/\s*(memory-context|MEMORY\.md|USER\.md|memory-nudge|recall-context)\s*>/gi;

// The `[System note:]` preamble marker, likewise tolerant of internal whitespace
// (`[ System  note :`) so a padded forgery cannot slip past neutralization.
const SYSTEM_NOTE_MARKER = /\[\s*System\s+note\s*:/gi;

/**
 * Screen an untrusted memory/recall body and neutralize any fence-breakout in
 * it. `filename` labels the body for screenContextFile/blockPlaceholder
 * (e.g. 'MEMORY.md', 'USER.md', 'recall-context'). Benign content is returned
 * essentially unchanged (only a genuine forged fence token or `[System note:]`
 * marker is rewritten), so normal prose still renders readably inside the fence.
 */
export function neutralizeFenceBody(filename: string, body: string): string {
  const screened = screenContextFile(filename, body, { applyThreatPatterns: false });
  if (!screened.ok) return blockPlaceholder(filename, screened.reason);
  return screened.text
    .replace(FENCE_CLOSE_TAGS, '&lt;/$1&gt;')
    .replace(SYSTEM_NOTE_MARKER, '[System note (quoted context):');
}

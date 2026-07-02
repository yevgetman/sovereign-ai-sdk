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
// through the SAME screenContextFile() the local-context paths already use
// (user.ts, subdirectoryHints.ts, references.ts, systemPrompt.ts) — so an
// invisible-unicode / developer-mode / ignore-instructions / curl|sh body is
// rejected and represented as a blockPlaceholder rather than trusted — and then
// escapes the fence-closing tokens the memory/recall formatters emit.
//
// NOTE: `learned-context` is deliberately NOT in the escaped set. The
// proprietary recall formatter emits a legitimate <learned-context> block and
// the host prepends it verbatim (pinned by tests). The distinct OUTER
// <recall-context> fence — whose closing token IS escaped here — is what
// contains any breakout inside a recalled body, so the legit inner fence
// survives untouched while the body still cannot escape.

import { blockPlaceholder, screenContextFile } from './injectionDefense.js';

// Closing tokens for every fence the memory/recall injectors wrap a body in.
const FENCE_CLOSE_TAGS = /<\/(memory-context|MEMORY\.md|USER\.md|memory-nudge|recall-context)>/gi;

/**
 * Screen an untrusted memory/recall body and neutralize any fence-breakout in
 * it. `filename` labels the body for screenContextFile/blockPlaceholder
 * (e.g. 'MEMORY.md', 'USER.md', 'recall-context'). Benign content is returned
 * essentially unchanged (only a genuine forged fence token or `[System note:]`
 * marker is rewritten), so normal prose still renders readably inside the fence.
 */
export function neutralizeFenceBody(filename: string, body: string): string {
  const screened = screenContextFile(filename, body);
  if (!screened.ok) return blockPlaceholder(filename, screened.reason);
  return screened.text
    .replace(FENCE_CLOSE_TAGS, '&lt;/$1&gt;')
    .replace(/\[System note:/gi, '[System note (quoted context):');
}

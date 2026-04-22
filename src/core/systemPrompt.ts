// System prompt assembly. Phase 0: one hardcoded segment. Phase 6: segmented,
// cacheable, ordered static→dynamic with ephemeral marker at boundary.
//
// Source of pattern: Claude Code src/QueryEngine.ts + src/context.ts.

import type { SystemSegment } from './types.js';

const BASE_INSTRUCTIONS = `\
You are the canonical AI entity of the business described in the harness bundle
you have been given. Read the bundle's CONTEXT.md, memory files, and glossary
to orient; consult business/ docs on demand. First person fits where natural
("our plan", "our tech stack") rather than detached review.
`.trim();

export function buildSystemSegments(): SystemSegment[] {
  // Phase 0: just the base. Phase 6 adds:
  //   - tool descriptions (cacheable)
  //   - ephemeral marker
  //   - system context (OS, cwd, git — not cacheable)
  //   - user context (CLAUDE.md hierarchy, MEMORY.md — not cacheable)
  return [{ text: BASE_INSTRUCTIONS, cacheable: true }];
}

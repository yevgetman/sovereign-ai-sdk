// Settings loader. Walks the precedence layers (managed > user > project >
// local), parses each with the Zod schema, merges. Phase 0: returns an empty
// settings object; Phase 6+ does the full walk.
//
// Source of pattern: Claude Code src/schemas/ + settings layer convention.

import type { Settings } from './schema.js';

export function loadSettings(): Settings {
  // Phase 0: no layers, no file reads. Enough to boot.
  return {};
}

// src/learning/instinctSerde.ts
// Phase 13.4 / learning-loop spike — pure serialization for the on-disk
// instinct shape (YAML frontmatter matching InstinctSchema + markdown body).
// Extracted verbatim from InstinctStore so a Persist-backed reader can share
// the exact same encode/decode without depending on the synchronous FS store.

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { type Instinct, InstinctSchema } from './types.js';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

/** Encode an instinct + body into the on-disk string:
 *  YAML frontmatter + markdown body. */
export function serializeInstinct(instinct: Instinct, body: string): string {
  const fm = stringifyYaml(instinct);
  return `---\n${fm}---\n${body}`;
}

/** Decode an on-disk instinct string back into its parsed frontmatter +
 *  raw body. Throws if the frontmatter delimiters are missing. The optional
 *  `instinctId` is used only to label the error message. */
export function parseInstinct(
  raw: string,
  instinctId?: string,
): { instinct: Instinct; body: string } {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) {
    const label = instinctId === undefined ? 'instinct' : `instinct ${instinctId}`;
    throw new Error(`malformed ${label}: missing frontmatter`);
  }
  const data = parseYaml(m[1] ?? '') as Record<string, unknown>;
  return {
    instinct: InstinctSchema.parse(data),
    body: m[2] ?? '',
  };
}

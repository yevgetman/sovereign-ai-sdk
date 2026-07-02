// Canonical tool descriptors — the single OPEN source of truth for how a
// FOREIGN (Claude Code) tool call maps onto the harness's NATIVE tool
// vocabulary: name aliases, top-level input-key renames, and foreign-only
// noise keys to drop. The proprietary subscription-executor derives its
// observation-canonicalization maps from this table (it used to hardcode
// them), and the hook matcher resolves operator-written aliases through it —
// so cross-surface learning evidence co-clusters and no consumer rebuilds the
// maps by hand.
//
// Grounding (claude v2.1.168, captured live in runtime/subprocessExecutor.ts):
//   Read   name='Read'  input={ file_path, offset?, limit? }   (native: FileRead / { path, … })
//   Write  name='Write' input={ file_path, content }           (native: FileWrite / { path, content })
//   Edit   name='Edit'  input={ file_path, old_string, … }     (native: FileEdit / { path, … })
//   Bash   name='Bash'  input={ command, description?, … }     (native: Bash / { command, … } — no description)
//   Grep   name='Grep'  input={ pattern, … }                   (native: Grep — matches)
//   Glob   name='Glob'  input={ pattern, … }                   (native: Glob — matches)
//
// The table lists ONLY the tools whose foreign form diverges from the native
// one. Absence means identity: a tool with no descriptor (Grep, Glob) — or a
// tool with no native equivalent at all (Task, WebFetch, MCP tools, …) —
// passes through unchanged. The `aliases` entries mirror the authoritative
// `aliases:` declarations on the tool defs in src/tools/ (FileReadTool has
// `aliases: ['Read']`, etc.); tests/tool/descriptors.test.ts pins that mirror
// plus byte-identity with the executor's original hardcoded maps.

/** Per-tool canonicalization data: how a foreign (Claude Code) tool call maps
 *  onto this native tool. Every field except `name` is optional — an omitted
 *  field means "no divergence of that kind". */
export interface CanonicalToolDescriptor {
  /** Native harness tool name — the canonical vocabulary (FileRead, Bash, …). */
  name: string;
  /** Foreign tool names that canonicalize to `name` (Read → FileRead, …). */
  aliases?: readonly string[];
  /** Foreign top-level input key → native key (e.g. file_path → path),
   *  applied under the canonical name; unlisted keys pass through verbatim. */
  inputKeyRenames?: Readonly<Record<string, string>>;
  /** Foreign-only top-level noise keys with no native counterpart (e.g. the
   *  Claude-added Bash `description`), dropped from observations so the input
   *  hash co-identifies with an equivalent native call. Load-bearing values
   *  are never listed here. */
  inputKeysToDrop?: readonly string[];
}

/** The canonical descriptor table. Content is the byte-identical successor of
 *  the subscription-executor's original CLAUDE_TO_NATIVE_TOOL_NAME /
 *  INPUT_KEY_RENAMES / INPUT_KEYS_TO_DROP const maps. */
export const CANONICAL_TOOL_DESCRIPTORS: readonly CanonicalToolDescriptor[] = [
  { name: 'FileRead', aliases: ['Read'], inputKeyRenames: { file_path: 'path' } },
  { name: 'FileWrite', aliases: ['Write'], inputKeyRenames: { file_path: 'path' } },
  { name: 'FileEdit', aliases: ['Edit'], inputKeyRenames: { file_path: 'path' } },
  { name: 'Bash', inputKeysToDrop: ['description'] },
];

// O(1) lookup indexes, derived once at module load. Map-backed (NOT Record
// literals) so prototype keys ('toString', 'constructor', …) can never leak an
// inherited member into a lookup — the original Record-literal form would have
// returned Object.prototype.toString for a tool named 'toString'.
const aliasIndex = new Map<string, string>();
const renameIndex = new Map<string, Readonly<Record<string, string>>>();
const dropIndex = new Map<string, readonly string[]>();
for (const descriptor of CANONICAL_TOOL_DESCRIPTORS) {
  for (const alias of descriptor.aliases ?? []) {
    aliasIndex.set(alias, descriptor.name);
  }
  if (descriptor.inputKeyRenames !== undefined) {
    renameIndex.set(descriptor.name, descriptor.inputKeyRenames);
  }
  if (descriptor.inputKeysToDrop !== undefined) {
    dropIndex.set(descriptor.name, descriptor.inputKeysToDrop);
  }
}

/** Resolve a foreign tool name to its native name, or undefined when the name
 *  is not a known alias (already native, or no native equivalent — callers
 *  fall back to the name itself: `aliasToNativeName(n) ?? n`). */
export function aliasToNativeName(alias: string): string | undefined {
  return aliasIndex.get(alias);
}

/** Top-level input-key renames for a CANONICAL tool name, or undefined when
 *  the tool needs none. */
export function renamesFor(nativeName: string): Readonly<Record<string, string>> | undefined {
  return renameIndex.get(nativeName);
}

/** Foreign-only noise keys to drop for a CANONICAL tool name, or undefined
 *  when the tool has none. */
export function dropsFor(nativeName: string): readonly string[] | undefined {
  return dropIndex.get(nativeName);
}

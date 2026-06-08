// Shared SKILL.md frontmatter helpers used by both the loader (read path) and
// install/import (write path). Kept in one place so the two surfaces parse the
// exact same shape and the comma-list normalization can never drift.

/** The leading `---\n<yaml>\n---\n<body>` frontmatter block, CRLF-tolerant. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Split a markdown file into its RAW (still-unparsed) YAML frontmatter block and
 * body. Both the loader and install/import sit on top of this so they see an
 * identical shape; each then parses the YAML with its own validator.
 *
 * Throws when no leading `---` frontmatter block is present.
 */
export function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const match = raw.match(FRONTMATTER_RE);
  if (!match || match[1] === undefined) {
    throw new Error('missing YAML frontmatter (expected leading --- block)');
  }
  return { frontmatter: match[1], body: match[2] ?? '' };
}

/** Split a comma-separated string into a trimmed, non-empty list. Claude Code
 *  frequently writes `allowed-tools` as a single comma-separated string rather
 *  than a YAML list.
 *
 *  PAREN/BRACKET-AWARE: only commas at nesting depth 0 are split points. A
 *  comma INSIDE a `(...)` or `[...]` group is part of the entry — real CC Bash
 *  patterns routinely carry one (e.g. `Bash(git log --pretty=format:%h,%an)`).
 *  A naive `split(',')` would shred that into unparseable fragments that later
 *  throw in `parsePermissionRule` ("missing closing ')'"), failing the whole
 *  /skill turn. An unbalanced opener (depth never returns to 0) leaves the
 *  remainder as one entry rather than crashing. */
export function splitCommaList(value: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(' || ch === '[') {
      depth += 1;
      current += ch;
    } else if (ch === ')' || ch === ']') {
      // Clamp at 0 so a stray closer can't drive depth negative and start
      // splitting inside a later legitimate group.
      depth = Math.max(0, depth - 1);
      current += ch;
    } else if (ch === ',' && depth === 0) {
      entries.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  entries.push(current);
  return entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

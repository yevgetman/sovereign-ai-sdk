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
 *  than a YAML list. */
export function splitCommaList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

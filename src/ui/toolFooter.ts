// Per-tool footer summaries shown below inline tool output. Replaces the
// old generic "✓ N lines, X chars" with a tool-shape-aware string, e.g.
// `read 250 lines`, `found 47 files`, `matched 12 lines · in 3 files`.
//
// The slot calls `summarizeToolResult(name, content, isError, lineCount,
// truncatedCount)` and renders the returned string. Unknown tool names
// fall back to a generic counter that's still cleaner than the old
// "✓ N lines, X chars" — just `N lines` for content, `M more lines` when
// truncated.
//
// Pure: no IO, no theme calls. The slot does the styling.

export type ResultSummary = {
  /** Main descriptor string, e.g. `read 250 lines` or `exit 0 · 8 lines`.
   *  When the output was truncated, this is followed by ` · M more lines`
   *  in the rendered footer (the slot adds the suffix; this string just
   *  carries the primary descriptor). */
  primary: string;
};

/** Build the primary footer descriptor for a tool result. The slot
 *  appends `· M more lines` to the rendered footer when truncatedCount
 *  > 0; this function returns just the leading descriptor. */
export function summarizeToolResult(opts: {
  toolName: string;
  content: string;
  isError: boolean;
  /** Total lines of output (post-trim), regardless of truncation. */
  totalLines: number;
}): ResultSummary {
  const { toolName, content, isError, totalLines } = opts;

  if (isError) {
    return { primary: summarizeError(toolName, content, totalLines) };
  }

  switch (toolName) {
    case 'Bash': {
      // Look for an exit-code envelope like `exit code: 0` in the
      // observation block (Phase 12.5 wraps Bash output with a header).
      const exit = extractBashExit(content);
      if (exit !== null) return { primary: `exit ${exit} · ${pluralLines(totalLines)}` };
      return { primary: pluralLines(totalLines) };
    }
    case 'FileRead':
    case 'Read': {
      // The renderer prefixes line numbers; "N lines" is the natural
      // descriptor (matches the Read tool's own envelope summary).
      return { primary: `read ${pluralLines(totalLines)}` };
    }
    case 'FileWrite':
    case 'Write': {
      const path = extractFirstArtifactPath(content);
      return { primary: path ? `wrote ${path}` : 'wrote file' };
    }
    case 'FileEdit':
    case 'Edit': {
      const replacements = extractReplacementsCount(content);
      if (replacements !== null) {
        return {
          primary: `${replacements} replacement${replacements === 1 ? '' : 's'}`,
        };
      }
      return { primary: 'edited' };
    }
    case 'Grep': {
      // Grep output is `path:line:match` per result; one match per line.
      // Count distinct files for the footer.
      const fileCount = countDistinctGrepFiles(content);
      if (totalLines === 0) return { primary: 'no matches' };
      if (fileCount > 1) {
        return { primary: `matched ${pluralLines(totalLines)} · in ${fileCount} files` };
      }
      return { primary: `matched ${pluralLines(totalLines)}` };
    }
    case 'Glob': {
      if (totalLines === 0) return { primary: 'no files matched' };
      return { primary: `found ${totalLines} file${totalLines === 1 ? '' : 's'}` };
    }
    case 'AgentTool': {
      // The renderResult wraps the child's summary in a <subagent_result>
      // envelope; pull the terminal + turn count out of its attributes.
      const subagent = extractSubagentSummary(content);
      if (subagent) return { primary: subagent };
      return { primary: pluralLines(totalLines) };
    }
    case 'HarnessInfo': {
      return { primary: 'snapshot' };
    }
    case 'ToolSearch': {
      return { primary: `${totalLines === 0 ? 'no matches' : pluralLines(totalLines)}` };
    }
    default:
      return { primary: pluralLines(totalLines) };
  }
}

function pluralLines(n: number): string {
  return `${n} line${n === 1 ? '' : 's'}`;
}

function summarizeError(toolName: string, content: string, totalLines: number): string {
  if (toolName === 'Bash') {
    const exit = extractBashExit(content);
    if (exit !== null) return `exit ${exit} · ${pluralLines(totalLines)}`;
  }
  // Take the first non-empty line as the error gist.
  const firstLine =
    content
      .trim()
      .split('\n')
      .find((l) => l.length > 0) ?? '';
  if (firstLine.length === 0) return 'error';
  if (firstLine.length > 80) return `${firstLine.slice(0, 79)}…`;
  return firstLine;
}

function extractBashExit(content: string): number | null {
  // Phase 12.5's BashTool envelope renders `exit code: N` somewhere in
  // the formatted output. Match it permissively.
  const match = content.match(/exit code:?\s*(-?\d+)/i);
  if (match?.[1] !== undefined) {
    const n = Number.parseInt(match[1], 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function extractFirstArtifactPath(content: string): string | null {
  // The Phase 12.5 observation envelope has an `artifacts:` line followed
  // by `  - <path>` entries. Pick the first.
  const match = content.match(/artifacts:[\s\n]+-\s*(\S+)/);
  return match?.[1] ?? null;
}

function extractReplacementsCount(content: string): number | null {
  // FileEdit's renderResult includes a `replacements: N` line in the
  // observation block.
  const match = content.match(/replacements?:\s*(\d+)/i);
  if (match?.[1] !== undefined) {
    const n = Number.parseInt(match[1], 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function countDistinctGrepFiles(content: string): number {
  // Output lines are `<path>:<line-number>:<match>` per ripgrep.
  // Distinct files = distinct prefixes before the first ":<digits>:".
  const files = new Set<string>();
  for (const line of content.split('\n')) {
    const m = line.match(/^([^:\n]+):\d+:/);
    if (m?.[1] !== undefined) files.add(m[1]);
  }
  return files.size;
}

function extractSubagentSummary(content: string): string | null {
  // The renderResult format is:
  //   <subagent_result name="X" session="..." lane="p/m" turns="N"
  //                    tool_calls="M" duration_ms="..." terminal="completed">
  const match = content.match(
    /<subagent_result\s[^>]*\bturns="(\d+)"\s+tool_calls="(\d+)"[^>]*\bterminal="([^"]+)"/,
  );
  if (!match) return null;
  const [, turns, toolCalls, terminal] = match;
  return `${terminal} · ${turns} turn${turns === '1' ? '' : 's'} · ${toolCalls} tool call${toolCalls === '1' ? '' : 's'}`;
}

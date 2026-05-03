// Minimal diff renderer for FileEdit / FileWrite tool results.
//
// FileEdit input carries old_string + new_string verbatim, so we can
// render a precise minus/plus block without re-reading the file. For
// FileWrite, we only have the new content (and a `created` flag in the
// renderResult string), so we render it as an additive block —
// "+ created path (N bytes)" with a content preview.
//
// Verbose mode renders the full minus/plus blocks; non-verbose
// truncates to a small head/tail window so a 500-line replacement
// doesn't dominate the conversation. Either way, the output is one
// indented block under the tool call's slot line.

import chalk from 'chalk';

const NON_VERBOSE_HEAD = 4;
const NON_VERBOSE_TAIL = 2;
const MAX_LINE_LENGTH = 200;

export type DiffRenderInput =
  | { kind: 'edit'; path: string; oldString: string; newString: string; replacements?: number }
  | { kind: 'write'; path: string; content: string; created: boolean; bytesWritten?: number };

export type DiffRenderOpts = {
  /** When true, render the full diff. When false, truncate to a small
   *  head/tail window. Default false. */
  verbose?: boolean;
};

/** Render a styled diff block for a FileEdit / FileWrite tool call.
 *  Returns the multi-line string ready to write to stdout (with a
 *  trailing newline). Returns null when the tool isn't a known
 *  diff-shaped tool — caller falls back to default tool-result
 *  rendering. */
export function renderToolDiff(
  toolName: string,
  rawInput: unknown,
  opts: DiffRenderOpts = {},
): string | null {
  const parsed = parseToolInput(toolName, rawInput);
  if (!parsed) return null;
  return renderDiff(parsed, opts);
}

/** Lower-level renderer used by both `renderToolDiff` and tests that
 *  want to drive shapes directly without going through tool-name
 *  routing. */
export function renderDiff(input: DiffRenderInput, opts: DiffRenderOpts = {}): string {
  const verbose = opts.verbose === true;
  if (input.kind === 'edit') return renderEdit(input, verbose);
  return renderWrite(input, verbose);
}

function renderEdit(input: Extract<DiffRenderInput, { kind: 'edit' }>, verbose: boolean): string {
  const head: string[] = [];
  const reps = input.replacements ?? 1;
  const repsLabel = reps === 1 ? '1 replacement' : `${reps} replacements`;
  head.push(chalk.gray(`  ${input.path}  ${chalk.dim(`(${repsLabel})`)}`));

  const oldLines = splitLines(input.oldString);
  const newLines = splitLines(input.newString);
  const minus = oldLines.map((l) => chalk.red(`  - ${truncateLine(l)}`));
  const plus = newLines.map((l) => chalk.green(`  + ${truncateLine(l)}`));
  const lines = [...minus, ...plus];
  const rendered = verbose ? lines : truncateBlock(lines);
  return `${[...head, ...rendered].join('\n')}\n`;
}

function renderWrite(input: Extract<DiffRenderInput, { kind: 'write' }>, verbose: boolean): string {
  const head: string[] = [];
  const verb = input.created ? 'created' : 'wrote';
  const sizeLabel =
    input.bytesWritten !== undefined ? ` ${chalk.dim(`(${input.bytesWritten} bytes)`)}` : '';
  head.push(chalk.gray(`  ${verb} ${input.path}${sizeLabel}`));
  const contentLines = splitLines(input.content);
  const plus = contentLines.map((l) => chalk.green(`  + ${truncateLine(l)}`));
  const rendered = verbose ? plus : truncateBlock(plus);
  return `${[...head, ...rendered].join('\n')}\n`;
}

function parseToolInput(toolName: string, rawInput: unknown): DiffRenderInput | null {
  if (rawInput === null || typeof rawInput !== 'object') return null;
  const obj = rawInput as Record<string, unknown>;
  if (toolName === 'FileEdit' || toolName === 'Edit') {
    if (typeof obj.path !== 'string') return null;
    if (typeof obj.old_string !== 'string') return null;
    if (typeof obj.new_string !== 'string') return null;
    return {
      kind: 'edit',
      path: obj.path,
      oldString: obj.old_string,
      newString: obj.new_string,
    };
  }
  if (toolName === 'FileWrite' || toolName === 'Write') {
    if (typeof obj.path !== 'string') return null;
    if (typeof obj.content !== 'string') return null;
    return {
      kind: 'write',
      path: obj.path,
      content: obj.content,
      // We don't know created vs. updated until the tool runs; default
      // to false ("wrote") and let the caller override after parsing
      // the tool result if desired. The slot-line preview is fine
      // either way for a non-verbose summary.
      created: false,
    };
  }
  return null;
}

function splitLines(s: string): string[] {
  if (s.length === 0) return [''];
  return s.split(/\r?\n/);
}

function truncateLine(line: string): string {
  if (line.length <= MAX_LINE_LENGTH) return line;
  return `${line.slice(0, MAX_LINE_LENGTH - 1)}…`;
}

function truncateBlock(lines: string[]): string[] {
  const max = NON_VERBOSE_HEAD + NON_VERBOSE_TAIL + 1;
  if (lines.length <= max) return lines;
  const head = lines.slice(0, NON_VERBOSE_HEAD);
  const tail = lines.slice(-NON_VERBOSE_TAIL);
  const omitted = lines.length - NON_VERBOSE_HEAD - NON_VERBOSE_TAIL;
  return [...head, chalk.dim(`  … ${omitted} more line${omitted === 1 ? '' : 's'} …`), ...tail];
}

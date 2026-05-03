// Minimal diff renderer for FileEdit / FileWrite tool results.
//
// FileEdit input carries old_string + new_string verbatim. When the
// caller can also supply `preContent` (the file's contents at the
// moment the model decided to edit), the renderer expands the diff
// to full-line context: instead of "- hello world / + hello sovereign"
// the user sees "- const greeting = \"hello world\";" with the line
// number, which reads like a real diff. Without preContent the
// renderer falls back to raw substring rendering — useful for tests
// and for cases where the file isn't readable.
//
// FileWrite renders as an additive block of the new content. We
// don't currently diff against pre-existing content for overwrites;
// "wrote N bytes" is sufficient signal for Wave 1.
//
// Verbose mode renders the full minus/plus blocks; non-verbose
// truncates to a small head/tail window so a 500-line replacement
// doesn't dominate the conversation. Either way, the output is one
// indented block under the tool call's slot line.

import { theme } from './theme.js';

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
  /** Pre-edit file contents. When provided for FileEdit, the renderer
   *  computes which line(s) contain `old_string` and renders those
   *  full lines as `-`/`+` with a line number, instead of the raw
   *  substring. Falls back to substring rendering when the match
   *  isn't found, when `old_string` is empty, or when this is omitted. */
  preContent?: string;
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
  if (input.kind === 'edit') {
    const ctx =
      opts.preContent !== undefined
        ? computeEditContext(opts.preContent, input.oldString, input.newString)
        : null;
    if (ctx) return renderEditWithContext(input, ctx, verbose);
    return renderEditSubstring(input, verbose);
  }
  return renderWrite(input, verbose);
}

type EditContext = {
  /** Full lines from the pre-edit file that span the matched substring. */
  preLines: string[];
  /** Same lines after the substring is replaced. */
  postLines: string[];
  /** 1-based line number where the change starts. */
  startLine: number;
  /** Total times `oldString` appears in `preContent`. >1 when the
   *  model used `replace_all: true` against multiple matches; we
   *  still only render the first hunk and append a count note. */
  occurrences: number;
};

function computeEditContext(
  preContent: string,
  oldString: string,
  newString: string,
): EditContext | null {
  if (oldString.length === 0) return null;
  const idx = preContent.indexOf(oldString);
  if (idx === -1) return null;

  let occurrences = 0;
  let pos = 0;
  while (true) {
    const i = preContent.indexOf(oldString, pos);
    if (i === -1) break;
    occurrences++;
    pos = i + oldString.length;
  }

  // Line boundaries spanning the first occurrence: scan back to the
  // previous \n (or BOF) and forward to the next \n (or EOF). The
  // span may cover multiple lines if old_string itself crosses one.
  const before = preContent.slice(0, idx);
  const lineStartOffset = before.lastIndexOf('\n') + 1; // 0 when no \n
  const startLine = (before.match(/\n/g)?.length ?? 0) + 1;

  const matchEnd = idx + oldString.length;
  const after = preContent.slice(matchEnd);
  const nextNewline = after.indexOf('\n');
  const lineEndOffset = nextNewline === -1 ? preContent.length : matchEnd + nextNewline;

  const oldBlock = preContent.slice(lineStartOffset, lineEndOffset);
  // Apply the same replacement the tool will apply — first occurrence
  // only, since that's the hunk we're rendering. (replace_all still
  // reduces to a single rendered hunk by design.)
  const newBlock = oldBlock.replace(oldString, newString);

  return {
    preLines: oldBlock.split('\n'),
    postLines: newBlock.split('\n'),
    startLine,
    occurrences,
  };
}

function renderEditWithContext(
  input: Extract<DiffRenderInput, { kind: 'edit' }>,
  ctx: EditContext,
  verbose: boolean,
): string {
  const t = theme.tokens;
  const head: string[] = [];
  const lineLabel = t.textDim(`:${ctx.startLine}`);
  const repsLabel = formatRepsLabel(input.replacements, ctx.occurrences);
  head.push(`  ${t.textMuted(input.path)}${lineLabel}${repsLabel}`);

  const minus = ctx.preLines.map((l) => t.diffRemoved(`  - ${truncateLine(l)}`));
  const plus = ctx.postLines.map((l) => t.diffAdded(`  + ${truncateLine(l)}`));
  const lines = [...minus, ...plus];
  const rendered = verbose ? lines : truncateBlock(lines);
  return `${[...head, ...rendered].join('\n')}\n`;
}

function formatRepsLabel(replacements: number | undefined, occurrences: number): string {
  const dim = theme.tokens.textDim;
  if (occurrences > 1) {
    const reps = replacements ?? occurrences;
    return dim(
      `  (applied ${reps}× across ${occurrences} occurrence${occurrences === 1 ? '' : 's'})`,
    );
  }
  if (replacements && replacements > 1) {
    return dim(`  (${replacements} replacements)`);
  }
  return '';
}

function renderEditSubstring(
  input: Extract<DiffRenderInput, { kind: 'edit' }>,
  verbose: boolean,
): string {
  const t = theme.tokens;
  const head: string[] = [];
  const reps = input.replacements ?? 1;
  const repsLabel = reps === 1 ? '1 replacement' : `${reps} replacements`;
  head.push(t.textMuted(`  ${input.path}  ${t.textDim(`(${repsLabel})`)}`));

  const oldLines = splitLines(input.oldString);
  const newLines = splitLines(input.newString);
  const minus = oldLines.map((l) => t.diffRemoved(`  - ${truncateLine(l)}`));
  const plus = newLines.map((l) => t.diffAdded(`  + ${truncateLine(l)}`));
  const lines = [...minus, ...plus];
  const rendered = verbose ? lines : truncateBlock(lines);
  return `${[...head, ...rendered].join('\n')}\n`;
}

function renderWrite(input: Extract<DiffRenderInput, { kind: 'write' }>, verbose: boolean): string {
  const t = theme.tokens;
  const head: string[] = [];
  const verb = input.created ? 'created' : 'wrote';
  const sizeLabel =
    input.bytesWritten !== undefined ? ` ${t.textDim(`(${input.bytesWritten} bytes)`)}` : '';
  head.push(t.textMuted(`  ${verb} ${input.path}${sizeLabel}`));
  const contentLines = splitLines(input.content);
  const plus = contentLines.map((l) => t.diffAdded(`  + ${truncateLine(l)}`));
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
    const replacements =
      typeof obj.replace_all === 'boolean' && obj.replace_all === true
        ? undefined // unknown count without preContent; computeEditContext fills it in
        : 1;
    return {
      kind: 'edit',
      path: obj.path,
      oldString: obj.old_string,
      newString: obj.new_string,
      ...(replacements !== undefined ? { replacements } : {}),
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
  return [
    ...head,
    theme.tokens.textDim(`  … ${omitted} more line${omitted === 1 ? '' : 's'} …`),
    ...tail,
  ];
}

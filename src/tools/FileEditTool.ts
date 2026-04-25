// FileEditTool — string-replace inside a file. Defaults to the unique-
// match semantics from Claude Code: `old_string` must appear exactly once
// or the call fails, forcing the model to expand its match window with
// surrounding context. `replace_all: true` overrides that for global
// renames.
//
// Errors come back as is_error tool_results via the orchestrator's
// thrown-error wrapper. The model then sees the message and can adapt
// (widen old_string, switch to replace_all, etc.).

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { buildTool } from '../tool/buildTool.js';

const inputSchema = z.object({
  path: z.string().describe('Absolute path, or cwd-relative path, to the file to edit.'),
  old_string: z
    .string()
    .describe(
      'Substring to replace. Must match exactly once unless replace_all is true. Whitespace and indentation are significant.',
    ),
  new_string: z.string().describe('Replacement string. May be empty to delete the matched text.'),
  replace_all: z
    .boolean()
    .optional()
    .describe('Replace every occurrence instead of requiring a unique match. Default false.'),
});

type Input = z.infer<typeof inputSchema>;

type Output = {
  path: string;
  replacements: number;
};

export const FileEditTool = buildTool<Input, Output>({
  name: 'FileEdit',
  description: () =>
    'Replace a substring in a file. Defaults to unique-match: old_string must appear exactly once. Set replace_all to rename every occurrence.',
  inputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => true, // path-overlap detection serializes
  affectedPaths: (input) => [input.path],
  checkPermissions: async () => ({ behavior: 'ask' }),
  renderResult: (out) => ({
    content: `${out.path}: ${out.replacements} replacement${out.replacements === 1 ? '' : 's'}`,
  }),
  async call(input, ctx) {
    const abs = isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path);
    if (!existsSync(abs)) {
      throw new Error(`file does not exist: ${abs}`);
    }
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      throw new Error(`path is a directory, not a file: ${abs}`);
    }
    if (input.old_string === input.new_string) {
      throw new Error('old_string and new_string are identical — no edit to make');
    }
    if (input.old_string.length === 0) {
      throw new Error('old_string is empty');
    }
    const original = readFileSync(abs, 'utf8');
    const occurrences = countOccurrences(original, input.old_string);
    if (occurrences === 0) {
      throw new Error(`old_string not found in ${abs}`);
    }
    const replaceAll = input.replace_all ?? false;
    if (!replaceAll && occurrences > 1) {
      throw new Error(
        `old_string is not unique in ${abs} (${occurrences} matches). Expand the match with surrounding context, or set replace_all: true.`,
      );
    }
    const updated = replaceAll
      ? original.split(input.old_string).join(input.new_string)
      : replaceFirst(original, input.old_string, input.new_string);
    writeFileSync(abs, updated, 'utf8');
    return {
      data: {
        path: abs,
        replacements: replaceAll ? occurrences : 1,
      },
    };
  },
});

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    count++;
    pos = idx + needle.length;
  }
  return count;
}

/** First-occurrence replace via slice/concat — avoids the `$&`-and-friends
 *  expansion that String.prototype.replace performs when both args are
 *  strings. */
function replaceFirst(source: string, oldString: string, newString: string): string {
  const idx = source.indexOf(oldString);
  if (idx === -1) return source;
  return source.slice(0, idx) + newString + source.slice(idx + oldString.length);
}

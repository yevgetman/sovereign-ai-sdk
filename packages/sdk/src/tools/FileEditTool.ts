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
import { z } from 'zod';
import { buildTool } from '../tool/buildTool.js';
import type { ToolObservation } from '../tool/types.js';
import { resolveToolPath } from './pathUtils.js';
import { matchesPathPermissionPattern } from './permissionMatchers.js';

const inputSchema = z.object({
  path: z.string().describe('Absolute path, ~/ path, or cwd-relative path, to the file to edit.'),
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
  /** Phase 12.5: set on the recoverable error classes (missing match,
   *  non-unique match) so the rendered tool_result still shows the
   *  message. The `is_error` flag is driven by the observation envelope. */
  error?: string;
};

export const FileEditTool = buildTool<Input, Output>({
  name: 'FileEdit',
  aliases: ['Edit'],
  description: () =>
    'Replace a substring in a file. Defaults to unique-match: old_string must appear exactly once. Set replace_all to rename every occurrence.',
  inputSchema,
  displayInput: (input) => (input.replace_all === true ? `${input.path} (all)` : input.path),
  isReadOnly: () => false,
  isConcurrencySafe: () => true, // path-overlap detection serializes
  affectedPaths: (input) => [input.path],
  checkPermissions: async () => ({ behavior: 'ask' }),
  preparePermissionMatcher: async (input) => (pattern) =>
    matchesPathPermissionPattern(input.path, pattern),
  renderResult: (out) => {
    if (out.error !== undefined) return { content: out.error };
    return {
      content: `${out.path}: ${out.replacements} replacement${out.replacements === 1 ? '' : 's'}`,
    };
  },
  renderHint: { kind: 'diff' },
  async call(input, ctx) {
    const abs = resolveToolPath(input.path, ctx.cwd);
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
      const error = `old_string not found in ${abs}`;
      const observation: ToolObservation = {
        status: 'error',
        summary: `no match for old_string in ${abs}`,
        next_actions: [
          'Re-read the file (FileRead) to see current contents — your old_string may not match exactly.',
          'Check whitespace, indentation, and line endings — every byte of old_string must match.',
        ],
        artifacts: [abs],
      };
      return { data: { path: abs, replacements: 0, error }, observation };
    }
    const replaceAll = input.replace_all ?? false;
    if (!replaceAll && occurrences > 1) {
      const error = `old_string is not unique in ${abs} (${occurrences} matches). Expand the match with surrounding context, or set replace_all: true.`;
      const observation: ToolObservation = {
        status: 'error',
        summary: `old_string matches ${occurrences} times in ${abs}`,
        next_actions: [
          'Expand old_string with surrounding context so it identifies one location uniquely.',
          'Or set replace_all: true to apply the substitution to every occurrence.',
        ],
        artifacts: [abs],
      };
      return { data: { path: abs, replacements: 0, error }, observation };
    }
    const updated = replaceAll
      ? original.split(input.old_string).join(input.new_string)
      : replaceFirst(original, input.old_string, input.new_string);
    writeFileSync(abs, updated, 'utf8');
    const replacements = replaceAll ? occurrences : 1;
    return {
      data: { path: abs, replacements },
      observation: {
        status: 'success',
        summary: `${replacements} replacement${replacements === 1 ? '' : 's'} in ${abs}`,
        artifacts: [abs],
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

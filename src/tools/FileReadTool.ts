// FileReadTool — read a text file with optional line-range paging.
// Output is rendered to the model with `cat -n`-style line numbers so
// follow-up edits can reference exact line positions. Reads are
// permissionless (Phase 7 may add path-deny rules) and concurrency-safe;
// the orchestrator handles overlap with concurrent writes via affectedPaths.
//
// Source of pattern: Claude Code src/tools/FileReadTool. Smaller scope —
// no image/PDF/notebook handling for Phase 4. Add when a real use case
// appears.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { buildTool } from '../tool/buildTool.js';
import { matchesPathPermissionPattern } from './permissionMatchers.js';

/** Hard cap on how many bytes the tool will read in a single call. Files
 *  larger than this cap fail with a clear message asking the model to use
 *  offset/limit. 1 MiB matches Claude Code's default. */
const MAX_BYTES = 1024 * 1024;

const inputSchema = z.object({
  path: z.string().describe('Absolute path, or cwd-relative path, to the file.'),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Line index to start at (0-indexed). Default: 0.'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum number of lines to return. Default: read entire file.'),
});

type Input = z.infer<typeof inputSchema>;

type Output = {
  /** Resolved absolute path actually read. */
  path: string;
  lines: string[];
  /** 1-indexed line number of `lines[0]`. */
  startLine: number;
  totalLines: number;
};

export const FileReadTool = buildTool<Input, Output>({
  name: 'FileRead',
  aliases: ['Read'],
  description: () =>
    'Read a UTF-8 text file. Returns content with `cat -n`-style line numbers. Use offset/limit to page through large files.',
  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  checkPermissions: async () => ({ behavior: 'allow' }),
  affectedPaths: (input) => [input.path],
  preparePermissionMatcher: async (input) => (pattern) =>
    matchesPathPermissionPattern(input.path, pattern),
  renderResult: (out) => ({ content: renderFileRead(out) }),
  async call(input, ctx) {
    const abs = isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path);
    if (!existsSync(abs)) {
      throw new Error(`file does not exist: ${abs}`);
    }
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      throw new Error(`path is a directory, not a file: ${abs}`);
    }
    if (stat.size > MAX_BYTES) {
      throw new Error(
        `file too large: ${stat.size} bytes (cap is ${MAX_BYTES}). Use offset/limit to page through it.`,
      );
    }
    const content = readFileSync(abs, 'utf8');
    const allLines = content.split('\n');
    // A trailing newline produces a final empty element; strip it so
    // totalLines is the human-counted number of lines.
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
      allLines.pop();
    }
    const offset = input.offset ?? 0;
    const limit = input.limit ?? allLines.length;
    const lines = allLines.slice(offset, offset + limit);
    return {
      data: {
        path: abs,
        lines,
        startLine: offset + 1,
        totalLines: allLines.length,
      },
    };
  },
});

function renderFileRead(out: Output): string {
  if (out.lines.length === 0) {
    if (out.totalLines === 0) return `${out.path}: (empty file)`;
    return `${out.path}: empty range (${out.totalLines} lines total)`;
  }
  const lastLine = out.startLine + out.lines.length - 1;
  const padWidth = String(lastLine).length;
  const numbered = out.lines.map((line, i) => {
    const lineNo = out.startLine + i;
    return `${String(lineNo).padStart(padWidth, ' ')}\t${line}`;
  });
  const header = `${out.path} (lines ${out.startLine}-${lastLine} of ${out.totalLines}):`;
  return `${header}\n${numbered.join('\n')}`;
}

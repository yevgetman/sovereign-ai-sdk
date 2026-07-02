// GlobTool — list files matching a glob pattern. Uses tinyglobby (no shell-out,
// Node-compatible; replaced Bun.Glob in Task 2.2 of SDK consumable packaging).
// Read-only and concurrency-safe; results sorted lexicographically for
// determinism.

import { globSync } from 'tinyglobby';
import { z } from 'zod';
import { buildTool } from '../tool/buildTool.js';
import { resolveToolPath } from './pathUtils.js';
import { matchesPathPermissionPattern } from './permissionMatchers.js';

const inputSchema = z.object({
  pattern: z.string().describe('Glob pattern, e.g. "src/**/*.ts" or "*.md".'),
  path: z
    .string()
    .optional()
    .describe('Directory to scan; accepts absolute, ~/, or cwd-relative paths. Default: cwd.'),
  head_limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum number of paths to return. Default: no cap.'),
});

type Input = z.infer<typeof inputSchema>;

type Output = {
  paths: string[];
  truncated: boolean;
};

export const GlobTool = buildTool<Input, Output>({
  name: 'Glob',
  description: () =>
    'List files matching a glob pattern. Paths returned are relative to the scan root, sorted lexicographically.',
  inputSchema,
  displayInput: (input) =>
    input.path !== undefined ? `${input.pattern} in ${input.path}` : input.pattern,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  checkPermissions: async () => ({ behavior: 'allow' }),
  preparePermissionMatcher: async (input) => (pattern) =>
    matchesPathPermissionPattern(input.path ?? input.pattern, pattern),
  renderResult: (out) => ({
    content:
      out.paths.length === 0
        ? '(no matches)'
        : out.truncated
          ? `${out.paths.join('\n')}\n[truncated]`
          : out.paths.join('\n'),
  }),
  renderHint: { kind: 'tree' },
  async call(input, ctx) {
    const baseDir = input.path ? resolveToolPath(input.path, ctx.cwd) : ctx.cwd;
    // Collect ALL matches, then sort, THEN truncate — so head_limit returns the
    // lexicographically-first N (the documented deterministic contract). The
    // previous order (break at cap during the filesystem-order scan, then sort)
    // returned an arbitrary subset that varied run-to-run / across platforms.
    //
    // Options pin Bun.Glob.scanSync parity (empirical — see the scan-parity
    // suite in tests/tools/globTool.test.ts): `expandDirectories: false` (Bun
    // did not expand a bare directory pattern into `dir/**`) and
    // `followSymbolicLinks: false` (Bun's scanSync default — `**` does not
    // traverse symlinked directories).
    const matches = globSync(input.pattern, {
      cwd: baseDir,
      onlyFiles: true,
      expandDirectories: false,
      followSymbolicLinks: false,
    });
    matches.sort();
    const cap = input.head_limit;
    const truncated = cap !== undefined && matches.length > cap;
    const found = truncated ? matches.slice(0, cap) : matches;
    const next_actions: string[] = [];
    if (found.length === 0) {
      next_actions.push(
        'broaden the pattern (e.g. **/*.ts → **/*) or change the scan root with `path`',
        'try a different file extension if you guessed at the language',
      );
    } else if (truncated) {
      next_actions.push('raise head_limit, or narrow the pattern to reduce result count');
    }
    return {
      data: { paths: found, truncated },
      observation: {
        status: found.length === 0 ? 'warning' : 'success',
        summary:
          found.length === 0
            ? `no files matched ${input.pattern}`
            : `${found.length} file${found.length === 1 ? '' : 's'}${truncated ? ' (truncated)' : ''}`,
        ...(next_actions.length > 0 ? { next_actions } : {}),
      },
    };
  },
});

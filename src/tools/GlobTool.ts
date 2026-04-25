// GlobTool — list files matching a glob pattern. Uses Bun's built-in
// `Bun.Glob` (no shell-out, no extra dependency). Read-only and
// concurrency-safe; results sorted lexicographically for determinism.

import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { buildTool } from '../tool/buildTool.js';

const inputSchema = z.object({
  pattern: z.string().describe('Glob pattern, e.g. "src/**/*.ts" or "*.md".'),
  path: z.string().optional().describe('Directory to scan (default: cwd).'),
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
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  checkPermissions: async () => ({ behavior: 'allow' }),
  renderResult: (out) => ({
    content:
      out.paths.length === 0
        ? '(no matches)'
        : out.truncated
          ? `${out.paths.join('\n')}\n[truncated]`
          : out.paths.join('\n'),
  }),
  async call(input, ctx) {
    const baseDir = input.path
      ? isAbsolute(input.path)
        ? input.path
        : resolve(ctx.cwd, input.path)
      : ctx.cwd;
    const glob = new Bun.Glob(input.pattern);
    const found: string[] = [];
    let truncated = false;
    const cap = input.head_limit;
    for (const file of glob.scanSync({ cwd: baseDir, onlyFiles: true })) {
      found.push(file);
      if (cap !== undefined && found.length >= cap) {
        truncated = true;
        break;
      }
    }
    found.sort();
    return {
      data: { paths: found, truncated },
    };
  },
});

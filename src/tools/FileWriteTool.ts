// FileWriteTool — write/overwrite a text file. Parent directory must
// already exist (matches Claude Code; prevents the model from
// inadvertently creating deep nested paths). Always asks for permission
// in Phase 3 mode; Phase 7 will add path-allow rules so writes inside the
// session's working directory don't prompt.

import { existsSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { buildTool } from '../tool/buildTool.js';
import { resolveToolPath } from './pathUtils.js';
import { matchesPathPermissionPattern } from './permissionMatchers.js';

const inputSchema = z.object({
  path: z.string().describe('Absolute path, ~/ path, or cwd-relative path, to the file to write.'),
  content: z.string().describe('Full file contents. Overwrites any existing file at the path.'),
});

type Input = z.infer<typeof inputSchema>;

type Output = {
  path: string;
  bytesWritten: number;
  /** True when the file did not exist before this call. */
  created: boolean;
};

export const FileWriteTool = buildTool<Input, Output>({
  name: 'FileWrite',
  aliases: ['Write'],
  description: () =>
    'Write content to a file, overwriting any existing file. Parent directory must already exist.',
  inputSchema,
  displayInput: (input) => input.path,
  isReadOnly: () => false,
  // Concurrency-safe at the tool level — the orchestrator's path-overlap
  // detection serializes writes that target the same path. Two writes to
  // different paths can run in parallel.
  isConcurrencySafe: () => true,
  affectedPaths: (input) => [input.path],
  checkPermissions: async () => ({ behavior: 'ask' }),
  preparePermissionMatcher: async (input) => (pattern) =>
    matchesPathPermissionPattern(input.path, pattern),
  renderResult: (out) => ({
    content: out.created
      ? `created ${out.path} (${out.bytesWritten} bytes)`
      : `wrote ${out.bytesWritten} bytes to ${out.path}`,
  }),
  async call(input, ctx) {
    const abs = resolveToolPath(input.path, ctx.cwd);
    const parentDir = dirname(abs);
    if (!existsSync(parentDir)) {
      throw new Error(`parent directory does not exist: ${parentDir}`);
    }
    const created = !existsSync(abs);
    if (!created) {
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        throw new Error(`path is a directory, not a file: ${abs}`);
      }
    }
    writeFileSync(abs, input.content, 'utf8');
    const bytesWritten = Buffer.byteLength(input.content, 'utf8');
    return {
      data: { path: abs, bytesWritten, created },
      observation: {
        status: 'success',
        summary: created
          ? `created ${abs} (${bytesWritten} bytes)`
          : `wrote ${bytesWritten} bytes to ${abs}`,
        artifacts: [abs],
      },
    };
  },
});

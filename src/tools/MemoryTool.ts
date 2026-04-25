// MemoryTool — bounded markdown memory view/replace operations. This is the
// explicit agent-writable path for durable memory; there is no auto-extract.

import { z } from 'zod';
import { resolveHarnessHome } from '../config/paths.js';
import {
  type MemoryFile,
  normalizeMemoryFile,
  readAllMemory,
  readMemoryFile,
  replaceMemoryFile,
} from '../memory/bounded.js';
import { buildTool } from '../tool/buildTool.js';

const inputSchema = z.object({
  action: z.enum(['view', 'replace']).describe('view reads memory; replace overwrites one file.'),
  file: z
    .enum(['MEMORY.md', 'USER.md', 'memory.md', 'user.md', 'memory', 'user'])
    .optional()
    .describe('Memory file. Optional for action=view, required for action=replace.'),
  content: z.string().optional().describe('Replacement content for action=replace.'),
});

type Input = z.infer<typeof inputSchema>;

type Output = {
  ok: boolean;
  result: unknown;
};

export const MemoryTool = buildTool<Input, Output>({
  name: 'memory',
  description: () =>
    'View or replace bounded durable memory files. USER.md stores user profile/preferences; MEMORY.md stores agent notes. Replace requires consolidated full-file content.',
  inputSchema,
  isReadOnly: (input) => input.action === 'view',
  isConcurrencySafe: (input) => input.action === 'view',
  checkPermissions: async (input) => ({ behavior: input.action === 'view' ? 'allow' : 'ask' }),
  affectedPaths: (input) => {
    const file = optionalFile(input.file);
    return file ? [`memory/${file}`] : ['memory'];
  },
  renderResult: (out) => ({
    content: JSON.stringify(out.result, null, 2),
    ...(out.ok ? {} : { isError: true }),
  }),
  async call(input, ctx) {
    const harnessHome = ctx.harnessHome ?? resolveHarnessHome();
    if (input.action === 'view') {
      const file = optionalFile(input.file);
      return {
        data: {
          ok: true,
          result: file ? readMemoryFile(file, harnessHome) : readAllMemory(harnessHome),
        },
      };
    }

    const file = optionalFile(input.file);
    if (!file) {
      return {
        data: {
          ok: false,
          result: { error: 'file is required for action=replace' },
        },
      };
    }
    if (input.content === undefined) {
      return {
        data: {
          ok: false,
          result: { error: 'content is required for action=replace' },
        },
      };
    }
    const result = replaceMemoryFile(file, input.content, harnessHome);
    if (result.ok) await ctx.memoryManager?.onMemoryWrite({ file, chars: input.content.length });
    return {
      data: {
        ok: result.ok,
        result,
      },
    };
  },
});

function optionalFile(file: Input['file']): MemoryFile | undefined {
  return file ? normalizeMemoryFile(file) : undefined;
}

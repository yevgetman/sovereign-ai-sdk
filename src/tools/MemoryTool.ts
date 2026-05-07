// MemoryTool — bounded markdown memory view/replace operations. This is the
// explicit agent-writable path for durable memory; there is no auto-extract.
//
// Item 19 (Round 2 Task 4): MemoryTool grew an optional `scope` argument to
// route writes between the global `<harnessHome>/memory/MEMORY.md` and the
// per-project `<harnessHome>/memory/projects/<projectId>/MEMORY.md`. Default
// scope comes from `ToolContext.projectScope` — project when one is detected
// (bundle / git repo), else global. USER.md is always global by design.

import { z } from 'zod';
import { resolveHarnessHome } from '../config/paths.js';
import {
  type MemoryFile,
  type MemoryReadResult,
  normalizeMemoryFile,
  readAllMemory,
  readMemoryFile,
  readProjectMemoryFile,
  replaceMemoryFile,
  replaceProjectMemoryFile,
} from '../memory/bounded.js';
import type { ProjectScope } from '../memory/scope.js';
import { buildTool } from '../tool/buildTool.js';
import type { ToolContext } from '../tool/types.js';
import { matchesPathPermissionPattern } from './permissionMatchers.js';

const inputSchema = z.object({
  action: z.enum(['view', 'replace']).describe('view reads memory; replace overwrites one file.'),
  file: z
    .enum(['MEMORY.md', 'USER.md', 'memory.md', 'user.md', 'memory', 'user'])
    .optional()
    .describe('Memory file. Optional for action=view, required for action=replace.'),
  content: z.string().optional().describe('Replacement content for action=replace.'),
  scope: z
    .enum(['global', 'project'])
    .optional()
    .describe(
      'Memory scope. project = <harnessHome>/memory/projects/<projectId>/MEMORY.md; global = <harnessHome>/memory/MEMORY.md. Defaults: project when a project is detected (bundle or git repo), else global. USER.md is always global regardless of scope.',
    ),
});

type Input = z.infer<typeof inputSchema>;

type EffectiveScope = 'global' | 'project';

type Output = {
  ok: boolean;
  result: unknown;
};

type ProjectScopedReadResult = MemoryReadResult & { scope: 'project'; projectId: string };

export const MemoryTool = buildTool<Input, Output>({
  name: 'memory',
  description: () =>
    'View or replace bounded durable memory files. USER.md (global) stores user profile/preferences; MEMORY.md stores agent notes (per-project when a project is detected, otherwise global). Pass scope:"global" or scope:"project" to override the default. Replace requires consolidated full-file content.',
  inputSchema,
  isReadOnly: (input) => input.action === 'view',
  isConcurrencySafe: (input) => input.action === 'view',
  checkPermissions: async (input) => ({ behavior: input.action === 'view' ? 'allow' : 'ask' }),
  preparePermissionMatcher: async (input) => (pattern) =>
    matchesPathPermissionPattern(optionalFile(input.file) ?? 'memory', pattern),
  affectedPaths: (input) => affectedPathsFor(input),
  renderResult: (out) => ({
    content: JSON.stringify(out.result, null, 2),
    ...(out.ok ? {} : { isError: true }),
  }),
  async call(input, ctx) {
    const harnessHome = ctx.harnessHome ?? resolveHarnessHome();
    const file = optionalFile(input.file);
    const requestedScope = input.scope;
    const ctxScope = ctx.projectScope;
    const defaultScope: EffectiveScope = ctxScope?.kind === 'project' ? 'project' : 'global';
    const effectiveScope: EffectiveScope = requestedScope ?? defaultScope;

    if (input.action === 'view') {
      return handleView({ file, effectiveScope, ctxScope, harnessHome });
    }

    return handleReplace({
      file,
      content: input.content,
      requestedScope,
      effectiveScope,
      ctxScope,
      harnessHome,
      ctx,
    });
  },
});

function handleView(args: {
  file: MemoryFile | undefined;
  effectiveScope: EffectiveScope;
  ctxScope: ProjectScope | undefined;
  harnessHome: string;
}): { data: Output; observation: { status: 'success'; summary: string } } {
  const { file, effectiveScope, ctxScope, harnessHome } = args;

  // view-all: omit `file`. Returns global files; when project context exists,
  // also returns the project MEMORY.md under `MEMORY.md@project`.
  if (!file) {
    const all = readAllMemory(harnessHome);
    const result: Record<string, MemoryReadResult | ProjectScopedReadResult> = { ...all };
    let summary = 'viewed all memory files';
    if (effectiveScope === 'project' && ctxScope?.kind === 'project') {
      const projectRead = readProjectMemoryFile(ctxScope.id, harnessHome);
      result['MEMORY.md@project'] = {
        ...projectRead,
        scope: 'project',
        projectId: ctxScope.id,
      };
      summary = `viewed all memory files (incl. project=${ctxScope.id})`;
    }
    return {
      data: { ok: true, result },
      observation: { status: 'success', summary },
    };
  }

  // view a specific file. USER.md is always global.
  if (file === 'USER.md') {
    return {
      data: { ok: true, result: readMemoryFile(file, harnessHome) },
      observation: { status: 'success', summary: 'viewed USER.md' },
    };
  }

  // MEMORY.md — scope determines which file is read.
  if (effectiveScope === 'project' && ctxScope?.kind === 'project') {
    const read = readProjectMemoryFile(ctxScope.id, harnessHome);
    return {
      data: {
        ok: true,
        result: { ...read, scope: 'project', projectId: ctxScope.id },
      },
      observation: {
        status: 'success',
        summary: `viewed MEMORY.md (scope=project, project=${ctxScope.id})`,
      },
    };
  }

  return {
    data: { ok: true, result: readMemoryFile(file, harnessHome) },
    observation: {
      status: 'success',
      summary: 'viewed MEMORY.md (scope=global)',
    },
  };
}

async function handleReplace(args: {
  file: MemoryFile | undefined;
  content: string | undefined;
  requestedScope: 'global' | 'project' | undefined;
  effectiveScope: EffectiveScope;
  ctxScope: ProjectScope | undefined;
  harnessHome: string;
  ctx: ToolContext;
}): Promise<{
  data: Output;
  observation: {
    status: 'success' | 'error';
    summary: string;
    next_actions?: string[];
    artifacts?: string[];
  };
}> {
  const { file, content, requestedScope, effectiveScope, ctxScope, harnessHome, ctx } = args;

  if (!file) {
    return {
      data: { ok: false, result: { error: 'file is required for action=replace' } },
      observation: {
        status: 'error',
        summary: 'replace requires the `file` argument',
        next_actions: ['set file to "MEMORY.md" or "USER.md" and retry'],
      },
    };
  }
  if (content === undefined) {
    return {
      data: { ok: false, result: { error: 'content is required for action=replace' } },
      observation: {
        status: 'error',
        summary: 'replace requires the `content` argument',
        next_actions: ['provide the full new file body in `content` and retry'],
      },
    };
  }

  // USER.md is always global. If the caller asked for project scope, silently
  // route to global and surface a note in the success summary.
  if (file === 'USER.md') {
    const userScopeNote = requestedScope === 'project';
    const result = replaceMemoryFile(file, content, harnessHome);
    if (result.ok) await ctx.memoryManager?.onMemoryWrite({ file, chars: content.length });
    return buildReplaceResult({
      file,
      result,
      content,
      effectiveScope: 'global',
      userScopeNote,
    });
  }

  // MEMORY.md with project scope but no project context → reject.
  if (effectiveScope === 'project' && ctxScope?.kind !== 'project') {
    return {
      data: {
        ok: false,
        result: {
          error:
            'project scope requires a project context — current session has no bundle or git repo',
        },
      },
      observation: {
        status: 'error',
        summary: 'project scope requires a project context (bundle or git repo) — none detected',
        next_actions: [
          'omit the scope argument to write to global MEMORY.md instead',
          'pass scope:"global" explicitly to write the global file',
          'run sov from a directory inside a git repo or with a bundle to enable project scope',
        ],
      },
    };
  }

  // MEMORY.md with project scope and project context → per-project file.
  if (effectiveScope === 'project' && ctxScope?.kind === 'project') {
    const result = replaceProjectMemoryFile(ctxScope.id, content, harnessHome);
    if (result.ok) {
      await ctx.memoryManager?.onMemoryWrite({
        file,
        chars: content.length,
        scope: 'project',
        projectId: ctxScope.id,
      });
    }
    return buildReplaceResult({
      file,
      result,
      content,
      effectiveScope: 'project',
      projectId: ctxScope.id,
    });
  }

  // MEMORY.md global write.
  const result = replaceMemoryFile(file, content, harnessHome);
  if (result.ok) await ctx.memoryManager?.onMemoryWrite({ file, chars: content.length });
  return buildReplaceResult({ file, result, content, effectiveScope: 'global' });
}

function buildReplaceResult(args: {
  file: MemoryFile;
  result: ReturnType<typeof replaceMemoryFile>;
  content: string;
  effectiveScope: EffectiveScope;
  projectId?: string;
  userScopeNote?: boolean;
}): {
  data: Output;
  observation: {
    status: 'success' | 'error';
    summary: string;
    next_actions?: string[];
    artifacts?: string[];
  };
} {
  const { file, result, content, effectiveScope, projectId, userScopeNote } = args;
  if (!result.ok) {
    return {
      data: { ok: false, result },
      observation: {
        status: 'error',
        summary: `replace ${file} rejected by memory bound`,
        next_actions: [
          'reduce content length below the cap (USER.md=1375, MEMORY.md=2200 chars)',
          'consolidate older entries before adding new ones',
        ],
      },
    };
  }

  const artifact =
    effectiveScope === 'project' && projectId !== undefined
      ? `memory/projects/${projectId}/${file}`
      : `memory/${file}`;

  const baseSummary = userScopeNote
    ? `replaced ${file} (scope=global — USER.md is always global, ${content.length} chars)`
    : effectiveScope === 'project' && projectId !== undefined
      ? `replaced ${file} (scope=project, project=${projectId}, ${content.length} chars)`
      : `replaced ${file} (scope=global, ${content.length} chars)`;

  return {
    data: { ok: true, result },
    observation: {
      status: 'success',
      summary: baseSummary,
      artifacts: [artifact],
    },
  };
}

function affectedPathsFor(input: Input): string[] {
  const file = optionalFile(input.file);
  if (!file) return ['memory'];

  // USER.md always global.
  if (file === 'USER.md') return [`memory/${file}`];

  // MEMORY.md: project scope requires the projectId, but `affectedPaths` runs
  // without a ToolContext — fall back to a generic per-project marker so the
  // permission matcher (which runs basename checks) still resolves on file
  // names. The matcher operates on the basename for `MEMORY.md`-style globs,
  // so this is sufficient for permission resolution.
  if (input.scope === 'project') return [`memory/projects/${file}`];
  return [`memory/${file}`];
}

function optionalFile(file: Input['file']): MemoryFile | undefined {
  return file ? normalizeMemoryFile(file) : undefined;
}

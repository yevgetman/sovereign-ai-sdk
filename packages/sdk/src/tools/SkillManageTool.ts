// Agent-created skill authoring. Writes only to the agent-created skill root
// and runs the Phase 9.5 guard before any content becomes loadable.

import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { FilesystemSkillStore } from '../skills/store.js';
import type { SkillMutationEvent } from '../skills/store.js';
import { buildTool } from '../tool/buildTool.js';
import { matchesPathPermissionPattern } from './permissionMatchers.js';

const SAFE_SKILL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

const inputSchema = z.object({
  action: z.enum(['create', 'edit', 'delete']).describe('Skill mutation to perform.'),
  name: z.string().regex(SAFE_SKILL_NAME_RE, 'must be a slash-command-safe skill name'),
  body: z.string().optional().describe('Markdown body for create/edit.'),
  frontmatter: z.record(z.unknown()).optional().describe('Optional SKILL.md frontmatter fields.'),
  expectedRevision: z
    .string()
    .optional()
    .describe('Required current revision for edit/delete; obtain from create or the host store.'),
});

type Input = z.infer<typeof inputSchema>;

type Output = {
  ok: boolean;
  action: Input['action'];
  name: string;
  path?: string;
  message: string;
  revision?: string;
  event?: SkillMutationEvent;
};

export const SkillManageTool = buildTool<Input, Output>({
  name: 'skill_manage',
  description: () =>
    'Create, edit, or delete an agent-created skill under HARNESS_HOME/skills/agent-created.',
  inputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: async () => ({
    behavior: 'ask',
    reason: 'skill_manage can create, edit, or delete agent-created skill files',
  }),
  affectedPaths: (input) => [`skills/agent-created/${input.name}/SKILL.md`],
  preparePermissionMatcher: async (input) => (pattern) =>
    matchesPathPermissionPattern(`skills/agent-created/${input.name}/SKILL.md`, pattern),
  renderHint: { kind: 'markdown' },
  async call(input, ctx) {
    const store =
      ctx.skillStore ??
      (ctx.harnessHome
        ? new FilesystemSkillStore({ root: join(ctx.harnessHome, 'skills', 'agent-created') })
        : undefined);
    if (!store)
      return {
        data: {
          ok: false,
          action: input.action,
          name: input.name,
          message:
            'An explicit writable skillStore or harnessHome is required; no ambient home was selected.',
        },
      };
    if (input.action !== 'delete' && input.body === undefined) {
      return {
        data: {
          ok: false,
          action: input.action,
          name: input.name,
          message: 'body is required for create/edit.',
        },
      };
    }
    try {
      const result = await store.mutate({
        action: input.action,
        name: input.name,
        ...(input.body !== undefined
          ? { content: renderSkillMarkdown(input.name, input.body, input.frontmatter) }
          : {}),
        ...(input.expectedRevision !== undefined
          ? { expectedRevision: input.expectedRevision }
          : {}),
      });
      // Keep this turn's registry snapshot stable. The host refreshes future
      // snapshots from the durable mutation event, never from a tentative edit.
      try {
        await ctx.onSkillMutation?.(result.event);
      } catch {
        /* Commit succeeded; host diagnostics own refresh failures. */
      }
      return {
        data: {
          ok: true,
          action: input.action,
          name: input.name,
          ...(result.entry?.path ? { path: result.entry.path } : {}),
          ...(result.entry ? { revision: result.entry.revision } : {}),
          event: result.event,
          message: `${input.action === 'create' ? 'Created' : input.action === 'edit' ? 'Edited' : 'Deleted'} agent-created skill '${input.name}'.`,
        },
      };
    } catch (error) {
      return {
        data: {
          ok: false,
          action: input.action,
          name: input.name,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  },
  renderResult: (out) => ({
    content: JSON.stringify(out, null, 2),
    ...(out.ok ? {} : { isError: true }),
  }),
});

function renderSkillMarkdown(
  name: string,
  body: string,
  frontmatter: Record<string, unknown> | undefined,
): string {
  const fm: Record<string, unknown> = { ...(frontmatter ?? {}) };
  fm.name = name;
  if (fm.description === undefined) {
    fm.description = 'Agent-created skill';
  }
  if (fm.whenToUse === undefined) {
    fm.whenToUse = 'Agent-created reusable workflow';
  }
  if (fm.allowedTools === undefined) fm.allowedTools = [];
  return `---\n${stringifyYaml(fm).trimEnd()}\n---\n${body.trimEnd()}\n`;
}

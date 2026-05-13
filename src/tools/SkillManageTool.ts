// Agent-created skill authoring. Writes only to the agent-created skill root
// and runs the Phase 9.5 guard before any content becomes loadable.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { resolveHarnessHome } from '../config/paths.js';
import { formatGuardBlockMessage, guardSkillText } from '../skills/guard.js';
import { loadSkillFromPath } from '../skills/loader.js';
import type { SkillRegistry } from '../skills/types.js';
import { buildTool } from '../tool/buildTool.js';
import { matchesPathPermissionPattern } from './permissionMatchers.js';

const SAFE_SKILL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

const inputSchema = z.object({
  action: z.enum(['create', 'edit', 'delete']).describe('Skill mutation to perform.'),
  name: z.string().regex(SAFE_SKILL_NAME_RE, 'must be a slash-command-safe skill name'),
  body: z.string().optional().describe('Markdown body for create/edit.'),
  frontmatter: z.record(z.unknown()).optional().describe('Optional SKILL.md frontmatter fields.'),
});

type Input = z.infer<typeof inputSchema>;

type Output = {
  ok: boolean;
  action: Input['action'];
  name: string;
  path?: string;
  message: string;
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
    const harnessHome = ctx.harnessHome ?? resolveHarnessHome();
    const skillDir = join(harnessHome, 'skills', 'agent-created', input.name);
    const skillPath = join(skillDir, 'SKILL.md');

    if (input.action === 'delete') {
      await rm(skillDir, { recursive: true, force: true });
      removeSkill(ctx.skills, input.name);
      return {
        data: {
          ok: true,
          action: input.action,
          name: input.name,
          path: skillPath,
          message: `Deleted agent-created skill '${input.name}'.`,
        },
      };
    }

    if (input.body === undefined) {
      return {
        data: {
          ok: false,
          action: input.action,
          name: input.name,
          path: skillPath,
          message: 'body is required for create/edit.',
        },
      };
    }

    const content = renderSkillMarkdown(input.name, input.body, input.frontmatter);
    const guard = guardSkillText(content, 'agent-created');
    if (guard.action !== 'allow') {
      return {
        data: {
          ok: false,
          action: input.action,
          name: input.name,
          path: skillPath,
          message: `${formatGuardBlockMessage(guard)} agent-created critical-tier content is rejected.`,
        },
      };
    }

    await mkdir(skillDir, { recursive: true });
    await writeFile(skillPath, content);
    const loaded = await loadSkillFromPath(skillPath, {
      source: 'agent-created',
      trustTier: 'agent-created',
    });
    if (!loaded) {
      return {
        data: {
          ok: false,
          action: input.action,
          name: input.name,
          path: skillPath,
          message: 'Skill file was written but could not be loaded.',
        },
      };
    }
    upsertSkill(ctx.skills, loaded);
    return {
      data: {
        ok: true,
        action: input.action,
        name: loaded.name,
        path: skillPath,
        message: `${input.action === 'create' ? 'Created' : 'Edited'} agent-created skill '${loaded.name}'.`,
      },
    };
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
  if (typeof fm.description !== 'string' || fm.description.trim() === '') {
    fm.description = 'Agent-created skill';
  }
  if (typeof fm.whenToUse !== 'string') {
    fm.whenToUse = 'Agent-created reusable workflow';
  }
  if (
    !Array.isArray(fm.allowedTools) ||
    !fm.allowedTools.every((value) => typeof value === 'string')
  ) {
    fm.allowedTools = [];
  }
  return `---\n${stringifyYaml(fm).trimEnd()}\n---\n${body.trimEnd()}\n`;
}

function upsertSkill(
  registry: SkillRegistry | undefined,
  skill: SkillRegistry['skills'][number],
): void {
  if (!registry) return;
  const existing = registry.skills.findIndex((candidate) => candidate.name === skill.name);
  if (existing >= 0) registry.skills.splice(existing, 1, skill);
  else registry.skills.push(skill);
  registry.skills.sort((a, b) => a.name.localeCompare(b.name));
  registry.byName.set(skill.name, skill);
}

function removeSkill(registry: SkillRegistry | undefined, name: string): void {
  if (!registry) return;
  registry.skills = registry.skills.filter((skill) => skill.name !== name);
  registry.byName.delete(name);
}

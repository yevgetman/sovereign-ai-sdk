import { getSkillRegistry } from '../skills/registry.js';
// Progressive skill disclosure. Returns the full body for one visible skill,
// or a specific reference file under that skill's directory.

import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { z } from 'zod';
import { resolveSkillResource } from '../skills/activation.js';
import { assertSkillFileIdentity, captureSkillFileIdentity } from '../skills/fileIdentity.js';
import { reloadSkill } from '../skills/loader.js';
import type { Skill } from '../skills/types.js';
import { inferActiveToolsets, isSkillVisible } from '../skills/visibility.js';
import { buildTool } from '../tool/buildTool.js';
import type { ToolContext } from '../tool/types.js';

const inputSchema = z.object({
  name: z.string().min(1).describe('Visible skill name to inspect.'),
  path: z
    .string()
    .optional()
    .describe('Optional path to a reference file under the skill directory.'),
});

type Input = z.infer<typeof inputSchema>;

type Output = {
  skill: string;
  path: string;
  content: string;
};

export const SkillsViewTool = buildTool<Input, Output>({
  name: 'skill_view',
  description: () => 'View a visible skill body, or a reference file inside its skill directory.',
  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  renderHint: { kind: 'markdown' },
  checkPermissions: async () => ({ behavior: 'allow' }),
  affectedPaths: (input) => (input.path ? [input.path] : []),
  async call(input, ctx) {
    const skill = getSkillRegistry(ctx).byName.get(input.name);
    if (!skill) {
      const available =
        getSkillRegistry(ctx)
          .skills.map((s) => s.name)
          .join(', ') || 'none';
      throw new Error(`unknown skill '${input.name}'. Available skills: ${available}`);
    }

    if (ctx.skillRuntime) {
      const inspected = await ctx.skillRuntime.inspect(skill.name, input.path);
      assertCurrentSkillVisible(inspected.skill, input.name, ctx);
      return {
        data: { skill: inspected.skill.name, path: inspected.path, content: inspected.content },
        observation: {
          status: 'success',
          summary: `viewed ${inspected.path} for ${inspected.skill.name}`,
        },
      };
    }
    const current = await reloadSkill(skill);
    assertCurrentSkillVisible(current, input.name, ctx);
    if (!input.path) {
      return {
        data: {
          skill: current.name,
          path: 'SKILL.md',
          content: current.body,
        },
        observation: {
          status: 'success',
          summary: `viewed SKILL.md for ${current.name}`,
          artifacts: [current.path],
        },
      };
    }

    const target = await resolveSkillResource(current, input.path);
    const content = await readBoundedReference(current, input.path, target);
    return {
      data: {
        skill: current.name,
        path: relative(dirname(current.realpath), target),
        content,
      },
      observation: {
        status: 'success',
        summary: `viewed ${relative(dirname(current.realpath), target)} (skill ${current.name})`,
        artifacts: [target],
      },
    };
  },
  renderResult: (out) => ({
    content: [`<skill name="${out.skill}" path="${out.path}">`, out.content, '</skill>'].join('\n'),
  }),
});

/** Keep the fallback tool path safe for hosts without a composed skill runtime.
 * Read an opened regular file within the per-file loader limit, then verify
 * both the opened identity and logical path before exposing any bytes. */
async function readBoundedReference(
  skill: Parameters<typeof resolveSkillResource>[0],
  path: string,
  target: string,
): Promise<string> {
  const maxBytes = 1024 * 1024;
  const identity = await captureSkillFileIdentity(target);
  if (identity.file.size > maxBytes)
    throw new Error('skill reference must be a bounded regular file');
  const handle = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    await assertSkillFileIdentity(target, handle, identity);
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes)
      throw new Error('skill reference must be a bounded regular file');
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error('skill reference exceeds its bounded read limit');
    const current = await stat(target);
    if (
      (await realpath(target)) !== target ||
      (await resolveSkillResource(skill, path)) !== target ||
      current.ino !== info.ino ||
      current.dev !== info.dev
    )
      throw new Error('skill reference path or identity changed while reading');
    await assertSkillFileIdentity(target, handle, identity);
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Reloaded metadata and the current activation pool can differ from the catalog
 * used for lookup. Apply the same visibility floor before disclosing fresh text. */
function assertCurrentSkillVisible(skill: Skill, name: string, ctx: ToolContext): void {
  const names = ctx.skillActivation?.tools.map((tool) => tool.name) ?? ctx.activeToolNames;
  if (
    skill.name !== name ||
    ((names !== undefined || ctx.activeToolsets !== undefined) &&
      !isSkillVisible(
        skill,
        names !== undefined
          ? inferActiveToolsets(names, ctx.activeToolsets)
          : (ctx.activeToolsets ?? []),
        names ?? [],
      ))
  )
    throw new Error(`unknown or unavailable skill '${name}'`);
}

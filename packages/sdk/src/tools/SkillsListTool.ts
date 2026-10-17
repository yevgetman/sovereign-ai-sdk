// Progressive skill discovery. Small catalogs receive a bounded metadata
// index; models search and page the current visible catalog on demand.

import { z } from 'zod';
import { listSkillCatalog } from '../skills/catalog.js';
import { isSkillInvocable } from '../skills/descriptor.js';
import { getSkillRegistrySnapshot } from '../skills/registry.js';
import { buildTool } from '../tool/buildTool.js';

const inputSchema = z.object({
  query: z
    .string()
    .max(256)
    .optional()
    .describe('Optional case-insensitive filter by name, description or trigger.'),
  cursor: z
    .string()
    .max(2048)
    .optional()
    .describe(
      'Continuation from the previous page. Keep the same query; changed catalogs require restart.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Maximum entries per page (default 25; byte budget may return fewer).'),
  detail: z
    .enum(['names', 'summary', 'activation'])
    .optional()
    .describe(
      'Projection: names for enumeration, summary for discovery, activation before selection.',
    ),
});

type Input = z.infer<typeof inputSchema>;

type Output = import('../skills/catalog.js').SkillCatalogPage;

export const SkillsListTool = buildTool<Input, Output>({
  name: 'skills_list',
  description: () =>
    'Search or page every enabled skill. To list all skill names, use detail names and limit 100. Use summary for discovery and activation before selecting a skill. Follow nextCursor with the same query and detail. metadataTruncated means inspect with skill_view; nameFragment segments reconstruct an oversized name. budgetExhausted requires more context headroom.',
  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  renderHint: { kind: 'tree' },
  checkPermissions: async () => ({ behavior: 'allow' }),
  async call(input, ctx) {
    const snapshot = getSkillRegistrySnapshot(ctx);
    const data = listSkillCatalog(
      snapshot.registry.skills.filter((skill) => isSkillInvocable(skill, 'model')),
      {
        generation: snapshot.generation,
        ...(input.query !== undefined ? { query: input.query } : {}),
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        detail: input.detail ?? 'names',
        ...(ctx.skillContextBudget !== undefined ? { budget: ctx.skillContextBudget } : {}),
      },
    );
    const needle = input.query?.trim();
    const { skills, truncated } = data;
    return {
      data,
      observation: data.budgetExhausted
        ? {
            status: 'warning',
            summary: 'skill catalog page exceeds current context budget',
            next_actions: [
              'reduce history or increase the host context allowance, then retry without cursor',
            ],
          }
        : skills.length === 0
          ? {
              status: 'warning',
              summary: needle
                ? `no visible skills matched "${needle}"`
                : 'no visible skills configured',
              next_actions: needle
                ? [
                    'try a broader query, or call without `query` to see the full index',
                    'check that the skill is loaded (look for skill files under .harness/skills/)',
                  ]
                : ['add skills under .harness/skills/ or ~/.harness/skills/ to populate the index'],
            }
          : {
              status: 'success',
              summary: `${skills.length} of ${data.total} matching skills${truncated ? ' (continue with nextCursor)' : ''}`,
              ...(truncated
                ? { next_actions: ['call skills_list with nextCursor and the same query'] }
                : {}),
            },
    };
  },
  renderResult: (out) => ({
    content: JSON.stringify(out),
  }),
});

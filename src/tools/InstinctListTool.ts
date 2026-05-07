// Phase 13.4 — read-only instinct corpus query. Visible only in
// LEARNING_ONLY_TOOLS pool; injected into synthesizer + review-fork
// child pools. Never reaches the main agent.

import { z } from 'zod';
import { InstinctStore } from '../learning/instinctStore.js';
import { type Instinct, InstinctDomainSchema, InstinctScopeSchema } from '../learning/types.js';
import { buildTool } from '../tool/buildTool.js';
import type { Tool } from '../tool/types.js';

const InstinctListInputSchema = z.object({
  project_id: z.string().min(1),
  domain: InstinctDomainSchema.optional(),
  scope: InstinctScopeSchema.optional(),
  min_confidence: z.number().min(0).max(1).optional(),
});

export type InstinctListInput = z.infer<typeof InstinctListInputSchema>;

export const InstinctListTool = buildTool<InstinctListInput, { instincts: Instinct[] }>({
  name: 'instinct_list',
  searchHint: 'Query the instinct corpus by domain / scope / min confidence.',
  description: () =>
    [
      'List instincts for a project (or "_global" for cross-project promoted ones).',
      'Filter by domain, scope, and a minimum confidence threshold.',
      'Read-only; available only to the synthesizer and review-fork sub-agents.',
    ].join(' '),
  inputSchema: InstinctListInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    const home = ctx.harnessHome;
    if (!home) {
      throw new Error('instinct_list: harnessHome not configured in tool context');
    }
    const store = new InstinctStore(home);
    let results = store.list(input.project_id);
    if (input.domain !== undefined) {
      results = results.filter((i) => i.domain === input.domain);
    }
    if (input.scope !== undefined) {
      results = results.filter((i) => i.scope === input.scope);
    }
    if (input.min_confidence !== undefined) {
      const min = input.min_confidence;
      results = results.filter((i) => i.confidence >= min);
    }
    return {
      data: { instincts: results },
      observation: {
        status: 'success',
        summary: `${results.length} instinct(s) match`,
      },
    };
  },
}) as unknown as Tool<unknown, unknown>;

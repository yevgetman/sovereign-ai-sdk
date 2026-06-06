// Phase 13.4 — fetch a single instinct's frontmatter + body. Read-only.

import { z } from 'zod';
import { InstinctStore } from '../learning/instinctStore.js';
import type { Instinct } from '../learning/types.js';
import { buildTool } from '../tool/buildTool.js';
import type { Tool } from '../tool/types.js';

const InstinctViewInputSchema = z.object({
  project_id: z.string().min(1),
  id: z.string().min(1),
});

export type InstinctViewInput = z.infer<typeof InstinctViewInputSchema>;

export const InstinctViewTool = buildTool<InstinctViewInput, { instinct: Instinct; body: string }>({
  name: 'instinct_view',
  searchHint: 'Fetch the full instinct record + evidence body.',
  description: () =>
    [
      'Read a single instinct by id, including its evidence-summary body.',
      'Read-only; available only to the synthesizer and review-fork sub-agents.',
    ].join(' '),
  inputSchema: InstinctViewInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  renderHint: { kind: 'markdown' },
  async call(input, ctx) {
    const home = ctx.harnessHome;
    if (!home) {
      throw new Error('instinct_view: harnessHome not configured in tool context');
    }
    // Phase E T6 — scope reads to the owning principal (matches the write
    // path); undefined → legacy corpus (unchanged).
    const store = new InstinctStore(home, ctx.userId);
    const result = store.readWithBody(input.project_id, input.id);
    return {
      data: result,
      observation: {
        status: 'success',
        summary: `${result.instinct.id} — confidence ${result.instinct.confidence}`,
      },
    };
  },
}) as unknown as Tool<unknown, unknown>;

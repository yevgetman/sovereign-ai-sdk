// Phase 13.4 — synthesizer-only tool to create a new instinct. The
// initial confidence comes from confidenceFromEvidence(evidence_count) —
// an absolute saturating curve over total supporting evidence; there's
// no "manual confidence" path. All confidence math flows through the
// pure functions in src/learning/confidence.ts.

import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { confidenceFromEvidence } from '../learning/confidence.js';
import { InstinctStore } from '../learning/instinctStore.js';
import { loadConfidenceTuning } from '../learning/tuning.js';
import { type Instinct, InstinctDomainSchema, InstinctScopeSchema } from '../learning/types.js';
import { buildTool } from '../tool/buildTool.js';
import type { Tool } from '../tool/types.js';

const InstinctProposeInputSchema = z.object({
  trigger: z.string().min(1),
  action: z.string().min(1),
  evidence_count: z.number().int().positive(),
  domain: InstinctDomainSchema,
  scope: InstinctScopeSchema,
  project_id: z.string().nullable(),
  project_name: z.string().nullable(),
  observation_ids: z.array(z.string()).max(10),
  body: z.string().optional(),
});

export type InstinctProposeInput = z.infer<typeof InstinctProposeInputSchema>;

function newInstinctId(): string {
  // Sortable timestamp prefix + short random suffix. Avoids pulling in a
  // ulid package — keeps deps minimal while preserving lexical sort order.
  const date = new Date()
    .toISOString()
    .replace(/[-:T.Z]/g, '')
    .slice(0, 14);
  return `${date}-${randomBytes(6).toString('hex')}`;
}

export const InstinctProposeTool = buildTool<InstinctProposeInput, { instinct: Instinct }>({
  name: 'instinct_propose',
  searchHint: 'Create a new instinct from a cluster of supporting observations.',
  description: () =>
    [
      'Propose a new instinct: a small, evidence-backed learned behavior with confidence.',
      'Synthesizer-only — main agents and review forks cannot call this.',
      'Initial confidence is computed from evidence_count via the saturating evidence curve.',
    ].join(' '),
  inputSchema: InstinctProposeInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  renderHint: { kind: 'markdown' },
  async call(input, ctx) {
    const home = ctx.harnessHome;
    if (!home) {
      throw new Error('instinct_propose: harnessHome not configured in tool context');
    }
    if (input.scope === 'project' && input.project_id === null) {
      throw new Error('instinct_propose: project-scoped instincts require a non-null project_id');
    }
    const now = new Date().toISOString();
    const tuning = loadConfidenceTuning();
    const instinct: Instinct = {
      id: newInstinctId(),
      trigger: input.trigger,
      action: input.action,
      confidence: confidenceFromEvidence(input.evidence_count, tuning),
      evidence_count: input.evidence_count,
      domain: input.domain,
      scope: input.scope,
      project_id: input.project_id,
      project_name: input.project_name,
      created_at: now,
      last_evidence_at: now,
      observation_ids: input.observation_ids,
    };
    // Phase E T6 — scope the synthesized instinct to the owning principal.
    // ctx.userId rides the per-session ToolContext (spread to this synthesizer
    // child by the scheduler); undefined keeps the legacy top-level corpus.
    const store = new InstinctStore(home, ctx.userId);
    store.write(instinct, input.body ?? defaultBody(instinct));
    return {
      data: { instinct },
      observation: {
        status: 'success',
        summary: `proposed instinct ${instinct.id} (confidence ${instinct.confidence})`,
        artifacts: [`instinct:${instinct.id}`],
      },
    };
  },
}) as unknown as Tool<unknown, unknown>;

function defaultBody(instinct: Instinct): string {
  return [
    `# ${instinct.trigger} — ${instinct.action}`,
    '',
    '## Evidence summary',
    `${instinct.evidence_count} observations supporting this instinct.`,
    '',
    '## Earliest evidence',
    instinct.observation_ids
      .slice(0, 5)
      .map((id) => `- ${id}`)
      .join('\n'),
    '',
  ].join('\n');
}

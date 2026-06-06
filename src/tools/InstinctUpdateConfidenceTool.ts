// Phase 13.4 — synthesizer-only tool to apply reinforcement or
// contradiction to an existing instinct. All confidence math flows
// through the pure functions in src/learning/confidence.ts.

import { z } from 'zod';
import { confidenceFromEvidence, contradict } from '../learning/confidence.js';
import { InstinctStore } from '../learning/instinctStore.js';
import { loadConfidenceTuning } from '../learning/tuning.js';
import type { Instinct } from '../learning/types.js';
import { buildTool } from '../tool/buildTool.js';
import type { Tool } from '../tool/types.js';

const InstinctUpdateConfidenceInputSchema = z.object({
  id: z.string().min(1),
  project_id: z.string().min(1),
  action: z.enum(['reinforce', 'contradict']),
  evidence_count: z.number().int().nonnegative().optional(),
  reason: z.string().min(1),
});

export type InstinctUpdateConfidenceInput = z.infer<typeof InstinctUpdateConfidenceInputSchema>;

export const InstinctUpdateConfidenceTool = buildTool<
  InstinctUpdateConfidenceInput,
  { instinct: Instinct; previousConfidence: number }
>({
  name: 'instinct_update_confidence',
  searchHint: 'Apply reinforcement or contradiction to an existing instinct.',
  description: () =>
    [
      "Update an instinct's confidence — reinforce on supporting evidence, contradict on rejection.",
      'Synthesizer-only — main agents and review forks cannot call this.',
      'All math flows through the pure reinforce / contradict functions; no manual confidence overrides.',
    ].join(' '),
  inputSchema: InstinctUpdateConfidenceInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  renderHint: { kind: 'text' },
  async call(input, ctx) {
    const home = ctx.harnessHome;
    if (!home) {
      throw new Error('instinct_update_confidence: harnessHome not configured in tool context');
    }
    // Phase E T6 — scope read+write to the owning principal (matches the
    // synthesizer write path); undefined → legacy corpus (unchanged).
    const store = new InstinctStore(home, ctx.userId);
    const { instinct: prior, body } = store.readWithBody(input.project_id, input.id);
    const evidenceWeight = input.evidence_count ?? 1;
    const tuning = loadConfidenceTuning();
    // Reinforce: confidence is an absolute saturating function of the new
    // TOTAL supporting evidence — not an incremental bump from the prior
    // value (that curve was structurally too flat to ever promote).
    // Contradict: unchanged sharp drop from the prior confidence.
    const nextEvidenceCount =
      input.action === 'reinforce' ? prior.evidence_count + evidenceWeight : prior.evidence_count;
    const nextConfidence =
      input.action === 'reinforce'
        ? confidenceFromEvidence(nextEvidenceCount, tuning)
        : contradict(prior.confidence, evidenceWeight, tuning);
    const updated: Instinct = {
      ...prior,
      confidence: nextConfidence,
      evidence_count: nextEvidenceCount,
      last_evidence_at: new Date().toISOString(),
    };
    store.write(updated, body);
    return {
      data: { instinct: updated, previousConfidence: prior.confidence },
      observation: {
        status: 'success',
        summary: `${input.action} ${input.id}: ${prior.confidence} → ${updated.confidence}`,
      },
    };
  },
}) as unknown as Tool<unknown, unknown>;

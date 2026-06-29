// src/learning/types.ts
// Phase 13.4 — types and Zod schemas for the observation stream and
// instinct corpus.

import { z } from 'zod';
import { type ObservationStatus, ObservationStatusSchema } from '../core/observePort.js';

// `ObservationStatus` + its defining enum `ObservationStatusSchema` now live in
// the open core (`core/observePort.js`). Imported for local use (ObservationSchema
// below) and re-exported so existing learning importers keep their path unchanged.
export { ObservationStatusSchema };
export type { ObservationStatus };

export const ObservationSchema = z
  .object({
    id: z.string(),
    ts: z.string(),
    project_id: z.string(),
    project_name: z.string(),
    session_id: z.string(),
    tool_name: z.string(),
    tool_input_hash: z.string(),
    tool_input_summary: z.string().max(256),
    status: ObservationStatusSchema,
    duration_ms: z.number().nonnegative(),
    observation_envelope: z
      .object({
        status: z.enum(['success', 'warning', 'error']),
        summary: z.string(),
      })
      .strict()
      .optional(),
    trace_id: z.string().optional(),
  })
  .strict();
export type Observation = z.infer<typeof ObservationSchema>;

export const InstinctDomainSchema = z.enum([
  'code-style',
  'testing',
  'git',
  'debugging',
  'workflow',
  'tooling',
]);
export type InstinctDomain = z.infer<typeof InstinctDomainSchema>;

export const InstinctScopeSchema = z.enum(['project', 'global']);
export type InstinctScope = z.infer<typeof InstinctScopeSchema>;

export const InstinctSchema = z
  .object({
    id: z.string(),
    trigger: z.string().min(1),
    action: z.string().min(1),
    confidence: z.number().min(0).max(1),
    evidence_count: z.number().int().nonnegative(),
    domain: InstinctDomainSchema,
    scope: InstinctScopeSchema,
    project_id: z.string().nullable(),
    project_name: z.string().nullable(),
    created_at: z.string(),
    last_evidence_at: z.string(),
    observation_ids: z.array(z.string()),
  })
  .strict();
export type Instinct = z.infer<typeof InstinctSchema>;

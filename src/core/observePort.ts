// src/core/observePort.ts — open-core observe-port types.
//
// `ObserveInput` is the per-tool-call argument an observer records, and
// `ObservationStatus` is referenced by open core (orchestrator.ts) — so they and
// their minimal closure (`ObservationStatusSchema`, the enum that defines
// `ObservationStatus`) live in the open core. The proprietary learning layer
// re-exports them, inverting the dependency so open core never imports from
// proprietary code.

import { z } from 'zod';

export const ObservationStatusSchema = z.enum(['success', 'error', 'denied', 'cancelled']);
export type ObservationStatus = z.infer<typeof ObservationStatusSchema>;

export interface ObserveInput {
  toolName: string;
  toolInput: unknown;
  status: ObservationStatus;
  durationMs: number;
  observationEnvelope?: { status: 'success' | 'warning' | 'error'; summary: string };
  traceId?: string;
}

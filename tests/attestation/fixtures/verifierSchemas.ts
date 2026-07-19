// tests/attestation/fixtures/verifierSchemas.ts — the decorum-verify evidence
// contract, COPIED into this repo as a test fixture (attestation evidence, spec
// 2026-07-19-gateway-attestation-evidence-design.md §1/§3.4, plan T3).
//
// COPIED, NOT IMPORTED — deliberately. The verifier repo (~/code/decorum-verify,
// src/evidence/schemas.ts) is an INDEPENDENT auditor; importing it here would
// make sov a build-time dependent of the tool that audits it and would let a
// verifier-side refactor silently rewrite what these tests assert. The copy
// below is byte-faithful to the verifier's `ObservedTurnSchema` as of
// 2026-07-19; if the verifier contract ever changes, this fixture must be
// re-synced DELIBERATELY (and the writer re-verified against it).
//
// The records/manifest streams are NOT copied here: decorum-verify validates
// those against decorum's OWN exported `.strict()` schemas
// (`DecisionRecordSchema` / `AttestationManifestSchema`), which the root
// package legitimately depends on — the tests import those from
// '@yevgetman/decorum' directly, so they can never drift from the engine.

import { z } from 'zod';

/** One observed turn, as the verifier's live shell reads it from `io.jsonl`
 *  (decorum-verify spec §4.1): `{ sessionId, turnId?, input?, candidate?,
 *  delivered?, vars? }`. `.strict()` everywhere — an unrecognized key is a
 *  fail-closed defect in the verifier's intake, so ONE extra key written by the
 *  gateway fails a whole audit to INCOMPLETE. */
export const ObservedTurnSchema = z
  .object({
    sessionId: z.string(),
    turnId: z.string().optional(),
    input: z.string().optional(),
    candidate: z.string().optional(),
    delivered: z.string().optional(),
    vars: z
      .object({
        surface: z.enum(['user', 'internal']).optional(),
        model: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ObservedTurnFixture = z.infer<typeof ObservedTurnSchema>;

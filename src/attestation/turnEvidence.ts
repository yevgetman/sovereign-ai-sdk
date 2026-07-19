// src/attestation/turnEvidence.ts — the host-side turn-evidence coordinator
// (attestation evidence, spec 2026-07-19-gateway-attestation-evidence-design.md
// §3.3/§3.4, plan T4). Two jobs:
//
//   1. HOST TURN IDENTITY (§3.3). `beginTurn` mints one fresh turnId per drive
//      (the gateway calls it once per runOnce invocation — the compaction-pivot
//      second hop mints its OWN id) and, in io mode, registers it under the
//      sessionId the drive runs as. That (sessionId, turnId) pair is the
//      verifier's INJECTIVE records↔io join key, so registration must happen
//      with the post-pivot sessionId — the one decorum's DecisionRecords will
//      carry — never the pre-compaction parent.
//
//   2. THE ONE-ROW-PER-MINTED-TURNID INVARIANT (§3.4). A turn that reaches
//      terminal emits exactly one ConductEvidenceEvent through the SDK's
//      evidenceSink seam — the coordinator writes its io row (final-attempt
//      candidate/delivered pair + gate input) and settles the registration. A
//      turn that aborts undelivered (abandoned / rethrown) never emits; the
//      gateway's finally block calls `endTurn` for every minted id, and the
//      coordinator BACKFILLS a row with `delivered` OMITTED — never '' (the
//      verifier counts '' as a completed turn). Either way every minted turnId
//      ends with EXACTLY one row: no orphan DecisionRecord (the verifier's
//      completeness floor fails closed on orphans) and no duplicate
//      (sessionId, turnId) row (duplicate observed rows are ambiguous evidence
//      — the verifier also fails those closed).
//
// The registry is settle-once by construction: an entry is REMOVED when its
// row is written (by whichever of sink/endTurn fires first), so the losing
// path finds nothing and writes nothing. Unknown/absent turnIds on a sink
// event are dropped — a row the host cannot attribute to a minted turn would
// be manufactured evidence.
//
// FAILURE POSTURE (§3.5): evidence is observation and fails OPEN. The sink and
// endTurn never throw to callers (the writer is itself no-throw; the guard
// here is belt-and-suspenders for a stubbed/foreign writer).
//
// `withEvidenceSink` is the boot-time provider wrapper: the SDK reads
// `evidenceSink` off the mounted ConductProvider, and the engine's provider
// (decorum) neither knows nor carries the field — the HOST attaches it. The
// wrapper mirrors the base provider's capability PRESENCE exactly (the SDK
// seams key on presence — forging an absent capability would change seam
// behavior) and delegates calls verbatim; the base object is never mutated.

import { randomUUID } from 'node:crypto';
import type {
  ConductContext,
  ConductEvidenceEvent,
  ConductProvider,
} from '@yevgetman/sov-sdk/core/conductPort';
import type { AttestationWriter, ObservedTurnVars } from './writer.js';

/** The io surface the coordinator needs — structurally `AttestationWriter`'s
 *  `recordIo`, kept narrow so unit tests can hand in a capture stub. */
export type IoEvidenceWriter = Pick<AttestationWriter, 'recordIo'>;

/** One pending (minted, not yet settled) turn registration. */
type PendingTurn = {
  readonly sessionId: string;
  readonly vars?: ObservedTurnVars;
};

/** The host-side turn-evidence coordinator handle. Constructed once at gateway
 *  boot (per AttestationWriter) when `conduct.attestation.enabled`; threaded to
 *  the turns route via `Runtime.attestationEvidence`. */
export type TurnEvidence = {
  /** Mint + (io mode) register ONE fresh host turnId for one drive running as
   *  `sessionId`. Call once per drive — a compaction-pivot re-drive mints its
   *  own — and thread the returned id VERBATIM into `PerTurn.turnId` so the
   *  same id rides every conduct capability call of the drive (all-or-none;
   *  decorum stamps `turnIdSource:'host'`). `vars` mirror the ConductContext
   *  the hooks see (surface/model) for the verifier's CEL guards. */
  beginTurn(sessionId: string, vars?: ObservedTurnVars): string;
  /** Settle a minted turnId. No-op when the sink already wrote the row; for a
   *  turn that aborted undelivered, backfills the row (`delivered` OMITTED).
   *  Call for EVERY minted id on every exit path (the gateway's finally). */
  endTurn(turnId: string): void;
  /** Settle EVERY still-pending minted turnId (review fix wave) — the
   *  graceful-shutdown sweep. The gateway stops the server while background
   *  turn drives may still be mid-flight; their DecisionRecords are already
   *  enqueued, so an unsettled id would strand them as floor-B orphans
   *  (INCOMPLETE forever). Call BEFORE `AttestationWriter.close()` (a row
   *  recorded after close is dropped). Idempotent; never throws; a late sink
   *  event for a swept id writes nothing (settle-once). */
  settleAll(): void;
  /** The provider-mounted observed-io sink (SDK `ConductProvider.evidenceSink`).
   *  Present ONLY in io mode — records-only attestation captures no turn text,
   *  so the provider is mounted unwrapped and this stays undefined. */
  readonly evidenceSink?: (event: ConductEvidenceEvent) => void;
};

/**
 * Build the coordinator over the boot-constructed writer. `io: false`
 * (records-only attestation) still mints host turnIds — decorum needs them to
 * stamp `turnIdSource:'host'` on records — but exposes no sink and writes no
 * rows (io.jsonl must not exist unless `conduct.attestation.io` is on).
 */
export function createTurnEvidence(opts: {
  writer: IoEvidenceWriter;
  io: boolean;
}): TurnEvidence {
  const { writer, io } = opts;
  /** Minted-but-unsettled turns, keyed by turnId. Entries leave the map when
   *  their row is written (settle-once); `endTurn` on every exit path keeps
   *  the map from growing beyond in-flight turns. */
  const pending = new Map<string, PendingTurn>();

  const beginTurn = (sessionId: string, vars?: ObservedTurnVars): string => {
    const turnId = randomUUID();
    if (io) {
      pending.set(turnId, { sessionId, ...(vars !== undefined ? { vars } : {}) });
    }
    return turnId;
  };

  const endTurn = (turnId: string): void => {
    const entry = pending.get(turnId);
    if (entry === undefined) return; // already settled by the sink (or io off)
    pending.delete(turnId);
    try {
      // Backfill: the drive unwound before terminal, so nothing was observed
      // beyond the turn's existence. `delivered` (and input/candidate) are
      // OMITTED — never '' — so the turn reads honestly as undelivered.
      writer.recordIo({
        sessionId: entry.sessionId,
        turnId,
        ...(entry.vars !== undefined ? { vars: entry.vars } : {}),
      });
    } catch {
      // Evidence is an observer; never propagate (§3.5).
    }
  };

  const settleAll = (): void => {
    // Snapshot the keys first — endTurn deletes from the map it iterates.
    for (const turnId of [...pending.keys()]) {
      endTurn(turnId);
    }
  };

  if (!io) return { beginTurn, endTurn, settleAll };

  const evidenceSink = (event: ConductEvidenceEvent): void => {
    try {
      const turnId = event.turnId;
      if (turnId === undefined) return; // unattributable — never manufacture a row
      const entry = pending.get(turnId);
      if (entry === undefined) return; // unknown id, or already settled (dup event)
      pending.delete(turnId);
      // Fields are picked BY NAME off the event and omitted when unobserved
      // (the writer re-enforces the same discipline + applies the secrets
      // redactor before serialization).
      writer.recordIo({
        sessionId: entry.sessionId,
        turnId,
        ...(event.input !== undefined ? { input: event.input } : {}),
        ...(event.candidate !== undefined ? { candidate: event.candidate } : {}),
        ...(event.delivered !== undefined ? { delivered: event.delivered } : {}),
        ...(entry.vars !== undefined ? { vars: entry.vars } : {}),
      });
    } catch {
      // Evidence is an observer; never propagate (§3.5).
    }
  };

  return { beginTurn, endTurn, settleAll, evidenceSink };
}

/**
 * Wrap a ConductProvider with a host-attached `evidenceSink`, delegating every
 * capability the base actually has and forging NONE it lacks. The base object
 * is never mutated (decorum's provider is not the host's to extend), and
 * `outputGuard` passes through BY REFERENCE so the guard's own method binding
 * (`guard.onFinal(...)`) is untouched.
 */
export function withEvidenceSink(
  base: ConductProvider,
  evidenceSink: (event: ConductEvidenceEvent) => void,
): ConductProvider {
  return {
    ...(base.personaSegments !== undefined
      ? { personaSegments: (ctx: ConductContext) => base.personaSegments?.(ctx) ?? [] }
      : {}),
    ...(base.preGate !== undefined
      ? {
          preGate: (finalUserText: string, ctx: ConductContext) =>
            base.preGate?.(finalUserText, ctx) ?? { action: 'allow' as const },
        }
      : {}),
    ...(base.triage !== undefined
      ? {
          triage: (finalUserText: string, ctx: ConductContext) =>
            base.triage?.(finalUserText, ctx) ?? { genuine: true },
        }
      : {}),
    ...(base.toolPolicy !== undefined
      ? {
          toolPolicy: (toolName: string, input: unknown, ctx: ConductContext) =>
            base.toolPolicy?.(toolName, input, ctx) ?? { behavior: 'allow' as const },
        }
      : {}),
    ...(base.outputGuard !== undefined ? { outputGuard: base.outputGuard } : {}),
    ...(base.allowPerTurnInstructions !== undefined
      ? {
          allowPerTurnInstructions: (ctx: ConductContext) =>
            base.allowPerTurnInstructions?.(ctx) ?? true,
        }
      : {}),
    ...(base.auditSink !== undefined
      ? {
          auditSink: (event: Parameters<NonNullable<ConductProvider['auditSink']>>[0]) =>
            base.auditSink?.(event),
        }
      : {}),
    evidenceSink,
  };
}

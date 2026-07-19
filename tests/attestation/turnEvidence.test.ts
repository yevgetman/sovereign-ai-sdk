// tests/attestation/turnEvidence.test.ts — the host-side turn-evidence
// coordinator (attestation evidence, spec 2026-07-19 §3.3/§3.4, plan T4).
//
// The coordinator owns the ONE-ROW-PER-MINTED-TURNID invariant the verifier's
// completeness floor depends on:
//   - beginTurn mints a fresh host turnId per drive and (io mode) registers it
//     under the sessionId the drive runs as — the records↔io JOIN key;
//   - the evidenceSink writes the row for a turn that reached terminal
//     (final-attempt pair) and settles the registration;
//   - endTurn BACKFILLS a row for a turn whose sink never fired (abandoned /
//     rethrown), with `delivered` OMITTED — never '' — so an undelivered turn
//     reads honestly as undelivered;
//   - between them, EVERY minted turnId gets exactly one row: no orphan
//     DecisionRecord, no duplicate (sessionId, turnId) row (both fail a
//     verify-audit closed).
//
// withEvidenceSink is the boot-time provider wrapper: it must mirror the base
// provider's capability PRESENCE exactly (the SDK's seams key on presence),
// delegate calls verbatim, attach the sink, and never mutate the base.

import { describe, expect, test } from 'bun:test';
import type {
  ConductContext,
  ConductProvider,
  PreGateVerdict,
} from '@yevgetman/sov-sdk/core/conductPort';
import {
  type IoEvidenceWriter,
  createTurnEvidence,
  withEvidenceSink,
} from '../../src/attestation/turnEvidence.js';
import type { ObservedTurnRow } from '../../src/attestation/writer.js';
import { ObservedTurnSchema } from './fixtures/verifierSchemas.js';

/** Capture-only stand-in for the AttestationWriter's io surface. */
function captureWriter(): { rows: ObservedTurnRow[]; writer: IoEvidenceWriter } {
  const rows: ObservedTurnRow[] = [];
  return { rows, writer: { recordIo: (row) => rows.push(row) } };
}

const VARS = { surface: 'user', model: 'mock-haiku' } as const;

describe('createTurnEvidence — the one-row-per-minted-turnId ledger', () => {
  test('beginTurn mints a fresh UUID per drive (never reused across hops)', () => {
    const { writer } = captureWriter();
    const evidence = createTurnEvidence({ writer, io: true });
    const first = evidence.beginTurn('sess-1', VARS);
    const second = evidence.beginTurn('sess-1', VARS);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toMatch(/^[0-9a-f-]{36}$/);
    expect(first).not.toBe(second);
  });

  test('sink event for a minted turn writes ONE row with the registered sessionId + event fields', () => {
    const { rows, writer } = captureWriter();
    const evidence = createTurnEvidence({ writer, io: true });
    const turnId = evidence.beginTurn('sess-1', VARS);
    expect(evidence.evidenceSink).toBeDefined();
    evidence.evidenceSink?.({ turnId, input: 'hi', candidate: 'draft', delivered: 'final' });
    // endTurn afterwards must be a no-op — the row already exists.
    evidence.endTurn(turnId);
    expect(rows).toEqual([
      {
        sessionId: 'sess-1',
        turnId,
        input: 'hi',
        candidate: 'draft',
        delivered: 'final',
        vars: VARS,
      },
    ]);
  });

  test('unobserved event fields are OMITTED on the row — never empty strings', () => {
    const { rows, writer } = captureWriter();
    const evidence = createTurnEvidence({ writer, io: true });
    const turnId = evidence.beginTurn('sess-1', VARS);
    // An error-terminal turn: the sink fires but nothing was gated/delivered.
    evidence.evidenceSink?.({ turnId });
    evidence.endTurn(turnId);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) throw new Error('expected a row');
    expect(Object.keys(row).sort()).toEqual(['sessionId', 'turnId', 'vars']);
    expect('delivered' in row).toBe(false);
    expect('candidate' in row).toBe(false);
    expect('input' in row).toBe(false);
  });

  test('ABANDONED turn: endTurn without a sink event backfills exactly one row, delivered OMITTED', () => {
    const { rows, writer } = captureWriter();
    const evidence = createTurnEvidence({ writer, io: true });
    const turnId = evidence.beginTurn('sess-9', VARS);
    // The drive unwound before terminal — the SDK never emitted. The host
    // settles the minted id: the backfill row is what keeps every
    // DecisionRecord of this turn joinable (no orphan, verifier floor B).
    evidence.endTurn(turnId);
    expect(rows).toEqual([{ sessionId: 'sess-9', turnId, vars: VARS }]);
    const row = rows[0];
    if (row === undefined) throw new Error('expected a row');
    expect('delivered' in row).toBe(false);
    // Settled means settled: a second endTurn writes nothing more.
    evidence.endTurn(turnId);
    expect(rows).toHaveLength(1);
  });

  test('duplicate sink events for one turnId collapse to ONE row (dup (sessionId,turnId) fails an audit)', () => {
    const { rows, writer } = captureWriter();
    const evidence = createTurnEvidence({ writer, io: true });
    const turnId = evidence.beginTurn('sess-1', VARS);
    evidence.evidenceSink?.({ turnId, delivered: 'first' });
    evidence.evidenceSink?.({ turnId, delivered: 'second' });
    evidence.endTurn(turnId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.delivered).toBe('first');
  });

  test('sink events with an unknown or absent turnId write NOTHING (never an unattributable row)', () => {
    const { rows, writer } = captureWriter();
    const evidence = createTurnEvidence({ writer, io: true });
    const turnId = evidence.beginTurn('sess-1', VARS);
    evidence.evidenceSink?.({ turnId: 'not-minted-here', delivered: 'x' });
    evidence.evidenceSink?.({ delivered: 'y' });
    expect(rows).toHaveLength(0);
    // The minted turn still settles honestly via backfill.
    evidence.endTurn(turnId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.turnId).toBe(turnId);
  });

  test('interleaved concurrent turns attribute rows to their OWN sessionIds', () => {
    const { rows, writer } = captureWriter();
    const evidence = createTurnEvidence({ writer, io: true });
    const turnA = evidence.beginTurn('sess-A', VARS);
    const turnB = evidence.beginTurn('sess-B', VARS);
    evidence.evidenceSink?.({ turnId: turnB, delivered: 'reply B' });
    evidence.evidenceSink?.({ turnId: turnA, delivered: 'reply A' });
    evidence.endTurn(turnA);
    evidence.endTurn(turnB);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.turnId === turnA)?.sessionId).toBe('sess-A');
    expect(rows.find((r) => r.turnId === turnB)?.sessionId).toBe('sess-B');
  });

  test('io:false — turnIds still mint (host identity for records) but NO sink and NO rows', () => {
    const { rows, writer } = captureWriter();
    const evidence = createTurnEvidence({ writer, io: false });
    expect(evidence.evidenceSink).toBeUndefined();
    const turnId = evidence.beginTurn('sess-1', VARS);
    expect(turnId).toMatch(/^[0-9a-f-]{36}$/);
    evidence.endTurn(turnId);
    expect(rows).toHaveLength(0);
  });

  test('vars are optional: a begin without vars yields rows without a vars key', () => {
    const { rows, writer } = captureWriter();
    const evidence = createTurnEvidence({ writer, io: true });
    const turnId = evidence.beginTurn('sess-1');
    evidence.endTurn(turnId);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) throw new Error('expected a row');
    expect('vars' in row).toBe(false);
  });

  test('rows survive the verifier ObservedTurn .strict() contract (no extra keys, ever)', () => {
    const { rows, writer } = captureWriter();
    const evidence = createTurnEvidence({ writer, io: true });
    const full = evidence.beginTurn('sess-1', VARS);
    evidence.evidenceSink?.({ turnId: full, input: 'q', candidate: 'c', delivered: 'd' });
    const abandoned = evidence.beginTurn('sess-1', VARS);
    evidence.endTurn(full);
    evidence.endTurn(abandoned);
    for (const row of rows) {
      expect(() => ObservedTurnSchema.parse(row)).not.toThrow();
    }
  });

  test('evidence fails OPEN: a throwing writer never propagates out of the sink or endTurn', () => {
    const boom: IoEvidenceWriter = {
      recordIo: () => {
        throw new Error('disk died');
      },
    };
    const evidence = createTurnEvidence({ writer: boom, io: true });
    const turnId = evidence.beginTurn('sess-1', VARS);
    expect(() => evidence.evidenceSink?.({ turnId, delivered: 'x' })).not.toThrow();
    const second = evidence.beginTurn('sess-1', VARS);
    expect(() => evidence.endTurn(second)).not.toThrow();
  });
});

describe('settleAll — graceful-shutdown sweep (review fix wave)', () => {
  test('settles EVERY still-pending minted turnId with a delivered-omitted backfill row', () => {
    // The gateway's shutdown path stops the server while runTurnInBackground
    // drives may still be mid-flight; their records are already on disk, so
    // leaving their minted ids unsettled would strand them as floor-B orphans
    // (INCOMPLETE forever). settleAll is the pre-close sweep.
    const { rows, writer } = captureWriter();
    const evidence = createTurnEvidence({ writer, io: true });
    const settled = evidence.beginTurn('sess-1', VARS);
    evidence.evidenceSink?.({ turnId: settled, delivered: 'done' });
    const inflightA = evidence.beginTurn('sess-1', VARS);
    const inflightB = evidence.beginTurn('sess-2', VARS);

    evidence.settleAll();

    expect(rows).toHaveLength(3);
    const rowA = rows.find((r) => r.turnId === inflightA);
    const rowB = rows.find((r) => r.turnId === inflightB);
    expect(rowA?.sessionId).toBe('sess-1');
    expect(rowB?.sessionId).toBe('sess-2');
    // In-flight turns read honestly as undelivered: `delivered` OMITTED.
    if (rowA === undefined || rowB === undefined) throw new Error('missing backfill rows');
    expect('delivered' in rowA).toBe(false);
    expect('delivered' in rowB).toBe(false);
  });

  test('idempotent, and a late sink event after settleAll writes NOTHING (no duplicate rows)', () => {
    const { rows, writer } = captureWriter();
    const evidence = createTurnEvidence({ writer, io: true });
    const turnId = evidence.beginTurn('sess-1', VARS);
    evidence.settleAll();
    evidence.settleAll();
    expect(rows).toHaveLength(1);
    // The in-flight drive's sink fires after the sweep (single-threaded, but
    // the turn's async continuation can still run before process.exit): the
    // registration is gone, so no second (sessionId, turnId) row appears.
    evidence.evidenceSink?.({ turnId, delivered: 'late' });
    expect(rows).toHaveLength(1);
  });

  test('io:false — settleAll is a no-op (nothing pending, no rows)', () => {
    const { rows, writer } = captureWriter();
    const evidence = createTurnEvidence({ writer, io: false });
    evidence.beginTurn('sess-1', VARS);
    expect(() => evidence.settleAll()).not.toThrow();
    expect(rows).toHaveLength(0);
  });
});

describe('withEvidenceSink — boot-time provider wrapper', () => {
  test('mirrors capability PRESENCE exactly and delegates calls verbatim', async () => {
    const seen: Array<[string, ConductContext]> = [];
    const base: ConductProvider = {
      preGate: (text: string, ctx: ConductContext): PreGateVerdict => {
        seen.push([text, ctx]);
        return { action: 'rewrite', text: 'rewritten' };
      },
      outputGuard: { onFinal: () => ({ action: 'pass' }) },
      allowPerTurnInstructions: () => false,
      auditSink: () => {},
    };
    const sink = (): void => {};
    const wrapped = withEvidenceSink(base, sink);
    // Present on the base ⇒ present (and delegating) on the wrapper.
    expect(typeof wrapped.preGate).toBe('function');
    expect(wrapped.outputGuard).toBe(base.outputGuard);
    expect(typeof wrapped.allowPerTurnInstructions).toBe('function');
    expect(typeof wrapped.auditSink).toBe('function');
    // Absent on the base ⇒ ABSENT on the wrapper (the SDK seams key on
    // presence; forging a capability would change seam behavior).
    expect(wrapped.personaSegments).toBeUndefined();
    expect(wrapped.triage).toBeUndefined();
    expect(wrapped.toolPolicy).toBeUndefined();
    // The sink is attached; the BASE is never mutated.
    expect(wrapped.evidenceSink).toBe(sink);
    expect(base.evidenceSink).toBeUndefined();
    // Delegation is verbatim: same args in, same verdict out.
    const ctx: ConductContext = {
      sessionId: 's',
      surface: 'user',
      model: 'm',
      providerName: 'p',
      turnId: 't-1',
    };
    const verdict = await wrapped.preGate?.('hello', ctx);
    expect(verdict).toEqual({ action: 'rewrite', text: 'rewritten' });
    expect(seen).toEqual([['hello', ctx]]);
  });

  test('a bare base provider wraps to evidenceSink-only', () => {
    const sink = (): void => {};
    const wrapped = withEvidenceSink({}, sink);
    expect(Object.keys(wrapped)).toEqual(['evidenceSink']);
    expect(wrapped.evidenceSink).toBe(sink);
  });
});

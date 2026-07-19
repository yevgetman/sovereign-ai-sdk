// Fix wave (review finding, 2026-07-19 attestation evidence) — host turn
// identity on the CRON drive surface.
//
// The gateway's cron wiring binds `runtime.conduct` — the SAME provider
// instance carrying the boot-wired attestationSink — so a scheduled turn's
// DecisionRecords land in `<sessionId>.records.jsonl`. Pre-fix, the cron drive
// never minted a host turnId (beginTurn's only caller was the turns route) and
// never settled one, so those records persisted `turnIdSource:'synthesized'`
// with NO io row: permanent floor-B orphans that fold every future
// `verify audit` of the session INCOMPLETE, and the scheduled turn's text was
// never captured despite `io: true`.
//
// These tests pin the fix: a cron drive mints ONE fresh host turnId through
// `runtime.attestationEvidence` (→ PerTurn.turnId → ConductContext.turnId, so
// decorum stamps 'host'), and exactly ONE io row lands for it — the
// one-row-per-minted-turnId invariant the verifier's completeness floor
// depends on. Absent coordinator ⇒ byte-identical (no turnId on the ctx).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConductContext, ConductProvider } from '@yevgetman/sov-sdk/core/conductPort';
import { createTurnEvidence, withEvidenceSink } from '../../src/attestation/turnEvidence.js';
import type { IoEvidenceWriter } from '../../src/attestation/turnEvidence.js';
import type { ObservedTurnRow } from '../../src/attestation/writer.js';
import { addJob } from '../../src/cron/jobs.js';
import { createProductionCronRunner } from '../../src/cron/wiring.js';
import { buildRuntime } from '../../src/server/runtime.js';

/** Capture-only stand-in for the AttestationWriter's io surface. */
function captureWriter(): { rows: ObservedTurnRow[]; writer: IoEvidenceWriter } {
  const rows: ObservedTurnRow[] = [];
  return { rows, writer: { recordIo: (row) => rows.push(row) } };
}

/** A conduct stub whose outputGuard records every ConductContext it sees —
 *  the same observation decorum makes when stamping turn identity onto a
 *  DecisionRecord. */
function contextRecordingProvider(seen: ConductContext[]): ConductProvider {
  return {
    outputGuard: {
      onFinal: (_message, ctx) => {
        seen.push(ctx);
        return { action: 'pass' as const };
      },
    },
  };
}

describe('cron drive — host turnId + io row (attestation evidence)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-cron-attest-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(home, { recursive: true, force: true });
  });

  test('a scheduled turn mints a host turnId and settles exactly ONE io row for it', async () => {
    const seen: ConductContext[] = [];
    const { rows, writer } = captureWriter();
    const evidence = createTurnEvidence({ writer, io: true });
    if (evidence.evidenceSink === undefined) throw new Error('io mode must expose the sink');
    // Mirror the gateway boot wiring exactly: the mounted provider is the
    // evidence-wrapped one, and the SAME coordinator rides the runtime.
    const conduct = withEvidenceSink(contextRecordingProvider(seen), evidence.evidenceSink);

    const runtime = await buildRuntime({
      harnessHome: home,
      cwd: process.cwd(),
      provider: 'mock',
      model: 'mock-haiku',
      cronEnabled: false,
      conduct,
      attestationEvidence: evidence,
    });

    try {
      addJob(home, {
        prompt: 'say hello',
        schedule: { kind: 'relative', offsetMs: 0 },
        deliver: 'local',
        skills: [],
      });
      const runner = createProductionCronRunner(runtime, home);
      await runner.runDueJobs();

      // The governed turn ran (the guard saw it) and carried a HOST turnId.
      expect(seen.length).toBeGreaterThanOrEqual(1);
      const ctx = seen[0];
      if (ctx === undefined) throw new Error('no conduct context captured');
      expect(ctx.turnId).toBeDefined();
      expect(ctx.turnId).toMatch(/^[0-9a-f-]{36}$/);

      // MONEY: exactly one io row, joined to the SAME (sessionId, turnId) the
      // conduct hooks saw — no orphan record, no duplicate row.
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (row === undefined) throw new Error('no io row written');
      expect(row.turnId).toBe(ctx.turnId as string);
      expect(row.sessionId).toBe(ctx.sessionId);
      // The turn reached terminal, so the sink row carries the delivered text.
      expect(row.delivered).toBe('Hello world.');
      // vars mirror the ConductContext the hooks saw.
      expect(row.vars).toEqual({ surface: 'user', model: 'mock-haiku' });
    } finally {
      await runtime.dispose();
    }
  });

  test('absent coordinator ⇒ no turnId on the conduct context (byte-identical)', async () => {
    const seen: ConductContext[] = [];
    const runtime = await buildRuntime({
      harnessHome: home,
      cwd: process.cwd(),
      provider: 'mock',
      model: 'mock-haiku',
      cronEnabled: false,
      conduct: contextRecordingProvider(seen),
    });

    try {
      addJob(home, {
        prompt: 'say hello',
        schedule: { kind: 'relative', offsetMs: 0 },
        deliver: 'local',
        skills: [],
      });
      const runner = createProductionCronRunner(runtime, home);
      await runner.runDueJobs();

      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(seen[0]?.turnId).toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });
});

// Fix wave (review finding, 2026-07-19 attestation evidence) — host turn
// identity on the CHANNEL drive surface.
//
// The channel pipeline binds `runtime.conduct` (the boot-wired provider whose
// attestationSink persists DecisionRecords), so pre-fix an inbound Slack/
// Telegram/webhook turn emitted records with `turnIdSource:'synthesized'` and
// no io row — permanent floor-B orphans (any audit of the session folds
// INCOMPLETE) and a silent io-evidence hole despite `io: true`.
//
// Pins the fix: a channel turn mints ONE fresh host turnId through
// `runtime.attestationEvidence`, threads it to every conduct capability call,
// and settles exactly ONE io row for it. Absent coordinator ⇒ byte-identical.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConductContext, ConductProvider } from '@yevgetman/sov-sdk/core/conductPort';
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import { createTurnEvidence, withEvidenceSink } from '../../src/attestation/turnEvidence.js';
import type { IoEvidenceWriter } from '../../src/attestation/turnEvidence.js';
import type { ObservedTurnRow } from '../../src/attestation/writer.js';
import { runChannelTurn } from '../../src/channels/pipeline.js';
import { buildSessionKey } from '../../src/channels/sessionKey.js';
import type { InboundMessage } from '../../src/channels/types.js';
import { buildRuntime } from '../../src/server/runtime.js';

const TG_MSG: InboundMessage = {
  channel: 'telegram',
  sender: 'u1',
  chatId: 'c1',
  chatType: 'private',
  text: 'hello',
};

const PRINCIPAL = 'tg-bot';

function captureWriter(): { rows: ObservedTurnRow[]; writer: IoEvidenceWriter } {
  const rows: ObservedTurnRow[] = [];
  return { rows, writer: { recordIo: (row) => rows.push(row) } };
}

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

describe('channel drive — host turnId + io row (attestation evidence)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-channel-attest-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    // Pin the session DB to the temp home (deterministic channel session keys
    // collide across shared homes — see pipeline.test.ts).
    process.env.HARNESS_HOME = home;
    MockProvider.lastMessages = undefined;
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.HARNESS_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  test('an inbound channel turn mints a host turnId and settles exactly ONE io row', async () => {
    const seen: ConductContext[] = [];
    const { rows, writer } = captureWriter();
    const evidence = createTurnEvidence({ writer, io: true });
    if (evidence.evidenceSink === undefined) throw new Error('io mode must expose the sink');
    const conduct = withEvidenceSink(contextRecordingProvider(seen), evidence.evidenceSink);

    const runtime = await buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
      cronEnabled: false,
      conduct,
      attestationEvidence: evidence,
    });

    try {
      const result = await runChannelTurn({ runtime, msg: TG_MSG, principalId: PRINCIPAL });
      expect(result.text).toBe('Hello world.');

      expect(seen.length).toBeGreaterThanOrEqual(1);
      const ctx = seen[0];
      if (ctx === undefined) throw new Error('no conduct context captured');
      expect(ctx.turnId).toBeDefined();
      expect(ctx.turnId).toMatch(/^[0-9a-f-]{36}$/);
      expect(ctx.sessionId).toBe(buildSessionKey(TG_MSG));

      // MONEY: one io row for the minted id, joined to the channel session.
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (row === undefined) throw new Error('no io row written');
      expect(row.turnId).toBe(ctx.turnId as string);
      expect(row.sessionId).toBe(buildSessionKey(TG_MSG));
      expect(row.delivered).toBe('Hello world.');
      expect(row.vars).toEqual({ surface: 'user', model: 'mock-haiku' });
    } finally {
      await runtime.dispose();
    }
  });

  test('absent coordinator ⇒ no turnId on the conduct context (byte-identical)', async () => {
    const seen: ConductContext[] = [];
    const runtime = await buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
      cronEnabled: false,
      conduct: contextRecordingProvider(seen),
    });

    try {
      await runChannelTurn({ runtime, msg: TG_MSG, principalId: PRINCIPAL });
      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(seen[0]?.turnId).toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });
});

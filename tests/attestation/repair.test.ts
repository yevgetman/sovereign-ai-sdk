// tests/attestation/repair.test.ts — boot-time orphan repair (review fix wave,
// spec 2026-07-19 attestation evidence).
//
// A hard crash (SIGKILL, power loss) can end the gateway AFTER a turn's
// DecisionRecords were appended but BEFORE its io row landed (the sink/endTurn
// backfill never ran). Those records would be permanent floor-B orphans: every
// future `verify audit` of the session folds INCOMPLETE, unrepairable by the
// runtime that produced them. `repairOrphanTurnEvidence` runs at gateway boot
// (io mode only, BEFORE any new turn can begin) and backfills one
// delivered-omitted io row per orphaned (sessionId, turnId) pair — exactly the
// row `endTurn` would have written, asserting only that the turn existed and
// nothing was observed delivered.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repairOrphanTurnEvidence } from '../../src/attestation/repair.js';
import { AttestationWriter } from '../../src/attestation/writer.js';
import { ObservedTurnSchema } from './fixtures/verifierSchemas.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sov-attest-repair-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const HASH = 'a1'.repeat(32);

function makeWriter(): AttestationWriter {
  return new AttestationWriter({
    harnessHome: home,
    getManifest: () => {
      throw new Error('manifest getter must not be consulted by repair');
    },
  });
}

/** Minimal record line — repair reads only sessionId + turnId off each line. */
function recordLine(sessionId: string, turnId: string, eventId: string): string {
  return JSON.stringify({
    schemaVersion: 'decorum.attestation/1',
    eventId,
    sessionId,
    turnId,
    turnIdSource: 'host',
    attempt: 0,
    stage: 'output',
    verdict: 'pass',
    ruleIds: [],
    latencyMs: 1,
    iso: '2026-07-19T12:00:00.000Z',
    surface: 'user',
    governanceHash: HASH,
  });
}

function ioLine(sessionId: string, turnId: string, delivered?: string): string {
  return JSON.stringify({
    sessionId,
    turnId,
    ...(delivered !== undefined ? { delivered } : {}),
  });
}

function seedEvidence(dir: string, files: Record<string, string[]>): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, lines] of Object.entries(files)) {
    writeFileSync(join(dir, name), `${lines.map((l) => `${l}\n`).join('')}`, { mode: 0o600 });
  }
}

function readIoRows(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('repairOrphanTurnEvidence — crash-window orphan backfill', () => {
  test('backfills ONE delivered-omitted row per orphaned turnId, leaving covered turns alone', async () => {
    const writer = makeWriter();
    seedEvidence(writer.dir, {
      // t1 settled normally; t2's io row never landed (crash window). Multiple
      // records per turn (persona/pregate/output) must still collapse to ONE
      // backfill row.
      'sess-1.records.jsonl': [
        recordLine('sess-1', 't1', 'evt-1'),
        recordLine('sess-1', 't2', 'evt-2'),
        recordLine('sess-1', 't2', 'evt-3'),
      ],
      'sess-1.io.jsonl': [ioLine('sess-1', 't1', 'hello')],
    });

    const repaired = await repairOrphanTurnEvidence(writer);
    await writer.close();

    expect(repaired).toBe(1);
    const rows = readIoRows(join(writer.dir, 'sess-1.io.jsonl'));
    expect(rows).toHaveLength(2);
    const backfill = rows[1];
    if (backfill === undefined) throw new Error('missing backfill row');
    // MONEY: exactly the endTurn backfill shape — join keys only, `delivered`
    // OMITTED (never ''), and verifier-strict (no extra keys).
    expect(backfill).toEqual({ sessionId: 'sess-1', turnId: 't2' });
    expect(() => ObservedTurnSchema.parse(backfill)).not.toThrow();
  });

  test('idempotent: a second boot repair adds nothing', async () => {
    const writer = makeWriter();
    seedEvidence(writer.dir, {
      'sess-1.records.jsonl': [recordLine('sess-1', 't2', 'evt-2')],
    });
    expect(await repairOrphanTurnEvidence(writer)).toBe(1);
    // Simulate the next boot: a fresh writer over the same dir.
    await writer.close();
    const writer2 = makeWriter();
    expect(await repairOrphanTurnEvidence(writer2)).toBe(0);
    await writer2.close();
    expect(readIoRows(join(writer2.dir, 'sess-1.io.jsonl'))).toHaveLength(1);
  });

  test('spans sessions: each orphan lands in ITS OWN session io file under the record sessionId', async () => {
    const writer = makeWriter();
    seedEvidence(writer.dir, {
      'sess-1.records.jsonl': [recordLine('sess-1', 'tA', 'evt-1')],
      'sess-2.records.jsonl': [recordLine('sess-2', 'tB', 'evt-2')],
      'sess-2.io.jsonl': [ioLine('sess-2', 'tB', 'covered')],
    });
    const repaired = await repairOrphanTurnEvidence(writer);
    await writer.close();
    expect(repaired).toBe(1);
    expect(readIoRows(join(writer.dir, 'sess-1.io.jsonl'))).toEqual([
      { sessionId: 'sess-1', turnId: 'tA' },
    ]);
    expect(readIoRows(join(writer.dir, 'sess-2.io.jsonl'))).toHaveLength(1);
  });

  test('fails open: no evidence dir yet ⇒ 0, nothing created', async () => {
    const writer = makeWriter();
    expect(existsSync(writer.dir)).toBe(false);
    expect(await repairOrphanTurnEvidence(writer)).toBe(0);
    expect(existsSync(writer.dir)).toBe(false);
  });

  test('fails open: unparseable/turnId-less lines are skipped, parseable orphans still repair', async () => {
    const writer = makeWriter();
    seedEvidence(writer.dir, {
      'sess-1.records.jsonl': [
        'not json at all {{{',
        JSON.stringify({ sessionId: 'sess-1' }), // no turnId — never joinable, skip
        recordLine('sess-1', 't9', 'evt-9'),
      ],
      'sess-1.io.jsonl': ['also not json'],
    });
    const repaired = await repairOrphanTurnEvidence(writer);
    await writer.close();
    expect(repaired).toBe(1);
    const lines = readFileSync(join(writer.dir, 'sess-1.io.jsonl'), 'utf8').trim().split('\n');
    const last = lines.at(-1);
    if (last === undefined) throw new Error('missing appended row');
    expect(JSON.parse(last)).toEqual({ sessionId: 'sess-1', turnId: 't9' });
  });
});

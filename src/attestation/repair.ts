// src/attestation/repair.ts — boot-time orphan repair for attestation evidence
// (review fix wave, spec 2026-07-19-gateway-attestation-evidence-design.md
// §3.4).
//
// THE CRASH WINDOW. The graceful path settles every minted turnId (the turn's
// finally → `endTurn`; shutdown → `TurnEvidence.settleAll()` before the writer
// closes). But a hard crash — SIGKILL, power loss, a fatal error after
// `AttestationWriter.close()` — can end the process AFTER a turn's
// DecisionRecords were appended to `<sessionId>.records.jsonl` but BEFORE its
// io row landed in `<sessionId>.io.jsonl`. decorum-verify's completeness floor
// (floor B) fails closed on ANY record with no io row for its (sessionId,
// turnId), so one crashed turn would fold every future `verify audit` of that
// session INCOMPLETE, forever, with no way to repair — on a fully honest
// deployment.
//
// THE REPAIR. At gateway boot (io mode only, BEFORE the server accepts turns —
// so no in-flight drive can race a duplicate row), scan the evidence dir:
// every (sessionId, turnId) present in a records file but absent from every io
// file gets ONE backfill row `{sessionId, turnId}` — exactly the row `endTurn`
// would have written, asserting only that the turn existed and nothing was
// observed delivered (`delivered` OMITTED — never ''). Idempotent by
// construction: a repaired turn is covered on the next scan.
//
// FAILURE POSTURE (§3.5): evidence is observation and fails OPEN. A missing
// dir, an unreadable file, or an unparseable line never blocks boot — skip and
// continue; the function never throws.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AttestationWriter } from './writer.js';

/** The repair surface — structurally `AttestationWriter`'s `dir` + `recordIo`,
 *  kept narrow so unit tests can hand in a capture stub. */
export type OrphanRepairWriter = Pick<AttestationWriter, 'dir' | 'recordIo'>;

const RECORDS_SUFFIX = '.records.jsonl';
const IO_SUFFIX = '.io.jsonl';

/** Parse one JSONL line into its (sessionId, turnId) join keys, or undefined
 *  when the line is unparseable or carries no usable keys. Repair reads ONLY
 *  the join keys — never content — off each line. */
function parseJoinKeys(line: string): { sessionId: string; turnId: string } | undefined {
  const trimmed = line.trim();
  if (trimmed === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object') return undefined;
    const sessionId = (parsed as { sessionId?: unknown }).sessionId;
    const turnId = (parsed as { turnId?: unknown }).turnId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
    if (typeof turnId !== 'string' || turnId.length === 0) return undefined;
    return { sessionId, turnId };
  } catch {
    return undefined;
  }
}

/** Read a file's JSONL lines, failing open to an empty list. */
async function readLinesSafe(path: string): Promise<string[]> {
  try {
    const raw = await readFile(path, 'utf8');
    return raw.split('\n');
  } catch {
    return [];
  }
}

/**
 * Backfill one delivered-omitted io row per orphaned (sessionId, turnId) pair
 * found in the evidence dir. Returns the number of rows backfilled (0 on any
 * failure — fail open, never throw). Call ONLY at boot, before any turn can
 * begin, and ONLY in io mode (records-only attestation writes no io files by
 * contract, so its records are documented forensic raw material, not floor-
 * coverable turns).
 */
export async function repairOrphanTurnEvidence(writer: OrphanRepairWriter): Promise<number> {
  try {
    let names: string[];
    try {
      names = await readdir(writer.dir);
    } catch {
      return 0; // no evidence dir yet (first boot) — nothing to repair
    }

    // Every turnId already covered by ANY io row, across all sessions.
    // turnIds are host-minted UUIDs (or engine-synthesized `<sid>:turn-N`
    // forms from pre-fix evidence) — globally unique either way, so a flat
    // set is the robust join (immune to filename-stem sanitization drift).
    const covered = new Set<string>();
    for (const name of names) {
      if (!name.endsWith(IO_SUFFIX)) continue;
      for (const line of await readLinesSafe(join(writer.dir, name))) {
        const keys = parseJoinKeys(line);
        if (keys !== undefined) covered.add(keys.turnId);
      }
    }

    // Orphans: recorded turnIds with no io row. Dedup by turnId (a turn emits
    // several DecisionRecords — persona/pregate/output — one row covers all).
    const orphans = new Map<string, string>(); // turnId -> sessionId (the record's own)
    for (const name of names) {
      if (!name.endsWith(RECORDS_SUFFIX)) continue;
      for (const line of await readLinesSafe(join(writer.dir, name))) {
        const keys = parseJoinKeys(line);
        if (keys === undefined || covered.has(keys.turnId) || orphans.has(keys.turnId)) continue;
        orphans.set(keys.turnId, keys.sessionId);
      }
    }

    for (const [turnId, sessionId] of orphans) {
      // The exact endTurn backfill shape: join keys only, `delivered` OMITTED.
      writer.recordIo({ sessionId, turnId });
    }
    return orphans.size;
  } catch {
    return 0; // evidence is an observer; a failed repair never blocks boot
  }
}

// Plugin consent record (T2). The `.consent.json` written into a plugin's
// install dir is the on-disk artifact of the load-time consent gate (S1): the
// T3 loader contributes NOTHING from a plugin unless `readConsent` returns a
// record whose `pluginId` matches AND `verifyConsent` confirms the recorded
// tree hash still matches the live tree (catching a tree edited after
// consent — the TOCTOU H4 case).
//
// `buildConsentRecord` is PURE — `consentedAt` is PASSED IN, never generated
// here (this repo bans non-deterministic calls in pure functions and the
// builder must be unit-testable). The caller stamps the ISO timestamp.
//
// The on-disk write is atomic (temp file + rename), mirroring the shell-hook
// consent store in src/hooks/consent.ts.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CONSENT_FILENAME, hashPluginTree } from './integrity.js';

/** Per-component consent decisions. Keyed by component name (`skills`,
 *  `commands`, `hooks`, `mcpServers`, …); `true` = the operator consented to /
 *  acknowledged that component at install time. T6 writes these (skills +
 *  commands accepted; declared-inert hooks/mcp acknowledged). A flat boolean
 *  map keeps the record human-auditable and forward-compatible with new
 *  component kinds without a schema change. */
export type ConsentDecisions = Record<string, boolean>;

/** Validated `.consent.json` shape. `consentedAt` is an ISO-8601 timestamp
 *  STRING supplied by the caller (matching the repo's `toISOString()` +
 *  pass-in convention — see other writers in src/). */
export const ConsentRecordSchema = z
  .object({
    pluginId: z.string().min(1),
    version: z.string().min(1),
    treeHash: z.string().min(1),
    decisions: z.record(z.string(), z.boolean()),
    consentedAt: z.string().min(1),
  })
  .strict();

export type ConsentRecord = z.infer<typeof ConsentRecordSchema>;

/** Build a validated consent record from explicit inputs. PURE — `consentedAt`
 *  is passed in (never `Date.now()`/`new Date()`), nothing is written, and the
 *  inputs are not mutated (Zod returns a fresh object). Throws a `ZodError` on
 *  an invalid record. */
export function buildConsentRecord(input: {
  pluginId: string;
  version: string;
  treeHash: string;
  decisions: ConsentDecisions;
  consentedAt: string;
}): ConsentRecord {
  return ConsentRecordSchema.parse({
    pluginId: input.pluginId,
    version: input.version,
    treeHash: input.treeHash,
    decisions: { ...input.decisions },
    consentedAt: input.consentedAt,
  });
}

/** Read `<dir>/.consent.json` and validate it. Returns `null` — never throws —
 *  when the file is absent, unparseable, or fails the schema (a missing or
 *  corrupt record simply means "not consented", which the loader handles). */
export function readConsent(dir: string): ConsentRecord | null {
  const path = consentPath(dir);
  if (!existsSync(path)) return null;
  try {
    const parsed = ConsentRecordSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    // Unparseable / unreadable file ⇒ treat as no consent.
    return null;
  }
}

/** Write `<dir>/.consent.json` atomically (temp file + rename, mirroring
 *  src/hooks/consent.ts) so a reader never observes a half-written record. */
export function writeConsent(dir: string, record: ConsentRecord): void {
  const path = consentPath(dir);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

/** True only when the record's recorded tree hash still matches the live tree.
 *  The T3 loader uses this to detect a tree edited after consent (tampered).
 *  The hash excludes `.consent.json`, so a written record verifies against its
 *  own tree. */
export function verifyConsent(dir: string, record: ConsentRecord): boolean {
  return record.treeHash === hashPluginTree(dir);
}

function consentPath(dir: string): string {
  return join(dir, CONSENT_FILENAME);
}

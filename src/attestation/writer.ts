// src/attestation/writer.ts — the gateway's attestation-evidence writer
// (spec specs/2026-07-19-gateway-attestation-evidence-design.md §3.1/§3.2/§3.4,
// plan T3). Persists the three artifacts decorum-verify's `verify audit`
// consumes, under `<HARNESS_HOME>/<dir>/` (default `attestations/`):
//
//   <sessionId>.records.jsonl   one VERBATIM `JSON.stringify(record)` per line.
//                               The verifier's intake is `.strict()` — ONE added
//                               key (a timestamp, a nodeId) fails the whole audit
//                               to INCOMPLETE — so gateway metadata goes nowhere
//                               near these lines: no redaction, no sessionId
//                               injection, no envelope. Content-free by
//                               decorum's own emitter contract.
//   <sessionId>.io.jsonl        one ObservedTurn row per minted turnId:
//                               {sessionId, turnId?, input?, candidate?,
//                               delivered?, vars?{surface,model}} — CONTENT-
//                               BEARING, so candidate/delivered/input pass the
//                               SAME secrets redactor transcripts use. Fields
//                               are picked BY NAME (never spread) so a wider
//                               caller object can never leak an extra key, and
//                               unobserved fields are OMITTED — `delivered` is
//                               never written as `""` for an undelivered turn
//                               (the verifier counts `""` as a completed turn).
//   manifest-<hash12>.json      one whole-file AttestationManifest snapshot per
//                               FIRST-SEEN governanceHash, read from a live
//                               `getManifest` thunk (the provider getter) so a
//                               hot-reload/overlay recomposition snapshots the
//                               NEW composition (§3.2 hash drift).
//
// This is a DEDICATED writer, not the trace route: the conductAudit trace path
// is peek-only (drops events for non-resident sessions), which is fine for
// observability but a completeness hole for EVIDENCE — a dropped record makes
// the verifier's floor fail the audit closed. One writer serves the whole
// gateway process and keys files by each record's own sessionId, so records
// survive session eviction.
//
// FAILURE POSTURE (§3.5): enforcement fails closed; attestation is observation
// and fails OPEN end-to-end. record()/recordIo()/snapshotManifest() NEVER throw
// to callers; on the FIRST failure the writer emits ONE warning through the
// injected `warn` callback (itself wrapped no-throw) and keeps counting every
// subsequent failure in `failureCount`, so a dead disk is detectable rather
// than a silent evidence hole discovered weeks later by a failed floor.
//
// DISCIPLINE mirrored from TraceWriter (packages/sdk/src/trace/writer.ts):
// sequential write chain (concurrent writes land in order), lazy secureMkdir
// 0700 / files 0600, sanitized filename stems + containment assertions under
// HARNESS_HOME. The evidence dir itself is containment-asserted at
// CONSTRUCTION — that one throw is deliberate and boot-time-only (a bad
// `conduct.attestation.dir` is a config error, fail-fast like a bad pack path).

import { existsSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { AttestationManifest, DecisionRecord } from '@yevgetman/decorum';
import { resolveHarnessHome } from '@yevgetman/sov-sdk/config/paths';
import { redact } from '@yevgetman/sov-sdk/trajectory/redact';
import {
  SECURE_FILE_MODE,
  chmodSafe,
  secureMkdir,
  secureWriteFileAtomic,
} from '@yevgetman/sov-sdk/util/secureFs';

/** Conventional evidence dir name under HARNESS_HOME (spec §3). */
const ATTESTATIONS_DIR_NAME = 'attestations';

/** Manifest snapshot filenames carry the first 12 hex chars of the
 *  governanceHash — enough to disambiguate compositions, short enough to read. */
const GOVERNANCE_HASH_STEM_LENGTH = 12;

/** Optional CEL-style guard metadata on an io row (decorum-verify spec §4.1). */
export type ObservedTurnVars = {
  readonly surface?: 'user' | 'internal';
  readonly model?: string;
};

/** One observed turn, exactly as decorum-verify's `.strict()` intake reads it
 *  from `io.jsonl`. Vendor-neutral plain strings — the gateway builds these
 *  from the SDK's ConductEvidenceEvent plus its own session/turn identity. */
export type ObservedTurnRow = {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly input?: string;
  readonly candidate?: string;
  readonly delivered?: string;
  readonly vars?: ObservedTurnVars;
};

export type AttestationWriterOpts = {
  /** Evidence dir, RELATIVE to harnessHome (config `conduct.attestation.dir`,
   *  default `attestations`). Resolved + containment-asserted at construction:
   *  a value escaping HARNESS_HOME (or an absolute path) throws — a boot-time
   *  config error, never a turn-time one. */
  dir?: string;
  /** Override the HARNESS_HOME root. Mostly a test seam — the gateway leaves
   *  this unset. */
  harnessHome?: string;
  /** Live manifest getter — MUST read `provider.attestationManifest` fresh on
   *  every call (a thunk over the getter, never a captured value), so a
   *  post-reload composition snapshots its own state (§3.2). */
  getManifest: () => AttestationManifest;
  /** One-shot warning channel for the first write failure (the gateway wires
   *  this to an `{type:'external', source:'attestation'}` trace line). Wrapped
   *  no-throw; omitted → failures are counted silently. */
  warn?: (message: string) => void;
};

/** Sanitize a sessionId into a filename stem that can never traverse the
 *  filesystem — the identical discipline (and character policy) as
 *  `safeTraceFilenameStem` (packages/sdk/src/trace/writer.ts): collapse `..`
 *  runs first, then allowlist word chars, `.`, `-`, and the `:` channel-key
 *  delimiter. SINK-boundary defense in depth: even a sessionId source that
 *  skips upstream guards cannot escape the attestations dir. */
function safeAttestationFilenameStem(sessionId: string): string {
  return sessionId.replace(/\.\.+/g, (m) => '_'.repeat(m.length)).replace(/[^A-Za-z0-9_.:-]/g, '_');
}

/** Resolve + containment-assert the evidence dir under `harnessHome`.
 *  Throws on escape — construction-time only (boot config error). */
function resolveContainedDir(home: string, dir: string): string {
  const root = resolve(home);
  // Reject absolute dirs OUTRIGHT rather than letting `join` silently re-root
  // them under home — a config that says /var/evidence must fail loudly, not
  // quietly write to <home>/var/evidence.
  if (isAbsolute(dir)) {
    throw new Error(
      `[attestation] refused absolute evidence dir: ${JSON.stringify(dir)} (conduct.attestation.dir is resolved under the harness home; use a relative path)`,
    );
  }
  const candidate = resolve(join(root, dir));
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    throw new Error(
      `[attestation] refused evidence dir outside HARNESS_HOME: ${JSON.stringify(dir)} (conduct.attestation.dir must stay under the harness home)`,
    );
  }
  return candidate;
}

/** Build the verifier-shaped ObservedTurn object from a caller row. Fields are
 *  picked BY NAME and undefined ones are omitted — the physical no-extra-keys /
 *  no-empty-string guarantee (decorum's record-emitter discipline). The writer
 *  writes what was OBSERVED: it never converts an absent field to `""` nor an
 *  empty delivery to absence — both would manufacture a fact.
 *
 *  candidate/delivered/input pass the SAME secrets redactor transcripts use
 *  (packages/sdk/src/trajectory/redact.ts), applied PER FIELD before
 *  serialization — never over the serialized line, which could corrupt the
 *  strict-parsed JSON — and identically to candidate and delivered so
 *  pass-unchanged equality survives redaction. sessionId/turnId are the
 *  records↔io JOIN keys and are never redacted (records are verbatim; a
 *  redacted id on one side would orphan every turn). */
function buildObservedTurn(row: ObservedTurnRow): Record<string, unknown> {
  const surface = row.vars?.surface;
  const model = row.vars?.model;
  const vars =
    surface !== undefined || model !== undefined
      ? {
          ...(surface !== undefined ? { surface } : {}),
          ...(model !== undefined ? { model } : {}),
        }
      : undefined;
  return {
    sessionId: row.sessionId,
    ...(row.turnId !== undefined ? { turnId: row.turnId } : {}),
    ...(row.input !== undefined ? { input: redact(row.input) } : {}),
    ...(row.candidate !== undefined ? { candidate: redact(row.candidate) } : {}),
    ...(row.delivered !== undefined ? { delivered: redact(row.delivered) } : {}),
    ...(vars !== undefined ? { vars } : {}),
  };
}

/** The gateway-wide attestation-evidence writer. Construct ONE at boot (per
 *  provider), feed it decorum's `attestationSink` records and the SDK's
 *  observed-io events, and `await close()` at shutdown so the queue drains. */
export class AttestationWriter {
  /** The resolved, containment-asserted evidence dir. */
  readonly dir: string;
  private readonly getManifest: () => AttestationManifest;
  private readonly warn: ((message: string) => void) | undefined;
  /** Sequential write chain — concurrent writes land in call order. */
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;
  /** governanceHashes whose manifest snapshot has been enqueued. In-memory per
   *  process lifetime is enough: a restart re-snapshots idempotently (same
   *  hash ⇒ same content ⇒ same file, atomically overwritten). */
  private readonly snapshottedHashes = new Set<string>();
  private warned = false;
  private failures = 0;
  private appended = 0;

  constructor(opts: AttestationWriterOpts) {
    const home = opts.harnessHome ?? resolveHarnessHome();
    this.dir = resolveContainedDir(home, opts.dir ?? ATTESTATIONS_DIR_NAME);
    this.getManifest = opts.getManifest;
    this.warn = opts.warn;
  }

  /** Append one DecisionRecord VERBATIM to `<sessionId>.records.jsonl`, and
   *  snapshot the manifest if this record's governanceHash is first-seen.
   *  Fire-and-forget; NEVER throws (fails open — §3.5). */
  record(record: DecisionRecord): void {
    if (this.closed) return;
    // Snapshot first, independently guarded: a manifest failure (dead getter,
    // unwritable dir) must never cost the record line, and vice versa.
    this.maybeSnapshotForHash(record.governanceHash);
    try {
      const path = this.resolveSessionFile(record.sessionId, 'records');
      this.enqueueAppend(path, JSON.stringify(record));
    } catch (err) {
      this.noteFailure(`records write for session ${record.sessionId}`, err);
    }
  }

  /** Append one ObservedTurn row (named-pick + redaction — see
   *  {@link buildObservedTurn}) to `<sessionId>.io.jsonl`. Fire-and-forget;
   *  NEVER throws. The one-row-per-minted-turnId discipline (incl. backfilling
   *  abandoned turns) is the CALLER's contract — the writer writes what it is
   *  handed, once per call. */
  recordIo(row: ObservedTurnRow): void {
    if (this.closed) return;
    try {
      const observed = buildObservedTurn(row);
      const path = this.resolveSessionFile(row.sessionId, 'io');
      this.enqueueAppend(path, JSON.stringify(observed));
    } catch (err) {
      this.noteFailure(`io write for session ${row.sessionId}`, err);
    }
  }

  /** Read the live manifest getter and write `manifest-<hash12>.json` if that
   *  composition has no snapshot yet. Public for the gateway's boot-time
   *  snapshot (§3.2 — called once at boot with the SAME provider instance
   *  whose hooks run); also invoked internally on every first-seen record
   *  hash. NEVER throws. */
  snapshotManifest(): void {
    if (this.closed) return;
    try {
      const manifest = this.getManifest();
      // Filename + dedup key derive from the manifest's OWN hash — never from
      // a record's hash the manifest doesn't carry. In the reload race (a
      // record stamped under a hash the getter no longer serves), the honest
      // move is to write nothing for that hash: binding this content to that
      // name would manufacture evidence. The stale hash stays un-seen, so a
      // later record retries against the (cheap) live getter.
      const hash = manifest.governanceHash;
      if (typeof hash !== 'string' || hash.length === 0) {
        throw new Error('manifest getter returned no governanceHash');
      }
      if (this.snapshottedHashes.has(hash)) return;
      // Mark at enqueue time (not on write success): a failed snapshot write is
      // counted + warned, not retried — the TraceWriter posture.
      this.snapshottedHashes.add(hash);
      const stem = safeAttestationFilenameStem(hash.slice(0, GOVERNANCE_HASH_STEM_LENGTH));
      const path = this.resolveContainedFile(`manifest-${stem}.json`);
      const json = JSON.stringify(manifest, null, 2);
      this.writeChain = this.writeChain.then(() => {
        try {
          // secureWriteFileAtomic: parent dir 0700, atomic 0600 tmp + rename.
          secureWriteFileAtomic(path, json);
          this.appended++;
        } catch (err) {
          this.noteFailure(`manifest snapshot at ${path}`, err);
        }
      });
    } catch (err) {
      this.noteFailure('manifest snapshot', err);
    }
  }

  /** Drain the write queue. Safe to call multiple times; writes issued after
   *  the first close() are dropped (mirrors TraceWriter). */
  async close(): Promise<void> {
    this.closed = true;
    await this.writeChain;
  }

  /** Total failed write/snapshot operations (exposed for tests + the gateway's
   *  health surface). The warning fires once; this keeps counting. */
  get failureCount(): number {
    return this.failures;
  }

  /** Successful write operations (JSONL appends + manifest snapshots). */
  get count(): number {
    return this.appended;
  }

  private maybeSnapshotForHash(governanceHash: string): void {
    if (this.snapshottedHashes.has(governanceHash)) return;
    this.snapshotManifest();
  }

  /** Contained per-session evidence file path. Post-sanitize escape is
   *  impossible; the assertion is belt-and-suspenders (TraceWriter invariant)
   *  and any throw is caught by the fire-and-forget callers. */
  private resolveSessionFile(sessionId: string, kind: 'records' | 'io'): string {
    return this.resolveContainedFile(`${safeAttestationFilenameStem(sessionId)}.${kind}.jsonl`);
  }

  private resolveContainedFile(filename: string): string {
    const candidate = resolve(join(this.dir, filename));
    if (!candidate.startsWith(this.dir + sep)) {
      throw new Error(`[attestation] refused to write outside the evidence dir: ${filename}`);
    }
    return candidate;
  }

  private enqueueAppend(path: string, line: string): void {
    this.writeChain = this.writeChain.then(async () => {
      try {
        // Evidence may carry conversation text (io.jsonl): dir 0700, file 0600,
        // same custody as transcripts/traces (audit F10/F16).
        const creating = !existsSync(path);
        if (creating) {
          secureMkdir(dirname(path));
        }
        await appendFile(path, `${line}\n`, { encoding: 'utf8', mode: SECURE_FILE_MODE });
        // `mode` applies only on create; tighten once on first append.
        if (creating) chmodSafe(path, SECURE_FILE_MODE);
        this.appended++;
      } catch (err) {
        this.noteFailure(`append at ${path}`, err);
      }
    });
  }

  /** Count every failure; surface only the FIRST through `warn` (§3.1 — one
   *  detectable signal, no warning storm from a dead disk). The callback is
   *  itself guarded: evidence fails open even when the warn sink is broken. */
  private noteFailure(context: string, err: unknown): void {
    this.failures++;
    if (this.warned) return;
    this.warned = true;
    const message = err instanceof Error ? err.message : String(err);
    try {
      this.warn?.(
        `[attestation] evidence write failed (${context}): ${message} — further failures are counted, not re-warned`,
      );
    } catch {
      // The warning channel is an observer too; never propagate.
    }
  }
}

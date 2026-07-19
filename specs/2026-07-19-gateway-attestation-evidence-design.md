# Gateway attestation evidence — live-audit plumbing for decorum-verify

**Status: APPROVED 2026-07-19 — CEO ratified all three §9 decisions as recommended:
D1 full evidence in v1 (records + manifest + io) · D2 opt-in · D3 one arc, sov + Appleo.**
**Scope:** the sov gateway persists the three evidence artifacts decorum-verify's
`verify audit` consumes, so a live deployment (Appleo-style) can be forensically
audited after the fact — not just proven pre-deploy with `verify run`.

---

## 1. Goal

A gateway host with a decorum pack bound can hand an auditor three files —

| file | content | contract |
|---|---|---|
| `manifest.json` | what SHOULD constrain the agent | one whole-file JSON `AttestationManifest` (`decorum.attestation/1`) |
| `records.jsonl` | what the runtime DID, per decision | one verbatim `DecisionRecord` JSON object per line |
| `io.jsonl` | what actually went in and out | one `ObservedTurn` row per turn: `{sessionId, turnId, input?, candidate?, delivered?, vars?}` |

— and `verify audit --manifest … --records … --io … --packs …` renders
ALIGNED / MISALIGNED / INCOMPLETE. The gateway sits exactly where all three
artifacts exist; today it persists none of them.

**Non-goals:** no network egress, no auto-upload, no verifier code in sov, no
adherence claims, no coverage claim over `sov drive` subprocess sub-agents (the
in-process provider does not cross that boundary — the attestation scope is the
gateway process, stated honestly in docs).

## 2. What exists today (the seams)

- The conduct config block: `conduct { configPath?, packDir?, overlay? }`
  (`packages/sdk/src/config/schema.ts:776-795`) with sibling
  `observability.conductAudit` (`:830-838`).
- `createDecorumAdapter` passes **only** `configPath` + `auditSink` to
  `createDecorumProvider` (`src/conduct/decorumAdapter.ts:143`). decorum ≥0.10.0
  already accepts `attestationSink` / `attestationSinks` (sync, observation
  **fails open** — a throwing sink never breaks a governed turn) and exposes
  `provider.attestationManifest` (deep-frozen getter, fresh from the active
  composition).
- The `conductAudit` trace route (`{type:'external', source:'decorum'}` →
  `traces/<sessionId>.jsonl`) is **peek-only**: events for a non-resident session
  are silently dropped (`src/server/sessionContext.ts:184-197`). Fine for
  observability; a completeness hole for *evidence* (dropped records → orphan io
  turns → the verifier's floor fails the audit closed). **Therefore records get a
  dedicated writer, not the trace route.**
- `ConductContext` carries **no turnId** (`packages/sdk/src/core/conductPort.ts:46-52`),
  so every DecisionRecord today would be `turnIdSource:'synthesized'` — the
  verifier caps all correlation-dependent findings HIGH→MEDIUM. decorum accepts an
  optional host `turnId` (honored verbatim → `'host'`), all-or-none per turn.
- `candidate` (pre-governance output) exists **only** inside the open SDK's drive
  loop (`packages/sdk/src/agent/createAgent.ts:510-515`, the `guard.onFinal`
  call); `delivered` is the post-governor persisted message. The SDK cannot
  import decorum (boundary lint), so any capture seam must be vendor-neutral.

## 3. Design overview

New optional config block (inside `conduct`, since it is meaningless without a
pack bound):

```jsonc
"conduct": {
  "configPath": "...",
  "attestation": {                 // absent ⇒ byte-identical gateway (the repo discipline)
    "enabled": true,               // records.jsonl + manifest snapshots (content-free)
    "io": true,                    // io.jsonl capture (CONTENT-BEARING — separate, deliberate flag)
    "dir": "attestations"          // optional; resolved under HARNESS_HOME, containment-asserted
  }
}
```

File layout, mirroring the TraceWriter discipline (append-only JSONL, sequential
write chain, `secureMkdir` 0700 / files 0600, sanitized names, containment under
`HARNESS_HOME`):

```
<HARNESS_HOME>/attestations/
  manifest-<governanceHash12>.json      # one per distinct hash observed (§5)
  <sessionId>.records.jsonl             # verbatim DecisionRecords
  <sessionId>.io.jsonl                  # ObservedTurn rows (only when io: true)
```

### 3.1 Records sink (content-free)

- Adapter grows `attestationSink?: (record) => void` in `DecorumAdapterOptions`,
  spread into `createDecorumProvider` exactly as `auditSink` is
  (`decorumAdapter.ts:143`); absent ⇒ byte-identical (the existing
  option→capability contract test pattern extends).
- The gateway constructs a dedicated `AttestationWriter` at boot
  (`gatewayCommand.ts:178-200`, beside the `conductAuditEnabled` gate) — **not**
  routed through `makeExternalTraceRecorder` (peek-only drop) and **not** keyed to
  live SessionContexts, so records survive session eviction.
- Lines are `JSON.stringify(record)` **verbatim** — decorum-verify's intake is
  `.strict()`; one added key (a timestamp, a nodeId) fails the whole audit to
  INCOMPLETE. Gateway metadata goes nowhere near these files.
- The sink is fire-and-forget async internally, never throws into decorum (which
  would swallow silently); on the **first** write failure it emits one
  `{type:'external', source:'attestation'}` warning trace line + a counter, so a
  dead disk is detectable rather than a silent evidence hole discovered weeks
  later by a failed floor.

### 3.2 Manifest lifecycle (§9-D2 risk: hash drift)

- At boot, serialize `provider.attestationManifest` from **the same provider
  instance whose hooks run** (post-overlay if `conduct.overlay` is configured —
  a scoped provider stamps a scoped hash) to `manifest-<hash12>.json`.
- The sink watches `record.governanceHash`; on a value with no snapshot on disk
  (hot-reload / overlay recomposition), it reads the getter again and writes a
  new `manifest-<hash>.json`. Every hash in `records.jsonl` therefore has its
  manifest alongside. (`verify audit` takes ONE manifest today — the runbook
  audits per hash window; multi-manifest intake is a decorum-verify follow-up,
  noted, not required for v1: Appleo restarts per config change, so a window is
  normally a whole deployment.)

### 3.3 Host turn identity

- `runTurnInBackground` mints `turnId = crypto.randomUUID()` per invocation
  (`src/server/routes/turns.ts:514`, beside the per-turn AbortController) and
  threads it via the per-turn slice → `createAgent` → `ConductContext.turnId`
  (**optional** field on the open-SDK type — semver-minor, STABILITY.md notes).
- All-or-none: the same id rides every hook of the turn (decorum's mixed-source
  trap). The compaction-pivot second hop mints a **fresh** turnId (it is a
  distinct drive) — and §3.4 guarantees every minted turnId gets an io row, so
  no record is ever an orphan (the verifier's floor B fails closed on orphans).
- Result: `turnIdSource:'host'` on every record — the verifier's confidence caps
  lift, and correlation findings hold at HIGH.

### 3.4 Observed-io capture (content-bearing, opt-in via `io: true`)

- New **vendor-neutral** optional callback on the SDK conduct port config:
  `evidenceSink?: (e: {turnId, input?, candidate?, delivered?}) => void` — plain
  strings, no decorum types (boundary-safe), called once per turn at the
  `guard.onFinal` seam with the FINAL attempt's pre-governance `candidate` and
  post-governor `delivered`, plus the exact `gateText` the input gate saw.
  The root-package gateway wires it to the io writer; absent ⇒ byte-identical.
- One row per minted turnId, always (even an aborted/undelivered turn writes a
  row with `delivered` **omitted** — never `""`, which the verifier counts as a
  completed turn). Regenerate collapses to the final pair (attempt-0 candidates
  are discarded by design; the verifier declines those honestly).
- `delivered` is defined as the **persisted post-governor message**, not the SSE
  wire bytes (the streamed block-after-release divergence is a documented decorum
  residual, not evidence of tampering).
- Rows pass the same secrets redactor as transcripts (applied to candidate and
  delivered alike, so pass-unchanged equality survives redaction).
- **Custody:** `io.jsonl` is the customer's conversation text. It lives only
  under the per-account `HARNESS_HOME`, 0600, same custody as the existing
  transcript JSONL (which already stores delivered text today — io adds
  `candidate` + gate-input). Retention/rotation stays the host's (none exists for
  traces/transcripts either; a shared rotation story is a separate follow-up).
  Who may run `--report full` (which quotes spans) is a host policy decision;
  the runbook says so explicitly.

### 3.5 Failure posture

Enforcement fails closed (unchanged); attestation is observation and **fails
open** end-to-end: writer errors never block a turn, never starve the audit
sink, and surface via the §3.1 warning line. `attestation.enabled` without a
bound pack is a boot-time config error (fail-fast, same as a bad pack path).

## 4. Appleo integration (second repo, small)

- `buildConfigJson` (`resume-as-code-platform/src/agent/gateway/spawn.ts:111-152`)
  emits the `attestation` block when a new env `AGENT_ATTESTATION` is set
  (values `records` | `full` — full = io capture too), mirroring the
  `AGENT_DECORUM_CONFIG` gating; absent in dev/tests ⇒ byte-identical.
- Evidence lands in each account's HARNESS_HOME (already volume-persisted and
  covered by the nightly backup). Runbook addition to `deploy/decorum/README.md`:
  copy the three files out + `verify audit --manifest … --records … --io …
  --packs /opt/appleo/decorum/conduct/appleo/conduct.yaml`.

## 5. Test plan (the money tests)

1. **Round-trip acceptance (the gate):** boot a real gateway with a pack +
   attestation on, drive governed turns (pass / block / redact / pregate-deny /
   regenerate / abandoned), then run the REAL `verify audit` from decorum-verify
   over the produced files → **ALIGNED**, zero floor findings, all records
   `turnIdSource:'host'`. (Golden shape: decorum-verify
   `tests/fixtures/aligned/` + its regen script.)
2. Byte-identical when absent — no `attestation` block ⇒ no new files, no
   behavior delta (extend the adapter contract test).
3. Orphan-proofing: abandoned turn ⇒ io row without `delivered`, no floor trip.
4. Hash drift: recomposition mid-run ⇒ second `manifest-<hash>.json` appears;
   per-window audits both ALIGNED.
5. Sink failure: unwritable dir ⇒ turns unaffected, one warning trace line.
6. Tamper canary (proves the point): hand-edit one persisted record's verdict ⇒
   `verify audit` → MISALIGNED. The evidence chain catches its own corruption.

## 6. Release / sequencing

sov 0.6.66 (minor; open-SDK `ConductContext.turnId` + `evidenceSink` = sdk
semver-minor). No decorum change required (sinks + manifest getter shipped in
0.10.0/0.10.1; the binary already bundles 0.10.1). Appleo bump = repin
`SOV_VERSION` + the env flag, deploy per the standard Mac Mini runbook.

## 7. Risks (carried from recon, mitigations inline)

- Peek-only trace route drops evidence → dedicated writer (§3.1).
- `.strict()` intake poisoning → verbatim serialization, metadata nowhere (§3.1).
- Hash drift / overlay scoping → per-hash manifest snapshots (§3.2).
- Synthesized-id confidence caps → host turnId (§3.3).
- Silent sink death → first-failure warning + counter (§3.1, §5-5).
- Unbounded evidence growth → flagged as the shared rotation follow-up (§3.4).

## 8. Alternatives considered

- **Fold records into `traces/*.jsonl`:** rejected — envelope wrapping breaks
  verbatim-line consumption, and peek-only drop semantics are a completeness
  hole for evidence.
- **Records-only v1 (no io, no candidate):** rejected as the default — without
  `candidate` the verifier's strongest checks (block/replace proof, unclaimed-hit
  re-execution over delivered) degrade to UNVERIFIABLE; the gateway is the only
  place candidate exists. Kept available as decision D1's fallback.
- **Reuse assay's `${sessionId}#${turn}` ordinal as turnId:** rejected — not
  stable across compaction-pivot re-drives and not mintable before hooks run.

## 9. Open decisions (CEO)

- **D1 — io capture in v1?** Recommended: **yes, both flags ship** (`enabled` +
  `io`), Appleo runs `full`. Fallback: records-only v1 forfeits the strongest
  lie-detection until v1.1.
- **D2 — default posture when a pack is bound:** Recommended: **opt-in**
  (evidence is a deliberate act; content-bearing io must never be a surprise).
  Alternative: records-on-by-default like `conductAudit` (content-free), io
  opt-in regardless.
- **D3 — scope:** Recommended: this spec covers sov + the small Appleo wiring
  (§4) as one arc, Appleo behind its env flag. Alternative: sov-only, Appleo
  later.

## 10. Amendments (2026-07-19 review fix wave)

Corrections and extensions ratified by the adversarial review over the built
branch — the claims below supersede the corresponding v1 text.

1. **Host turn identity covers EVERY in-gateway governed drive, not just the
   turns route.** §3.3 as written wired `beginTurn`/`endTurn` only into
   `runTurnInBackground`; the cron scheduler, the channel pipeline, and the
   OpenAI-compat route all bind `runtime.conduct` (the same provider carrying
   the attestationSink) and were emitting `turnIdSource:'synthesized'` records
   with no io row — permanent floor-B orphans. Fixed: all three drive sites
   mint one fresh host turnId per drive and settle it in their finally (the
   turns-route pattern). The stated scope ("the gateway process") now holds.
   `sov drive` subprocess sub-agents remain out of scope (§1 non-goals).
2. **Crash/shutdown windows are settled, not leaked.** Graceful shutdown
   sweeps every still-pending minted turnId (`TurnEvidence.settleAll()`)
   BEFORE the writer closes; a hard crash (SIGKILL) is repaired at next boot —
   the gateway backfills one `delivered`-omitted row per orphaned
   (sessionId, turnId) found in the evidence dir (io mode only, before any new
   turn can begin).
3. **§5-6 tamper-canary claim, honestly scoped.** The audit proves
   consistency/integrity of what is PRESENT (an in-place edit → MISALIGNED);
   it can NOT prove completeness of what is ABSENT. Evidence is host-writable
   0600 JSONL with no continuity seal, and decorum's evt-N counter interleaves
   across sessions, so a custodian who consistently deletes one turn's records
   lines AND its io row hands the auditor a set that still verifies ALIGNED.
   Completeness requires external anchoring (retained copies / backups at
   audit time) — the host's responsibility, stated in the runbook. A
   per-session continuity seal + verifier counterpart is a noted follow-up.
4. **Records-only mode is forensic raw material, not an auditable mode.**
   `verify audit` hard-requires `--io`, and io-less records are all orphans
   under the completeness floor. Only `full` yields ALIGNED/MISALIGNED. The
   config docstring and the Appleo runbook now say so.
5. **Redaction collides with re-execution (F4) — tagged markers.** The io
   redactor now writes `[REDACTED:<kind>]` (never bare `[REDACTED]`): an
   authored rule whose detect matches secret-shaped text (API-key forms, JWTs,
   …) cannot be re-executed over persisted evidence, and a bare marker would
   read as CONTRADICTED on an honest fire (false MISALIGNED) or hide a real
   leak behind a claimed pass. The tagged form is machine-recognizable so
   decorum-verify can decline such checks honestly (UNVERIFIABLE) — the noted
   verifier-side follow-up. Pass-equality (F3) survives: candidate and
   delivered get identical substitutions.
6. **The §2 boundary claim is now mechanical.** "The SDK cannot import decorum
   (boundary lint)" was review-enforced only; `bun run boundary` now carries a
   dedicated `no-open-to-engine` rule (value AND type edges, resolvable or
   raw) so the vendor-neutrality invariant fails the build, not the review.

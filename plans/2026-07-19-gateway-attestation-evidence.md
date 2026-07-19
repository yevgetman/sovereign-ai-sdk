# Gateway attestation evidence — implementation plan

> Executes `specs/2026-07-19-gateway-attestation-evidence-design.md` (APPROVED
> 2026-07-19: D1 full evidence · D2 opt-in · D3 sov + Appleo one arc).
> Subagent-driven on branch `feat/attestation-evidence`; Appleo change rides
> `resume-as-code-platform` main behind its env gate (inert until set).

**Global constraints (bind every task):** absent config ⇒ byte-identical (test
it); attestation fails OPEN end-to-end; records/io written VERBATIM per the
strict verifier schemas (no extra keys, ever); open-SDK additions are
vendor-neutral + optional (boundary lint `bun run boundary` stays green;
STABILITY semver-minor); io rows: one per minted turnId, `delivered` omitted
(never `""`) for undelivered turns; secrets redactor applied to io text; 0700
dirs / 0600 files + containment under HARNESS_HOME; gates after every task =
`bun run lint && bun run typecheck && bun test` (baseline 5012 pass / 0 fail).

## sov chain (sequential, one tree)

- **T1 — open-SDK seams.** `ConductContext.turnId?: string`
  (`packages/sdk/src/core/conductPort.ts:46-52`) + vendor-neutral
  `evidenceSink?: (e:{turnId?, input?, candidate?, delivered?}) => void` on the
  conduct port config; called once per turn at the `guard.onFinal` seam
  (`packages/sdk/src/agent/createAgent.ts:510-544` — final attempt only,
  post-substitution `delivered`, pre-substitution `candidate`) + gate-input
  capture at `core/query.ts:175-189`; conductCtx build threads `turnId`
  (`createAgent.ts:283-289`). sdk version 0.7.0 → 0.8.0. Tests: seam contract +
  absent ⇒ byte-identical + boundary lint.
- **T2 — config block.** `conduct.attestation { enabled, io, dir? }` strict
  Zod block (`packages/sdk/src/config/schema.ts:776-795`), defaults false /
  false / `"attestations"`; `enabled` without a bound pack = boot config error.
  Extend `tests/config/schema.test.ts` (mirror the a009367 conductAudit tests).
- **T3 — AttestationWriter (root `src/attestation/`).** Mirrors TraceWriter
  discipline: `<sid>.records.jsonl` (verbatim lines), `<sid>.io.jsonl`
  (ObservedTurn rows, redacted), `manifest-<hash12>.json` snapshots on
  first-seen `record.governanceHash`; async fire-and-forget, never throws;
  first-failure warning trace line + counter. Unit tests incl. failure path +
  containment.
- **T4 — wiring.** `DecorumAdapterOptions.attestationSink` spread into
  `createDecorumProvider` (`src/conduct/decorumAdapter.ts:35-54,143`); gateway
  boot constructs the writer beside the conductAudit gate
  (`src/cli/gatewayCommand.ts:178-200`) from the SAME provider instance the
  runtime mounts (post-overlay manifest); `runTurnInBackground` mints
  `crypto.randomUUID()` per invocation incl. a FRESH id for the compaction-pivot
  second hop (`src/server/routes/turns.ts:514`, `:1072-1079`) and threads it +
  the evidenceSink through the per-turn slice. Extend
  `tests/conduct/decorumAdapter.test.ts` + `tests/server/gatewayConduct.test.ts`
  + `turnsConduct.test.ts` (deny/regenerate/abandoned turn → io row shapes;
  every record `turnIdSource:'host'`; no orphans).
- **T5 — round-trip acceptance (the money gate).**
  `scripts/attestation-roundtrip.ts` + a test skipped unless
  `../decorum-verify` exists (CI-safe): boot a real gateway with a pack +
  attestation full, drive pass / block / redact / pregate-deny / regenerate /
  abandoned turns, then run the REAL `verify audit` over the produced files →
  **ALIGNED, zero floor findings**; tamper canary (edit one verdict) →
  MISALIGNED. Golden shape: decorum-verify `tests/fixtures/aligned/`.

## parallel + tail

- **T6 — Appleo wiring** (parallel to T1-T5; separate repo, inert until env
  set): `AGENT_ATTESTATION` env (`records`|`full`) → `config.ts` →
  `buildConfigJson` emits `conduct.attestation`
  (`src/agent/gateway/spawn.ts:82,111-152`); spawn tests; runbook section in
  `deploy/decorum/README.md` (copy 3 files out → `verify audit` command). No
  deploy.
- **T7 — docs + release prep** (after T1-T5): CHANGELOG (`harness 0.6.66` +
  `sdk 0.8.0`, byte-identical-when-absent framing), root version 0.6.65 →
  0.6.66, README touch if warranted. NO release cut, NO tag.

## review + gates

Adversarial review wave over the whole branch (false-negative hunt on the
evidence path: dropped records, extra keys, empty-string delivered, orphan
turnIds, redactor breaking pass-equality) → fix wave → re-verify. Merge
`feat/attestation-evidence` → master + push only when green.

**Staged for CEO after merge:** cut `v0.6.66` (`bun run release`), `sov
upgrade`, Appleo `SOV_VERSION` repin + `AGENT_ATTESTATION=full` + redeploy,
then the first real live audit on app.appleo.ai evidence.

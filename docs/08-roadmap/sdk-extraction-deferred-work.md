# Deferred Work & Follow-ups — Open-Core SDK Extraction

> **Status: living catalog (2026-06-30).** Every deferral, known limitation, accepted review finding, and open decision recorded across the SDK open-core extraction build (the `sdk-extraction` branch). Source-of-truth design: [`specs/2026-06-29-sdk-open-core-extraction-design.md`](../../specs/2026-06-29-sdk-open-core-extraction-design.md) (B-0014); plan: [`plans/2026-06-29-sdk-open-core-extraction.md`](../../plans/2026-06-29-sdk-open-core-extraction.md). The build delivered Phases 1–9 (boundary lint + ports + `createAgent` + every surface re-seated onto the SDK, including the gateway); the items below were intentionally **not** done and are tracked here so nothing is lost. File/symbol pointers retained; duplicates merged.
>
> **Reconciled 2026-07-02 against the consumable-packaging build** (branch `sdk-consumable-packaging`; spec [`specs/2026-07-01-sdk-consumable-packaging-design.md`](../../specs/2026-07-01-sdk-consumable-packaging-design.md), plan [`plans/2026-07-01-sdk-consumable-packaging.md`](../../plans/2026-07-01-sdk-consumable-packaging.md)). That build physically split the two open packages, made them Node+Bun consumable from a packed tarball, hardened the consumer-facing contracts, and stopped **publish-ready** (the publish itself is the CEO's gate — `PUBLISHING.md`). §1.2 / §1.3 / §1.5 / §1.6 and four §2 limitations are marked resolved in place below (the house style — history is never deleted); the new deferrals that build ledgered are added into the matching sections, each tagged *(consumable-packaging build)*.

---

## 1. Deferred Scope — intentional, sequenced work

### HIGH

#### 1.1 Ship steps (final whole-branch review → merge → post-merge `sov upgrade`)
- **What:** The remaining tail after the §15 acceptance gate was confirmed (Task 9.1): the **final whole-branch code review** folding in all the Minor / accepted findings in §2 below, then `finishing-a-development-branch` (the merge/PR decision), then the post-merge steps.
- **Entails:** the broad final review; merge `sdk-extraction` → `master`; `sov upgrade` (installs from the git `master` ref, so it is a **post-merge** step — not runnable on the unmerged branch); decide on stripping the inconsistent `Claude-Session:` commit trailers (only the two Task-9.1 commits carry them).
- **Trigger/prereq:** Phases 1–9.1 complete. Source: Spec §15 + §17 step 9; ledger.
- **Update 2026-07-02:** the merge landed — `sdk-extraction` merged to `master` 2026-06-30 (per the consumable-packaging spec header). What remains of this item is the **post-inversion release tail**: the installed binary is v0.6.47 (pre-inversion) and `sov upgrade` only pulls the latest *release tag* — no release has been cut since the inversion (or the packaging build), so no released artifact carries either. Cutting a post-inversion harness release is a separate decision (consumable-packaging spec §11 — the SDK ships via npm, not the `sov-releases` binary pipeline).

### MEDIUM

#### 1.2 ~~Physical `packages/` split + two-package separation (`@yevgetman/sov-protocol` + `@yevgetman/sov-sdk`)~~ — ✅ RESOLVED 2026-07-02
- **What:** Today the split is **logical only** (boundary lint + a `package.json` exports map exposing `./sdk` and `./protocol`). The end-state is to move the open core into `packages/sdk/` and the protocol into `packages/protocol/`, each its own workspace with a version + exports map + workspace links, leaving `@yevgetman/sov` as the proprietary wrapper depending on both. `src/protocol/` is deliberately **not** re-exported from `src/sdk.ts` (kept as a sibling surface with its own `src/protocol/index.ts`).
- **Entails:** relocate the file-level-classified open files into the two workspaces; retarget hundreds of imports; add a build emitting compiled `.js` + `.d.ts`; per-package semver + exports maps + workspace links through the public ports. Touch points: `src/protocol/index.ts`, `src/sdk.ts`, `package.json` exports map.
- **Why deferred:** **CEO decision at Phase 8: defer the big move** — it is the riskiest packaging step (high churn: a missed import or exports-gap breaks the build), and the boundary lint + exports map + surface snapshots + the no-`bun:sqlite` canary already deliver the acceptance value.
- **Trigger/prereq:** lands when **resume-as-code** is rebuilt and needs the pinnable small protocol package (§1.4). Source: Spec §12/§13.
- **Resolved by:** the consumable-packaging build (CEO-green-lit 2026-07-01) executed exactly this — `src/protocol/` → `packages/protocol` (`95ae62d`), then the 154-file open-core relocation into `packages/sdk` + the wrapper/test retarget to package imports (**`733082b`**). Each package is its own workspace (`version: 0.1.0`, own exports map, `workspace:*` links from the private wrapper); `src/protocol` stayed a sibling package, not re-exported from the sdk barrel, as specified.

#### 1.3 ~~Conditional/compiled exports map (replace bare `.ts` subpaths)~~ — ✅ RESOLVED 2026-07-02
- **What:** `package.json` `exports` points `.`→`./src/main.ts`, `./sdk`→`./src/sdk.ts`, `./protocol`→`./src/protocol/index.ts` as **bare `.ts` paths with no `types`/`import` conditions**, relying on Bun resolving `.ts` and `private:true`.
- **Entails:** on publish, replace with conditional exports pointing at compiled `.js` + `.d.ts` (`types`/`import`/`default`) per published package.
- **Trigger/prereq:** first real npm publish / non-Bun consumer; coupled to the package split (§1.2). Source: `task-8.1`.
- **Resolved by:** both published packages carry full conditional exports (**`733082b`** + the Phase-0/1 scaffolding): `bun` → `src/*.ts` (no-build dev loop + Bun consumers), `types` → `dist/*.d.ts`, `import`/`default` → `dist/*.js`; the sdk additionally exposes the `./*` deep-subpath wildcard (shipped-but-internal — `STABILITY.md`). The private root keeps a bare `.ts` entry **by design** (never published).

#### 1.4 resume-as-code rebuild on the SDK / `sov-protocol` (fast-follow)
- **What:** tear out resume-as-code's own agent loop and re-implement on the SDK via `@yevgetman/sov-protocol` (typed client + events) against a versioned gateway.
- **Entails:** replace its hand-rolled `client.ts`/`contract.ts` and the ~100 MB vendored binary with the typed protocol client; convert `env`/`config.json` to typed options; preserve `/chat/turns` + `/chat/events` proxy semantics; thereafter semver upgrades.
- **Trigger/prereq:** SDK + a versioned gateway shipped; needs the pinnable protocol package — this is the trigger that justifies the physical split (§1.2). Source: Spec §13/§14.
- **Update 2026-07-02:** the prerequisite is met — `@yevgetman/sov-protocol` exists, tarball-canary green under Node+Bun, publish dry-run green. The remaining gate is the actual npm publish (CEO, `PUBLISHING.md`); the rebuild itself stays a separate build.

#### 1.5 ~~Package-level external-import canary~~ — ✅ RESOLVED 2026-07-02
- **What:** promote `tests/sdk/barrel.test.ts` (the in-repo importability smoke) into a real **external-consumer canary** that imports the built/published open package (not deep `src` paths) and runs a no-disk agent turn with no filesystem / `bun:sqlite` reachable; then freeze the public surface.
- **Trigger/prereq:** Phase-8 packaging + surface freeze. Source: `task-3.2`.
- **Resolved by:** `scripts/canary/run-consumer-canary.ts` + `sdk-consumer.mjs`/`protocol-consumer.mjs` (**`44080de`**): `npm pack` each package → install the tarball into a scratch project → run a no-disk, tool-dispatching agent turn via the public entry under **both node and bun**, plus the shipped-artifact purity check (no `bun:sqlite`, no wrapper imports) against the installed tree; the purity gate's patterns carry a standing self-test so its failure mode can't be silent-pass (**`66bc5c3`**). Wired into CI (`.github/workflows/ci.yml` `packages` job) and runnable locally via `bun run canary`. Surfaces frozen (§1.6).

#### 1.6 ~~SDK barrel — missing surfaces (SDK-completeness pass)~~ — ✅ RESOLVED 2026-07-02
- **Delegation surface:** `src/sdk.ts` does not re-export the `Scheduler` port / `delegate`, `DelegateInput`/`DelegateResult`, the `runSubprocessExecutor` port types, or the pure `LaneRegistry` / `DelegationLifecycleEvent` (the latter two already open in `src/tool/ports.ts`). Define + export the public delegation/scheduler surface.
- **Canonical tool descriptors:** no open module exports them yet. Author them in open core (§5.1) and refactor the **subscription-executor to derive its tool name/key mapping from them** instead of the hardcoded block at `subprocessExecutor.ts:146-168`; then re-export from `src/sdk.ts`.
- **MCP pool/factory port:** the barrel exports the MCP client entrypoint + types but **not** the hot-swappable pool/factory port. Define + export it so embed consumers and (B) surfaces obtain MCP tools through the SDK rather than via host-supplied `toolContext`, preserving the gateway's `reloadMcpServers` hot-swap.
- **`buildToolScope`:** omitted because it lives only in **proprietary** `src/commands/toolScope.ts` (re-exporting it would fail the boundary lint). Relocate it (+ its closure) to an open module, then re-export; verify boundary stays green.
- Source: `task-3.2` (§5.1 omitted items).
- **Resolved by:** all four surfaces, then the freeze — delegation/scheduler surface + MCP factory port + `buildToolScope` relocated open and exported (**`1f86c10`**); canonical tool descriptors authored in open core with the subscription-executor deriving its maps from them (**`5f4c619`**); the remaining dangling-type gaps closed and the completed surface **frozen as the 0.1.0 semver contract** (**`7e2a204`**, `packages/sdk/tests/surface.test.ts`).

### LOW

- **`Agent.buildToolContext` method form** — Task 5.1 shipped the standalone open `buildToolContext(input)` + barrel export; the Agent-method convenience wrapper was not added. Decide whether the `Agent` object needs it or the standalone suffices.
- **~~OSS license flip~~ — ✅ RESOLVED 2026-07-02** — both open packages are **MIT** (`license: "MIT"` + a `LICENSE` file in each); the root wrapper stays `private`/`UNLICENSED`; the open dep-graph is separated (six declared third-party deps on the sdk, zero on protocol; no dependency on the wrapper — boundary-lint + purity-gate enforced). The publish itself is the CEO gate below.
- **Public npm publish** of `@yevgetman/sov-sdk` + `@yevgetman/sov-protocol` — **publish-ready, CEO gate pending (2026-07-02)**: per-package semver at 0.1.0, `npm publish --dry-run` green for both (locally + in CI), runbook written (`PUBLISHING.md`). The only remaining step is the CEO personally running the publish (and, separately, deciding the repo-public flip — its own checklist in the runbook).
- **~~SDK docs / examples polish~~ — ✅ RESOLVED 2026-07-02 (in substance)** — per-package READMEs with verified, runnable quickstarts; `STABILITY.md` (the semver/stability policy); `PUBLISHING.md`; `examples/embed` now carries a consumer `package.json`. A full API reference beyond the barrel's TSDoc remains optional future polish, not a gap.
- **Bundle minimization** — tree-shake / size-reduce the open bundle (`bundle/types.ts` + loader stay OPEN; *classification* is done, *minimization* deferred). (Spec §13)
- **~~Node compatibility~~ — ✅ RESOLVED 2026-07-02** — the packaging build shipped Node ≥20 support: the cross-runtime spawn shim (`8469992`, `c56b656`), `picomatch`/`tinyglobby` glob shims with write-scope parity pinned (`ba2b90a`, `93d00ac`), `node:http` StaticSiteValidateTool + a standing Bun-residual guard (`6383890`) — proven end-to-end by the dual-runtime tarball canary (`44080de`).
- **`./*` deep-subpath narrowing** *(was "Barrel surface freeze")* — the freeze itself landed (`7e2a204`; the 0.1.0 surface snapshot is the semver contract). What remains: skills/MCP modules still export more symbols than the barrel, reachable via the `@yevgetman/sov-sdk/*` wildcard — which is now **LIVE in the published shape** (shipped-but-internal, no semver cover; `STABILITY.md`). A future Phase-8-style narrowing — enumerate the deep subpaths the wrapper actually imports, close the rest — would shut off casual deep-binding by external consumers.

---

## 2. Accepted Minor Findings & Known Limitations

### MEDIUM — known limitations to revisit

- **~~`zod` imported into `src/core` but not declared in `package.json`~~ — ✅ RESOLVED 2026-07-02** — `packages/sdk/package.json` declares `zod` as a runtime dependency (alongside the other five: `yaml`, `@modelcontextprotocol/sdk`, `@anthropic-ai/sdk`, `picomatch`, `tinyglobby`) as of the physical split (**`733082b`**). (Task 1.4a)
- **~~Config injection doesn't reach live-reload / scheduler disk reads~~ — ✅ RESOLVED 2026-07-02** — injected `Settings` are threaded into the scheduler's child-provider resolution + all four live-reload closures (**`2b48b68`**) and into `buildSessionContext`'s per-session wiring (**`5d6585f`**): an injected-settings embed is now disk-free across delegation, live-reload, and session creation. The locked by-reference / live-reconfiguration semantics are documented on `RuntimeOptions.settings` (src/server/runtime.ts) and in `STABILITY.md`. Residual gateway-only hazard tracked as a NEW item below. (Task 2.3 → Tasks 4.3/4.3b)
- **~~`createAgent` token-usage uses the latest `usage_delta` snapshot, not cross-turn accumulation~~ — ✅ RESOLVED 2026-07-02** — `createAgent` now accumulates usage across provider calls via the internal open `usageAccumulator` (last-seen-per-call, sum of finals, cache fields included) before `recordTokenUsage` (**`079a08b`**). The gateway's own loop still has the defect — tracked as a NEW item below. (Task 3.1 → Task 4.2)
- **~~`createAgent.persistTurn` re-saves the full input each run → duplicate-row risk~~ — ✅ RESOLVED 2026-07-02** — the persistence contract is formalized + implemented (**`5a64727`**): when the store already holds the session's messages AND the seed's head is a **verbatim rehydration** of that stored history, persistence starts after the stored prefix — a stable-`sessionId` embedder never gets duplicate rows; a fresh session or a non-verbatim seed saves everything (the SDK never drops content on a guess). Documented in the `createAgent.ts` header + guarded by test. An optional tripwire on the non-verbatim fallback is a NEW LOW item below. (Task 3.1 → Task 4.1)
- **Gateway `turns.ts` usage capture — same defect class as the resolved `createAgent` item** *(consumable-packaging build, ledgered at Task 4.2)* — `src/server/routes/turns.ts:882` keeps only the **last** `usage_delta` per `runOnce` (`latestUsage = streamEvent.usage`), so a multi-provider-call tool loop under-records usage/cost at the `recordTokenUsage` call site (`:561-569`). The SDK-side fix (`079a08b`) is the model: reuse/port the open `usageAccumulator` into the gateway stream loop.
- **Gateway-only `/config`-style live-apply reads disk — mixed-state hazard IF command routes ever mount on an injected runtime** *(consumable-packaging build, ledgered at Task 4.3)* — `rebuildSessionRecall` (`src/server/sessionContext.ts:231`) and `commandContext.refreshRuntimeFromConfig` (`src/server/commandContext.ts:282`) call `readConfig()` unconditionally. Today they are reachable only through the gateway's command routes, which mount on disk-config runtimes — no live defect. But mounted on an injected-`Settings` runtime they would mix disk values into an otherwise disk-free embed. **Thread `runtime.injectedSettings` through both paths** before any such mounting.
- **`createAgent` throw→`terminal{error}` conversion — the `rethrow` contract** — a thrown **pre-loop** exception (memory injection, recall, `UserPromptSubmit` hook; `core/query.ts:74-76`/`:82`/`:98`) is converted to `terminal.reason==='error'` instead of propagating (in-loop errors are identical to `query()`). The gateway needed byte-identical `turn_error`, fixed via the additive `rethrow?` option (default off = convert; Spec §5.2). **Standing constraint:** every future re-seat relying on throw-propagation for control flow must handle `terminal.reason==='error'` like the old throw, or pass `rethrow:true`. (Task 4.1 bar-setting / 7.2)
- **Boundary lint runs under `bun --bun depcruise`, not bare `node`** — the dev host node (25.9.0) is outside dependency-cruiser's supported range; under Bun's node-compat it runs. **The `ci.yml` decision is settled: keep `bun --bun`** — it runs clean on the CI's ubuntu runner (first run green), so no bare-`node`/version pinning is needed. (Tasks 1.6/1.7)
- **~~No pre-commit hook framework — the `lint` script IS the boundary gate~~ — ✅ RESOLVED 2026-06-30** — a CI gate (`.github/workflows/ci.yml`, commit `fcefa2f`) now runs `bun run lint` (biome + the `bun run boundary` dependency-cruiser check) + `typecheck` on **every push to `master` and every PR**, so an open→proprietary import regression fails CI instead of silently landing between releases. First run green. (Tasks 1.6/1.7)
- **The OPEN protocol client does no runtime validation** — `src/protocol/client.ts` casts each parsed response to its protocol type ("validation stays server-side"). Intentional (keeps the OPEN client thin + zod-free). If hardening is wanted, **add opt-in validation without pulling zod into the OPEN module**, or document the trust boundary. (Task 6.2)
- **`core/workflowPort.ts` puts workflow capability shapes in open core** — to keep `commands/types.ts` open, the workflow result/event shapes were relocated there, forced by `CommandContext.workflows`. See Open Decision §3.1. (Task 1.7)
- **Gateway pre-loop-throw coverage is partial** — the rethrow regression test injects the throw only via `memoryManager.prefetchSnapshot`; the **recall thunk** (`query.ts:82`) and **`UserPromptSubmit` hook** (`query.ts:98`) are asserted equivalent-by-construction but not directly exercised. **Add focused tests** for both. (Task 7.2)

### MEDIUM — recurring flake (needs a single owner)

- **`tuiLauncherIntegration` test flake** — intermittent "server never bound within 5s" (port-bind timing); passes isolated (7/7 on a quiet machine) and in clean full runs — **proven pre-existing/environmental, not a regression**. A parallel-run **cron `jobs.json` corruption** surfaces from the same contention. **Stabilize:** a longer/dynamic bind timeout or port retry for the launcher; per-test temp dir / serialize the cron corrupt-recovery tests.

### LOW — accepted findings & known characteristics

**Cleanup / cosmetic**
- **Stale prose path comments after the stall/principals → `src/util/` relocation** — `tests/server/turns.stallDetected.test.ts:14` & `:54` and `src/commands/reviewOps.ts:276` reference old `src/review/stall.ts` / `src/server/principals.ts` paths. Update to `src/util/`. (Task 1.1)
- **`tests/router/capabilities.test.ts` not relocated** — imports `../../src/core/capabilities.js` but still lives under `tests/router/`. Move to `tests/core/`. (Task 1.2)
- **Stale comment + redundant cast in `commands/workflowOps.ts`** — stale header + a now-redundant structural cast in `getWorkflowCapability` (redundant since `CommandContext.workflows` is declared). Remove both. (Task 1.7)
- **Dead `src/ui/splash.ts` — deletion candidate** *(consumable-packaging build)* — no production caller remains (only its own test `tests/ui/splash.test.ts` + `tests/_smoke/wave3-smoke.ts` import it; the REPL it served was retired in M12/M13, and it carries a stale hardcoded `PKG_VERSION = '0.0.1'`). Delete the module + its test + the smoke usage.

**Type-safety / structural nits**
- **`run!` non-null assertion at scheduler dispatch** (`runtime/scheduler.ts`) — guarded by a throw; consistent with the existing `config!` ignore. Optionally restructure to narrow without the assertion. (Task 1.5)
- **`createAgent` regression guards via the observable boundary, not `QueryParams` interception** — `query()` is imported (not injected) and `mock.module` is flaky here. For stronger interception, **introduce a `query()` injection seam** or a non-flaky mock. (Task 4.4a)
- **In-memory `SessionStore` leniency + `SCHEMA_VERSION` hardcode** — `createInMemorySessionStore().saveMessage` is lenient on orphan messages (where `SessionDb` throws an FK error, out of the turn path); a `metadata===null` edge is out-of-contract; `SCHEMA_VERSION=5` is hardcoded to mirror `SessionDb`. Optionally tighten. (Task 2.1)
- **`TranscriptStoreOpts` not renamed** for symmetry with `FileTranscriptStore`; the no-op transcript-store test reads the impl rather than fs-scanning. (Task 2.2)
- **`WorkflowHost` literal duplicated across 3 callers** — deliberate trade-off vs. re-coupling to the wide `Runtime` type. Optionally factor into a shared helper. (Task 5.2)
- **Protocol client polish** — `parseEventFrame` keeps the last `data:` line rather than newline-joining; `streamEvents`' `finally` doesn't `reader.cancel()` on early break (abort signal is the intended teardown). Fine for this gateway; matters only for general-purpose SSE robustness. (Task 6.2)
- **`z.unknown()` keys infer as optional** under `exactOptionalPropertyTypes` — the protocol SSE types mirror this so the bidirectional conformance holds. Re-verify the `AssertEq` sentinels on a zod upgrade or a switch off `exactOptionalPropertyTypes`. (Task 6.1)
- **Sub-agent no-microcompaction test is weak as positive proof** — the real guarantee is in-code (no `microcompactConfig` reaches the native delegation path). Optionally spy that none reaches `query()`. (Task 4.5)
- **`KILLED_EXIT_CODE` is `1`, not `143`** *(consumable-packaging build, spawn shim)* — `packages/sdk/src/util/spawn.ts:31` pins the kill / pre-aborted-signal exit code to `1`; the POSIX convention for a SIGTERM death is `143` (128+15). Callers today only branch on non-zero, so `1` is safe — harden to `143` if any consumer starts distinguishing exit codes.
- **Optional trace tripwire on `persistTurn`'s non-verbatim fallback** *(consumable-packaging build, Task 4.1 review)* — when a stable-session seed is NOT a verbatim rehydration of stored history, `persistTurn` appends everything (deliberate: never drop content on a guess) — duplicates are then possible and **silent**. An optional `TraceEvent` when the fallback fires would let an embedder detect that it hit the append path instead of the dedup path.
- **Bun-compiled-binary SDK `VERSION` falls back to `0.0.0`** *(consumable-packaging build, Phase 3)* — in `bun build --compile` mode, `packages/sdk/src/version.ts`'s runtime package.json walk fails inside the `/$bunfs/` virtual filesystem → `FALLBACK_VERSION '0.0.0'`. User-facing `sov --version` is unaffected (the wrapper has its own build-time version source, `src/wrapperVersion.ts`). Fix if wanted: inject a compile-time constant via `--define` in the release build (`scripts/release-build-target.ts`) and have `version.ts` prefer it — prescribed in `PUBLISHING.md` §1 as a pre-publish nicety, not a blocker.

**Accepted-as-correct (informational, no action unless the contract changes)**
- `CreateSessionResponse.createdAt` is an ISO **string** (matches the handler's `toISOString()`; the conformance guard pins protocol == handler). (Task 6.1)
- Approvals request typed `PostApprovalRequest` despite a loose `unknown` parse — the handler runtime-validates after (the `turns.ts` cast-then-validate pattern). (Task 6.2)
- Task 8.1 added `export * from './client.js'` to `src/protocol/index.ts` — makes `./protocol` genuinely Contract #2; additive, boundary green. (Task 8.1)
- Unrelated `TaskOutput` in `src/workflows/template.ts` is distinct from the relocated tasks DTO; correctly left untouched. (Task 1.4c)
- **Template-literal dynamic imports evade the shipped-artifact purity gate** *(consumable-packaging build, Task 3.7)* — the gate's `FORBIDDEN_SPECIFIERS` patterns match **quoted** module specifiers only, so a backtick form (`` import(`bun:sqlite`) ``) would slip past; widening the quote class to backticks would false-positive on the prose `` `bun:sqlite` `` mention in `packages/sdk/src/core/sessionPort.ts`. Documented trade-off, accepted (`scripts/canary/run-consumer-canary.ts:35`); the standing pattern self-test (`66bc5c3`) keeps the gate honest for every quoted form.

**Intentional asymmetries to PRESERVE (regression traps — do NOT "helpfully" change)**
- **`createAgent.observe` is honored only on the built minimal `ToolContext`** — when the host supplies `perTurn.toolContext`, it's used verbatim and `observe` is NOT grafted on (the host owns its learning wiring). (Task 3.1)
- **Cron transcripts use sequence-number ids, not DB message ids** — cron passes `transcripts` but deliberately not `sessionStore`. (Task 4.2)
- **Channels passes NEITHER `transcripts` NOR `sessionStore`** — it already persists AND transcribes via its own `persistMessage`; routing through `createAgent.persistTurn` would double-write. Pinned by tests. **Do not add `transcripts` to channels.** (Task 4.3)
- **The OpenAI-compatible server stays stateless (D10)** — persists out-of-band; passes neither store. (Task 4.4)
- **The gateway passes NEITHER `sessionStore` NOR `transcripts` to per-turn `createAgent`** — owns persistence out-of-band via `persistMessage`; passing a store would double-write. If gateway persistence is ever unified onto the SDK `SessionStore`, reconcile `persistMessage` and this omission together. (Task 7.1)
- **The gateway leaves several `createAgent` params unset** (`temperature`, `cacheEnabled`, `maxToolCallsBeforeCheckin`, `maxTurns`, `observe`, `sessionStore`, `transcripts`, `settings`) → `query()` uses its existing defaults (byte-identical to the prior direct call). Add to the standing config only when a gateway feature needs one. (Task 7.1)

---

## 3. Open Decisions Still Outstanding

### MEDIUM

#### 3.1 Should `CommandContext` expose a workflow capability at all?
- `core/workflowPort.ts` holds workflow type shapes in open core (the open-shape / proprietary-engine pattern) and `CommandContext.workflows` is declared open. **Decide** whether the command contract should expose a workflow capability; if not, **drop or inject `CommandContext.workflows`**, remove the type shapes from the open contract, and refactor `core/workflowPort.ts` + the command registry. The chosen pattern was judged sound, so the question was left open rather than forced.
- **Trigger:** an architectural review of the open command contract / any tightening of the boundary around workflows.

### LOW

- **`CommandContext` minimization** — every member resolves to an open type/port (genuinely open), but it remains a broad "everything the slash commands need" bag. Optionally decompose into narrower per-command capability handles. (Task 1.7)
- **Boundary classification of `version.ts`, `eval/`, `evals/`** — not enumerated in design §4; classified by judgment in Task 1.6 (`version.ts` OPEN; `eval/`+`evals/` non-open; no open file imports them). If design §4 intended otherwise, adjust `scripts/boundary-manifest.json`. (Task 1.6)
- **Cron full DB persistence** — if cron should write message/usage DB rows in future, inject a `sessionStore` (a new ratified capability). (Task 4.2)
- **OpenAI surface statefulness** — if it should become stateful, inject `sessionStore`/`transcripts` deliberately (currently stateless by D10). (Task 4.4)

---

## 4. Resolved During the Build (closed — for traceability)

| Item | Resolved by |
|---|---|
| Dead `AgentRunner` class removal (zero callers after the cron/channels/scheduler/gateway re-seats) + stale comments + the stray NUL byte in `hooks/runner.ts` | Task 9.1 |
| §15 acceptance gate confirmed (coverage map: every criterion → a real covering test) | Task 9.1 |
| `ToolContext.taskManager` proprietary-class field — `TaskManagerPort` added; `TaskRecord`/`CreateTaskInput`/`TaskOutput`/`TaskState` relocated to `core/taskPort.ts` | Task 1.4c |
| `ChildCompletionEvent` inline-vs-named drift — named interface relocated byte-identical into `tool/ports.ts` | Task 1.4c |
| `TranscriptStore` port + no-op default wired into `createAgent` (`transcripts?`) | Task 3.1 |
| `cacheEnabled`/`temperature`/`maxToolCallsBeforeCheckin` not expressible on `AgentConfig` — added to both `AgentConfig` + `PerTurn` | Task 4.4a |
| Endpoint runtime-conformance + the typed client — handlers re-pointed (`… satisfies <ResponseType>`); `protocol/client.ts` authored | Task 6.2 |
| Gateway `turn_error` byte-identity on a thrown pre-loop error — additive `rethrow` option | Task 7.2 |
| **Boundary durability — PR/push CI gate** (the review's #1 post-merge recommendation): `.github/workflows/ci.yml` runs `bun run lint` (biome + boundary) + `typecheck` on every push to `master` + PR; first run green | post-merge, commit `fcefa2f` (2026-06-30) |
| §18.1 ratify architecture + §13 scope | CEO green-light 2026-06-29 (B-0014) |
| §18.2 transcripts/microcompaction on (B) surfaces | "Fix the gap": cron+mission gained microcompaction; cron gained transcripts; channels already had both; sub-agents + OpenAI pure parity |
| §18.3 Contract #2 type strategy | "Pure `.d.ts`": `src/protocol/` pure types + a zod-conformance guard on the proprietary side |
| §18.4 acceptance-bar sufficiency | The §15 gate is sufficient; no added manual pass |

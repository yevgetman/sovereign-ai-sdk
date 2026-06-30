# Deferred Work & Follow-ups — Open-Core SDK Extraction

> **Status: living catalog (2026-06-30).** Every deferral, known limitation, accepted review finding, and open decision recorded across the SDK open-core extraction build (the `sdk-extraction` branch). Source-of-truth design: [`specs/2026-06-29-sdk-open-core-extraction-design.md`](../../specs/2026-06-29-sdk-open-core-extraction-design.md) (B-0014); plan: [`plans/2026-06-29-sdk-open-core-extraction.md`](../../plans/2026-06-29-sdk-open-core-extraction.md). The build delivered Phases 1–9 (boundary lint + ports + `createAgent` + every surface re-seated onto the SDK, including the gateway); the items below were intentionally **not** done and are tracked here so nothing is lost. File/symbol pointers retained; duplicates merged.

---

## 1. Deferred Scope — intentional, sequenced work

### HIGH

#### 1.1 Ship steps (final whole-branch review → merge → post-merge `sov upgrade`)
- **What:** The remaining tail after the §15 acceptance gate was confirmed (Task 9.1): the **final whole-branch code review** folding in all the Minor / accepted findings in §2 below, then `finishing-a-development-branch` (the merge/PR decision), then the post-merge steps.
- **Entails:** the broad final review; merge `sdk-extraction` → `master`; `sov upgrade` (installs from the git `master` ref, so it is a **post-merge** step — not runnable on the unmerged branch); decide on stripping the inconsistent `Claude-Session:` commit trailers (only the two Task-9.1 commits carry them).
- **Trigger/prereq:** Phases 1–9.1 complete. Source: Spec §15 + §17 step 9; ledger.

### MEDIUM

#### 1.2 Physical `packages/` split + two-package separation (`@yevgetman/sov-protocol` + `@yevgetman/sov-sdk`)
- **What:** Today the split is **logical only** (boundary lint + a `package.json` exports map exposing `./sdk` and `./protocol`). The end-state is to move the open core into `packages/sdk/` and the protocol into `packages/protocol/`, each its own workspace with a version + exports map + workspace links, leaving `@yevgetman/sov` as the proprietary wrapper depending on both. `src/protocol/` is deliberately **not** re-exported from `src/sdk.ts` (kept as a sibling surface with its own `src/protocol/index.ts`).
- **Entails:** relocate the file-level-classified open files into the two workspaces; retarget hundreds of imports; add a build emitting compiled `.js` + `.d.ts`; per-package semver + exports maps + workspace links through the public ports. Touch points: `src/protocol/index.ts`, `src/sdk.ts`, `package.json` exports map.
- **Why deferred:** **CEO decision at Phase 8: defer the big move** — it is the riskiest packaging step (high churn: a missed import or exports-gap breaks the build), and the boundary lint + exports map + surface snapshots + the no-`bun:sqlite` canary already deliver the acceptance value.
- **Trigger/prereq:** lands when **resume-as-code** is rebuilt and needs the pinnable small protocol package (§1.4). Source: Spec §12/§13.

#### 1.3 Conditional/compiled exports map (replace bare `.ts` subpaths)
- **What:** `package.json` `exports` points `.`→`./src/main.ts`, `./sdk`→`./src/sdk.ts`, `./protocol`→`./src/protocol/index.ts` as **bare `.ts` paths with no `types`/`import` conditions**, relying on Bun resolving `.ts` and `private:true`.
- **Entails:** on publish, replace with conditional exports pointing at compiled `.js` + `.d.ts` (`types`/`import`/`default`) per published package.
- **Trigger/prereq:** first real npm publish / non-Bun consumer; coupled to the package split (§1.2). Source: `task-8.1`.

#### 1.4 resume-as-code rebuild on the SDK / `sov-protocol` (fast-follow)
- **What:** tear out resume-as-code's own agent loop and re-implement on the SDK via `@yevgetman/sov-protocol` (typed client + events) against a versioned gateway.
- **Entails:** replace its hand-rolled `client.ts`/`contract.ts` and the ~100 MB vendored binary with the typed protocol client; convert `env`/`config.json` to typed options; preserve `/chat/turns` + `/chat/events` proxy semantics; thereafter semver upgrades.
- **Trigger/prereq:** SDK + a versioned gateway shipped; needs the pinnable protocol package — this is the trigger that justifies the physical split (§1.2). Source: Spec §13/§14.

#### 1.5 Package-level external-import canary
- **What:** promote `tests/sdk/barrel.test.ts` (the in-repo importability smoke) into a real **external-consumer canary** that imports the built/published open package (not deep `src` paths) and runs a no-disk agent turn with no filesystem / `bun:sqlite` reachable; then freeze the public surface.
- **Trigger/prereq:** Phase-8 packaging + surface freeze. Source: `task-3.2`.

#### 1.6 SDK barrel — missing surfaces (SDK-completeness pass)
- **Delegation surface:** `src/sdk.ts` does not re-export the `Scheduler` port / `delegate`, `DelegateInput`/`DelegateResult`, the `runSubprocessExecutor` port types, or the pure `LaneRegistry` / `DelegationLifecycleEvent` (the latter two already open in `src/tool/ports.ts`). Define + export the public delegation/scheduler surface.
- **Canonical tool descriptors:** no open module exports them yet. Author them in open core (§5.1) and refactor the **subscription-executor to derive its tool name/key mapping from them** instead of the hardcoded block at `subprocessExecutor.ts:146-168`; then re-export from `src/sdk.ts`.
- **MCP pool/factory port:** the barrel exports the MCP client entrypoint + types but **not** the hot-swappable pool/factory port. Define + export it so embed consumers and (B) surfaces obtain MCP tools through the SDK rather than via host-supplied `toolContext`, preserving the gateway's `reloadMcpServers` hot-swap.
- **`buildToolScope`:** omitted because it lives only in **proprietary** `src/commands/toolScope.ts` (re-exporting it would fail the boundary lint). Relocate it (+ its closure) to an open module, then re-export; verify boundary stays green.
- Source: `task-3.2` (§5.1 omitted items).

### LOW

- **`Agent.buildToolContext` method form** — Task 5.1 shipped the standalone open `buildToolContext(input)` + barrel export; the Agent-method convenience wrapper was not added. Decide whether the `Agent` object needs it or the standalone suffices.
- **OSS license flip** — open packages retain `private`/`UNLICENSED`. Choose a license, update `package.json` license fields for the open subset only, separate the open dep-graph from the `@yevgetman/sov` wrapper. Pairs with publish. (Spec §12/§13)
- **Public npm publish** of `@yevgetman/sov-sdk` + `@yevgetman/sov-protocol` — per-package semver + publish workflow; depends on the license flip + ideally the physical split.
- **SDK docs / examples polish** — API docs + usage examples beyond the `examples/embed` canary. (Spec §13)
- **Bundle minimization** — tree-shake / size-reduce the open bundle (`bundle/types.ts` + loader stay OPEN; *classification* is done, *minimization* deferred). (Spec §13)
- **Node compatibility** — v1 is Bun-only (accepted, Spec §16). The open dep-graph already excludes `bun:sqlite` (in-memory `SessionStore` default + the canary; concrete `bun:sqlite` `SessionDb` isolated behind the port). Audit Bun-specific APIs + provide Node shims.
- **Barrel surface freeze** — skills/MCP surfaces export more symbols than the barrel re-exports; deep imports remain available until a freeze decides which become barrel exports vs. stay private.

---

## 2. Accepted Minor Findings & Known Limitations

### MEDIUM — known limitations to revisit

- **`zod` imported into `src/core` but not declared in `package.json`** — `src/core/observePort.ts` imports `zod` (`ObservationStatusSchema` backing `ObservationStatus`). In-repo nothing breaks (zod is a runtime dep). At packaging, **declare `zod` as a runtime dependency of the open package**. (Task 1.4a)
- **Config injection doesn't reach live-reload / scheduler disk reads** — `buildRuntime` injects validated `Settings` (3 boot reads → 1), but the scheduler child-provider-resolution callback (`runtime.ts:~1360`) and the live-reload closures (`reresolveProvider`/`reloadHooks`/`reloadMcpServers`/`rebuildTaskRouting`) still read from disk. An injected-settings embed that delegates sub-agents or live-reloads still touches disk. **Thread the injected settings into those paths** for full no-disk self-containment. (Task 2.3)
- **`createAgent` token-usage uses the latest `usage_delta` snapshot, not cross-turn accumulation** — mirrors the gateway. For accurate multi-turn SDK cost accounting, **accumulate `usage_delta` across tool-use turns** before `recordTokenUsage`. (Task 3.1)
- **`createAgent.persistTurn` re-saves the full input each run → duplicate-row risk** — fine for single-turn embeds, but a (B) surface rehydrating under a **stable `sessionId`** while passing a `sessionStore` would get duplicate rows. Phase 4 sidestepped it operationally (cron passes no `sessionStore`; channels self-persists), but the contract was never formalized. **Document the persistence contract** ("host passes only new-turn messages, or `createAgent` owns dedup") + add a guard/test. (Task 3.1)
- **`createAgent` throw→`terminal{error}` conversion — the `rethrow` contract** — a thrown **pre-loop** exception (memory injection, recall, `UserPromptSubmit` hook; `core/query.ts:74-76`/`:82`/`:98`) is converted to `terminal.reason==='error'` instead of propagating (in-loop errors are identical to `query()`). The gateway needed byte-identical `turn_error`, fixed via the additive `rethrow?` option (default off = convert; Spec §5.2). **Standing constraint:** every future re-seat relying on throw-propagation for control flow must handle `terminal.reason==='error'` like the old throw, or pass `rethrow:true`. (Task 4.1 bar-setting / 7.2)
- **Boundary lint runs under `bun --bun depcruise`, not bare `node`** — the dev host node (25.9.0) is outside dependency-cruiser's supported range; under Bun's node-compat it runs. On CI/supported node, decide whether to keep `bun --bun` (local parity) or switch to bare `depcruise`. (Tasks 1.6/1.7)
- **No pre-commit hook framework — the `lint` script IS the boundary gate** — `bun run boundary` is enforced only because it's appended to `lint` (`biome check src tests && bun run boundary`). **Add a pre-commit hook or a CI step** running `bun run lint` so the open→proprietary boundary can't regress unnoticed. (Tasks 1.6/1.7)
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

**Type-safety / structural nits**
- **`run!` non-null assertion at scheduler dispatch** (`runtime/scheduler.ts`) — guarded by a throw; consistent with the existing `config!` ignore. Optionally restructure to narrow without the assertion. (Task 1.5)
- **`createAgent` regression guards via the observable boundary, not `QueryParams` interception** — `query()` is imported (not injected) and `mock.module` is flaky here. For stronger interception, **introduce a `query()` injection seam** or a non-flaky mock. (Task 4.4a)
- **In-memory `SessionStore` leniency + `SCHEMA_VERSION` hardcode** — `createInMemorySessionStore().saveMessage` is lenient on orphan messages (where `SessionDb` throws an FK error, out of the turn path); a `metadata===null` edge is out-of-contract; `SCHEMA_VERSION=5` is hardcoded to mirror `SessionDb`. Optionally tighten. (Task 2.1)
- **`TranscriptStoreOpts` not renamed** for symmetry with `FileTranscriptStore`; the no-op transcript-store test reads the impl rather than fs-scanning. (Task 2.2)
- **`WorkflowHost` literal duplicated across 3 callers** — deliberate trade-off vs. re-coupling to the wide `Runtime` type. Optionally factor into a shared helper. (Task 5.2)
- **Protocol client polish** — `parseEventFrame` keeps the last `data:` line rather than newline-joining; `streamEvents`' `finally` doesn't `reader.cancel()` on early break (abort signal is the intended teardown). Fine for this gateway; matters only for general-purpose SSE robustness. (Task 6.2)
- **`z.unknown()` keys infer as optional** under `exactOptionalPropertyTypes` — the protocol SSE types mirror this so the bidirectional conformance holds. Re-verify the `AssertEq` sentinels on a zod upgrade or a switch off `exactOptionalPropertyTypes`. (Task 6.1)
- **Sub-agent no-microcompaction test is weak as positive proof** — the real guarantee is in-code (no `microcompactConfig` reaches the native delegation path). Optionally spy that none reaches `query()`. (Task 4.5)

**Accepted-as-correct (informational, no action unless the contract changes)**
- `CreateSessionResponse.createdAt` is an ISO **string** (matches the handler's `toISOString()`; the conformance guard pins protocol == handler). (Task 6.1)
- Approvals request typed `PostApprovalRequest` despite a loose `unknown` parse — the handler runtime-validates after (the `turns.ts` cast-then-validate pattern). (Task 6.2)
- Task 8.1 added `export * from './client.js'` to `src/protocol/index.ts` — makes `./protocol` genuinely Contract #2; additive, boundary green. (Task 8.1)
- Unrelated `TaskOutput` in `src/workflows/template.ts` is distinct from the relocated tasks DTO; correctly left untouched. (Task 1.4c)

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
| §18.1 ratify architecture + §13 scope | CEO green-light 2026-06-29 (B-0014) |
| §18.2 transcripts/microcompaction on (B) surfaces | "Fix the gap": cron+mission gained microcompaction; cron gained transcripts; channels already had both; sub-agents + OpenAI pure parity |
| §18.3 Contract #2 type strategy | "Pure `.d.ts`": `src/protocol/` pure types + a zod-conformance guard on the proprietary side |
| §18.4 acceptance-bar sufficiency | The §15 gate is sufficient; no added manual pass |

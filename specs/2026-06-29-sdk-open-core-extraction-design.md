# Sovereign AI SDK — full-inversion extraction design (2026-06-29)

> **Status: GREEN-LIT by CEO (2026-06-29) — proceeding to plan + autonomous build (SOP-12).** Rigorous successor to the shape doc (`plans/2026-06-24-sdk-open-core-extraction-shape.md`). Ratifies the target architecture, the module boundary, the two public contracts, the SDK port surface, the seams, the strangler sequence, and the versioning model. Business decision: **B-0014**. Grounded by six code-level audits + a four-lens adversarial review (2026-06-29), all cited inline. Implementation plan: `plans/2026-06-29-sdk-open-core-extraction.md`.
>
> **Ratified CEO decisions (§18), 2026-06-29:** (1) target architecture + scope §13 approved as written; (2) **fix** the (B)-surface parity gap — cron/channels/mission **gain** transcripts + microcompaction via the new ports; (3) Contract #2 ships as **pure `.d.ts`** (no zod in the protocol package); (4) the §15 gate is the **sufficient** acceptance bar (no added manual pass required).
>
> **Revision note (v3):** an adversarial review corrected three load-bearing errors in v2 — the boundary was *not* "two leaf helpers" (there are 5 open→proprietary value edges, all leaves or invertible); the `run()` surface was too thin ("two seams" was really ~11 per-turn-bound params + live-reload); and several subsystems were unplaced. All corrected below; the corrections were **directly verified against HEAD**.

## 1. Prime directives (founder, 2026-06-29)

1. **Full inversion to a first-class SDK.** The reproducible agent-loop engine becomes an importable, versioned, open-core SDK (`@yevgetman/sov-sdk`). Everything else is rebuilt to run **on** it. End-state mirrors **Claude Code ↔ the Claude Agent SDK**: a lean SDK is the engine; the harness/TUI is an *interface wrapper*; apps (resume-as-code) are other consumers.
2. **Zero feature regression / full parity.** The harness keeps every capability and the same build quality. "What's currently the harness is **easily revived by building it from the SDK**."
3. **Downstream apps absorb SDK upgrades as semver.** Consumers pin a version and upgrade via ordinary bumps — never a rewrite.
4. **The SDK stays LEAN; parity is a property of the *composition*.** Lean ≠ feature-poor: the SDK is the engine + primitives + the **full per-turn parameter surface `query()` already accepts** + injectable ports. It adds **no new orchestration concepts** (no SSE, approval queue, compaction policy, live-reload — those stay proprietary). `SDK + proprietary packages + a thin wrapper` = full parity. Lean constrains the *concept count*, not the *parameter surface*.

Directives 2+3 are one move: every consumer binds to one versioned contract, and the harness is **consumer #0** — the in-repo canary that catches a break before any external app.

## 2. Target architecture — full inversion

```
  APPS            resume-as-code  ·  (future apps)                    ── consume SDK / Contract #2 ──
  ─────────────────────────────────────────────────────────────────────────────────────────────
  HARNESS         Go TUI  ·  sov drive  ·  CLI verbs  ·  channels  ·  cron            (thin wrappers)
  (wrapper app)        │ (A) HTTP/SSE                            │ (B) in-process
  ─────────────────────────────────────────────────────────────────────────────────────────────
  PROPRIETARY     gateway server (orchestration: SSE ring · approval queue · compaction policy ·
  PACKAGES        live-reload · principal isolation)  ·  learning  ·  workflows  ·  review ·
                  subscription-executor   (all built ON the SDK; gateway exposes Contract #2)
  ─────────────────────────────────────────────────────────────────────────────────────────────
  OPEN-CORE SDK   query() · createAgent() (full per-turn override) · scheduler/delegate ·
  @yevgetman/     Tool<I,O> · providers · MCP · hooks · skills · memory iface · transcript ·
  sov-sdk         compact(micro) · ports: SessionStore · config · recall · observe · trace ·
                  ToolContext-assembler · capability resolution · canonical tool descriptors
                  └─ Contract #1 (in-process) ─┘   └─ Contract #2 types in @…/sov-protocol ─┘
```

**Two versioned contracts.** **#1** — the in-process SDK surface (`@yevgetman/sov-sdk`). **#2** — the gateway wire protocol + typed client (`@yevgetman/sov-protocol`, open; the gateway *server* stays proprietary) for multi-tenant/remote consumers (Go TUI, `sov drive`, resume-as-code).

The harness is no longer the host — it is a **wrapper**: the Go TUI is a Contract #2 client; `sov gateway` is the proprietary server on the SDK; the in-process CLI verbs are thin `createAgent()` wrappers.

## 3. Grounding (verified against HEAD, 2026-06-29)

**What's already SDK-grade.** `query()` is a clean async generator (`src/core/query.ts:46`); `QueryParams` (`src/core/types.ts:101`) already accepts `recall`/`memoryManager`/`hookRunner`/`canUseTool`/`traceRecorder`/`microcompactConfig` as injected ports. `src/runtime/agentRunner.ts:130` is the de-facto `createAgent` body and returns the structured `AgentRunnerResult` (`agentRunner.ts:105-125`). Persistence opens **only** in `buildRuntime()` (`runtime.ts:1175`); `:memory:` already exists (`sessionDb.ts:308`). **Confirmed good news (disproven attack hypotheses):** open core does **not** pull `bun:sqlite` or the gateway at runtime — `bun:sqlite` lives only in `agent/sessionDb.ts` and is reached from open code only via *type-only* imports (erased); `workflows → scheduler` is the *correct* (proprietary→open) direction.

**The real boundary (correcting v2's "two leaf helpers").** There are **five** open→proprietary **value** edges — four are pure leaves that relocate, one inverts to an injected port:
| Open file:line | → proprietary | Fix |
|---|---|---|
| `core/query.ts:26` → `detectStall` | `review/stall.ts` (**pure leaf, 0 imports** ✓) | relocate to open `util/` |
| `scheduler.ts:34` → `findCapableModel` | `router/capabilities.ts` (**pure leaf, 0 imports** ✓) | relocate to open core |
| `scheduler.ts:43` → `runSubprocessExecutor` | `runtime/subprocessExecutor.ts` (proprietary) | **invert**: make it a required injected port; proprietary composition supplies it |
| `memory/`,`transcript/` → `validatePrincipalId` | `server/principals.ts:24` (pure) | relocate to open `util/` |
| `memory/scope.ts` → `tryGitProjectId` | `learning/project.ts:52` (pure) | relocate to open `util/` |

Plus **type-only** crossings that must relocate or become open port interfaces (compile away, but the boundary lint flags them): `core/types.ts:8` `RecallResult` (← learning-layer); `ToolContext` (`tool/types.ts`) references `LearningObserver` (:89), `ReviewManager` (:78), `TaskManager` (:74), `LaneRegistry` (:128), `DelegationLifecycleEvent` (:138); several `commands/*Ops.ts` import proprietary result types.

**The per-turn seam set (correcting v2's "two seams").** The gateway's single `query()` call (`turns.ts:745`) binds **eleven** values that vary per-turn/per-session, none of them standing config: `provider`, `model`, `effort` (live-mutated by `/effort`), `systemPrompt`, `tools` (skill-scoped via `buildToolScope`), `toolContext` (with `delegationLifecycleRecorder`+`effectivePool`), `memoryManager`, `recall`, `hookRunner`, `microcompactConfig`, `traceRecorder` — and the **compaction pivot** (`turns.ts:633,638`) re-resolves the *whole* `sessionCtx` against a new child id mid-turn, while **live-reload** mutates `runtime.provider/model/hookRunner/toolPool/compact` in place between turns (`runtime.ts:1651-1745`). These are the design driver for §5.2.

**Surface inventory.** Only 3 inline `query()` sites (`turns.ts:745`, `missionRun.ts:238`, `chatCompletions.ts:256`) and 3 `AgentRunner` sites (`scheduler.ts:457`, `cron/wiring.ts:255`, `channels/pipeline.ts:254`). The Go TUI + `sov drive` are **(A) over-gateway**; everything else **(B) in-process**. No surviving inline-query REPL (the `agentRunner.ts:15` comment is stale).

## 4. Module disposition — exhaustive (the boundary-lint manifest is FILE-level)

The cut is **file-granular, not dir-granular** — several proprietary dirs contain an open leaf and vice-versa. The boundary lint treats any *unclassified* import as a failure.

| Module | Disposition | Split / note |
|---|---|---|
| `core/`, `tool/`, `providers/`, `mcp/`, `hooks/`, `skills/`, `memory/`(iface), `transcript/`, `loop/`, `permissions/`, `agents/`, `context/`, `tools/` | **OPEN** | `core` relocates `detectStall`+`RecallResult`; `tool/ToolContext` proprietary fields → open port interfaces (§5.1); `tools/WebSearchTool.ts:61` ambient config read → thread via ToolContext |
| `trace/`, `trajectory/` | **OPEN** (writer sinks) | TraceEvent is here, not learning/; verify the writers are leaves, else expose as injected sink ports |
| `compact/` | **SPLIT** | `microcompact.ts` OPEN; `compactor.ts` OPEN-with-injected-deps (`SessionStore`/`TranscriptStore`/pricing/aux-client) — also consumed in-process by `cli/configMode.ts:298`, so it cannot be gateway-only |
| `bundle/` | **OPEN** (types+loader) | `bundle/types.ts` must be open (`memory`/`agents`/`context` depend on it); *minimization* is the deferred work, distinct from classification |
| `runtime/` | **SPLIT** | `agentRunner`, `scheduler`, `semaphores`, `pathLock` OPEN; `subprocessExecutor.ts` PROPRIETARY (invert the scheduler edge to a port) |
| `router/` | **SPLIT** | `capabilities.ts` (leaf) OPEN; the pure types `LaneRegistry`, `DelegationLifecycleEvent`/delegator schemas relocate to open core / `sov-protocol`; `stats.ts`, RouterProvider, task-routing PROPRIETARY |
| `review/` | **SPLIT** | `stall.ts` (leaf) → open `util/`; `manager.ts`/`fork`/`consolidate`/`proposal` PROPRIETARY (`manager.ts:5` imports `learning/synthesizer`) |
| `config/` | **SPLIT** | `loader.ts`+`schema.ts`(`Settings`, incl. `SubscriptionExecutorConfig`) OPEN; `liveApply.ts` PROPRIETARY/wrapper (mutates Runtime, imports `ui/theme`) |
| `commands/` | **SPLIT** | pure handlers OPEN; `pluginOps.ts`, `reviewOps.ts` (value-imports `review/`), `workflowOps.ts`, `routingStats.ts` PROPRIETARY-or-stub; relocate their router/workflow *result types* to open core |
| `tasks/` | **PROPRIETARY** | `TaskManager`/`TaskStore`; `ToolContext.taskManager` → open `TaskManagerPort` interface |
| `learning/`, `learning-layer/` | **PROPRIETARY** | recall/observe **port types** relocate to open; impls stay closed |
| `server/` | **PROPRIETARY** | gateway; exposes Contract #2; `principals.ts:24` validator → open `util/` |
| `agent/` | **PROPRIETARY** (impl) | `sessionDb.ts` (`bun:sqlite`) = the concrete impl of the open `SessionStore` port; `persistMessage` proprietary |
| `workflows/`, `plugins/`, `daemon/`, `cron/`, `channels/`, `router/`(rest) | **PROPRIETARY / surface** | gated; not needed for a bare turn |
| `ui/`, `openai/`, `cli/`, `mission/` | **WRAPPER** | harness surfaces (the `src/ui/*.ts` kit is legacy/dead; live UI is the Go TUI) |

## 5. Contract #1 — the SDK surface (`@yevgetman/sov-sdk`)

Lean in *concepts*, complete in *parameters*. The barrel `src/sdk.ts` via a package `exports` map.

### 5.1 Exports
- **Agent loop:** `query`; types `QueryParams`, `StreamEvent`, `Message`/`UserMessage`/`AssistantMessage`, `ContentBlock`, `Terminal`, `StopReason`, `TokenUsage`, `SystemSegment`, `MicrocompactConfig`.
- **Assembler:** `createAgent`; types `AgentConfig`, `Agent`, **`RunResult`** (= the promoted `AgentRunnerResult`: `sessionId`, `terminal`, `finalAssistant?`, `iterationsUsed`, `toolCallCount`, `distinctToolNames`, `messages`).
- **Delegation:** the `Scheduler` port (`delegate(DelegateInput): Promise<DelegateResult>` + `agentNames()`); types `DelegateInput`/`DelegateResult`. The `runSubprocessExecutor` hook becomes a **required injected port** on the scheduler (proprietary supplies it) with open port types `RunSubprocessExecutorOpts`/`SubprocessExecutorResult`.
- **Tool-context assembler:** `buildToolContext(sessionId, opts)` — promotes `buildSessionToolContext` logic out of `server/routes/`. `opts` carries `canUseTool?`, the per-turn `delegationLifecycleRecorder?` and `effectivePool?`, and the injected port impls. **Five** current consumers must migrate (gateway, OpenAI, cron, channels, workflows).
- **Tools:** `buildTool`; types `Tool`, `ToolDef`, `ToolContext`, `PermissionResult`, `CanUseTool`, `ToolObservation`; **canonical tool descriptors** (so the subscription-executor derives its name/key mapping instead of hardcoding `:146-168`).
- **Capability resolution:** `findCapableModel` (relocated from `router/capabilities.ts`).
- **Providers / MCP / hooks / skills:** `resolveProvider`, `LLMProvider`, `ResolvedProvider`, `ReasoningEffort`; the MCP client + types **+ a pool/factory port** (so (B) surfaces obtain MCP tools and the gateway keeps `reloadMcpServers` hot-swap); the hook-runner + `HookRunner`; the skill/slash loader + `buildToolScope` (skill-scoping).
- **Injected-port TYPES (impls stay proprietary), relocated into open core:** `RecallResult`+`RecallTurn` (recall), `ObserveInput`+`ObservationStatus` (observe), `TraceEvent` (from `trace/`), `MemoryRuntime` (memory), and **open port interfaces** replacing the proprietary classes ToolContext references: `LearningObserverPort` `{ observe(i: ObserveInput): void }`, `ReviewManagerPort`, `TaskManagerPort`, plus the relocated `LaneRegistry` + `DelegationLifecycleEvent` pure types.
- **Persistence / transcript:** `SessionStore` interface + `createInMemorySessionStore()`; `TranscriptStore` interface (so (B) surfaces can write transcripts — today they don't; §15 decides whether to add or accept).

### 5.2 `createAgent` — standing config + full per-turn override
`createAgent` is **more than wrapping `agentRunner`** — it adds `SessionStore` persistence (AgentRunner explicitly never persists, `agentRunner.ts:75`), the `observe`→`LearningObserverPort` adapter, and per-turn session pivoting. These are net-new engine logic (tracked in §16/§17).

```ts
type AgentConfig = {                 // standing DEFAULTS
  provider: string | LLMProvider; model: string;
  tools?: Tool[]; systemPrompt?: SystemSegment[] | string; cwd?: string;
  settings?: Settings;               // config OBJECT, not a path
  sessionStore?: SessionStore;       // omit → in-memory (no disk)
  transcripts?: TranscriptStore;     // omit → no transcript writes
  recall?: RecallTurn; observe?: (i: ObserveInput) => void;
  memoryManager?: MemoryRuntime; hookRunner?: HookRunner;
  traceRecorder?: (e: TraceEvent) => void; effort?: ReasoningEffort;
  microcompactConfig?: MicrocompactConfig; maxTokens?: number; maxTurns?: number;
};
// The per-turn override = the per-turn slice of QueryParams. Standing config
// supplies defaults; PerTurn wins. This is how the gateway carries the
// compaction pivot, live-reload, and per-turn port re-binding WITHOUT the SDK
// absorbing any orchestration logic — the host computes PerTurn, the SDK runs it.
type PerTurn = Partial<{
  signal: AbortSignal; canUseTool: CanUseTool; sessionId: string;
  provider: LLMProvider; model: string; tools: Tool[]; systemPrompt: SystemSegment[];
  effort: ReasoningEffort; memoryManager: MemoryRuntime; recall: RecallTurn;
  observe: (i: ObserveInput) => void; traceRecorder: (e: TraceEvent) => void;
  microcompactConfig: MicrocompactConfig; toolContext: ToolContext;
}>;
type Agent = {
  // Yields query()'s exact StreamEvent|Message stream UNCHANGED & in order
  // (pinned invariant, §16) and returns the STRUCTURED result.
  run(input: string | Message[], perTurn?: PerTurn): AsyncGenerator<StreamEvent | Message, RunResult>;
  buildToolContext(sessionId: string, opts?: BuildToolContextOpts): ToolContext;
};
```
Defaults: **no-disk, no-server, no-cron, no-learning** — a bare embeddable turn. The proprietary gateway keeps its orchestration (when to pivot, how to assemble `PerTurn`, live-reload) and drives **each** turn via `run(messages, perTurn)`. The SDK adds **no new concept** — `PerTurn` is exactly the parameter surface `query()` already exposes per-call.

### 5.3 Why this keeps the SDK lean *and* preserves behavior
The gateway's compaction pivot, `/effort`/`/model` live-reload, skill-scoped pools, per-session memory/recall/trace bindings, and approval-bus `canUseTool` rebind are **all** expressible as a fresh `PerTurn` the host computes each turn — because the host already computes them today (`turns.ts:745-810`). The SDK never sees SSE, the approval queue, or compaction policy. This is the resolution to every per-turn-seam finding: not "two seams," but "the host owns orchestration and passes the per-turn parameter slice."

## 6. Persistence & 7. config (confirmed)
- **`SessionStore`** — narrow interface (session lifecycle; save/load messages; `recordTokenUsage(sessionId, usage, estimatedCostUsd?)` — carries the cost figure). Concrete `bun:sqlite` `SessionDb` stays an impl; `createInMemorySessionStore()` is the open default. The `handle` getter (`sessionDb.ts:329`) leaking raw SQLite to `TaskStore`/`compactor` stays **off the port**. **Invariant:** the open dependency graph contains no `bun:sqlite` — the example-consumer canary (§15) asserts this.
- **Config** — thread `settings?: Settings` through `RuntimeOptions`/`createAgent` (validated object is the unit). Tidy two ambient reads: `resolver.ts:88` (already seamed) + `WebSearchTool.ts:61`. `query()` reads no config. `liveApply.ts` is wrapper/runtime-mutating (not a pure loader) and stays proprietary.

## 8. Contract #2 — gateway protocol + client (`@yevgetman/sov-protocol`, open)
Extract the SSE event union (`schema.ts:167`) + the six endpoints' request/response shapes (today inline casts/literals — `turns.ts:178`, `approvals.ts:61`, `sessions.ts:86`, `cancel.ts:51`, `health.ts:11` — must be **authored**). Relocate the 4 delegator schemas out of `router/progressEvents.ts:75`. Ship a thin typed client. **Decision:** pure `.d.ts` (zero runtime deps) vs. keep `zod` — recommend pure `.d.ts`, guarded by a surface-snapshot test. The gateway server *imports* the protocol (single source). The contract is already hand-copied **3×** (Go `types.go`, resume-as-code `contract.ts`, `schema.ts`) → collapse to **1 versioned source**.

## 9. Proprietary-package re-seat verdicts (all feasible; order matters)
- **Learning** — already injected via `recall`/`observe`; relocate port *types*; impl stays closed. (Note the `observe` function adapts into the `LearningObserverPort` object the orchestrator calls at `tool/types.ts:88`.)
- **Subscription-executor** — zero runtime harness imports; **but** its dispatch is fused into `scheduler.delegate()` (`scheduler.ts:412-446`) and gates the write-lock decision (`:282-285`). **Carve it out behind the injected port FIRST** (before the scheduler can be published open). Publish the 4 type groups + canonical tool descriptors; `SubscriptionExecutorConfig` stays in open `config/` (it derives from open `Settings`).
- **Workflows** — binds to the open `Scheduler.delegate` already; swap `buildSessionToolContext` (from `server/routes/`) for the SDK `buildToolContext`, and replace the wide `Runtime` type with a narrow handle. No behavioral change.
- **Review** — split: `stall.ts` open; `ReviewManager` proprietary (distinct from the server `ApprovalQueue`).
- **Gateway** — re-seat the single `query()` call (`turns.ts:745`) onto `agent.run(messages, perTurn)`, leaving ~1900 lines of orchestration (SSE ring, approval queue, principal isolation, persistence, compaction policy, live-reload) intact and proprietary; `mapStreamEventToServerEvent` keeps consuming the unchanged stream.

## 10. Surface re-seat (per-surface parity, not a blanket swap)
- **(A) gateway-backed (stay over Contract #2):** Go TUI, `sov drive`. "TUI on the SDK" = transitively, via the gateway-on-SDK.
- **(B) in-process (adopt `createAgent()`):** OpenAI server, `sov mission run`, cron, channels, sub-agents. **They assemble ToolContext three incompatible ways today** (shared `buildSessionToolContext`; bespoke `missionRun.ts:218-246`; derived child via `buildChildToolPool`). Each surface migrates behind its **own field-level parity test** — not one blanket "adopt createAgent." Mission run in particular must not silently gain/lose `learningObserver`/`subagentScheduler`/skill-filtering. **Known existing gap to preserve or fix deliberately:** `agentRunner` does *not* forward `microcompactConfig` today, so the (B) surfaces already run without microcompaction — §15 decides whether re-seat fixes this or preserves it.
- **Non-turn CLI verbs** (`sov dispatch`, `configMode`, learning/profile/trace/eval) are part of the §13.G wrapper rebuild and the §15.3 proof.

## 11. Versioning & upgrade-safety
Each open package gets its own semver line + `exports` map; surface-snapshot tests pin both contracts; harness = consumer #0; an in-repo example consumer compiles in CI (and asserts no `bun:sqlite` in the open graph). Breaking change = major bump + migration note.

## 12. Packaging — monorepo (founder choice)
`packages/sdk/` → `@yevgetman/sov-sdk`; `packages/protocol/` → `@yevgetman/sov-protocol`; the existing `@yevgetman/sov` = proprietary + wrapper, depending on both via workspace links through the same public ports. License flip + public publish **deferred**.

## 13. Scope
**In scope — full inversion to parity:** A boundary cleanup (relocate the 4 leaves + invert the executor port + relocate the type-only crossings) + a **file-level boundary lint**; B carve Contract #1 (`createAgent` w/ `PerTurn`, the ports, `SessionStore`, `RunResult`); C config-object injection; D re-seat the proprietary packages + the gateway turn-exec; E extract Contract #2; F adopt `createAgent` in the (B) surfaces (per-surface parity tests); G **rebuild the harness entrypoint as the thin wrapper** (the acceptance proof); H monorepo split + snapshot tests + example consumer.

**Deferred (publish/polish, not architecture):** OSS license flip + npm publish; SDK docs/examples polish; bundle *minimization*; Node compatibility (Bun-only v1); the resume-as-code migration *execution* (path defined §14); physical multi-repo split.

## 14. resume-as-code rebuild path (rebuilt, not preserved; fast-follow)
After the SDK ships, its agent loop is **torn out and re-implemented on the SDK** — adopt `@yevgetman/sov-protocol` (typed client + events) against a versioned gateway, replacing the ~100MB vendored binary + hand-rolled `client.ts`/`contract.ts` + env/`config.json` (→ typed options). `/chat/turns`+`/chat/events` proxy semantics stay. Thereafter, semver upgrades.

## 15. Acceptance criteria (the parity gate)
1. `bun run lint && typecheck && test` — green, **no regressions**.
2. **File-level boundary lint** (dependency-cruiser or a custom AST check — *new tooling*, not Biome): zero open→proprietary imports, against an explicit file manifest listing every exception (`principals.ts`, `capabilities.ts`, `stall.ts`, `subprocessExecutor.ts`, the `commands/*Ops.ts` set).
3. **Per-(B)-surface re-seat-equivalence tests:** each in-process surface forwards `recall`/`memoryManager`/`microcompactConfig`/`traceRecorder`/transcripts **identically** to today (catches silent drops the existing suite misses).
4. **Harness-from-SDK proof:** the harness entrypoint is a thin composition over `@yevgetman/sov-sdk` + the proprietary packages, and a **Go-TUI E2E** that *enumerates* the subsystems — a turn with tools, recall, a workflow, an approval round-trip, **micro + overflow compaction**, a **skill-scoped turn**, and one channel + one cron turn — passes on it.
5. **External-import canary:** `import { createAgent } from '@yevgetman/sov-sdk'` runs a turn against a mock/local provider with **no disk** and **no `bun:sqlite` in the dep graph**; compiles in CI.
6. **Contract surface-snapshots** (#1 + #2) + the **stream-passthrough invariant** test (§16) pass.
7. `sov upgrade` clean.

## 16. Risks & mitigations
- **The per-turn `PerTurn` surface + live-reload** are the heart. → Resolved by the host computing `PerTurn` each turn (§5.2/5.3); pin with the per-surface parity tests + a `/model`-swap-then-turn regression. *Re-seat the gateway last.*
- **Stream-passthrough invariant.** `agent.run()` must yield `query()`'s `StreamEvent|Message` stream unchanged and in order (the gateway's `persistMessage` timing + one-`turn_complete`-per-turn boundary depend on it). → Pin as an explicit SDK invariant + a sequence test.
- **Executor carve-out ordering.** The boundary lint can't go green until `runSubprocessExecutor` is inverted out of `delegate()` and `findCapableModel`/`detectStall` relocate. → §17 puts these in step 1, before the scheduler-port publish.
- **`buildToolContext` promotion** pulls proprietary fields. → Open port interfaces (`LearningObserverPort` etc.); proprietary supplies impls; snapshot-test the assembler input shape.
- **createAgent net-new logic** (SessionStore persistence, observe-adapter, per-turn pivot) — not a mechanical extraction. → Tracked as real work in §17, not a footnote.
- **MCP pool / transcripts / cost surface** placement. → §5.1 ports; §15.3 covers; cost figure rides `SessionStore.recordTokenUsage`.
- **Bun-only** narrows adoption. → Accepted v1; Node compat deferred.

## 17. Strangler work breakdown (re-ordered so each step preserves behavior)
1. **Boundary prep (must precede the lint going green):** relocate the 4 pure leaves (`detectStall`, `findCapableModel`, `validatePrincipalId`, `tryGitProjectId`) + `RecallResult`/`TraceEvent` types into open `util/`/core; define the open port interfaces (`LearningObserverPort`, `ReviewManagerPort`, `TaskManagerPort`, `LaneRegistry`, `DelegationLifecycleEvent`); **invert `runSubprocessExecutor` to a required injected port** (carve it out of `delegate()`, preserving the write-lock coupling with a pinned test); carve the `commands/*Ops.ts` proprietary files. Stand up the **file-level boundary lint** → GREEN.
2. `SessionStore` + in-memory default; `TranscriptStore` port; `settings?` object injection; tidy two ambient reads.
3. `createAgent()` + `PerTurn` + `RunResult` + `sdk.ts` barrel/`exports`; promote `buildToolContext(sessionId, opts)`; publish the ports + canonical tool descriptors + the MCP pool port. Pin the stream-passthrough invariant.
4. Adopt `createAgent()` in the (B) in-process surfaces — **one at a time, each behind its field-level parity test**.
5. Re-seat workflows + subscription-executor onto the SDK ports; gate green.
6. Extract `sov-protocol` (Contract #2); point the gateway + Go TUI at it.
7. Re-seat the gateway turn-exec onto `agent.run(messages, perTurn)` (the hard step, last); full suite + the enumerated Go-TUI E2E.
8. Monorepo `packages/` split + surface-snapshot tests + example consumer.
9. Rebuild the harness entrypoint as the thin wrapper (acceptance proof); docs + testing-log + `sov upgrade`; ship.

## 18. Open decisions for the CEO (green-light gate)
1. **Ratify the target architecture + scope §13** (full inversion to parity; deferreds as listed).
2. **Transcripts/microcompaction on (B) surfaces:** fix the existing gap (give cron/channels/mission transcripts + microcompaction via the new ports) or **preserve current behavior** (they stay without). Recommendation: fix — it's truer to "full parity."
3. **Contract #2 type strategy:** pure `.d.ts` (recommended) vs. keep `zod`.
4. **Acceptance bar:** is the §15 gate (incl. per-surface parity tests + enumerated E2E) sufficient, or add a manual pass.

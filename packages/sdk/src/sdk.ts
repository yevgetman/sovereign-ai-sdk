// src/sdk.ts — the importable Contract #1 surface (Phase 3 / Task 3.2).
//
// This barrel gathers the OPEN public SDK surface (`@yevgetman/sov-sdk`) into a
// single module so an external-style consumer can `import { createAgent } from`
// it and run a turn with no disk, no server, no learning. It is the in-process
// SDK entry point; the physical package split + the `exports` map are Phase 8.
//
// Authoritative surface: specs/2026-06-29-sdk-open-core-extraction-design.md §5.1.
//
// INVARIANTS (load-bearing):
//   - RE-EXPORT ONLY. No logic, no new behavior, no source changes live here.
//   - OPEN-only. This file is classified OPEN in the boundary manifest
//     (scripts/boundary-manifest.json → openRootFiles), so `bun run boundary`
//     ACTIVELY GATES its imports: re-exporting anything proprietary fails the
//     gate. That is the point — the barrel cannot leak the closed core.
//   - `.js` specifiers; `export type` for every type-only re-export
//     (verbatimModuleSyntax / isolatedModules).
//
// Every surface named in §5.1 is now exported here (Task 2.6 closed the last
// gap — the canonical tool descriptors). Task 2.9 then closed the reviewer-
// found NAMEABILITY gaps and froze the surface as the 0.1.0 semver contract
// (tests/sdk/surface.test.ts): every type referenced by a public field/method
// signature of an exported surface is itself nameable from this barrel —
// "lean in concepts, complete in parameters".

// ── Agent loop (core/) ──────────────────────────────────────────────────────
export { query } from './core/query.js';
export type {
  AssistantMessage,
  ContentBlock,
  LoopDetectionInfo,
  Message,
  MicrocompactInfo,
  QueryParams,
  Role,
  RouteDecisionInfo,
  StopReason,
  StreamEvent,
  SystemSegment,
  Terminal,
  TokenUsage,
  UserMessage,
} from './core/types.js';
export type { MicrocompactConfig } from './compact/microcompact.js';
// Cross-call usage accumulation (W1) — the exact per-call/summed token semantics
// the tool loop uses. Public so the gateway and external meters reuse them
// instead of re-deriving (re-deriving is how the turn-undercount bug happened).
export {
  accumulateUsage,
  createUsageAccumulator,
  finalizeUsage,
} from './core/usageAccumulator.js';
export type { UsageAccumulator } from './core/usageAccumulator.js';

// ── Assembler (agent/createAgent.js) ────────────────────────────────────────
export { createAgent } from './agent/createAgent.js';
export type { Agent, AgentConfig, PerTurn, RunResult } from './agent/createAgent.js';

// ── Tools (tool/ + permissions/) ────────────────────────────────────────────
export { buildTool } from './tool/buildTool.js';
// Tool-context assembler (§5.1) — the OPEN pure assembly; the proprietary
// per-session resolution stays in server/ and delegates to it.
export { buildToolContext } from './tool/buildToolContext.js';
export type { BuildToolContextInput } from './tool/buildToolContext.js';
export type {
  PermissionBehavior,
  PermissionResult,
  RenderHint,
  Tool,
  ToolContext,
  ToolDef,
  ToolObservation,
  ToolResult,
  ValidationResult,
} from './tool/types.js';
// `ResolvedPermissionResult` is CanUseTool's return type (Task 2.9 —
// referenced types must be nameable).
export type { CanUseTool, ResolvedPermissionResult } from './permissions/types.js';
// Open port interfaces that ToolContext binds (impls stay proprietary).
export type {
  LearningObserverPort,
  ReviewManagerPort,
  TaskManagerPort,
} from './tool/ports.js';
// The task DTOs `TaskManagerPort`'s method signatures reference (Task 2.9).
export type {
  CreateTaskInput,
  TaskOutput,
  TaskRecord,
  TaskState,
} from './core/taskPort.js';
// ToolContext / BuildToolContextInput field types (Task 2.9): the memory
// project-scope tag and the subdirectory-hint state.
export type { ProjectScope } from './memory/scope.js';
export type { SubdirectoryHintState } from './context/subdirectoryHints.js';
// Turn-scoped tool restrictions (skill/command scoping) — relocated OPEN to
// src/tool/toolScope.ts (formerly proprietary-by-location src/commands/).
export { buildToolScope } from './tool/toolScope.js';
export type { ToolScope } from './tool/toolScope.js';
// Canonical tool descriptors — the single source of truth for foreign→native
// tool identity (aliases, input-key renames, noise-key drops). The proprietary
// subscription-executor derives its observation canonicalization from these.
export {
  CANONICAL_TOOL_DESCRIPTORS,
  aliasToNativeName,
  dropsFor,
  renamesFor,
} from './tool/descriptors.js';
export type { CanonicalToolDescriptor } from './tool/descriptors.js';

// ── Delegation (runtime/scheduler + the executor / lane ports) ──────────────
// `SubagentScheduler` is the open in-process child-spawn implementation;
// `Scheduler` is the narrow port the workflow engine (and any embedder)
// consumes — delegate() + agentNames() only.
export { SubagentScheduler } from './runtime/scheduler.js';
export type {
  DelegateInput,
  DelegateResult,
  Scheduler,
  SubagentSchedulerOpts,
} from './runtime/scheduler.js';
// Task 2.9 — the types that make `SubagentScheduler` genuinely CONSTRUCTIBLE
// from the barrel alone (every SubagentSchedulerOpts / DelegateInput field is
// nameable). `LaneSemaphores` and `PathLockManager` are REQUIRED opts fields
// and classes, so they are VALUE exports — embedders must `new` them.
export { LaneSemaphores } from './runtime/laneSemaphores.js';
export type { LaneName, LaneSemaphoresOpts } from './runtime/laneSemaphores.js';
export { PathLockManager } from './runtime/pathLock.js';
export type { PathScope } from './runtime/pathLock.js';
// The agent registry the scheduler resolves delegations against (also a
// ToolContext / BuildToolContextInput field).
export type {
  AgentDefinition,
  AgentRegistry,
  AgentSource,
  AgentTrustTier,
} from './agents/types.js';
// Open config shapes referenced by the public surface (Task 2.9):
//   - `LaneConfig` — LaneRegistry.lookup/entries + SubagentSchedulerOpts.resolveLane.
//   - `SubscriptionExecutorConfig` — RunSubprocessExecutorOpts.config.
//   - `Settings` — AgentConfig.settings / ResolveProviderOpts.settings /
//     ToolContext.webSearch (an indexed sub-shape). Type-only: the shape is
//     supplied BY embedders, so it must be nameable.
export type { LaneConfig, Settings, SubscriptionExecutorConfig } from './config/schema.js';
// `ParsedPermissionRule` — ToolScope.rules element type (Task 2.9).
export type { ParsedPermissionRule } from './config/rules.js';
// The subscription-executor PORT contract (the impl stays proprietary; the
// composition root injects it as `RunSubprocessExecutor`).
export type {
  LearningSink,
  RunSubprocessExecutor,
  RunSubprocessExecutorOpts,
  SpawnFn,
  SpawnOpts,
  SpawnedProc,
  SubprocessExecutorResult,
  TraceSink,
} from './runtime/executorPort.js';
// Relocated pure delegation DTOs (the open homes of the router/review shapes).
export type {
  ChildCompletionEvent,
  DelegationLifecycleEvent,
  LaneRegistry,
} from './tool/ports.js';

// ── Providers (providers/) ──────────────────────────────────────────────────
export { resolveProvider } from './providers/resolver.js';
export type {
  ProviderPurpose,
  ResolveProviderOpts,
  ResolvedProvider,
} from './providers/resolver.js';
// Task 2.9 — `ProviderRequest` is the parameter of `LLMProvider.stream()`: an
// embedder implementing a custom provider must name it (and its closure —
// ToolSchema / ToolChoice). `Transport` + `AuthType` are ResolvedProvider
// fields; `ApiMode` is a Transport field.
export type {
  ApiMode,
  AuthType,
  LLMProvider,
  ProviderRequest,
  ToolChoice,
  ToolSchema,
  Transport,
} from './providers/types.js';
export type { ReasoningEffort } from './providers/effort.js';
// Metering / pricing (W4) — the public cost surface. `estimateCostUsd` prices a
// `TokenUsage` against the built-in `PRICE_TABLE` (readonly); `PRICING_VERSION`
// lets consumers (e.g. assay's `pricing_ref`) pin the exact table they priced
// against — it is bumped on ANY table change. `formatUsd` renders a dollar
// figure; `TokenPricesPerMillion` is a `PRICE_TABLE` entry's shape.
export { PRICE_TABLE, PRICING_VERSION, estimateCostUsd, formatUsd } from './providers/pricing.js';
export type { TokenPricesPerMillion } from './providers/pricing.js';

// ── MCP (mcp/) — client entrypoint, pool-factory port + public types ────────
export { buildMcpClientPool } from './mcp/client.js';
export type { BuildMcpClientPoolOpts, McpClientPoolFactory } from './mcp/client.js';
export { isRemoteMcpConfig } from './mcp/types.js';
export type {
  McpCallResult,
  McpClientPool,
  McpHttpServerConfig,
  McpRemoteServerFields,
  McpServerConfig,
  McpServerHandle,
  McpSseServerConfig,
  McpStdioServerConfig,
  McpToolMeta,
  RemoteMcpServerConfig,
} from './mcp/types.js';

// ── Hooks (hooks/) — runner factory + HookRunner ────────────────────────────
export { buildHookRunner } from './hooks/runner.js';
export type { BuildHookRunnerOpts } from './hooks/runner.js';
// Task 2.9 — HookRunner's own signature types (event name/payload/result) and
// BuildHookRunnerOpts' config + consent-gate types.
export type {
  HookCommandSpec,
  HookConfig,
  HookEvent,
  HookEventName,
  HookEventOf,
  HookResult,
  HookRunner,
} from './hooks/types.js';
export type {
  HookConsentChecker,
  HookConsentDecision,
  HookConsentOutcome,
} from './hooks/consent.js';

// ── Skills / slash commands (skills/ + commands/) ───────────────────────────
export { expandSkillPrompt, expandSkillText, loadSkills } from './skills/loader.js';
// `SkillRoot` is LoadSkillsOptions.extraRoots' element type;
// `SkillClassification` is SkillRoot.classify's return type (Task 2.9).
export type { LoadSkillsOptions, SkillClassification, SkillRoot } from './skills/loader.js';
export { buildSkillCommands } from './skills/commands.js';
export type {
  Skill,
  SkillExpansionOptions,
  SkillGuardDecision,
  SkillGuardFinding,
  SkillGuardLevel,
  SkillHarnessMetadata,
  SkillRegistry,
  SkillSource,
  SkillTrustTier,
} from './skills/types.js';
export type { PromptCommand } from './commands/types.js';

// ── Memory / transcript ─────────────────────────────────────────────────────
export type { MemoryRuntime } from './memory/provider.js';
export { createNoopTranscriptStore } from './persistence/noopTranscriptStore.js';
export type { TranscriptStore } from './persistence/transcriptStore.js';

// ── Persistence (session) ───────────────────────────────────────────────────
export { createInMemorySessionStore } from './persistence/inMemoryStore.js';
export type { SessionStore } from './persistence/sessionStore.js';
// The session DTOs `SessionStore`'s method signatures reference (Task 2.9).
export type {
  CreateSessionInput,
  SaveMessageInput,
  Session,
  StoredMessage,
} from './core/sessionPort.js';

// ── Injected-port types (impls stay proprietary) ────────────────────────────
export type { RecallTurn } from './core/types.js';
// `RecalledLesson` is RecallResult.lessons' element type (Task 2.9).
export type { RecallResult, RecalledLesson } from './core/recallPort.js';
export type { ObservationStatus, ObserveInput } from './core/observePort.js';
// `PermissionDecision` is the permission_check TraceEvent variant's field type.
export type { PermissionDecision, TraceEvent } from './trace/types.js';

// ── Assay usage wire (spec 2026-07-05) — the official token-accounting export.
// A traceRecorder that streams usage-only gen_ai spans to a local assay serve.
export { ASSAY_WIRE_VERSION, createAssayUsageRecorder } from './telemetry/assayUsageRecorder.js';
export type {
  AssayExportStats,
  AssayUsageRecorder,
  AssayUsageRecorderConfig,
} from './telemetry/assayUsageRecorder.js';

// ── Capability resolution ───────────────────────────────────────────────────
export { findCapableModel } from './core/capabilities.js';
// `CapabilityProfile` is findCapableModel's return type; `CapabilityRole` its
// recommendedRoles element type (Task 2.9).
export type { CapabilityProfile, CapabilityRole } from './core/capabilities.js';

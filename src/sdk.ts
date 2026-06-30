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
// Surfaces named in §5.1 but NOT yet exported here (added by later tasks — they
// either do not exist as an open module yet or live in a proprietary file):
//   - the delegation port (`Scheduler`/`delegate`, `DelegateInput`/`DelegateResult`,
//     the `runSubprocessExecutor` port types, `LaneRegistry`,
//     `DelegationLifecycleEvent`) — delegation-surface task;
//   - canonical tool descriptors — subscription-executor task;
//   - the MCP pool/factory port — MCP-pool task;
//   - `buildToolScope` (skill-scoping) — still lives in proprietary
//     `src/commands/toolScope.ts`; cannot be re-exported from an OPEN barrel.

// ── Agent loop (core/) ──────────────────────────────────────────────────────
export { query } from './core/query.js';
export type {
  AssistantMessage,
  ContentBlock,
  Message,
  QueryParams,
  StopReason,
  StreamEvent,
  SystemSegment,
  Terminal,
  TokenUsage,
  UserMessage,
} from './core/types.js';
export type { MicrocompactConfig } from './compact/microcompact.js';

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
  Tool,
  ToolContext,
  ToolDef,
  ToolObservation,
} from './tool/types.js';
export type { CanUseTool } from './permissions/types.js';
// Open port interfaces that ToolContext binds (impls stay proprietary).
export type {
  LearningObserverPort,
  ReviewManagerPort,
  TaskManagerPort,
} from './tool/ports.js';

// ── Providers (providers/) ──────────────────────────────────────────────────
export { resolveProvider } from './providers/resolver.js';
export type { ResolvedProvider } from './providers/resolver.js';
export type { LLMProvider } from './providers/types.js';
export type { ReasoningEffort } from './providers/effort.js';

// ── MCP (mcp/) — client entrypoint + public types (pool port is a later task) ─
export { buildMcpClientPool } from './mcp/client.js';
export type { BuildMcpClientPoolOpts } from './mcp/client.js';
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
export type { HookRunner } from './hooks/types.js';

// ── Skills / slash commands (skills/ + commands/) ───────────────────────────
export { expandSkillPrompt, expandSkillText, loadSkills } from './skills/loader.js';
export type { LoadSkillsOptions } from './skills/loader.js';
export { buildSkillCommands } from './skills/commands.js';
export type {
  Skill,
  SkillExpansionOptions,
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

// ── Injected-port types (impls stay proprietary) ────────────────────────────
export type { RecallTurn } from './core/types.js';
export type { RecallResult } from './core/recallPort.js';
export type { ObservationStatus, ObserveInput } from './core/observePort.js';
export type { TraceEvent } from './trace/types.js';

// ── Capability resolution ───────────────────────────────────────────────────
export { findCapableModel } from './core/capabilities.js';

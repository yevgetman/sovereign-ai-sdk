// Task 8.1 — the Contract #1 SURFACE SNAPSHOT for the `src/sdk.ts` barrel.
//
// This is the deliberate-change gate on the public SDK surface (`./sdk`): it
// pins the EXACT sorted set of runtime VALUE exports the barrel ships, so any
// accidental addition / removal / rename of an export fails CI until the
// expected list below is updated ON PURPOSE. It is the Phase-8 promotion of the
// "representative slice" guard in tests/sdk/barrel.test.ts to a full snapshot.
//
// Two halves:
//   1. VALUE surface — `Object.keys(* as sdk)` enumerates exactly the runtime
//      bindings (type-only `export type` re-exports erase, so they never appear
//      as keys); sorted, it must equal EXPECTED_VALUE_EXPORTS.
//   2. TYPE surface — a typecheck-only witness references every documented
//      `export type` name. If a type is removed or renamed in the barrel, this
//      file stops typechecking (`bun run typecheck` fails) — the type-erasure
//      blind spot the value snapshot cannot see.
//
// GUARD VERIFIED (Task 8.1): temporarily adding a dummy `export const __x = 1`
// to src/sdk.ts makes the value assertion FAIL (extra key); reverted.

import { describe, expect, test } from 'bun:test';
import * as sdk from '../../src/sdk.js';
import type {
  Agent,
  AgentConfig,
  AssistantMessage,
  BuildHookRunnerOpts,
  BuildMcpClientPoolOpts,
  BuildToolContextInput,
  CanUseTool,
  ChildCompletionEvent,
  ContentBlock,
  DelegateInput,
  DelegateResult,
  DelegationLifecycleEvent,
  HookRunner,
  LLMProvider,
  LaneRegistry,
  LearningObserverPort,
  LearningSink,
  LoadSkillsOptions,
  McpCallResult,
  McpClientPool,
  McpClientPoolFactory,
  McpHttpServerConfig,
  McpRemoteServerFields,
  McpServerConfig,
  McpServerHandle,
  McpSseServerConfig,
  McpStdioServerConfig,
  McpToolMeta,
  MemoryRuntime,
  Message,
  MicrocompactConfig,
  ObservationStatus,
  ObserveInput,
  PerTurn,
  PermissionBehavior,
  PermissionResult,
  PromptCommand,
  QueryParams,
  ReasoningEffort,
  RecallResult,
  RecallTurn,
  RemoteMcpServerConfig,
  ResolvedProvider,
  ReviewManagerPort,
  RunResult,
  RunSubprocessExecutor,
  RunSubprocessExecutorOpts,
  Scheduler,
  SessionStore,
  Skill,
  SkillExpansionOptions,
  SkillRegistry,
  SkillSource,
  SkillTrustTier,
  SpawnFn,
  SpawnOpts,
  SpawnedProc,
  StopReason,
  StreamEvent,
  SubagentSchedulerOpts,
  SubprocessExecutorResult,
  SystemSegment,
  TaskManagerPort,
  Terminal,
  TokenUsage,
  Tool,
  ToolContext,
  ToolDef,
  ToolObservation,
  ToolScope,
  TraceEvent,
  TraceSink,
  TranscriptStore,
  UserMessage,
} from '../../src/sdk.js';

/** The committed Contract #1 VALUE surface. Adding/removing/renaming a value
 *  export in src/sdk.ts must update THIS list in the same commit. Sorted to
 *  match `Object.keys(...).sort()` (enumeration order is not guaranteed). */
const EXPECTED_VALUE_EXPORTS: readonly string[] = [
  'SubagentScheduler',
  'buildHookRunner',
  'buildMcpClientPool',
  'buildSkillCommands',
  'buildTool',
  'buildToolContext',
  'buildToolScope',
  'createAgent',
  'createInMemorySessionStore',
  'createNoopTranscriptStore',
  'expandSkillPrompt',
  'expandSkillText',
  'findCapableModel',
  'isRemoteMcpConfig',
  'loadSkills',
  'query',
  'resolveProvider',
];

describe('sdk barrel — Contract #1 surface snapshot', () => {
  test('the value exports equal the committed snapshot exactly', () => {
    const actual = Object.keys(sdk).sort();
    expect(actual).toEqual([...EXPECTED_VALUE_EXPORTS]);
  });

  test('every snapshotted value export is actually defined', () => {
    for (const name of EXPECTED_VALUE_EXPORTS) {
      expect((sdk as Record<string, unknown>)[name]).toBeDefined();
    }
  });

  test('the type surface is pinned (this test only forces the witness to run)', () => {
    // The real guard is the type-only witness below: if any documented barrel
    // TYPE is removed/renamed, `bun run typecheck` fails on this file. The
    // runtime body just keeps biome/bun happy.
    const witness: TypeSurfaceWitness = {} as TypeSurfaceWitness;
    expect(typeof witness).toBe('object');
  });
});

/** Typecheck-only witness: one optional slot per documented `export type` from
 *  the barrel. A removed/renamed type breaks compilation here — the type-surface
 *  half of the snapshot (values are erased at runtime; types are not, so they
 *  need a compile-time pin). */
type TypeSurfaceWitness = {
  agent?: Agent;
  agentConfig?: AgentConfig;
  assistantMessage?: AssistantMessage;
  buildHookRunnerOpts?: BuildHookRunnerOpts;
  buildMcpClientPoolOpts?: BuildMcpClientPoolOpts;
  buildToolContextInput?: BuildToolContextInput;
  canUseTool?: CanUseTool;
  childCompletionEvent?: ChildCompletionEvent;
  contentBlock?: ContentBlock;
  delegateInput?: DelegateInput;
  delegateResult?: DelegateResult;
  delegationLifecycleEvent?: DelegationLifecycleEvent;
  hookRunner?: HookRunner;
  laneRegistry?: LaneRegistry;
  learningObserverPort?: LearningObserverPort;
  learningSink?: LearningSink;
  llmProvider?: LLMProvider;
  loadSkillsOptions?: LoadSkillsOptions;
  mcpCallResult?: McpCallResult;
  mcpClientPool?: McpClientPool;
  mcpClientPoolFactory?: McpClientPoolFactory;
  mcpHttpServerConfig?: McpHttpServerConfig;
  mcpRemoteServerFields?: McpRemoteServerFields;
  mcpServerConfig?: McpServerConfig;
  mcpServerHandle?: McpServerHandle;
  mcpSseServerConfig?: McpSseServerConfig;
  mcpStdioServerConfig?: McpStdioServerConfig;
  mcpToolMeta?: McpToolMeta;
  memoryRuntime?: MemoryRuntime;
  message?: Message;
  microcompactConfig?: MicrocompactConfig;
  observationStatus?: ObservationStatus;
  observeInput?: ObserveInput;
  permissionBehavior?: PermissionBehavior;
  permissionResult?: PermissionResult;
  perTurn?: PerTurn;
  promptCommand?: PromptCommand;
  queryParams?: QueryParams;
  reasoningEffort?: ReasoningEffort;
  recallResult?: RecallResult;
  recallTurn?: RecallTurn;
  remoteMcpServerConfig?: RemoteMcpServerConfig;
  resolvedProvider?: ResolvedProvider;
  reviewManagerPort?: ReviewManagerPort;
  runResult?: RunResult;
  runSubprocessExecutor?: RunSubprocessExecutor;
  runSubprocessExecutorOpts?: RunSubprocessExecutorOpts;
  scheduler?: Scheduler;
  sessionStore?: SessionStore;
  skill?: Skill;
  skillExpansionOptions?: SkillExpansionOptions;
  skillRegistry?: SkillRegistry;
  skillSource?: SkillSource;
  skillTrustTier?: SkillTrustTier;
  spawnedProc?: SpawnedProc;
  spawnFn?: SpawnFn;
  spawnOpts?: SpawnOpts;
  stopReason?: StopReason;
  streamEvent?: StreamEvent;
  subagentSchedulerOpts?: SubagentSchedulerOpts;
  subprocessExecutorResult?: SubprocessExecutorResult;
  systemSegment?: SystemSegment;
  taskManagerPort?: TaskManagerPort;
  terminal?: Terminal;
  tokenUsage?: TokenUsage;
  tool?: Tool<unknown, unknown>;
  toolContext?: ToolContext;
  toolDef?: ToolDef<unknown, unknown>;
  toolObservation?: ToolObservation;
  toolScope?: ToolScope;
  traceEvent?: TraceEvent;
  traceSink?: TraceSink;
  transcriptStore?: TranscriptStore;
  userMessage?: UserMessage;
};

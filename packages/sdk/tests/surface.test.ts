// ═══════════════════════════════════════════════════════════════════════════
// THE 0.1.0 SEMVER CONTRACT (Task 2.9 — the FREEZE).
//
// This snapshot IS the published surface contract of the open SDK barrel
// (`src/sdk.ts` → `@yevgetman/sov-sdk`), frozen at 0.1.0:
//   • REMOVING or RENAMING any export listed below (value OR type) is a
//     BREAKING change → major version bump.
//   • ADDING an export is additive → minor version bump (update the snapshot
//     in the same commit, deliberately).
//   • Only export NAMES are frozen — type SHAPES are not: a shape change
//     compiles clean here and is semver-judged at change time.
// The Phase-3 move into packages/sdk must carry this surface over UNCHANGED.
// ═══════════════════════════════════════════════════════════════════════════
//
// This is the deliberate-change gate on the public SDK surface (`./sdk`): it
// pins the EXACT sorted set of runtime VALUE exports the barrel ships, so any
// accidental addition / removal / rename of an export fails CI until the
// expected list below is updated ON PURPOSE.
//
// Two halves:
//   1. VALUE surface — `Object.keys(* as sdk)` enumerates exactly the runtime
//      bindings (type-only `export type` re-exports erase, so they never appear
//      as keys); sorted, it must equal EXPECTED_VALUE_EXPORTS.
//   2. TYPE surface — a typecheck-only witness references every documented
//      `export type` name. If a type is removed or renamed in the barrel, this
//      file stops typechecking (`bun run typecheck` fails) — the type-erasure
//      blind spot the value snapshot cannot see. Type ADDITIONS are caught at
//      runtime by the barrel-parse test below (set-equality with the witness).
//
// GUARD VERIFIED (Task 8.1): temporarily adding a dummy `export const __x = 1`
// to src/sdk.ts makes the value assertion FAIL (extra key); reverted.
//
// ── Documented EXCLUSIONS (Task 2.9 dangling-ref sweep) ─────────────────────
// Every type referenced by a public field/method signature of the surface is
// itself on the barrel, EXCEPT the following, excluded deliberately:
//   • `CommandContext` (src/commands/types.ts) — the parameter of
//     `PromptCommand.getPromptForCommand`. It is the HOST-SURFACE services
//     record (~40 fields of REPL/TUI/server hooks: pickers, config live-apply,
//     session metrics, review/task ports…). Embedders RECEIVE PromptCommands
//     from `buildSkillCommands` and hand them to a host dispatcher; they never
//     construct a CommandContext. Exporting it would drag ~18 wrapper-surface
//     types (PickerOpenConfig, ScopeBadge, BudgetReport, SessionMetrics,
//     RoutingStatsSnapshot, WorkflowCommandCapability, …) into this frozen
//     contract. Nameable when genuinely needed via
//     `Parameters<PromptCommand['getPromptForCommand']>[1]`.
//   • `zod` schema types (`ToolDef.inputSchema` / `outputSchema`: `z.ZodType`)
//     — an EXTERNAL package's types; consumers import them from `zod`.
//   • Ambient globals (`AbortSignal`, `ReadableStream`, `Set`,
//     `NodeJS.ProcessEnv`) — provided by the platform/lib types, not the SDK.
// Everything else exported by open modules but NOT referenced by any public
// surface signature stays OFF the barrel by design — module-internal helpers
// (`shouldFireReviewOnDelegation`, `filterParseableRules`, `scopesOverlap`,
// `HookOutput`, `PermissionRule`/`PermissionRuleLayer`, zod schema VALUES,
// effort-budget constants, …). The exact-equality assertion below enforces
// this for values; the witness (which references EVERY exported type — a
// removal breaks typecheck) is the type half.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sdk from '@yevgetman/sov-sdk';
import type {
  Agent,
  AgentConfig,
  AgentDefinition,
  AgentRegistry,
  AgentSource,
  AgentTrustTier,
  ApiMode,
  AssayExportStats,
  AssayUsageRecorder,
  AssayUsageRecorderConfig,
  AssistantMessage,
  AuthType,
  BuildHookRunnerOpts,
  BuildMcpClientPoolOpts,
  BuildToolContextInput,
  CanUseTool,
  CanonicalToolDescriptor,
  CapabilityProfile,
  CapabilityRole,
  ChildCompletionEvent,
  ContentBlock,
  CreateSessionInput,
  CreateTaskInput,
  DelegateInput,
  DelegateResult,
  DelegationLifecycleEvent,
  HookCommandSpec,
  HookConfig,
  HookConsentChecker,
  HookConsentDecision,
  HookConsentOutcome,
  HookEvent,
  HookEventName,
  HookEventOf,
  HookResult,
  HookRunner,
  LLMProvider,
  LaneConfig,
  LaneName,
  LaneRegistry,
  LaneSemaphores,
  LaneSemaphoresOpts,
  LearningObserverPort,
  LearningSink,
  LoadSkillsOptions,
  LoopDetectionInfo,
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
  MicrocompactInfo,
  ObservationStatus,
  ObserveInput,
  ParsedPermissionRule,
  PathLockManager,
  PathScope,
  PerTurn,
  PermissionBehavior,
  PermissionDecision,
  PermissionResult,
  ProjectScope,
  PromptCommand,
  ProviderPurpose,
  ProviderRequest,
  QueryParams,
  ReasoningEffort,
  RecallResult,
  RecallTurn,
  RecalledLesson,
  RemoteMcpServerConfig,
  RenderHint,
  ResolveProviderOpts,
  ResolvedPermissionResult,
  ResolvedProvider,
  ReviewManagerPort,
  Role,
  RouteDecisionInfo,
  RunResult,
  RunSubprocessExecutor,
  RunSubprocessExecutorOpts,
  SaveMessageInput,
  Scheduler,
  Session,
  SessionStore,
  Settings,
  Skill,
  SkillClassification,
  SkillExpansionOptions,
  SkillGuardDecision,
  SkillGuardFinding,
  SkillGuardLevel,
  SkillHarnessMetadata,
  SkillRegistry,
  SkillRoot,
  SkillSource,
  SkillTrustTier,
  SpawnFn,
  SpawnOpts,
  SpawnedProc,
  StopReason,
  StoredMessage,
  StreamEvent,
  SubagentScheduler,
  SubagentSchedulerOpts,
  SubdirectoryHintState,
  SubprocessExecutorResult,
  SubscriptionExecutorConfig,
  SystemSegment,
  TaskManagerPort,
  TaskOutput,
  TaskRecord,
  TaskState,
  Terminal,
  TokenPricesPerMillion,
  TokenUsage,
  Tool,
  ToolChoice,
  ToolContext,
  ToolDef,
  ToolObservation,
  ToolResult,
  ToolSchema,
  ToolScope,
  TraceEvent,
  TraceSink,
  TranscriptStore,
  Transport,
  TurnLogEvent,
  TurnLogKind,
  TurnLogRecord,
  TurnLogRecorder,
  TurnLogRecorderOptions,
  TurnLogRecorderStats,
  TurnLogRole,
  TurnLogSink,
  UsageAccumulator,
  UserMessage,
  ValidationResult,
} from '@yevgetman/sov-sdk';

/** The committed 0.1.0 VALUE surface (Contract #1). Adding/removing/renaming a
 *  value export in src/sdk.ts must update THIS list in the same commit —
 *  removal/rename = major bump, addition = minor bump. Sorted to match
 *  `Object.keys(...).sort()` (enumeration order is not guaranteed). */
const EXPECTED_VALUE_EXPORTS: readonly string[] = [
  'ASSAY_WIRE_VERSION',
  'CANONICAL_TOOL_DESCRIPTORS',
  'LaneSemaphores',
  'PRICE_TABLE',
  'PRICING_VERSION',
  'PathLockManager',
  'SubagentScheduler',
  'accumulateUsage',
  'aliasToNativeName',
  'buildHookRunner',
  'buildMcpClientPool',
  'buildSkillCommands',
  'buildTool',
  'buildToolContext',
  'buildToolScope',
  'createAgent',
  'createAssayUsageRecorder',
  'createInMemorySessionStore',
  'createNoopTranscriptStore',
  'createTurnLogRecorder',
  'createUsageAccumulator',
  'dropsFor',
  'estimateCostUsd',
  'expandSkillPrompt',
  'expandSkillText',
  'finalizeUsage',
  'findCapableModel',
  'formatUsd',
  'isRemoteMcpConfig',
  'loadSkills',
  'query',
  'renamesFor',
  'resolveProvider',
];

describe('sdk barrel — the 0.1.0 semver-contract surface snapshot', () => {
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

  test('every barrel `export type` name is witnessed — a type ADDITION fails here', () => {
    // The witness catches type REMOVALS (typecheck breaks), but a NEW
    // `export type` on the barrel would compile without touching this file —
    // and its later removal would then be unguarded. So: parse the barrel's
    // `export type { ... }` blocks and require SET-EQUALITY with the names this
    // file imports (minus the classes, which the VALUE snapshot already pins).
    const here = dirname(fileURLToPath(import.meta.url));
    const barrel = readFileSync(join(here, '..', 'src', 'sdk.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, ''); // strip comments before parsing
    // Parser premise (a barrel INVARIANT): sdk.ts is RE-EXPORT ONLY. A local
    // `export type X =` / `export interface X` would evade the brace parser
    // below, so its absence is asserted first.
    expect(barrel.match(/export\s+(type|interface)\s+[A-Za-z_$]/)).toBeNull();
    const exported = [...barrel.matchAll(/export\s+type\s*\{([^}]*)\}/g)]
      .flatMap((m) => (m[1] ?? '').split(','))
      .map(
        (name) =>
          name
            .trim()
            .split(/\s+as\s+/)
            .pop() ?? '',
      )
      .filter((name) => name.length > 0)
      .sort();
    const witnessImport = readFileSync(fileURLToPath(import.meta.url), 'utf8').match(
      /import type \{([^}]*)\} from '@yevgetman\/sov-sdk'/,
    );
    const witnessed = (witnessImport?.[1] ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0 && !EXPECTED_VALUE_EXPORTS.includes(name))
      .sort();
    expect(exported).toEqual(witnessed);
  });
});

/** Typecheck-only witness: one optional slot per documented `export type` from
 *  the barrel (class exports appear via their instance types — their NAMES are
 *  pinned by the value snapshot above). A removed/renamed type breaks
 *  compilation here — the type-surface half of the 0.1.0 contract (values are
 *  erased at runtime; types are not, so they need a compile-time pin). */
type TypeSurfaceWitness = {
  agent?: Agent;
  agentConfig?: AgentConfig;
  agentDefinition?: AgentDefinition;
  agentRegistry?: AgentRegistry;
  agentSource?: AgentSource;
  agentTrustTier?: AgentTrustTier;
  apiMode?: ApiMode;
  assayExportStats?: AssayExportStats;
  assayUsageRecorder?: AssayUsageRecorder;
  assayUsageRecorderConfig?: AssayUsageRecorderConfig;
  assistantMessage?: AssistantMessage;
  authType?: AuthType;
  buildHookRunnerOpts?: BuildHookRunnerOpts;
  buildMcpClientPoolOpts?: BuildMcpClientPoolOpts;
  buildToolContextInput?: BuildToolContextInput;
  canonicalToolDescriptor?: CanonicalToolDescriptor;
  canUseTool?: CanUseTool;
  capabilityProfile?: CapabilityProfile;
  capabilityRole?: CapabilityRole;
  childCompletionEvent?: ChildCompletionEvent;
  contentBlock?: ContentBlock;
  createSessionInput?: CreateSessionInput;
  createTaskInput?: CreateTaskInput;
  delegateInput?: DelegateInput;
  delegateResult?: DelegateResult;
  delegationLifecycleEvent?: DelegationLifecycleEvent;
  hookCommandSpec?: HookCommandSpec;
  hookConfig?: HookConfig;
  hookConsentChecker?: HookConsentChecker;
  hookConsentDecision?: HookConsentDecision;
  hookConsentOutcome?: HookConsentOutcome;
  hookEvent?: HookEvent;
  hookEventName?: HookEventName;
  hookEventOfStop?: HookEventOf<'Stop'>;
  hookResult?: HookResult;
  hookRunner?: HookRunner;
  laneConfig?: LaneConfig;
  laneName?: LaneName;
  laneRegistry?: LaneRegistry;
  laneSemaphores?: LaneSemaphores;
  laneSemaphoresOpts?: LaneSemaphoresOpts;
  learningObserverPort?: LearningObserverPort;
  learningSink?: LearningSink;
  llmProvider?: LLMProvider;
  loadSkillsOptions?: LoadSkillsOptions;
  loopDetectionInfo?: LoopDetectionInfo;
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
  microcompactInfo?: MicrocompactInfo;
  observationStatus?: ObservationStatus;
  observeInput?: ObserveInput;
  parsedPermissionRule?: ParsedPermissionRule;
  pathLockManager?: PathLockManager;
  pathScope?: PathScope;
  permissionBehavior?: PermissionBehavior;
  permissionDecision?: PermissionDecision;
  permissionResult?: PermissionResult;
  perTurn?: PerTurn;
  projectScope?: ProjectScope;
  promptCommand?: PromptCommand;
  providerPurpose?: ProviderPurpose;
  providerRequest?: ProviderRequest;
  queryParams?: QueryParams;
  reasoningEffort?: ReasoningEffort;
  recalledLesson?: RecalledLesson;
  recallResult?: RecallResult;
  recallTurn?: RecallTurn;
  remoteMcpServerConfig?: RemoteMcpServerConfig;
  renderHint?: RenderHint;
  resolvedPermissionResult?: ResolvedPermissionResult;
  resolvedProvider?: ResolvedProvider;
  resolveProviderOpts?: ResolveProviderOpts;
  reviewManagerPort?: ReviewManagerPort;
  role?: Role;
  routeDecisionInfo?: RouteDecisionInfo;
  runResult?: RunResult;
  runSubprocessExecutor?: RunSubprocessExecutor;
  runSubprocessExecutorOpts?: RunSubprocessExecutorOpts;
  saveMessageInput?: SaveMessageInput;
  scheduler?: Scheduler;
  session?: Session;
  sessionStore?: SessionStore;
  settings?: Settings;
  skill?: Skill;
  skillClassification?: SkillClassification;
  skillExpansionOptions?: SkillExpansionOptions;
  skillGuardDecision?: SkillGuardDecision;
  skillGuardFinding?: SkillGuardFinding;
  skillGuardLevel?: SkillGuardLevel;
  skillHarnessMetadata?: SkillHarnessMetadata;
  skillRegistry?: SkillRegistry;
  skillRoot?: SkillRoot;
  skillSource?: SkillSource;
  skillTrustTier?: SkillTrustTier;
  spawnedProc?: SpawnedProc;
  spawnFn?: SpawnFn;
  spawnOpts?: SpawnOpts;
  stopReason?: StopReason;
  storedMessage?: StoredMessage;
  streamEvent?: StreamEvent;
  subagentScheduler?: SubagentScheduler;
  subagentSchedulerOpts?: SubagentSchedulerOpts;
  subdirectoryHintState?: SubdirectoryHintState;
  subprocessExecutorResult?: SubprocessExecutorResult;
  subscriptionExecutorConfig?: SubscriptionExecutorConfig;
  systemSegment?: SystemSegment;
  taskManagerPort?: TaskManagerPort;
  taskOutput?: TaskOutput;
  taskRecord?: TaskRecord;
  taskState?: TaskState;
  terminal?: Terminal;
  tokenPricesPerMillion?: TokenPricesPerMillion;
  tokenUsage?: TokenUsage;
  tool?: Tool<unknown, unknown>;
  toolChoice?: ToolChoice;
  toolContext?: ToolContext;
  toolDef?: ToolDef<unknown, unknown>;
  toolObservation?: ToolObservation;
  toolResult?: ToolResult<unknown>;
  toolSchema?: ToolSchema;
  toolScope?: ToolScope;
  traceEvent?: TraceEvent;
  traceSink?: TraceSink;
  transcriptStore?: TranscriptStore;
  transport?: Transport;
  turnLogEvent?: TurnLogEvent;
  turnLogKind?: TurnLogKind;
  turnLogRecord?: TurnLogRecord;
  turnLogRecorder?: TurnLogRecorder;
  turnLogRecorderOptions?: TurnLogRecorderOptions;
  turnLogRecorderStats?: TurnLogRecorderStats;
  turnLogRole?: TurnLogRole;
  turnLogSink?: TurnLogSink;
  usageAccumulator?: UsageAccumulator;
  userMessage?: UserMessage;
  validationResult?: ValidationResult;
};

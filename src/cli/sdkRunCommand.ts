/** Native headless host. No server, no preflight inference, and one SDK store writer. */
import { createHash, randomUUID } from 'node:crypto';
import type { RunResult } from '@yevgetman/sov-sdk/agent/createAgent';
import {
  LOGICAL_TURN_LEASE_MS,
  LOGICAL_TURN_RECOVERY_CAPABILITY,
  LogicalTurnLeaseError,
  logicalTurnCursor,
  logicalTurnWorkSignal,
  superviseLogicalTurn,
} from '@yevgetman/sov-sdk/agent/logicalTurn';
import type { LogicalTurnRecord } from '@yevgetman/sov-sdk/agent/logicalTurn';
import { ContextManagementError } from '@yevgetman/sov-sdk/compact/contextManagement';
import { resolveHarnessHome } from '@yevgetman/sov-sdk/config/paths';
import {
  ConfigurationError,
  type RuntimeSettingsSnapshot,
  loadHookSettings,
  loadMcpServerSettings,
  loadPermissionSettings,
  loadRuntimeSettingsSnapshot,
} from '@yevgetman/sov-sdk/config/settings';
import { AMBIGUOUS_MAX_TOKENS_TOOL_NOTE } from '@yevgetman/sov-sdk/core/query';
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  TokenUsage,
} from '@yevgetman/sov-sdk/core/types';
import { toToolSchemas } from '@yevgetman/sov-sdk/mcp/schemaSerialization';
import { FENCE_PREAMBLE } from '@yevgetman/sov-sdk/memory/injection';
import type { SessionStore } from '@yevgetman/sov-sdk/persistence/sessionStore';
import {
  ContextOverflowError,
  PersistBeforeRunError,
  SessionPersistenceError,
  SubscriptionAuthExpiredError,
  SubscriptionHttpError,
  SubscriptionRefreshError,
  SubscriptionStreamError,
  SubscriptionTierBlockedError,
  ToolStorageError,
  UnknownToolsetError,
  isContextOverflowError,
} from '@yevgetman/sov-sdk/providers/errors';
import { verifiedSubscriptionImageInput } from '@yevgetman/sov-sdk/providers/models/imageInput';
import { type ModelRecord, findModel } from '@yevgetman/sov-sdk/providers/models/index';
import { validateModelRequest } from '@yevgetman/sov-sdk/providers/models/validateRequest';
import {
  RouteError,
  getRoute,
  resolveRouteProvider,
  routeErrorCodeFor,
  routeSupportsImages,
} from '@yevgetman/sov-sdk/providers/routes/index';
import { modelInputTokenAccounting } from '@yevgetman/sov-sdk/providers/tokenAccounting';
import type { SkillContinuityPort } from '@yevgetman/sov-sdk/skills/continuity';
import { isToolsetName } from '@yevgetman/sov-sdk/tool/toolset';
import { defaultMaxTurns } from '@yevgetman/sov-sdk/tool/toolset';
import { persistMessage } from '../agent/persistMessage.js';
import { LogicalTurnRecordError, SessionDb, type StoredMessage } from '../agent/sessionDb.js';
import { SessionNotFoundError } from '../server/errors.js';
import {
  modelSystemPrompt,
  selectedTurnModel,
  shouldCompactModelRequest,
} from '../server/modelMetadata.js';
import { buildRuntime } from '../server/runtime.js';
import type { Runtime, RuntimeOptions } from '../server/runtime.js';
import {
  appendInstructions,
  buildTurnCanUseTool,
  clearSkillCeiling,
  composeTurn,
  createSteeringPoller,
  gateTurnInstructions,
  headlessDenyAsk,
  hydrateSessionHistory,
  loadStoredMessages,
  persistTurnMessage,
  restoreLogicalTurnSkillCeiling,
  stampLogicalTurnSkillCeiling,
} from '../server/turnComposition.js';
import { mapTerminalReason } from '../server/turnRelay.js';
import { readModelCatalogSnapshot } from './modelDiscovery.js';
import { hasNativeRecoveryTarget } from './nativeRunOutcome.js';
import { type NativeReceipt, nativeTurnMetrics, nativeUsageMeter } from './nativeTurnMetrics.js';
import type { RunCommandIO, RunOptions } from './runCommand.js';
import { SdkInputError, parseSdkInput, readSdkStdin } from './sdkInput.js';

type SelectedRoute = Awaited<ReturnType<typeof resolveRouteProvider>>;
export type SdkRunDependencies = {
  resolve?: typeof resolveRouteProvider;
  runtime?: (opts: RuntimeOptions) => Promise<Runtime>;
  signal?: AbortSignal;
};
const ERRORS: Record<string, string> = {
  invalid_input: 'Invalid native SDK input or options.',
  route_unavailable: 'Selected authentication route is unavailable.',
  model_unsupported: 'Model is not supported by the selected route.',
  effort_unsupported: 'Effort is not supported by the selected model.',
  credential_missing: 'Selected route needs a configured key or external login.',
  auth_expired: 'Selected subscription login expired. Sign in again externally.',
  credential_unavailable: 'Selected credential store is unavailable.',
  tier_blocked: 'Selected subscription tier cannot use this inference path.',
  rate_limited: 'Selected provider is rate limited.',
  context_overflow:
    'Model context budget cannot fit this request. Reduce instructions, history or tools, or use verified model limits.',
  unsupported_input: 'Selected route does not support this input.',
  interrupted: 'Turn interrupted.',
  storage_failed: 'Session storage failed. No automatic retry was performed.',
  configuration_invalid:
    'Runtime configuration is invalid. Check the settings and skill approval list.',
  runtime_start_failed: 'Runtime could not start. Check local runtime diagnostics.',
  provider_request_rejected:
    'Selected provider rejected this request. No route fallback was performed.',
  provider_failed: 'Selected provider failed. No route fallback was performed.',
  provider_unavailable: 'Subscription token service is unavailable. Wait and retry.',
  provider_timeout: 'Subscription token refresh timed out. Retry when the service is available.',
  provider_response_invalid:
    'Subscription token service returned an invalid response. Check provider status before retrying.',
  continuation_exhausted: 'Logical turn exhausted its cumulative recovery budget.',
  continuation_stalled: 'Logical turn stopped after two attempts made no progress.',
  continuation_failed: 'Logical turn failed and cannot continue.',
  recovery_unsafe: 'Logical turn cannot continue because a tool effect is not safely replayable.',
  recovery_state_invalid: 'Logical turn recovery state is invalid.',
  logical_turn_leased:
    'A live owner is busy with this logical turn. Continue a crashed owner after the lease expires.',
};
/** Same code as the model-call cap. The sentence names the deadline, not that cap. */
const DEADLINE_EXHAUSTED_ERROR = 'Logical turn reached its deadline.';
const UNKNOWN_LOGICAL_TURN = 'logical turn does not exist';
const MISSING_LOGICAL_TURN_ROUTE = 'logical turn route is missing';
const STDIN_CONTINUE_CLASH = '--stdin cannot be combined with --continue-logical-turn';
/** A failed row may resume only when its stored cause is one of these. */
const SAFE_TRANSIENT_CAUSES = new Set([
  'transient_provider',
  'rate_limited',
  'provider_unavailable',
  'provider_timeout',
]);

function isSafeTransientFailure(record: LogicalTurnRecord): boolean {
  return [record.finishReason, record.lastCause].some(
    (cause) => cause !== undefined && SAFE_TRANSIENT_CAUSES.has(cause),
  );
}

/** Text of the latest human user turn, skipping tool results and runtime markers. */
function latestHumanUserText(messages: readonly Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== 'user' || message.origin === 'runtime') continue;
    if (message.content.some((block) => block.type === 'tool_result')) continue;
    const text = message.content.find((block) => block.type === 'text');
    return text?.type === 'text' ? text.text : undefined;
  }
  return undefined;
}

const RECALL_FENCE_OPEN = '<recall-context>';
const RECALL_FENCE_CLOSE = '</recall-context>';
const MEMORY_FENCE_CLOSE = '</memory-context>';

/** Memory and recall fences are reapplied on the next segment. Anything else
 *  that changes the stored prompt is a user-turn gate and has to be kept. */
function ephemeralInjectionRemainder(prefix: string): string | undefined {
  let rest = prefix.trim();
  while (rest.length > 0) {
    if (rest.startsWith(RECALL_FENCE_OPEN)) {
      const end = rest.indexOf(RECALL_FENCE_CLOSE);
      if (end < 0) return undefined;
      rest = rest.slice(end + RECALL_FENCE_CLOSE.length).trim();
      continue;
    }
    if (rest.startsWith(FENCE_PREAMBLE)) {
      const end = rest.indexOf(MEMORY_FENCE_CLOSE);
      if (end < 0) return undefined;
      rest = rest.slice(end + MEMORY_FENCE_CLOSE.length).trim();
      continue;
    }
    return undefined;
  }
  return rest;
}

/** The text to store, or undefined when the provider text is only the stored
 *  prompt plus ephemeral memory and recall fences. */
function gatedUserText(providerText: string, stored: string): string | undefined {
  if (providerText === stored) return undefined;
  if (!providerText.endsWith(stored)) return providerText;
  const prefix = providerText.slice(0, providerText.length - stored.length);
  return ephemeralInjectionRemainder(prefix) === '' ? undefined : providerText;
}

/** Replace the stored user prompt with the post-gate text before a later segment reloads it. */
function replaceStoredUserText(db: SessionDb, messageId: number, text: string): void {
  const row = db.handle
    .query<{ content: string }, [number]>('SELECT content FROM messages WHERE id = ?')
    .get(messageId);
  if (!row) throw new SessionPersistenceError(new Error('gated user message is missing'));
  let content: unknown;
  try {
    content = JSON.parse(row.content) as unknown;
  } catch (error) {
    throw new SessionPersistenceError(error);
  }
  if (!Array.isArray(content))
    throw new SessionPersistenceError(new Error('gated user message is invalid'));
  const index = content.findIndex(
    (block) =>
      block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text',
  );
  if (index < 0) return;
  const block = content[index] as { type?: unknown; text?: unknown };
  const next = typeof block.text === 'string' ? gatedUserText(text, block.text) : text;
  if (next === undefined) return;
  content[index] = { ...block, type: 'text', text: next };
  db.handle.run('UPDATE messages SET content = ? WHERE id = ?', [
    JSON.stringify(content),
    messageId,
  ]);
}
const CONTINUATION_INPUT_ERRORS = new Set([
  UNKNOWN_LOGICAL_TURN,
  MISSING_LOGICAL_TURN_ROUTE,
  STDIN_CONTINUE_CLASH,
]);
function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
/** A rejected `routes.<id>.defaultModel` names the setting; other model errors stay generic.
 *  Explicit `off` is a route refusal (reasoning cannot be disabled), not a model with no effort.
 *  Continuation input failures keep their safe sentence. Other invalid input stays generic.
 */
function turnErrorText(code: string, err: unknown): string {
  if (code === 'configuration_invalid' && err instanceof ConfigurationError) return err.message;
  if (
    code === 'invalid_input' &&
    err instanceof SdkInputError &&
    CONTINUATION_INPUT_ERRORS.has(err.message)
  )
    return err.message;
  if (err instanceof RouteError) {
    if (code === 'model_unsupported' && /routes\.[A-Za-z0-9-]+\.defaultModel/.test(err.message)) {
      return err.message;
    }
    if (
      code === 'effort_unsupported' &&
      err.message.startsWith('effort "off" is not supported by route ') &&
      err.message.includes(' with model ')
    ) {
      return err.message;
    }
  }
  if (
    code === 'unsupported_input' &&
    err instanceof RouteError &&
    err.message === 'Stored Grok reasoning is incomplete. Start a new session after upgrading.'
  ) {
    return err.message;
  }
  if (code === 'provider_request_rejected' && err instanceof SubscriptionHttpError) {
    const safe = err.upstream;
    return `${ERRORS[code]} HTTP ${err.status}.${safe ? ` ${safe.code ? `${safe.code}: ` : ''}${safe.message}` : ''}`;
  }
  return ERRORS[code] ?? 'Selected provider failed. No route fallback was performed.';
}

/** Time left on another owner's lease. An unreadable expiry waits out one full lease. */
function remainingLogicalTurnLeaseMs(
  store: SessionDb | undefined,
  logicalTurnId: string | undefined,
): number {
  if (!store || !logicalTurnId) return LOGICAL_TURN_LEASE_MS;
  try {
    const lease = store.readLogicalTurnLease(logicalTurnId);
    if (!lease) return LOGICAL_TURN_LEASE_MS;
    const expiresAt = lease.expiresAt;
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return 0;
    return Math.max(0, Math.ceil(expiresAt - Date.now()));
  } catch {
    return LOGICAL_TURN_LEASE_MS;
  }
}

function interrupted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(new Error('interrupted'));
    else signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true });
  });
}
export async function runSdkRunCommand(
  opts: RunOptions,
  io: RunCommandIO = {},
  deps: SdkRunDependencies = {},
): Promise<number> {
  const write =
    io.writeStdout ??
    ((s: string) => {
      process.stdout.write(s);
    });
  const emit = (obj: Record<string, unknown>) => {
    if (!terminalSent && !controller.signal.aborted) write(`${JSON.stringify(obj)}\n`);
  };
  const controller = new AbortController();
  let exit = 130;
  let interruptionCause: 'cancelled' | 'deadline' = 'cancelled';
  let cleanupCoherent = true;
  let storageFault = false;
  const sigint = () => {
    exit = 130;
    controller.abort();
  };
  const sigterm = () => {
    exit = 143;
    controller.abort();
  };
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);
  const externalAbort = () => controller.abort();
  deps.signal?.addEventListener('abort', externalAbort, { once: true });
  if (deps.signal?.aborted) controller.abort();
  let deadlineAt: number | undefined;
  const deadlineTimers: ReturnType<typeof setTimeout>[] = [];
  // A stored deadlineAt stays absolute. --deadline-ms on continue adds its own
  // timer and does not replace that instant.
  let storedDeadlineArmed = false;
  // Node and Bun collapse a delay above this to 1ms.
  const MAX_TIMER_MS = 2_147_483_647;
  const abortForDeadline = (): void => {
    if (controller.signal.aborted) return;
    interruptionCause = 'deadline';
    controller.abort('deadline');
  };
  const armDeadline = (delayMs: number): void => {
    const endsAt = Date.now() + delayMs;
    const schedule = (): void => {
      if (controller.signal.aborted) return;
      const remainingMs = Math.max(0, endsAt - Date.now());
      if (remainingMs === 0) {
        abortForDeadline();
        return;
      }
      const delay = Math.min(remainingMs, MAX_TIMER_MS);
      deadlineTimers.push(
        setTimeout(() => {
          if (delay < remainingMs) schedule();
          else abortForDeadline();
        }, delay),
      );
    };
    schedule();
  };
  const armStoredResumeDeadline = (): void => {
    if (storedDeadlineArmed || continuationRecord?.deadlineAt === undefined) return;
    storedDeadlineArmed = true;
    const schedule = (): void => {
      if (controller.signal.aborted || continuationRecord?.deadlineAt === undefined) return;
      const remainingMs = Math.max(0, continuationRecord.deadlineAt - Date.now());
      if (remainingMs === 0) {
        abortForDeadline();
        return;
      }
      const delay = Math.min(remainingMs, MAX_TIMER_MS);
      deadlineTimers.push(
        setTimeout(() => {
          if (delay < remainingMs) schedule();
          else abortForDeadline();
        }, delay),
      );
    };
    schedule();
  };
  let runtime: Runtime | undefined;
  let selected: SelectedRoute | undefined;
  let selectedMetadata: ModelRecord | undefined;
  let sessionId: string | null = null;
  let activeStream: AsyncGenerator<StreamEvent | Message, RunResult> | undefined;
  let stage: 'input' | 'route' | 'boot' | 'storage' | 'provider' = 'input';
  let terminalSent = false;
  const receipts: NativeReceipt[] = [];
  const skillActivationTurnId = randomUUID();
  const continuityPorts = new Set<SkillContinuityPort>();
  let continuityOutcome: 'succeeded' | 'failed' | 'cancelled' = 'failed';
  const mintedTurnIds: string[] = [];
  const wire = { block: 0, seq: 0 };

  const finish = (obj: Record<string, unknown>) => {
    if (terminalSent) return;
    terminalSent = true;
    write(`${JSON.stringify(obj)}\n`);
  };
  const continuationId = string(opts.continueLogicalTurn);
  let continuationRecord: LogicalTurnRecord | undefined;
  let routeId = string(opts.route);
  const metadata = () => ({
    route: routeId ?? null,
    ...(selected
      ? {
          provider: selected.route.provider,
          auth: selected.route.auth,
          model: selected.model,
          effort: selected.effort,
        }
      : {}),
  });
  // Race against cancellation at every host wait. Provider/tools also receive signal.
  const canceled = interrupted(controller.signal);
  canceled.catch(() => {});
  try {
    if (continuationId && opts.stdin === true)
      throw new SdkInputError('invalid_input', STDIN_CONTINUE_CLASH);
    if (
      opts.json !== true ||
      (!continuationId && opts.stdin !== true) ||
      (!continuationId && !routeId) ||
      opts.provider !== undefined ||
      (opts.permissionMode !== undefined &&
        !['default', 'ask', 'bypass'].includes(String(opts.permissionMode))) ||
      (opts.model !== undefined && !string(opts.model)) ||
      (opts.skillApprovalFile !== undefined && !string(opts.skillApprovalFile)) ||
      (opts.effort !== undefined &&
        !['auto', 'off', 'low', 'medium', 'high', 'max'].includes(String(opts.effort)))
    )
      throw new SdkInputError(
        'invalid_input',
        'SDK mode requires json, stdin, route and no legacy provider',
      );
    if (continuationId) {
      const probe = SessionDb.open(string(opts.db) ? { path: String(opts.db) } : {});
      try {
        const record = probe.loadLogicalTurn(continuationId);
        if (!record) throw new SdkInputError('invalid_input', UNKNOWN_LOGICAL_TURN);
        continuationRecord = record;
        restoreLogicalTurnSkillCeiling(record, skillActivationTurnId);
        routeId = record.binding.route;
        if (!routeId) throw new SdkInputError('invalid_input', MISSING_LOGICAL_TURN_ROUTE);
        opts.model = record.binding.model;
        opts.effort = record.binding.effort;
        opts.toolset = record.binding.toolset;
        opts.permissionMode = record.binding.permissionMode;
        opts.bundle = record.binding.bundleIdentity;
        opts.resume = record.activeSessionId;
      } finally {
        probe.close();
      }
    }
    if (!routeId) throw new SdkInputError('invalid_input', 'native SDK route is missing');
    const resolvedRouteId = routeId;
    const toolset = opts.toolset ?? 'coding';
    if (typeof toolset !== 'string' || !isToolsetName(toolset))
      throw new UnknownToolsetError(String(toolset));
    if (opts.deadlineMs !== undefined) {
      if (
        typeof opts.deadlineMs !== 'number' ||
        !Number.isSafeInteger(opts.deadlineMs) ||
        opts.deadlineMs <= 0
      )
        throw new SdkInputError('invalid_input', 'invalid deadline');
      armDeadline(opts.deadlineMs);
      deadlineAt = Date.now() + opts.deadlineMs;
    }
    const raw = continuationId
      ? ''
      : await Promise.race([(io.readStdin ?? readSdkStdin)(), canceled]);
    // Validate every settings layer before credentials, hooks, skills or storage.
    // Runtime boot consumes these same bytes, so approvals cannot change between reads.
    const harnessHome = resolveHarnessHome();
    const settingsSnapshot = loadRuntimeSettingsSnapshot({
      cwd: process.cwd(),
      harnessHome,
      ...(string(opts.skillApprovalFile)
        ? { skillApprovalFile: String(opts.skillApprovalFile) }
        : {}),
    });
    // Pin the allow-list and MCP servers before boot. A wider file or a new
    // server must not create tools, and the stored row is left unchanged.
    const skillApprovalDigest = sha256Json(
      skillApprovalIdentity(settingsSnapshot, string(opts.skillApprovalFile)),
    );
    const mcpIdentityDigest = sha256Json(
      mcpServerIdentity(settingsSnapshot, process.cwd(), harnessHome),
    );
    const hookIdentity = hookScopeIdentity(settingsSnapshot, process.cwd(), harnessHome);
    const hookScopeDigest = sha256Json(hookIdentity);
    const storedHookDigest = continuationRecord?.binding.hookScopeDigest;
    // An old row has no pin. Empty hooks cannot widen. Any command can.
    const hookMismatch =
      continuationRecord !== undefined &&
      (storedHookDigest === undefined
        ? hookIdentity.length > 0
        : storedHookDigest !== hookScopeDigest);
    if (continuationRecord) {
      const skillMismatch = continuationRecord.binding.skillApprovalDigest !== skillApprovalDigest;
      const mcpMismatch = continuationRecord.binding.mcpIdentityDigest !== mcpIdentityDigest;
      if (skillMismatch || mcpMismatch || hookMismatch) {
        const named = [
          skillMismatch ? 'skill-approval mismatch' : undefined,
          mcpMismatch ? 'MCP mismatch' : undefined,
          hookMismatch ? 'hook-scope mismatch' : undefined,
        ].filter((item) => item !== undefined);
        finish({
          type: 'turn.error',
          outcome: 'failed',
          reason: 'recovery_state_invalid',
          code: 'recovery_state_invalid',
          error: `Logical turn ${named.join(' and ')}.`,
          recoverable: false,
          nextAction: 'repair_request',
          sessionId: null,
          logicalTurnId: continuationRecord.logicalTurnId,
          ...metadata(),
          counters: continuationRecord.counters,
          ...nativeTurnMetrics(receipts),
        });
        return 3;
      }
    }
    const settings = settingsSnapshot.config;
    const requestedRoute = getRoute(resolvedRouteId, settings);
    const requestedModel =
      string(opts.model) && opts.model !== 'auto'
        ? String(opts.model)
        : requestedRoute.defaultModel;
    selectedMetadata = findModel(
      readModelCatalogSnapshot(resolvedRouteId, settings),
      requestedModel,
    );
    const imageProof = verifiedSubscriptionImageInput(selectedMetadata);
    const supportsImages =
      routeSupportsImages(resolvedRouteId) &&
      (requestedRoute.auth !== 'subscription' || imageProof !== undefined);
    // Validate input and bounded attachments BEFORE credential access or runtime boot.
    const input = continuationId
      ? { message: { role: 'user' as const, content: [] }, instructions: undefined }
      : await Promise.race([
          parseSdkInput(raw, opts.inputFormat, supportsImages, imageProof?.mimeTypes),
          canceled,
        ]);
    if (input.message.content.some((block) => block.type === 'image'))
      validateModelRequest(
        { model: requestedModel, system: [], messages: [input.message], maxTokens: 1 },
        requestedRoute.provider,
        selectedMetadata,
      );
    stage = 'route';
    selected = await Promise.race([
      (deps.resolve ?? resolveRouteProvider)(resolvedRouteId, {
        settings,
        modelMetadata: selectedMetadata,
        ...(string(opts.model) ? { model: String(opts.model) } : {}),
        ...(opts.effort !== undefined ? { effort: String(opts.effort) } : {}),
      }),
      canceled,
    ]);
    // Injected resolvers can return their own default. Freeze evidence for the
    // actual resolved model; never carry another selection's record into a run.
    if (selectedMetadata.id !== selected.model || selectedMetadata.routeId !== selected.route.id)
      selectedMetadata = findModel(
        readModelCatalogSnapshot(selected.route.id, settings),
        selected.model,
      );
    stage = 'boot';
    const runtimeBoot = (deps.runtime ?? buildRuntime)({
      cwd: process.cwd(),
      harnessHome,
      settingsSnapshot,
      ...(string(opts.skillApprovalFile)
        ? { skillApprovalFile: String(opts.skillApprovalFile) }
        : {}),
      sdkRoute: { resolved: selected.resolved },
      preflight: false,
      cronEnabled: false,
      model: selected.model,
      effort: selected.effort,
      ...(string(opts.bundle) ? { bundleRoot: String(opts.bundle) } : {}),
      ...(string(opts.db) ? { dbPath: String(opts.db) } : {}),
      ...(string(opts.resume) ? { resumeId: String(opts.resume) } : {}),
      ...(string(opts.steerFile) ? { steerFile: String(opts.steerFile) } : {}),
      ...(typeof opts.maxTokens === 'number' ? { maxTokens: opts.maxTokens } : {}),
      ...(opts.permissionMode !== undefined
        ? { permissionMode: opts.permissionMode as Runtime['permissionMode'] }
        : {}),
      cacheEnabled: opts.cache !== false,
    }).then(async (built) => {
      if (controller.signal.aborted) {
        await boundedDispose(built);
        throw new Error('interrupted');
      }
      return built;
    });
    runtime = await Promise.race([runtimeBoot, canceled]);
    stage = 'storage';
    const permissionMetadata = {
      requestedPermissionMode: opts.permissionMode ?? null,
      permissionMode: runtime.permissionMode,
    };
    const turnMetadata = {
      ...metadata(),
      ...permissionMetadata,
      at: new Date().toISOString(),
      toolset,
    };
    const requestedResume = string(opts.resume);
    if (requestedResume && !runtime.sessionDb.getSession(requestedResume))
      throw new SessionNotFoundError(requestedResume);
    sessionId =
      requestedResume ??
      runtime.sessionDb.createSession({
        provider: selected.route.provider,
        model: selected.model,
        platform: 'cli',
        metadata: { route: resolvedRouteId, auth: selected.route.auth },
        systemPrompt: runtime.systemSegments,
      });
    // Concrete host metadata; SDK SessionStore remains the only message writer.
    runtime.sessionDb.handle
      .query(
        "UPDATE sessions SET metadata = json_set(metadata, '$.sdkTurns', json_insert(COALESCE(json_extract(metadata, '$.sdkTurns'), '[]'), '$[#]', json(?))) WHERE session_id = ?",
      )
      .run(JSON.stringify(turnMetadata), sessionId);
    const persistence = {
      mode: 'sdk-store' as const,
      sessionStore: runtime.sessionDb,
      ...(runtime.transcripts !== undefined ? { transcripts: runtime.transcripts } : {}),
    };
    const stored = hydrateSessionHistory(loadStoredMessages(persistence, sessionId), sessionId);
    if (
      !routeSupportsImages(resolvedRouteId) &&
      stored.some((m) => m.content.some((b) => b.type === 'image'))
    )
      throw new SdkInputError('unsupported_input', 'stored session images unsupported');
    if (stored.some((message) => message.content.some((block) => block.type === 'image'))) {
      try {
        validateModelRequest(
          { model: selected.model, system: [], messages: stored, maxTokens: 1 },
          selected.provider.name,
          selectedMetadata,
        );
      } catch (error) {
        if (error instanceof RouteError && error.code === 'unsupported_input')
          throw new SdkInputError(
            'unsupported_input',
            'stored images are not certified for the selected model',
          );
        throw error;
      }
    }
    if (
      selected.route.provider !== 'anthropic' &&
      stored.some((m) =>
        m.content.some(
          (b) =>
            b.type === 'redacted_thinking' || (b.type === 'thinking' && b.signature !== undefined),
        ),
      )
    ) {
      throw new SdkInputError('unsupported_input', 'stored signed thinking cannot cross backends');
    }
    if (
      stored.some((message) =>
        message.content.some(
          (block) =>
            block.type === 'encrypted_reasoning' &&
            ((resolvedRouteId !== 'grok-subscription' &&
              resolvedRouteId !== 'chatgpt-subscription') ||
              block.routeId !== resolvedRouteId ||
              block.provenance?.version !== 1 ||
              block.provenance.routeId !== resolvedRouteId ||
              block.provenance.modelId !== selected?.model),
        ),
      )
    ) {
      throw new SdkInputError(
        'unsupported_input',
        'stored encrypted reasoning cannot cross backends',
      );
    }
    const hostRuntime = runtime;
    const routeSelection = selected;
    const modelMetadata = selectedMetadata;
    const inputTokenAccounting = modelInputTokenAccounting(routeSelection.provider.name);
    const modelSnapshot = selectedTurnModel(selected.provider.name, selected.model, {
      modelMetadata,
      maxTokens: runtime.maxTokens,
    });
    if (!modelSnapshot) throw new Error('native model evidence unavailable');
    const policyDigest = createHash('sha256')
      .update(
        JSON.stringify(
          loadPermissionSettings({
            cwd: hostRuntime.cwd,
            harnessHome: hostRuntime.harnessHome,
          }).layers,
        ),
      )
      .digest('hex');
    const hydrate = () =>
      hydrateSessionHistory(
        loadStoredMessages(persistence, sessionId as string),
        sessionId as string,
      );
    // The first model call of a user segment sees the post-gate prompt. Record
    // that text before the provider runs so the next segment reloads it.
    let persistGatedUserText = false;
    const turnProvider = {
      name: routeSelection.provider.name,
      async *stream(
        request: Parameters<(typeof routeSelection.provider)['stream']>[0],
      ): AsyncGenerator<StreamEvent, AssistantMessage> {
        if (persistGatedUserText && gatedUserMessageId !== undefined) {
          const text = latestHumanUserText(request.messages);
          if (text !== undefined)
            replaceStoredUserText(hostRuntime.sessionDb, gatedUserMessageId, text);
          persistGatedUserText = false;
        }
        return yield* routeSelection.provider.stream(request);
      },
    };
    const makeHop = () => {
      const id = sessionId as string;
      const sessionCtx = hostRuntime.getSessionContext(id);
      sessionCtx.effort = routeSelection.effort;
      sessionCtx.modelBudget = {
        provider: modelMetadata.provider,
        model: modelMetadata.id,
        contextTokens: modelSnapshot.limits.contextTokens,
      };
      if (sessionCtx.skillContinuity) continuityPorts.add(sessionCtx.skillContinuity);
      const instructions = gateTurnInstructions(hostRuntime, id, input.instructions);
      const pollSteering = createSteeringPoller(string(opts.steerFile), (count) =>
        emit({ type: 'steer_injected', sessionId, activeSessionId: sessionId, count }),
      );
      // The SDK and cancellation fallback share a settle-once usage writer.
      // A cooperative provider can finish just after the cancellation race;
      // that late finalizer must not bill the same partial drive twice.
      let usageRecorded = false;
      const hopStore: SessionStore = new Proxy(hostRuntime.sessionDb, {
        get(target, property) {
          if (property === 'recordUsageEstimate')
            return (
              key: string,
              usage: Parameters<SessionStore['recordTokenUsage']>[1],
              estimate: NonNullable<NativeReceipt['costEstimate']>,
            ) => {
              if (usageRecorded) return;
              try {
                target.recordUsageEstimate(key, usage, estimate);
              } catch (error) {
                throw new SessionPersistenceError(error);
              }
              usageRecorded = true;
            };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const composed = composeTurn({
        runtime: hostRuntime,
        persistence: { ...persistence, sessionStore: hopStore },
        rethrow: false,
        canUseTool: buildTurnCanUseTool(hostRuntime, {
          ask: headlessDenyAsk,
          permissionMode: hostRuntime.permissionMode,
        }),
        provider: turnProvider,
        model: routeSelection.model,
        modelMetadata,
        effort: routeSelection.effort,
        toolset,
        skillActivationTurnId,
        manageSkillContinuity: true,
        ...(instructions !== undefined ? { instructions } : {}),
        signal: controller.signal,
        ...(pollSteering !== undefined ? { pollSteering } : {}),
        traceRecorder: (event) => {
          sessionCtx.traceWriter.record(event);
          hostRuntime.assayRecorder?.record(event);
        },
      });
      const system = modelSystemPrompt(hostRuntime.systemSegments, composed.tools, modelMetadata);
      return {
        composed,
        sessionCtx,
        hopStore,
        system: instructions !== undefined ? appendInstructions(system, instructions) : system,
      };
    };
    const canReduce = (candidate: ReturnType<typeof makeHop>, history: readonly Message[]) => {
      // Compaction keeps at least four tail rows, including any tool pair
      // crossing that boundary. Summarizing the head cannot reduce this floor.
      let start = Math.max(0, history.length - 4);
      while (
        start > 0 &&
        history[start]?.content.some((b) => b.type === 'tool_result') &&
        history[start - 1]?.content.some((b) => b.type === 'tool_use')
      )
        start--;
      const accounting = inputTokenAccounting({
        model: routeSelection.model,
        messages: [...history.slice(start)],
        system: candidate.system,
        tools: toToolSchemas(candidate.composed.tools),
        maxTokens: 1,
        modelMetadata,
      });
      // Unknown tokenizer: let the single upstream-overflow recovery attempt
      // try a smaller history; an advisory byte bound cannot veto it.
      return (
        accounting.enforce === false || accounting.tokens + 1 <= modelSnapshot.limits.contextTokens
      );
    };
    // Persist the prompt before the model runs. A user-turn gate may replace
    // this row with the gated text, or a denial, before the first provider call.
    if (!continuationId) persistTurnMessage(persistence, sessionId, input.message);
    const originalUserMessageId = continuationId
      ? runtime.sessionDb.loadLogicalTurn(continuationId)?.originalUserMessageId
      : runtime.sessionDb.loadMessages(sessionId).at(-1)?.id;
    const gatedUserMessageId = originalUserMessageId;
    let messages = hydrate();
    // Refuse unsafe prior effects before a paid summary or inference call.
    // Complete journal receipts can repair their missing canonical batch.
    // A continuation's started or unknown receipt is recovery_unsafe below.
    // An unreadable store is still a storage fault.
    if (!hasNativeRecoveryTarget(hostRuntime.sessionDb, sessionId)) {
      if (!continuationRecord || sessionId === null)
        throw new SessionPersistenceError(new Error('session receipt history requires inspection'));
      assertReadableRecoveryStore(hostRuntime.sessionDb, sessionId);
    }
    emit({
      type: 'session.started',
      sessionId,
      activeSessionId: sessionId,
      resumed: !!string(opts.resume),
      ...(continuationId ? { logicalTurnId: continuationId } : {}),
      ...metadata(),
      toolset,
      ...permissionMetadata,
      capabilities: { logicalTurnRecovery: LOGICAL_TURN_RECOVERY_CAPABILITY },
    });
    if (continuationRecord) {
      const binding = continuationRecord.binding;
      // A moved directory or a changed permission policy is an intact row.
      // Corrupt JSON stays on the LogicalTurnRecordError path.
      const cwdMismatch = binding.cwd !== process.cwd();
      const policyMismatch = binding.policyDigest !== policyDigest;
      const otherMismatch =
        binding.route !== resolvedRouteId ||
        binding.provider !== routeSelection.route.provider ||
        binding.authKind !== routeSelection.route.auth ||
        binding.model !== routeSelection.model ||
        binding.effort !== routeSelection.effort ||
        binding.toolset !== toolset ||
        binding.permissionMode !== hostRuntime.permissionMode ||
        binding.bundleIdentity !== string(opts.bundle);
      if (cwdMismatch || policyMismatch || otherMismatch) {
        const named = [
          cwdMismatch ? 'working-directory mismatch' : undefined,
          policyMismatch ? 'permission-policy mismatch' : undefined,
        ].filter((item) => item !== undefined);
        finish({
          type: 'turn.error',
          outcome: 'failed',
          reason: 'recovery_state_invalid',
          code: 'recovery_state_invalid',
          error:
            named.length > 0
              ? `Logical turn ${named.join(' and ')}.`
              : ERRORS.recovery_state_invalid,
          recoverable: false,
          nextAction: 'repair_request',
          sessionId: null,
          logicalTurnId: continuationRecord.logicalTurnId,
          ...metadata(),
          counters: continuationRecord.counters,
          ...nativeTurnMetrics(receipts),
        });
        return 3;
      }
    }
    if (continuationRecord?.status === 'cancelled') {
      finish({
        type: 'turn.error',
        outcome: 'failed',
        reason: 'recovery_state_invalid',
        code: 'recovery_state_invalid',
        error: 'Logical turn was cancelled.',
        recoverable: false,
        nextAction: 'none',
        sessionId: null,
        logicalTurnId: continuationRecord.logicalTurnId,
        ...metadata(),
        counters: continuationRecord.counters,
        ...nativeTurnMetrics(receipts),
      });
      return 3;
    }
    // A policy denial and any other non-transient failure must not run again.
    if (continuationRecord?.status === 'failed' && !isSafeTransientFailure(continuationRecord)) {
      finish({
        type: 'turn.error',
        outcome: 'failed',
        reason: continuationRecord.finishReason ?? 'failed',
        code: 'continuation_failed',
        error: ERRORS.continuation_failed,
        recoverable: false,
        nextAction: 'none',
        sessionId: null,
        logicalTurnId: continuationRecord.logicalTurnId,
        ...metadata(),
        counters: continuationRecord.counters,
        ...nativeTurnMetrics(receipts),
      });
      return 3;
    }
    // A spent model-call budget or a repeated no-progress stop cannot run again.
    if (
      continuationRecord &&
      (continuationRecord.status === 'exhausted' || continuationRecord.status === 'stalled')
    ) {
      const code =
        continuationRecord.status === 'stalled' ? 'continuation_stalled' : 'continuation_exhausted';
      const storedReason = continuationRecord.finishReason ?? continuationRecord.status;
      finish({
        type: 'turn.error',
        outcome: continuationRecord.status,
        reason: storedReason,
        code,
        error: storedReason === 'deadline' ? DEADLINE_EXHAUSTED_ERROR : ERRORS[code],
        recoverable: false,
        nextAction: 'none',
        sessionId,
        activeSessionId: sessionId,
        logicalTurnId: continuationRecord.logicalTurnId,
        ...metadata(),
        reply: continuationRecord.finalReply ?? '',
        finishReason: storedReason,
        counters: continuationRecord.counters,
        ...nativeTurnMetrics(receipts),
      });
      return 3;
    }
    if (
      continuationRecord &&
      (continuationRecord.status === 'completed' || continuationRecord.status === 'waiting_user')
    ) {
      if (!hasNativeRecoveryTarget(hostRuntime.sessionDb, sessionId))
        throw new SessionPersistenceError(new Error('logical turn receipt is not reusable'));
      continuityOutcome = 'succeeded';
      finish({
        type: 'turn.completed',
        outcome: continuationRecord.status,
        reason: continuationRecord.finishReason ?? continuationRecord.status,
        nextAction: continuationRecord.status === 'waiting_user' ? 'user_input' : 'none',
        sessionId,
        activeSessionId: sessionId,
        logicalTurnId: continuationRecord.logicalTurnId,
        ...metadata(),
        reply: continuationRecord.finalReply ?? '',
        finishReason: continuationRecord.finishReason ?? continuationRecord.status,
        counters: continuationRecord.counters,
        ...nativeTurnMetrics(receipts),
      });
      return 0;
    }
    if (continuationRecord && !hasNativeRecoveryTarget(hostRuntime.sessionDb, sessionId)) {
      finish({
        type: 'turn.error',
        outcome: 'failed',
        reason: 'unsafe_effect',
        code: 'recovery_unsafe',
        error: ERRORS.recovery_unsafe,
        recoverable: false,
        nextAction: 'inspect_session',
        sessionId: null,
        logicalTurnId: continuationRecord.logicalTurnId,
        ...metadata(),
        counters: continuationRecord.counters,
        ...nativeTurnMetrics(receipts),
      });
      return 3;
    }
    stage = 'provider';
    const compact = async (): Promise<
      { usage?: TokenUsage; estimatedCostUsd?: number } | undefined
    > => {
      const id = sessionId as string;
      const meter = nativeUsageMeter(
        routeSelection.provider.name,
        routeSelection.model,
        modelMetadata,
      );
      let receipt: NativeReceipt | undefined;
      let noOp = false;
      try {
        const result = await Promise.race([
          hostRuntime.compact(
            messages,
            id,
            logicalTurnWorkSignal(controller.signal) ?? controller.signal,
            {
              onStreamEvent: meter.observe,
              modelMetadata,
              effort: routeSelection.effort,
              inputTokenAccounting,
              inputSystem: hop.system,
              inputTools: toToolSchemas(hop.composed.tools),
            },
          ),
          canceled,
        ]);
        noOp = result.noOp === true || result.newSessionId === id;
        if (noOp) return undefined;
        receipt = result.costEstimate ? result : meter.partial();
        sessionId = result.newSessionId;
        // Report the durable child before rebuilding anything that may fail.
        emit({
          type: 'compaction_complete',
          sessionId: id,
          activeSessionId: sessionId,
          parentSessionId: id,
          estimatedBeforeTokens: result.estimatedBeforeTokens,
          estimatedAfterTokens: result.estimatedAfterTokens,
        });
        messages = hydrate();
        return {
          ...(result.usage ? { usage: result.usage } : {}),
          ...(result.estimatedCostUsd !== undefined
            ? { estimatedCostUsd: result.estimatedCostUsd }
            : {}),
        };
      } finally {
        if (!noOp) {
          const measured = receipt ?? meter.partial();
          receipts.push(measured);
          // Successful compactSession writes its own summary receipt. Failed
          // or cancelled requests have no child; preserve their partial bill.
          if (!receipt && measured.costEstimate) {
            try {
              hostRuntime.sessionDb.recordCompactionUsage(
                id,
                measured.usage ?? {},
                undefined,
                measured.costEstimate,
              );
            } catch {
              // The failed/cancelled compaction is already unwinding; retain
              // the store fault so its terminal cannot advertise recovery.
              storageFault = true;
            }
          }
        }
      }
    };
    let hop = makeHop();
    const schemas = toToolSchemas(hop.composed.tools);
    const accounting = inputTokenAccounting({
      model: routeSelection.model,
      messages,
      system: hop.system,
      tools: schemas,
      maxTokens: modelSnapshot.limits.outputTokens,
      modelMetadata,
    });
    emit({
      type: 'context.accounting',
      sessionId,
      activeSessionId: sessionId,
      ...accounting,
      effectiveLimit: modelSnapshot.limits.contextTokens,
      requestedOutput: modelSnapshot.limits.outputTokens,
      reservedOutput:
        accounting.enforce === false
          ? modelSnapshot.limits.outputTokens
          : Math.max(
              0,
              Math.min(
                modelSnapshot.limits.outputTokens,
                modelSnapshot.limits.contextTokens - accounting.tokens,
              ),
            ),
    });
    // Capability refusal must precede a paid summary call.
    validateModelRequest(
      {
        model: selected.model,
        system: hop.system,
        messages,
        tools: schemas,
        maxTokens: modelSnapshot.limits.outputTokens,
      },
      selected.provider.name,
      modelMetadata,
    );
    const runOnce = async (segment: {
      continuation: boolean;
      remainingModelCalls: number;
    }): Promise<RunResult> => {
      const id = sessionId as string;
      const meter = nativeUsageMeter(
        routeSelection.provider.name,
        routeSelection.model,
        modelMetadata,
      );
      const turnId = hostRuntime.attestationEvidence?.beginTurn(id, {
        surface: 'user',
        model: routeSelection.model,
      });
      if (turnId !== undefined) mintedTurnIds.push(turnId);
      let result: RunResult | undefined;
      let settledResult: RunResult | undefined;
      let drive: Promise<RunResult> | undefined;
      try {
        persistGatedUserText = segment.continuation !== true;
        activeStream = hop.composed.agent.run(messages, {
          ...hop.composed.perTurn({
            sessionId: id,
            sessionCtx: hop.sessionCtx,
            storedPrefixLength: messages.length,
            ...(turnId !== undefined ? { turnId } : {}),
            maxTurns: Math.min(defaultMaxTurns(toolset), segment.remainingModelCalls),
            continuation: segment.continuation,
            logicalTurn: true,
          }),
          persistCompletedMessages: true,
        });
        drive = relayNative(activeStream, emit, id, wire, meter.observe).then(
          (completed) => {
            settledResult = completed;
            return completed;
          },
          (error) => {
            if (isStorageFault(error)) storageFault = true;
            throw error;
          },
        );
        result = await Promise.race([drive, canceled]);
        hop.sessionCtx.trajectoryMetadata.toolCallCount += result.toolCallCount;
        hop.sessionCtx.trajectoryMetadata.iterationsUsed += result.iterationsUsed;
        hop.sessionCtx.trajectoryMetadata.terminalReason = result.terminal.reason;
        return result;
      } finally {
        // Give cooperative cancellation one bounded chance to persist completed
        // messages, tool receipts and final usage before exposing a target.
        // An uncooperative drive never advertises automatic recovery.
        if (!result && controller.signal.aborted && drive) {
          cleanupCoherent &&= await settleWithin(drive, 1000);
          result = settledResult;
        }
        if (result?.terminal.reason === 'error' && isStorageFault(result.terminal.error))
          storageFault = true;
        if (!result)
          hop.sessionCtx.trajectoryMetadata.terminalReason = controller.signal.aborted
            ? 'interrupted'
            : 'error';
        const receipt = result?.costEstimate ? result : meter.partial();
        receipts.push(receipt);
        if (!result && receipt.costEstimate)
          hop.hopStore.recordUsageEstimate?.(id, receipt.usage ?? {}, receipt.costEstimate);
      }
    };
    const overflow = (r: RunResult) =>
      r.terminal.reason === 'error' &&
      (r.terminal.error instanceof ContextOverflowError ||
        r.terminal.error instanceof ContextManagementError ||
        isContextOverflowError(r.terminal.error));
    let boundaryRows: { sessionId: string; rows: StoredMessage[] } | null = null;
    // One stored read for the safety check, the id fingerprint, and rehydrate.
    const loadBoundary = (id: string) => {
      const rows = hostRuntime.sessionDb.loadMessages(id);
      const executions = hostRuntime.sessionDb.loadToolExecutions(id);
      boundaryRows = { sessionId: id, rows };
      const view = sessionView(hostRuntime.sessionDb, id, rows, executions);
      const receipts = new Map<string, string>();
      for (const receipt of executions) receipts.set(receipt.toolUseId, receipt.state);
      return {
        safe: hasNativeRecoveryTarget(view, id) && !ambiguousTruncatedToolRequest(view, id),
        progress: {
          receipts: [...receipts].sort(([left], [right]) => left.localeCompare(right)),
          tasks: hostRuntime.taskManager.list(id).map((task) => ({
            id: task.id,
            state: task.state,
          })),
          transcriptIds: rows.map((row) => row.id),
          transcriptCount: rows.length,
          cursor: logicalTurnCursor(rows) ?? null,
          compactionChildId: id,
        },
        messages: () =>
          hydrateSessionHistory(
            loadStoredMessages(
              {
                mode: 'sdk-store' as const,
                sessionStore: view,
                ...(hostRuntime.transcripts !== undefined
                  ? { transcripts: hostRuntime.transcripts }
                  : {}),
              },
              id,
            ),
            id,
          ),
      };
    };
    // Same threshold check as the pre-loop prepare. Later segments do not call prepare.
    const compactIfProactive = async (): Promise<AttemptCharge | undefined> => {
      // A deadline that already aborted the work signal must not start a summary.
      if (controller.signal.aborted) return undefined;
      const segmentSchemas = toToolSchemas(hop.composed.tools);
      if (
        !shouldCompactModelRequest(
          messages,
          hop.system,
          segmentSchemas,
          modelSnapshot.limits,
          hostRuntime.proactiveCompactThreshold,
          {
            counter: inputTokenAccounting,
            model: routeSelection.model,
            metadata: modelMetadata,
          },
        ) ||
        !canReduce(hop, messages)
      )
        return undefined;
      const charge = await compact();
      if (!charge) return undefined;
      hop = makeHop();
      return charge;
    };
    // Arm before prepare(). A stored deadline must abort compaction, not only the segment.
    armStoredResumeDeadline();
    const logical = await superviseLogicalTurn({
      store: skillCeilingLogicalTurnStore(hostRuntime.sessionDb, skillActivationTurnId),
      binding: {
        route: resolvedRouteId,
        provider: routeSelection.route.provider,
        authKind: routeSelection.route.auth,
        model: routeSelection.model,
        effort: routeSelection.effort,
        toolset,
        permissionMode: hostRuntime.permissionMode,
        policyDigest,
        skillApprovalDigest,
        mcpIdentityDigest,
        // Keep an unpinned empty hook set off the binding so old rows still match.
        ...(!continuationRecord || storedHookDigest !== undefined || hookIdentity.length > 0
          ? { hookScopeDigest }
          : {}),
        cwd: process.cwd(),
        ...(string(opts.bundle) ? { bundleIdentity: String(opts.bundle) } : {}),
      },
      sessionId,
      ...(originalUserMessageId !== undefined ? { originalUserMessageId } : {}),
      initialMessages: messages,
      // Toolset maxTurns bounds one segment inside runSegment. It is not a segment count.
      logicalModelCallLimit: 100,
      ...(deadlineAt !== undefined ? { deadlineAt } : {}),
      ...(continuationId ? { logicalTurnId: continuationId } : {}),
      signal: controller.signal,
      prepare: async () => {
        await compactIfProactive();
      },
      rehydrate: () => hydrate(),
      recoverySafe: (id) =>
        hasNativeRecoveryTarget(hostRuntime.sessionDb, id) &&
        !ambiguousTruncatedToolRequest(hostRuntime.sessionDb, id),
      readBoundary: (id) => loadBoundary(id),
      persistRuntimeContinuation: ({ activeSessionId, id, text }) => {
        const rows =
          boundaryRows?.sessionId === activeSessionId
            ? boundaryRows.rows
            : hostRuntime.sessionDb.loadMessages(activeSessionId);
        if (rows.some((row) => row.toolCallId === id || runtimeMarkerId(row) === id)) return;
        // A truncated tool call already stored its synthetic tool_result user row.
        if (rows.at(-1)?.role === 'user') return;
        const rowId = persistMessage(hostRuntime, activeSessionId, {
          role: 'user',
          content: [{ type: 'text', text }],
          toolCallId: id,
          toolCalls: { origin: 'runtime', id },
        });
        if (boundaryRows?.sessionId !== activeSessionId || rowId <= 0) return;
        boundaryRows.rows.push({
          id: rowId,
          sessionId: activeSessionId,
          role: 'user',
          content: [{ type: 'text', text }],
          toolCallId: id,
          toolCalls: { origin: 'runtime', id },
          tokenCount: 0,
          createdAt: Date.now() / 1000,
        });
      },
      onContinuing: (event) => emit({ type: 'turn.continuing', ...event }),
      onTrace: (event) => {
        const context = hostRuntime.getSessionContext(event.activeSessionId);
        context.traceWriter.record({
          type: 'external',
          source: 'logical-turn',
          payload: event,
          iso: new Date().toISOString(),
        });
      },
      runSegment: async (segment) => {
        boundaryRows = null;
        // Keep a child already pivoted by prepare(); resetting would drop the lease-held compaction.
        if (sessionId === segment.activeSessionId) {
          messages = segment.messages;
          hop = makeHop();
        }
        // The supervisor calls prepare once. Continuation segments still need
        // the proactive check, inside this lease and the remaining model budget.
        let summary: AttemptCharge | undefined;
        let remainingModelCalls = segment.remainingModelCalls;
        if (segment.continuation) {
          summary = await compactIfProactive();
          if (summary) remainingModelCalls -= 1;
        }
        if (remainingModelCalls <= 0) {
          const activeSessionId = sessionId as string;
          return {
            sessionId: activeSessionId,
            terminal: { reason: 'max_turns' as const },
            iterationsUsed: 1,
            toolCallCount: 0,
            distinctToolNames: [],
            messages,
            ...(summary?.usage ? { usage: summary.usage } : {}),
            ...(summary?.estimatedCostUsd !== undefined
              ? { estimatedCostUsd: summary.estimatedCostUsd }
              : {}),
          };
        }
        let result = await runOnce({
          continuation: segment.continuation,
          remainingModelCalls,
        });
        if (summary) result = chargeLeadingSummary(result, summary);
        if (overflow(result)) {
          messages = hydrate();
          const recoveryHop = makeHop();
          if (canReduce(recoveryHop, messages)) {
            const compaction = await compact();
            if (compaction) {
              // The abandoned drive and the summary are already spent. A retry
              // only gets the logical model-call budget that remains.
              const leftover = segment.remainingModelCalls - result.iterationsUsed - 1;
              if (leftover <= 0) {
                result = chargeRecoveredAttempt(result, compaction, sessionId as string);
              } else {
                hop = makeHop();
                const retry = await runOnce({
                  continuation: true,
                  remainingModelCalls: leftover,
                });
                result = mergeRecoveredAttempts(result, retry, compaction);
              }
            }
          }
        }
        return result;
      },
    });
    sessionId = logical.activeSessionId;
    const result = logical.finalSegment;
    const deadlineTerminal = logical.finishReason === 'deadline';
    // A deadline shares the work signal so the model stops. It is not /stop.
    if (!deadlineTerminal && (logical.status === 'cancelled' || controller.signal.aborted))
      throw new Error('interrupted');
    // Model-call cap and a repeated fingerprint are terminal, same as a deadline.
    const nonResumableStop =
      deadlineTerminal || logical.status === 'exhausted' || logical.status === 'stalled';
    if (logical.status === 'failed' && !logical.code && result?.terminal.reason === 'error') {
      const error = result.terminal.error;
      // The gate returned before any provider call. Keep its verdict, not the
      // rejected prompt, in the row a later resume would rehydrate.
      if (error?.name === 'UserTurnPolicyError' && originalUserMessageId !== undefined)
        replaceStoredUserText(hostRuntime.sessionDb, originalUserMessageId, error.message);
      throw error ?? new Error('provider failed');
    }
    const outcome = deadlineTerminal
      ? 'exhausted'
      : logical.status === 'waiting_user'
        ? 'waiting_user'
        : logical.status;
    const failed = !['completed', 'waiting_user'].includes(logical.status);
    const ambiguousTool = ambiguousTruncatedToolRequest(runtime.sessionDb, sessionId);
    const durable = hasNativeRecoveryTarget(runtime.sessionDb, sessionId);
    if (!failed && !durable)
      throw new SessionPersistenceError(new Error('completed session could not be verified'));
    continuityOutcome = failed ? 'failed' : 'succeeded';
    // A segment limit is not the logical outcome. Stall, exhaustion, an unsafe
    // receipt, and a deadline keep logical.finishReason instead of max_turns/max_tokens.
    const finishReason =
      !result ||
      logical.status === 'stalled' ||
      logical.status === 'exhausted' ||
      logical.code === 'recovery_unsafe' ||
      deadlineTerminal
        ? logical.finishReason
        : mapTerminalReason(result.terminal);
    const deadlineCode = 'continuation_exhausted';
    finish({
      type: failed ? 'turn.error' : 'turn.completed',
      outcome,
      reason: logical.finishReason,
      ...(failed
        ? {
            code: deadlineTerminal ? deadlineCode : logical.code,
            error: deadlineTerminal
              ? DEADLINE_EXHAUSTED_ERROR
              : ERRORS[logical.code ?? 'provider_failed'],
            recoverable: nonResumableStop || ambiguousTool ? false : durable,
            nextAction: nonResumableStop
              ? 'none'
              : ambiguousTool
                ? 'inspect_session'
                : durable
                  ? 'continue_logical_turn'
                  : 'inspect_session',
          }
        : { nextAction: logical.status === 'waiting_user' ? 'user_input' : 'none' }),
      sessionId: failed && !durable ? null : sessionId,
      ...(!(failed && !durable) ? { activeSessionId: sessionId } : {}),
      logicalTurnId: logical.logicalTurnId,
      ...metadata(),
      reply:
        result?.finalAssistant?.content
          .filter((b) => b.type === 'text')
          .map((b) => (b.type === 'text' ? b.text : ''))
          .join('') ?? logical.reply,
      finishReason,
      counters: logical.counters,
      ...nativeTurnMetrics(receipts),
    });
    return failed ? 3 : 0;
  } catch (err) {
    // A live owner already holds this turn. This launch must not start another worker.
    // Wait out the lease, then continue the same id. This is not a spent budget.
    if (err instanceof LogicalTurnLeaseError) {
      const logicalTurnId = continuationRecord?.logicalTurnId ?? continuationId;
      finish({
        type: 'turn.error',
        outcome: 'failed',
        reason: 'logical_turn_leased',
        code: 'logical_turn_leased',
        error: ERRORS.logical_turn_leased,
        recoverable: true,
        nextAction: 'continue_logical_turn',
        retryAfterMs: remainingLogicalTurnLeaseMs(runtime?.sessionDb, logicalTurnId),
        sessionId: null,
        ...(logicalTurnId ? { logicalTurnId } : {}),
        ...metadata(),
        ...(continuationRecord ? { counters: continuationRecord.counters } : {}),
        ...nativeTurnMetrics(receipts),
      });
      return 3;
    }
    // Corrupt JSON is invalid recovery state, not a provider failure.
    if (err instanceof LogicalTurnRecordError) {
      finish({
        type: 'turn.error',
        outcome: 'failed',
        reason: 'recovery_state_invalid',
        code: 'recovery_state_invalid',
        error: ERRORS.recovery_state_invalid,
        recoverable: false,
        nextAction: 'repair_request',
        sessionId: null,
        ...(continuationId ? { logicalTurnId: continuationId } : {}),
        ...metadata(),
        ...nativeTurnMetrics(receipts),
      });
      return 3;
    }
    storageFault ||= isStorageFault(err);
    if (!storageFault && controller.signal.reason === 'deadline') {
      const durable = cleanupCoherent && hasNativeRecoveryTarget(runtime?.sessionDb, sessionId);
      finish({
        type: 'turn.error',
        outcome: 'exhausted',
        reason: 'deadline',
        code: 'continuation_exhausted',
        error: DEADLINE_EXHAUSTED_ERROR,
        recoverable: false,
        nextAction: 'none',
        sessionId: durable ? sessionId : null,
        ...(durable ? { activeSessionId: sessionId } : {}),
        ...nativeTurnMetrics(receipts),
        ...metadata(),
      });
      return 3;
    }
    let code: string = storageFault
      ? 'storage_failed'
      : controller.signal.aborted
        ? 'interrupted'
        : err instanceof SdkInputError
          ? err.code
          : err instanceof ConfigurationError
            ? 'configuration_invalid'
            : err instanceof UnknownToolsetError
              ? 'invalid_input'
              : err instanceof SessionNotFoundError
                ? 'invalid_input'
                : err instanceof PersistBeforeRunError
                  ? 'storage_failed'
                  : err instanceof ContextManagementError
                    ? 'context_overflow'
                    : stage === 'boot'
                      ? 'runtime_start_failed'
                      : stage === 'storage'
                        ? 'storage_failed'
                        : routeErrorCodeFor(err);
    if (!ERRORS[code]) code = 'provider_failed';
    const durable =
      cleanupCoherent && !storageFault && hasNativeRecoveryTarget(runtime?.sessionDb, sessionId);
    const incomplete =
      err instanceof SubscriptionStreamError && err.phase === 'incomplete_delivery';
    const retryable = [
      'rate_limited',
      'interrupted',
      'provider_unavailable',
      'provider_timeout',
    ].includes(code);
    const recoverable = durable && !incomplete && retryable;
    finish({
      type: 'turn.error',
      outcome: code === 'interrupted' ? 'interrupted' : 'failed',
      reason: code === 'interrupted' ? interruptionCause : code,
      nextAction:
        code === 'configuration_invalid'
          ? 'check_configuration'
          : recoverable
            ? 'resume'
            : storageFault || code === 'storage_failed'
              ? 'inspect_storage'
              : sessionId !== null && (!durable || incomplete)
                ? 'inspect_session'
                : code === 'provider_response_invalid'
                  ? 'check_provider'
                  : retryable
                    ? 'retry'
                    : 'repair_request',
      sessionId: durable ? sessionId : null,
      ...(durable ? { activeSessionId: sessionId } : {}),
      ...nativeTurnMetrics(receipts),
      ...metadata(),
      code,
      error: turnErrorText(code, err),
      ...((err instanceof SubscriptionHttpError ||
        err instanceof SubscriptionAuthExpiredError ||
        err instanceof SubscriptionTierBlockedError ||
        err instanceof ContextOverflowError) &&
      err.upstream
        ? { upstream: err.upstream }
        : {}),
      ...(err instanceof SubscriptionStreamError
        ? { deliveryPhase: err.phase, deliveryReason: err.reason }
        : {}),
      ...(err instanceof SubscriptionRefreshError
        ? {
            refreshReason: err.reason,
            ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
          }
        : {}),
      recoverable,
    });
    return code === 'interrupted'
      ? exit
      : [
            'invalid_input',
            'route_unavailable',
            'model_unsupported',
            'effort_unsupported',
            'unsupported_input',
          ].includes(code)
        ? 2
        : 1;
  } finally {
    if (controller.signal.aborted) continuityOutcome = 'cancelled';
    controller.abort();
    for (const id of mintedTurnIds) runtime?.attestationEvidence?.endTurn(id);
    for (const port of continuityPorts)
      await boundedWait(
        port.finish(skillActivationTurnId, continuityOutcome).catch(() => {}),
        1000,
      );
    clearSkillCeiling(skillActivationTurnId);
    for (const timer of deadlineTimers) clearTimeout(timer);
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
    deps.signal?.removeEventListener('abort', externalAbort);
    if (activeStream)
      await boundedWait(
        activeStream.return(undefined as unknown as RunResult).catch(() => undefined),
        1000,
      );
    if (runtime) {
      await boundedDispose(runtime);
    }
  }
}

function skillCeilingLogicalTurnStore(store: SessionDb, key: string): SessionDb {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'createLogicalTurn') {
        return (record: LogicalTurnRecord) => {
          stampLogicalTurnSkillCeiling(record, key);
          target.createLogicalTurn(record);
        };
      }
      if (property === 'saveLogicalTurn') {
        return (record: LogicalTurnRecord, owner: string) => {
          stampLogicalTurnSkillCeiling(record, key);
          target.saveLogicalTurn(record, owner);
        };
      }
      if (property === 'loadLogicalTurn') {
        return (id: string) => {
          const record = target.loadLogicalTurn(id);
          if (record) restoreLogicalTurnSkillCeiling(record, key);
          return record;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function sha256Json(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

/** Effective skill allow-list. Raw layer text stays cwd-stable; an approval file wins. */
function skillApprovalIdentity(
  snapshot: RuntimeSettingsSnapshot,
  skillApprovalFile: string | undefined,
): unknown {
  if (skillApprovalFile !== undefined) {
    return { approvalFile: true, roots: snapshot.discovery.allowedLinkRoots ?? [] };
  }
  for (const name of ['local', 'user'] as const) {
    const roots = snapshot.layers.find((layer) => layer.name === name)?.settings.skills?.discovery
      ?.allowedLinkRoots;
    if (roots !== undefined) return { approvalFile: false, source: name, roots };
  }
  const configured = snapshot.config.skills?.discovery?.allowedLinkRoots;
  if (configured !== undefined) {
    return { approvalFile: false, source: 'profile-config', roots: configured };
  }
  return { approvalFile: false, source: 'default', roots: null };
}

function mcpServerIdentity(
  snapshot: RuntimeSettingsSnapshot,
  cwd: string,
  harnessHome: string,
): unknown {
  return loadMcpServerSettings({ cwd, harnessHome, snapshot }).servers;
}

/** Event, matcher, and command only. The stored row keeps the digest, not the command. */
function hookScopeIdentity(
  snapshot: RuntimeSettingsSnapshot,
  cwd: string,
  harnessHome: string,
): Array<{ event: string; matcher: string | null; command: string }> {
  const loaded = loadHookSettings({ cwd, harnessHome, snapshot });
  const identity: Array<{ event: string; matcher: string | null; command: string }> = [];
  for (const event of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop'] as const) {
    for (const config of loaded.hooksByEvent[event]) {
      for (const hook of config.hooks) {
        identity.push({ event, matcher: config.matcher ?? null, command: hook.command });
      }
    }
  }
  return identity;
}

/** Native wire block ids are unique across tool calls and model rounds. */
async function relayNative(
  stream: AsyncGenerator<StreamEvent | Message, RunResult>,
  emit: (event: Record<string, unknown>) => void,
  sessionId: string,
  wire: { block: number; seq: number },
  observe: (event: StreamEvent) => void,
): Promise<RunResult> {
  let streamed = false;
  const pending = new Map<string, { block: number; tool: string; input: unknown }>();
  const send = (event: Record<string, unknown>) =>
    emit({ seq: ++wire.seq, sessionId, activeSessionId: sessionId, ...event });
  while (true) {
    const next = await stream.next();
    if (next.done) return next.value;
    const event = next.value;
    if (!('role' in event)) observe(event);
    if ('role' in event) {
      for (const content of event.content) {
        if (content.type !== 'tool_result') continue;
        const tool = pending.get(content.tool_use_id);
        if (!tool) throw new Error('tool result without matching saved call');
        send({
          type: 'tool_result',
          block: tool.block,
          tool: tool.tool,
          input: tool.input,
          output: content.content,
          isError: content.is_error === true,
        });
        pending.delete(content.tool_use_id);
      }
    } else if (event.type === 'message_start') {
      wire.block++;
      streamed = false;
    } else if (event.type === 'text_delta') {
      streamed = true;
      send({ type: 'text_delta', block: wire.block, text: event.text });
    } else if (event.type === 'thinking_delta')
      send({ type: 'thinking_delta', block: wire.block, text: event.thinking });
    else if (event.type === 'assistant_message') {
      for (const content of event.message.content) {
        if (content.type === 'text' && !streamed)
          send({ type: 'text_delta', block: wire.block, text: content.text });
        if (content.type !== 'tool_use') continue;
        const id = ++wire.block;
        pending.set(content.id, { block: id, tool: content.name, input: content.input });
        send({
          type: 'tool_use_start',
          block: id,
          tool: content.name,
          inputPartial: content.input,
        });
        send({ type: 'tool_use_done', block: id, input: content.input });
      }
    }
  }
}

async function boundedWait(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  if (timer) clearTimeout(timer);
}
async function boundedDispose(runtime: Runtime): Promise<void> {
  await boundedWait(
    (async () => {
      for (const session of runtime.sessionContexts.keys()) {
        for (const task of runtime.taskManager.list(session))
          await runtime.taskManager.stop(task.id);
      }
      await runtime.dispose();
    })().catch(() => {}),
    3000,
  );
}

function runtimeMarkerId(row: {
  toolCallId: string | null;
  toolCalls: unknown;
}): string | undefined {
  if (!row.toolCalls || typeof row.toolCalls !== 'object') return undefined;
  const id = (row.toolCalls as { id?: unknown; origin?: unknown }).id;
  if ((row.toolCalls as { origin?: unknown }).origin !== 'runtime') return undefined;
  if (typeof id === 'string' && id.length > 0) return id;
  return row.toolCallId ?? undefined;
}

/** Safety and rehydrate read this boundary's rows instead of querying again. */
function sessionView(
  store: SessionDb,
  sessionId: string,
  rows: StoredMessage[],
  executions: ReturnType<SessionDb['loadToolExecutions']>,
): SessionStore {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'loadMessages')
        return (id: string) => (id === sessionId ? rows : target.loadMessages(id));
      if (property === 'loadToolExecutions')
        return (id: string) => (id === sessionId ? executions : target.loadToolExecutions(id));
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as SessionStore;
}

function ambiguousTruncatedToolRequest(store: SessionStore, sessionId: string | null): boolean {
  if (!sessionId) return false;
  try {
    const last = store.loadMessages(sessionId).at(-1);
    if (!last || last.role !== 'user') return false;
    const results = last.content.filter((block) => block.type === 'tool_result');
    if (results.length === 0) return false;
    return results.every(
      (block) =>
        block.type === 'tool_result' &&
        block.is_error === true &&
        block.content === AMBIGUOUS_MAX_TOKENS_TOOL_NOTE,
    );
  } catch {
    return false;
  }
}

function isStorageFault(error: unknown): boolean {
  return (
    error instanceof PersistBeforeRunError ||
    error instanceof SessionPersistenceError ||
    error instanceof ToolStorageError
  );
}

/** A clean re-read is an unsafe receipt. A throw is a storage fault. */
function assertReadableRecoveryStore(store: SessionDb, sessionId: string): void {
  try {
    store.getSession(sessionId);
    store.loadMessages(sessionId);
    store.loadToolExecutions(sessionId);
  } catch (error) {
    throw new SessionPersistenceError(error);
  }
}
type AttemptCharge = { usage?: TokenUsage; estimatedCostUsd?: number };

/** One logical segment pays for every drive it started and for the summary between them. */
function mergeRecoveredAttempts(
  abandoned: RunResult,
  retry: RunResult,
  compaction: AttemptCharge,
): RunResult {
  const usage = sumTokenUsage(abandoned.usage, compaction.usage, retry.usage);
  const estimatedCostUsd = pricedTotal(attemptCharge(abandoned), compaction, attemptCharge(retry));
  const {
    usage: _retryUsage,
    estimatedCostUsd: _retryCost,
    costEstimate: _retryEstimate,
    usageComplete: _retryComplete,
    ...rest
  } = retry;
  const names = new Set([...abandoned.distinctToolNames, ...retry.distinctToolNames]);
  return {
    ...rest,
    iterationsUsed: abandoned.iterationsUsed + 1 + retry.iterationsUsed,
    toolCallCount: abandoned.toolCallCount + retry.toolCallCount,
    distinctToolNames: [...names].sort(),
    ...(usage !== undefined ? { usage } : {}),
    ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
  };
}

/** A proactive summary before a continuation segment is one model call. */
function chargeLeadingSummary(result: RunResult, compaction: AttemptCharge): RunResult {
  const usage = sumTokenUsage(result.usage, compaction.usage);
  const estimatedCostUsd = pricedTotal(attemptCharge(result), compaction);
  return {
    ...result,
    iterationsUsed: result.iterationsUsed + 1,
    ...(usage !== undefined ? { usage } : {}),
    ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
  };
}

function chargeRecoveredAttempt(
  abandoned: RunResult,
  compaction: AttemptCharge,
  activeSessionId: string,
): RunResult {
  const usage = sumTokenUsage(abandoned.usage, compaction.usage);
  const estimatedCostUsd = pricedTotal(attemptCharge(abandoned), compaction);
  const {
    usage: _usage,
    estimatedCostUsd: _cost,
    costEstimate: _estimate,
    usageComplete: _complete,
    ...rest
  } = abandoned;
  return {
    ...rest,
    sessionId: activeSessionId,
    iterationsUsed: abandoned.iterationsUsed + 1,
    ...(usage !== undefined ? { usage } : {}),
    ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
  };
}

function attemptCharge(result: Pick<RunResult, 'usage' | 'estimatedCostUsd'>): AttemptCharge {
  return {
    ...(result.usage !== undefined ? { usage: result.usage } : {}),
    ...(result.estimatedCostUsd !== undefined ? { estimatedCostUsd: result.estimatedCostUsd } : {}),
  };
}

function sumTokenUsage(...parts: Array<TokenUsage | undefined>): TokenUsage | undefined {
  const present = parts.filter((part): part is TokenUsage => part !== undefined);
  if (present.length === 0) return undefined;
  const total: TokenUsage = {};
  for (const field of [
    'inputTokens',
    'outputTokens',
    'cacheCreationInputTokens',
    'cacheReadInputTokens',
    'reasoningTokens',
  ] as const) {
    let seen = false;
    let sum = 0;
    for (const usage of present) {
      const value = usage[field];
      if (value === undefined) continue;
      seen = true;
      sum += value;
    }
    if (seen) total[field] = sum;
  }
  return total;
}

function pricedTotal(...parts: AttemptCharge[]): number | undefined {
  let total = 0;
  let seen = false;
  for (const part of parts) {
    if (part.estimatedCostUsd !== undefined) {
      seen = true;
      total += part.estimatedCostUsd;
      continue;
    }
    if (part.usage !== undefined) return undefined;
  }
  return seen ? total : undefined;
}

async function settleWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

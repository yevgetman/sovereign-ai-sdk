/** Native headless host. No server, no preflight inference, and one SDK store writer. */
import { randomUUID } from 'node:crypto';
import type { RunResult } from '@yevgetman/sov-sdk/agent/createAgent';
import { ContextManagementError } from '@yevgetman/sov-sdk/compact/contextManagement';
import { loadSettings } from '@yevgetman/sov-sdk/config/loader';
import type { Message, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import { toToolSchemas } from '@yevgetman/sov-sdk/mcp/schemaSerialization';
import type { SessionStore } from '@yevgetman/sov-sdk/persistence/sessionStore';
import {
  ContextOverflowError,
  PersistBeforeRunError,
  SubscriptionAuthExpiredError,
  SubscriptionHttpError,
  SubscriptionStreamError,
  SubscriptionTierBlockedError,
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
  composeTurn,
  createSteeringPoller,
  gateTurnInstructions,
  headlessDenyAsk,
  hydrateSessionHistory,
  loadStoredMessages,
  persistTurnMessage,
} from '../server/turnComposition.js';
import { mapTerminalReason } from '../server/turnRelay.js';
import { readModelCatalogSnapshot } from './modelDiscovery.js';
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
  provider_request_rejected:
    'Selected provider rejected this request. No route fallback was performed.',
  provider_failed: 'Selected provider failed. No route fallback was performed.',
};
function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
/** A rejected `routes.<id>.defaultModel` names the setting; other model errors stay generic.
 *  Explicit `off` is a route refusal (reasoning cannot be disabled), not a model with no effort.
 */
function turnErrorText(code: string, err: unknown): string {
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
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let runtime: Runtime | undefined;
  let selected: SelectedRoute | undefined;
  let selectedMetadata: ModelRecord | undefined;
  let sessionId: string | null = null;
  let activeStream: AsyncGenerator<StreamEvent | Message, RunResult> | undefined;
  let stage: 'input' | 'route' | 'storage' | 'provider' = 'input';
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
  const routeId = string(opts.route);
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
    if (
      opts.json !== true ||
      opts.stdin !== true ||
      !routeId ||
      opts.provider !== undefined ||
      (opts.permissionMode !== undefined &&
        !['default', 'ask', 'bypass'].includes(String(opts.permissionMode))) ||
      (opts.model !== undefined && !string(opts.model)) ||
      (opts.effort !== undefined &&
        !['auto', 'off', 'low', 'medium', 'high', 'max'].includes(String(opts.effort)))
    )
      throw new SdkInputError(
        'invalid_input',
        'SDK mode requires json, stdin, route and no legacy provider',
      );
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
      deadline = setTimeout(sigint, opts.deadlineMs);
    }
    const raw = await Promise.race([(io.readStdin ?? readSdkStdin)(), canceled]);
    const settings = loadSettings();
    const requestedRoute = getRoute(routeId, settings);
    const requestedModel =
      string(opts.model) && opts.model !== 'auto'
        ? String(opts.model)
        : requestedRoute.defaultModel;
    selectedMetadata = findModel(readModelCatalogSnapshot(routeId, settings), requestedModel);
    const imageProof = verifiedSubscriptionImageInput(selectedMetadata);
    const supportsImages =
      routeSupportsImages(routeId) &&
      (requestedRoute.auth !== 'subscription' || imageProof !== undefined);
    // Validate input and bounded attachments BEFORE credential access or runtime boot.
    const input = await Promise.race([
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
      (deps.resolve ?? resolveRouteProvider)(routeId, {
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
    stage = 'storage';
    const runtimeBoot = (deps.runtime ?? buildRuntime)({
      cwd: process.cwd(),
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
    sessionId =
      string(opts.resume) ??
      runtime.sessionDb.createSession({
        provider: selected.route.provider,
        model: selected.model,
        platform: 'cli',
        metadata: { route: routeId, auth: selected.route.auth },
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
      !routeSupportsImages(routeId) &&
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
            ((routeId !== 'grok-subscription' && routeId !== 'chatgpt-subscription') ||
              block.routeId !== routeId ||
              block.provenance?.version !== 1 ||
              block.provenance.routeId !== routeId ||
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
    const hydrate = () =>
      hydrateSessionHistory(
        loadStoredMessages(persistence, sessionId as string),
        sessionId as string,
      );
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
              target.recordUsageEstimate(key, usage, estimate);
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
        provider: routeSelection.provider,
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
    // Persist the original prompt once. Each retry reloads the latest durable
    // transcript, including completed tools, rather than replaying the input.
    persistTurnMessage(persistence, sessionId, input.message);
    let messages = hydrate();
    emit({
      type: 'session.started',
      sessionId,
      activeSessionId: sessionId,
      resumed: !!string(opts.resume),
      ...metadata(),
      toolset,
      ...permissionMetadata,
    });
    stage = 'provider';
    const compact = async (): Promise<boolean> => {
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
          hostRuntime.compact(messages, id, controller.signal, {
            onStreamEvent: meter.observe,
            modelMetadata,
            effort: routeSelection.effort,
            inputTokenAccounting,
            inputSystem: hop.system,
            inputTools: toToolSchemas(hop.composed.tools),
          }),
          canceled,
        ]);
        noOp = result.noOp === true || result.newSessionId === id;
        if (noOp) return false;
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
        return true;
      } finally {
        if (!noOp) {
          const measured = receipt ?? meter.partial();
          receipts.push(measured);
          // Successful compactSession writes its own summary receipt. Failed
          // or cancelled requests have no child; preserve their partial bill.
          if (!receipt && measured.costEstimate)
            hostRuntime.sessionDb.recordCompactionUsage(
              id,
              measured.usage ?? {},
              undefined,
              measured.costEstimate,
            );
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
    if (
      shouldCompactModelRequest(
        messages,
        hop.system,
        schemas,
        modelSnapshot.limits,
        runtime.proactiveCompactThreshold,
        { counter: inputTokenAccounting, model: routeSelection.model, metadata: modelMetadata },
      )
    ) {
      if (canReduce(hop, messages) && (await compact())) hop = makeHop();
    }
    const runOnce = async (): Promise<RunResult> => {
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
      try {
        activeStream = hop.composed.agent.run(
          messages,
          hop.composed.perTurn({
            sessionId: id,
            sessionCtx: hop.sessionCtx,
            storedPrefixLength: messages.length,
            ...(turnId !== undefined ? { turnId } : {}),
          }),
        );
        result = await Promise.race([
          relayNative(activeStream, emit, id, wire, meter.observe),
          canceled,
        ]);
        hop.sessionCtx.trajectoryMetadata.toolCallCount += result.toolCallCount;
        hop.sessionCtx.trajectoryMetadata.iterationsUsed += result.iterationsUsed;
        hop.sessionCtx.trajectoryMetadata.terminalReason = result.terminal.reason;
        return result;
      } finally {
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
    let result = await runOnce();
    const overflow = (r: RunResult) =>
      r.terminal.reason === 'error' &&
      (r.terminal.error instanceof ContextOverflowError ||
        r.terminal.error instanceof ContextManagementError ||
        isContextOverflowError(r.terminal.error));
    if (overflow(result)) {
      // Independent of proactive compaction: ONE actual recovery retry only.
      messages = hydrate();
      const recoveryHop = makeHop();
      if (canReduce(recoveryHop, messages) && (await compact())) {
        hop = makeHop();
        result = await runOnce();
      }
    }
    if (result.terminal.reason === 'interrupted' || controller.signal.aborted)
      throw new Error('interrupted');
    if (result.terminal.reason === 'error')
      throw result.terminal.error ?? new Error('provider failed');
    continuityOutcome = 'succeeded';
    finish({
      type: 'turn.completed',
      sessionId,
      activeSessionId: sessionId,
      ...metadata(),
      reply:
        result.finalAssistant?.content
          .filter((b) => b.type === 'text')
          .map((b) => (b.type === 'text' ? b.text : ''))
          .join('') ?? '',
      finishReason: mapTerminalReason(result.terminal),
      ...nativeTurnMetrics(receipts),
    });
    return 0;
  } catch (err) {
    let code = controller.signal.aborted
      ? 'interrupted'
      : err instanceof SdkInputError
        ? err.code
        : err instanceof UnknownToolsetError
          ? 'invalid_input'
          : err instanceof SessionNotFoundError
            ? 'invalid_input'
            : err instanceof PersistBeforeRunError
              ? 'storage_failed'
              : err instanceof ContextManagementError
                ? 'context_overflow'
                : stage === 'storage'
                  ? 'storage_failed'
                  : routeErrorCodeFor(err);
    if (!ERRORS[code]) code = 'provider_failed';
    finish({
      type: 'turn.error',
      sessionId,
      activeSessionId: sessionId,
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
      recoverable:
        !(err instanceof SubscriptionStreamError && err.phase === 'incomplete_delivery') &&
        ['rate_limited', 'interrupted'].includes(code),
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
    if (deadline) clearTimeout(deadline);
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

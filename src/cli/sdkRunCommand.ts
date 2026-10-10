/** Native headless host. No server, no preflight inference, and one SDK store writer. */
import type { RunResult } from '@yevgetman/sov-sdk/agent/createAgent';
import { ContextManagementError } from '@yevgetman/sov-sdk/compact/contextManagement';
import { loadSettings } from '@yevgetman/sov-sdk/config/loader';
import type { Message, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import { PersistBeforeRunError, UnknownToolsetError } from '@yevgetman/sov-sdk/providers/errors';
import { type ModelRecord, findModel } from '@yevgetman/sov-sdk/providers/models/index';
import { getRoute } from '@yevgetman/sov-sdk/providers/routes/index';
import {
  resolveRouteProvider,
  routeErrorCodeFor,
  routeSupportsImages,
} from '@yevgetman/sov-sdk/providers/routes/index';
import { isToolsetName } from '@yevgetman/sov-sdk/tool/toolset';
import { SessionNotFoundError } from '../server/errors.js';
import { buildRuntime } from '../server/runtime.js';
import type { Runtime, RuntimeOptions } from '../server/runtime.js';
import {
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
  provider_failed: 'Selected provider failed. No route fallback was performed.',
};
function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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
    // Validate input and bounded attachments BEFORE credential access or runtime boot.
    const input = await Promise.race([
      parseSdkInput(raw, opts.inputFormat, routeSupportsImages(routeId)),
      canceled,
    ]);
    stage = 'route';
    const settings = loadSettings();
    const requestedModel =
      string(opts.model) && opts.model !== 'auto'
        ? String(opts.model)
        : getRoute(routeId, settings).defaultModel;
    selectedMetadata = findModel(readModelCatalogSnapshot(routeId, settings), requestedModel);
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
    const turnMetadata = { ...metadata(), at: new Date().toISOString(), toolset };
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
    const sessionCtx = runtime.getSessionContext(sessionId);
    sessionCtx.effort = selected.effort;
    const canUseTool = buildTurnCanUseTool(runtime, {
      ask: headlessDenyAsk,
      permissionMode: runtime.permissionMode,
    });
    const instructions = gateTurnInstructions(runtime, sessionId, input.instructions);
    const pollSteering = createSteeringPoller(string(opts.steerFile), (count) =>
      emit({ type: 'steer_injected', sessionId, count }),
    );
    const composed = composeTurn({
      runtime,
      persistence,
      canUseTool,
      provider: selected.provider,
      model: selected.model,
      modelMetadata: selectedMetadata,
      effort: selected.effort,
      toolset,
      ...(instructions !== undefined ? { instructions } : {}),
      signal: controller.signal,
      ...(pollSteering !== undefined ? { pollSteering } : {}),
      traceRecorder: (event) => sessionCtx.traceWriter.record(event),
    });
    // User row first; prefix includes this row so SDK does not duplicate it.
    persistTurnMessage(persistence, sessionId, input.message);
    emit({
      type: 'session.started',
      sessionId,
      resumed: !!string(opts.resume),
      ...metadata(),
      toolset,
      permissionMode: runtime.permissionMode,
    });
    stage = 'provider';
    activeStream = composed.agent.run(
      [...stored, input.message],
      composed.perTurn({ sessionId, sessionCtx, storedPrefixLength: stored.length + 1 }),
    );
    const result = await Promise.race([relayNative(activeStream, emit, sessionId), canceled]);
    sessionCtx.trajectoryMetadata.toolCallCount += result.toolCallCount;
    sessionCtx.trajectoryMetadata.iterationsUsed += result.iterationsUsed;
    sessionCtx.trajectoryMetadata.terminalReason = result.terminal.reason;
    if (result.terminal.reason === 'interrupted' || controller.signal.aborted)
      throw new Error('interrupted');
    if (result.terminal.reason === 'error')
      throw result.terminal.error ?? new Error('provider failed');
    finish({
      type: 'turn.completed',
      sessionId,
      ...metadata(),
      reply:
        result.finalAssistant?.content
          .filter((b) => b.type === 'text')
          .map((b) => (b.type === 'text' ? b.text : ''))
          .join('') ?? '',
      finishReason: mapTerminalReason(result.terminal),
      ...(result.usage ? { usage: result.usage } : {}),
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
      ...metadata(),
      code,
      error: ERRORS[code],
      recoverable: ['rate_limited', 'interrupted'].includes(code),
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
    controller.abort();
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
): Promise<RunResult> {
  let block = 0;
  let seq = 0;
  let streamed = false;
  const pending = new Map<string, { block: number; tool: string; input: unknown }>();
  const send = (event: Record<string, unknown>) => emit({ seq: ++seq, sessionId, ...event });
  while (true) {
    const next = await stream.next();
    if (next.done) return next.value;
    const event = next.value;
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
      block++;
      streamed = false;
    } else if (event.type === 'text_delta') {
      streamed = true;
      send({ type: 'text_delta', block, text: event.text });
    } else if (event.type === 'thinking_delta')
      send({ type: 'thinking_delta', block, text: event.thinking });
    else if (event.type === 'assistant_message') {
      for (const content of event.message.content) {
        if (content.type === 'text' && !streamed)
          send({ type: 'text_delta', block, text: content.text });
        if (content.type !== 'tool_use') continue;
        const id = ++block;
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

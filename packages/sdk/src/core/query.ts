import { rememberLogicalSegmentStop } from '../agent/logicalTurn.js';
import { isOwnerSubscriptionModel } from '../providers/models/ownerModelPolicy.js';
// The turn loop — async generator yielding typed events. Phase 2: wraps
// the Phase-1 single-turn body in a while-loop. When the assistant
// message contains `tool_use` blocks, dispatches to `runTools()`, yields
// the resulting user message (with tool_result blocks), and loops for a
// continuation turn. Terminates when the assistant responds without any
// tool_use, when maxTurns is hit, when aborted, or on error.
//
// History discipline: we build the history internally. The caller passes
// `messages` as the input seed; every assistant reply and tool-result
// user message is appended to the internal history, which is what's sent
// on the next iteration's provider.stream() call. The caller's array is
// not mutated.
//
// Source of pattern: Claude Code src/query.ts (lesson: core loop shape is
// a one-way door; use async generator from day one).

import {
  ContextManagementError,
  historyBytes,
  reduceContext,
  validateContextLimits,
} from '../compact/contextManagement.js';
import {
  DEFAULT_MICROCOMPACT_CONFIG,
  buildToolNameMap,
  microcompact,
  shouldMicrocompact,
} from '../compact/microcompact.js';
import type { StopHookReason } from '../hooks/types.js';
import { LoopDetectorState } from '../loop/detector.js';
import { toToolSchemas } from '../mcp/schemaSerialization.js';
import {
  FENCE_PREAMBLE,
  injectMemoryIntoLatestUserMessage,
  injectMemoryIntoUserText,
} from '../memory/injection.js';
import {
  PersistBeforeRunError,
  ToolStorageError,
  isContextOverflowError,
} from '../providers/errors.js';
import {
  type RequestInputTokenEstimate,
  assertRequestFits,
  resolveModelLimits,
} from '../providers/modelLimits.js';
import { validateModelRequest } from '../providers/models/validateRequest.js';
import { listRoutes } from '../providers/routes/catalog.js';
import { validateRouteSelection } from '../providers/routes/validate.js';
import {
  legacyInputTokenAccounting,
  modelInputTokenAccounting,
} from '../providers/tokenAccounting.js';
import type { ProviderRequest } from '../providers/types.js';
import { createSkillActivationState, createSkillChildPermission } from '../skills/activation.js';
import { resolveSkillContextBudget } from '../skills/budget.js';
import { buildSkillCatalogIndex } from '../skills/catalog.js';
import { isSkillInvocable } from '../skills/descriptor.js';
import { reloadSkill } from '../skills/loader.js';
import { getSkillRegistry, getSkillRegistrySnapshot } from '../skills/registry.js';
import { inferActiveToolsets } from '../skills/visibility.js';
import { intersectCanUseTool } from '../tool/capabilityProfiles.js';
import { effectiveToolInventory, projectToolInventory } from '../tool/effectiveInventory.js';
import type { Tool, ToolContext } from '../tool/types.js';
import type { TraceEvent } from '../trace/types.js';
import { type TurnSummary, detectStall } from '../util/stall.js';
import { DEFAULT_CONDUCT_REFUSAL, wrapConductAuditSink } from './conductPort.js';
import { runTools } from './orchestrator.js';
import { injectRecallIntoLatestUserMessage } from './recallInjection.js';
import type {
  AssistantMessage,
  ContentBlock,
  LoopDetectionInfo,
  Message,
  QueryParams,
  StopReason,
  StreamEvent,
  Terminal,
  TokenUsage,
  UserMessage,
} from './types.js';

const DEFAULT_MAX_TURNS = 100;

type DeferredLogicalStop = { fire?: (reason?: StopHookReason) => Promise<void> };

const logicalStops = new WeakMap<Terminal, (reason?: StopHookReason) => Promise<void>>();

/** Stop hook deferred by one logical-turn segment. Absent when that segment fired nothing. */
export function logicalSegmentStop(
  terminal: Terminal,
): ((reason?: StopHookReason) => Promise<void>) | undefined {
  return logicalStops.get(terminal);
}

function bindDeferredLogicalStop(terminal: Terminal, deferred: DeferredLogicalStop): void {
  if (deferred.fire) logicalStops.set(terminal, deferred.fire);
}

// The TokenUsage fields carried by usage_delta events. Mirrors the
// usageAccumulator's field list (kept local — the boundary forbids importing
// its internals). `reasoningTokens` (T1) is an informational subset of
// outputTokens; it merges like the rest.
const USAGE_DELTA_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheCreationInputTokens',
  'cacheReadInputTokens',
  'reasoningTokens',
] as const satisfies readonly (keyof TokenUsage)[];

/** Merge one `usage_delta` into the call's running usage, last-seen PER FIELD.
 *  Anthropic emits input + cache at message_start then output at message_delta
 *  (a second delta that omits the earlier fields); a whole-object overwrite
 *  would drop them. Immutable: returns a NEW object spreading `prev`, then
 *  copies only the DEFINED fields of `delta` (never writing an explicit-
 *  undefined key — respecting exactOptionalPropertyTypes). Identical to the old
 *  `usage = delta` behavior when a call emits a single delta. */
function mergeUsage(prev: TokenUsage | undefined, delta: TokenUsage): TokenUsage {
  const merged: TokenUsage = { ...prev };
  for (const field of USAGE_DELTA_FIELDS) {
    const value = delta[field];
    if (value !== undefined) merged[field] = value;
  }
  return merged;
}

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>;
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>;

/** Index a runTools output message's `tool_result` blocks by `tool_use_id`, so
 *  each of this turn's `tool_use` blocks can be paired with what it returned. */
function collectToolResults(message: Message | undefined): Map<string, ToolResultBlock> {
  const byId = new Map<string, ToolResultBlock>();
  if (message === undefined || message.role !== 'user') return byId;
  for (const block of message.content) {
    if (block.type === 'tool_result') byId.set(block.tool_use_id, block);
  }
  return byId;
}

/** Flatten `tool_result` content to the text the loop guard hashes. This SDK's
 *  canonical shape is a plain string, but history can arrive from a host that
 *  kept Anthropic's array form — so accept both, join text blocks, and give a
 *  non-text block a stable marker (`[image]`) rather than dropping it, which
 *  would make two different results hash equal. Typed `unknown` on purpose:
 *  the array branch is unreachable for well-typed history and this is the
 *  boundary that must not trust it. */
function flattenToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(flattenContentBlock).join('\n');
}

function flattenContentBlock(block: unknown): string {
  if (typeof block === 'string') return block;
  if (block === null || typeof block !== 'object' || !('type' in block)) return '';
  const typed = block as { type: unknown; text?: unknown };
  if (typed.type === 'text' && typeof typed.text === 'string') return typed.text;
  return `[${String(typed.type)}]`;
}

/** Run one user turn, including provider streaming and tool-use continuation turns. */
export async function* query(params: QueryParams): AsyncGenerator<StreamEvent | Message, Terminal> {
  const deferred: DeferredLogicalStop = {};
  const continuity = params.toolContext?.skillContinuity;
  if (!continuity) {
    const terminal = yield* queryInternal(params, deferred);
    bindDeferredLogicalStop(terminal, deferred);
    return terminal;
  }
  const context = params.toolContext;
  if (
    !context ||
    continuity.scope.session !== context.sessionId ||
    (params.sessionId !== undefined && params.sessionId !== context.sessionId)
  )
    return {
      reason: 'error',
      error: new Error('skill continuity scope does not match the current session'),
    };
  const state =
    context.skillActivation ??
    createSkillActivationState({
      tools: params.tools ?? [],
      ...(params.canUseTool ? { canUseTool: params.canUseTool } : {}),
      ...(params.hookRunner ? { hookRunner: params.hookRunner } : {}),
    });
  let terminal: Terminal | undefined;
  let failed = false;
  try {
    terminal = yield* queryInternal(
      {
        ...params,
        toolContext: { ...context, skillActivation: state },
      },
      deferred,
    );
    bindDeferredLogicalStop(terminal, deferred);
    return terminal;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (!context.skillContinuityManagedByHost)
      await continuity.finish(
        state.turnId,
        failed ||
          terminal?.reason === 'error' ||
          terminal?.reason === 'max_tokens' ||
          terminal?.reason === 'max_turns'
          ? 'failed'
          : !terminal || terminal.reason === 'interrupted'
            ? 'cancelled'
            : 'succeeded',
      );
  }
}

async function* queryInternal(
  params: QueryParams,
  deferred: DeferredLogicalStop,
): AsyncGenerator<StreamEvent | Message, Terminal> {
  const modelMetadata = params.modelMetadata ? structuredClone(params.modelMetadata) : undefined;
  // Publisher limits are snapshotted once. Host caps never expand them.
  const useModelLimits = Boolean(modelMetadata || params.contextLimits?.contextWindowTokens);
  const effectiveModelLimits = useModelLimits
    ? resolveModelLimits(
        modelMetadata
          ? {
              contextTokens: modelMetadata.contextWindow,
              outputTokens: modelMetadata.maxOutputTokens,
              stale:
                modelMetadata.metadata.stale &&
                !isOwnerSubscriptionModel(modelMetadata, params.model),
              source: modelMetadata.metadata.source,
            }
          : undefined,
        {
          contextTokens: params.contextLimits?.contextWindowTokens,
          outputTokens: params.maxTokens,
        },
      )
    : undefined;
  const outputCeiling = effectiveModelLimits
    ? Math.min(params.maxTokens, effectiveModelLimits.outputTokens)
    : params.maxTokens;
  let maxTokens = outputCeiling;
  const contextLimits =
    params.contextLimits && effectiveModelLimits
      ? {
          ...params.contextLimits,
          contextWindowTokens: effectiveModelLimits.contextTokens,
        }
      : params.contextLimits;
  const {
    provider,
    model,
    messages,
    systemPrompt: initialSystemPrompt,
    tools,
    temperature,
    effort,
    maxTurns = DEFAULT_MAX_TURNS,
    signal,
    cacheEnabled = true,
  } = params;

  // biome-ignore lint/suspicious/noExplicitAny: cast-free tool composition (F8) — see createAgent AgentConfig.tools.
  let toolPool: Tool<any, any>[] = tools ?? [];
  const inheritedActivation = params.toolContext?.skillActivation;
  if (inheritedActivation) {
    const inheritedNames = new Set(inheritedActivation.tools.map((tool) => tool.name));
    toolPool = toolPool.filter((tool) => inheritedNames.has(tool.name));
  }
  toolPool = effectiveToolInventory(toolPool);
  // Isolate skill-enabled contexts so their capabilities expire with the turn.
  // Generic host contexts retain the public query() identity contract.
  const skillsEnabled = Boolean(
    params.toolContext?.skills ||
      params.toolContext?.skillActivation ||
      params.toolContext?.skillContinuity ||
      params.toolContext?.skillRegistryManager,
  );
  const toolCtx: ToolContext | undefined =
    skillsEnabled && params.toolContext ? { ...params.toolContext } : params.toolContext;
  let systemPrompt = initialSystemPrompt;
  const inheritedChildPermission = toolCtx?.canUseTool;
  const hostPermission =
    inheritedActivation && params.canUseTool && params.canUseTool !== inheritedActivation.canUseTool
      ? intersectCanUseTool(inheritedActivation.canUseTool, params.canUseTool)
      : (params.canUseTool ?? inheritedActivation?.canUseTool);
  const skillHooks = params.hookRunner ?? inheritedActivation?.hookRunner;
  const activationState = createSkillActivationState({
    tools: toolPool,
    ...(hostPermission ? { canUseTool: hostPermission } : {}),
    ...(skillHooks ? { hookRunner: skillHooks } : {}),
  });
  activationState.hasHostPermission =
    params.canUseTool !== undefined || inheritedActivation?.hasHostPermission === true;
  if (toolCtx && skillsEnabled) {
    if (inheritedActivation) activationState.turnId = inheritedActivation.turnId;
    if (inheritedActivation?.hasInheritedRestrictions)
      activationState.hasInheritedRestrictions = true;
    // The actual turn pool is authoritative, including SDK-only contexts and
    // host contexts whose visibility hints were created for a broader pool.
    toolCtx.activeToolNames = toolPool.map((tool) => tool.name);
    toolCtx.activeToolsets = inferActiveToolsets(toolCtx.activeToolNames, toolCtx.activeToolsets);
    activationState.activations = toolCtx.skillActivation?.activations.slice() ?? [];
    if (toolCtx.skillActivation) {
      activationState.restrictionCanUseTool = toolCtx.skillActivation.restrictionCanUseTool;
      // A fresh attempt retains the input floor with its fresh host callback.
      // Delegated calls need this gate as well as the final dispatch check.
      activationState.canUseTool = intersectCanUseTool(
        activationState.canUseTool,
        activationState.restrictionCanUseTool,
      );
    }
    toolCtx.skillActivation = activationState;
    params.onSkillRestrictionState?.({
      get tools() {
        return activationState.tools;
      },
      get restrictionCanUseTool() {
        return activationState.restrictionCanUseTool;
      },
      get activations() {
        return activationState.activations;
      },
    });
  }
  // Resolve dynamically: serial calls after SkillTool in the same batch must
  // obey its new floor as well as continuation requests on the next iteration.
  const canUseTool = skillsEnabled
    ? async (...args: Parameters<typeof activationState.canUseTool>) =>
        activationState.canUseTool(...args)
    : params.canUseTool;
  const hookRunner = skillHooks;
  const sessionId = params.sessionId ?? toolCtx?.sessionId;
  const cwd = params.cwd ?? toolCtx?.cwd;
  const recordTrace = makeTraceRecorder(params.traceRecorder);
  const loopDetector = new LoopDetectorState(params.loop);
  /** The loop guard is advisory: a throw inside it must never fail the turn.
   *  Any exception is recorded as a `loop_detector_error` trace event and the
   *  call yields `fallback` — "no detection" for a check, nothing for an
   *  observation (spec §3.8). */
  const guarded = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (err) {
      recordTrace({
        type: 'loop_detector_error',
        message: err instanceof Error ? err.message : String(err),
        iso: nowIso(),
      });
      return fallback;
    }
  };
  let loopDetectionCount = 0;
  let totalToolCallCount = 0;
  // Phase 13.3 — sliding window of TurnSummary records for stall detection.
  const recentTurnSummaries: TurnSummary[] = [];
  const originalUserText = latestUserText(messages);
  // The host stores the original user message and rehydrates it on the next
  // segment, so the fence has to be applied again in this copy. Recall and
  // user-turn hooks stay skipped. An existing fence is not copied again.
  let history = [...messages];
  if (params.memoryManager) {
    history = params.continuation
      ? await reinjectMemoryFence(history, params.memoryManager)
      : await injectMemoryIntoLatestUserMessage(history, params.memoryManager);
  }

  // Learning loop (Recall): after memory injection, prepend recalled lessons to
  // the latest user message. Optional thunk bound by the host; query() stays
  // project-agnostic. Empty injectionText leaves history unchanged (same ref).
  if (!params.continuation && params.recall) {
    const recalled = await params.recall(originalUserText);
    history = injectRecallIntoLatestUserMessage(history, recalled.injectionText);
  }

  // Both memory + recall injection PREPEND their blocks to the latest user
  // message's first text block, keeping `originalUserText` as the trailing
  // suffix. Capture the injected prefix now so that if a UserPromptSubmit hook
  // rewrites the prompt below, we can preserve the injected context instead of
  // letting the whole-block rewrite silently wipe MEMORY.md / <learned-context>.
  // Empty when nothing was injected.
  const injectedPrefix =
    originalUserText !== undefined ? extractInjectedPrefix(history, originalUserText) : '';

  // UserPromptSubmit: runs once before turn 0. A hook can deny (terminating
  // immediately) or rewrite the prompt text in the latest user message.
  if (!params.continuation && hookRunner && sessionId && cwd && originalUserText !== undefined) {
    const result = await hookRunner(
      'UserPromptSubmit',
      {
        hookEventName: 'UserPromptSubmit',
        session_id: sessionId,
        cwd,
        prompt: originalUserText,
      },
      signal,
    );
    if (result.block) {
      const error = new Error(result.reason ?? 'prompt rejected by UserPromptSubmit hook');
      error.name = 'UserTurnPolicyError';
      const terminal: Terminal = {
        reason: 'error',
        error,
      };
      await maybeFireStop(terminal.reason);
      return terminal;
    }
    if (typeof result.rewrittenPrompt === 'string') {
      // Re-apply the injected memory/recall prefix in front of the hook's
      // rewritten text. The hook only ever sees + returns the user prompt, so
      // without this the whole-block rewrite would drop that turn's injected
      // context. `injectedPrefix` is '' when nothing was injected → identical
      // to the plain rewrite.
      history = rewriteLatestUserText(history, `${injectedPrefix}${result.rewrittenPrompt}`);
    }
  }

  // Synthesize a refusal reply (preGate deny-with-text / triage refuse): the
  // turn COMPLETES with an assistant message — a refusal is a successful turn,
  // not an error. Mirrors the shape consumers already handle (assistant_message
  // event → the message itself is NOT re-yielded; hosts persist via the event,
  // matching createAgent's drive loop which collects assistant messages from
  // events only).
  function* yieldConductRefusal(text: string): Generator<StreamEvent, Terminal> {
    const message: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text }],
    };
    history.push(message);
    yield { type: 'message_start' };
    yield { type: 'text_delta', text };
    yield { type: 'assistant_message', message };
    yield { type: 'message_stop', stop_reason: 'end_turn' };
    return { reason: 'completed' };
  }
  // Conduct seams (1b). preGate runs AFTER the UserPromptSubmit rewrite so it
  // sees the FINAL text — including the injected memory/recall prefix and any
  // hook rewrite; nothing smuggles past it via a rewriting hook (D23). 'user'
  // surface only; a thrown capability fails OPEN (fail-closed postures are the
  // engine's job, inside the capability). Audit events are content-free.
  const conduct = params.conduct;
  const conductCtx = params.conductCtx;
  const emitConductAudit = wrapConductAuditSink(conduct?.auditSink?.bind(conduct));
  if (!params.continuation && conduct?.preGate && conductCtx && conductCtx.surface === 'user') {
    const gateText = latestUserText(history);
    if (gateText !== undefined) {
      // Gate-input capture (attestation evidence §3.4): hand the EXACT text the
      // gate is about to see to the host's capture callback, BEFORE the verdict
      // applies (a rewrite must not alter what was captured). Observer — a
      // throw is swallowed; evidence never breaks a turn.
      if (params.onConductGateInput) {
        try {
          params.onConductGateInput(gateText);
        } catch {
          // Evidence is an observer; never propagate.
        }
      }
      const startedAt = Date.now();
      let verdictLabel = 'allow';
      try {
        const verdict = await conduct.preGate(gateText, conductCtx);
        verdictLabel = verdict.action;
        if (verdict.action === 'rewrite') {
          history = rewriteLatestUserText(history, verdict.text);
        } else if (verdict.action === 'deny') {
          emitConductAudit({
            stage: 'pregate',
            sessionId: conductCtx.sessionId,
            surface: conductCtx.surface,
            verdict: 'deny',
            latencyMs: Date.now() - startedAt,
            iso: nowIso(),
          });
          if (verdict.refusalText !== undefined) {
            const refusal = yield* yieldConductRefusal(verdict.refusalText);
            await maybeFireStop('completed');
            return refusal;
          }
          const error = new Error('prompt rejected by conduct preGate');
          error.name = 'UserTurnPolicyError';
          const terminal: Terminal = {
            reason: 'error',
            error,
          };
          await maybeFireStop(terminal.reason);
          return terminal;
        }
      } catch {
        verdictLabel = 'error'; // fail open
      }
      if (verdictLabel !== 'deny') {
        emitConductAudit({
          stage: 'pregate',
          sessionId: conductCtx.sessionId,
          surface: conductCtx.surface,
          verdict: verdictLabel,
          latencyMs: Date.now() - startedAt,
          iso: nowIso(),
        });
      }
    }
  }

  // Conduct triage (D3): pre-generation intent assessment. Small-model,
  // posture-shaping, FAIL-OPEN by design; 'refuse' short-circuits pre-model
  // into a refusal reply. Non-refuse postures are advisory in 1b (audited;
  // the engine consumes them when it arrives).
  if (!params.continuation && conduct?.triage && conductCtx && conductCtx.surface === 'user') {
    const triageText = latestUserText(history);
    if (triageText !== undefined) {
      const startedAt = Date.now();
      try {
        const verdict = await conduct.triage(triageText, conductCtx);
        const label = verdict.posture ?? (verdict.genuine ? 'open' : 'guarded');
        emitConductAudit({
          stage: 'triage',
          sessionId: conductCtx.sessionId,
          surface: conductCtx.surface,
          verdict: label,
          latencyMs: Date.now() - startedAt,
          iso: nowIso(),
        });
        if (verdict.posture === 'refuse') {
          const refusal = yield* yieldConductRefusal(
            verdict.refusalText ?? DEFAULT_CONDUCT_REFUSAL,
          );
          await maybeFireStop('completed');
          return refusal;
        }
      } catch {
        emitConductAudit({
          stage: 'triage',
          sessionId: conductCtx.sessionId,
          surface: conductCtx.surface,
          verdict: 'error',
          latencyMs: Date.now() - startedAt,
          iso: nowIso(),
        });
        // fail open
      }
    }
  }

  async function maybeFireStop(reason: Terminal['reason']): Promise<void> {
    if (!hookRunner || !sessionId || !cwd) return;
    if (params.logicalTurn) {
      // The supervisor fires one Stop at the logical terminal. A retry or
      // continuation must not observe this segment as an ending. The work
      // signal is often already aborted (deadline) when that closure runs;
      // binding Stop to it skips the command. The host may also drop the
      // returned terminal on that abort, so the lease binding keeps the closure.
      deferred.fire = (override?: StopHookReason) => {
        const stopReason = override ?? reason;
        if (signal && !signal.aborted)
          return fireStopHook(hookRunner, sessionId, cwd, stopReason, signal);
        return fireStopHook(hookRunner, sessionId, cwd, stopReason);
      };
      rememberLogicalSegmentStop(deferred.fire);
      return;
    }
    await fireStopHook(hookRunner, sessionId, cwd, reason, signal);
  }

  const accountingPort = params.inputTokenAccounting ?? modelInputTokenAccounting(provider.name);
  const countInput = (request: ProviderRequest): RequestInputTokenEstimate => {
    const result = params.inputTokenCounter
      ? legacyInputTokenAccounting(params.inputTokenCounter(request))
      : accountingPort(request);
    if (!Number.isSafeInteger(result.tokens) || result.tokens < 1)
      throw new ContextManagementError('input accounting must return a positive safe integer');
    return result;
  };
  const budgetInput = (request: ProviderRequest): number => {
    const result = countInput(request);
    // Advisory bounds must not shrink the skill catalog as if measured.
    return result.enforce === false ? 0 : result.tokens;
  };

  const refreshSkillCatalog = (): void => {
    if (!toolCtx || !skillsEnabled) return;
    const standing = systemPrompt.filter((segment) => segment.kind !== 'skill-catalog');
    const budget = resolveSkillContextBudget({
      ...(effectiveModelLimits ? { contextWindowTokens: effectiveModelLimits.contextTokens } : {}),
      outputTokens: outputCeiling,
      reservedInputTokens: budgetInput({
        model,
        messages: history,
        system: standing,
        tools: toToolSchemas(activationState.tools),
        maxTokens: outputCeiling,
        ...(modelMetadata ? { modelMetadata } : {}),
      }),
    });
    toolCtx.skillContextBudget = budget;
    const snapshot = getSkillRegistrySnapshot(toolCtx);
    const index = buildSkillCatalogIndex(
      snapshot.registry.skills.filter((skill) => isSkillInvocable(skill, 'model')),
      {
        generation: snapshot.generation,
        budget,
      },
    );
    systemPrompt =
      activationState.tools.some((tool) => tool.name === 'skills_list') && index.text
        ? [
            ...standing,
            { text: index.text, cacheable: cacheEnabled, kind: 'skill-catalog' as const },
          ]
        : standing;
  };

  let overflowRecoveries = 0;
  let toolsDispatched = false;
  const contextSignal = signal ?? new AbortController().signal;
  const manageContext = async (reason: 'budget' | 'overflow'): Promise<StreamEvent> => {
    if (!params.contextManager || !contextLimits) {
      throw new ContextManagementError('contextManager requires contextLimits');
    }
    try {
      const reduced = await reduceContext(params.contextManager, {
        messages: history,
        reason,
        model,
        provider: provider.name,
        maxTokens,
        limits: contextLimits,
        signal: contextSignal,
        ...(sessionId !== undefined ? { sessionId } : {}),
      });
      // Model history only; createAgent persists its separate full transcript.
      history = reduced.messages;
      refreshSkillCatalog();
      return { type: 'context_management', info: reduced.info };
    } catch (error) {
      if (error instanceof ContextManagementError && error.info) throw error;
      throw new ContextManagementError('context reduction failed', {
        applied: false,
        reason,
        beforeBytes: historyBytes(history),
        afterBytes: historyBytes(history),
      });
    }
  };

  let retainedSkillGuidance = '';
  const requestHistory = (): Message[] => {
    if (!retainedSkillGuidance) return history;
    const copy = history.slice();
    let index = copy.findLastIndex((message) => isHumanUserMessage(message));
    if (index < 0) {
      copy.unshift({ role: 'user', content: [] });
      index = 0;
    }
    const message = copy[index];
    if (!message) throw new Error('skill guidance request message unavailable');
    copy[index] = {
      ...message,
      content: [...message.content, { type: 'text', text: retainedSkillGuidance }],
    };
    return copy;
  };
  const attachSkillGuidance = async (): Promise<void> => {
    if (!toolCtx?.skillContinuity) return;
    const budget = resolveSkillContextBudget({
      ...(effectiveModelLimits ? { contextWindowTokens: effectiveModelLimits.contextTokens } : {}),
      outputTokens: outputCeiling,
      reservedInputTokens: budgetInput({
        model,
        messages: history,
        system: systemPrompt,
        tools: toToolSchemas(activationState.tools),
        maxTokens: outputCeiling,
        ...(modelMetadata ? { modelMetadata } : {}),
      }),
    });
    const retained = await toolCtx.skillContinuity.guidance({
      budget,
      turnId: activationState.turnId,
      resolveRevision: async (name) => {
        if (toolCtx.skillRuntime) return (await toolCtx.skillRuntime.inspect(name)).skill.revision;
        const skill = getSkillRegistry(toolCtx).byName.get(name);
        return skill ? (await reloadSkill(skill)).revision : undefined;
      },
    });
    // Expanded args, references and command output keep their original user /
    // tool-result authority. Never promote them into a system instruction.
    retainedSkillGuidance = retained.text;
  };

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) {
      recordTrace({
        type: 'interrupt',
        stage: `turn-${turn}-pre-stream`,
        iso: nowIso(),
      });
      await maybeFireStop('interrupted');
      return { reason: 'interrupted' };
    }

    recordTrace({ type: 'turn_start', turn, iso: nowIso() });

    let assistant: AssistantMessage | undefined;
    let stopReason: StopReason | undefined;
    let usage: TokenUsage | undefined;
    let requestStart = Date.now();
    let firstEventAt: number | undefined;

    for (;;) {
      let providerStarted = false;
      try {
        // Reject an impossible metadata-backed selection before a host can pay
        // for reduction. Custom and metadata-less providers keep their contract.
        if (modelMetadata && effort !== undefined) {
          const route = listRoutes().find(
            (candidate) =>
              candidate.id === modelMetadata.routeId && candidate.provider === provider.name,
          );
          if (route) validateRouteSelection(route, { model, effort, modelMetadata });
        }

        maxTokens = outputCeiling;
        // Skill activation may narrow the pool between requests. Freeze one
        // effective inventory for schemas, prompt, visibility and dispatch.
        activationState.tools = effectiveToolInventory(activationState.tools);
        systemPrompt = projectToolInventory(
          systemPrompt,
          activationState.tools,
          !modelMetadata ||
            (!modelMetadata.metadata.stale && modelMetadata.contextWindow !== undefined),
        );
        if (toolCtx && skillsEnabled) {
          toolCtx.activeToolNames = activationState.tools.map((tool) => tool.name);
          toolCtx.activeToolsets = inferActiveToolsets(
            toolCtx.activeToolNames,
            toolCtx.activeToolsets,
          );
        }
        refreshSkillCatalog();
        const request: ProviderRequest = {
          model,
          system: systemPrompt,
          messages: history,
          ...(activationState.tools.length > 0
            ? { tools: toToolSchemas(activationState.tools) }
            : {}),
          maxTokens,
          ...(temperature !== undefined ? { temperature } : {}),
          ...(effort !== undefined ? { effort } : {}),
          ...(modelMetadata !== undefined ? { modelMetadata } : {}),
          ...(effectiveModelLimits ? { outputBudgetEnforced: true } : {}),
          ...(signal ? { signal } : {}),
          cacheEnabled,
        };
        // Check the complete history before a host can pay for context reduction.
        validateModelRequest(request, provider.name, modelMetadata);
        if (params.contextManager || contextLimits) {
          if (!params.contextManager || !contextLimits) {
            throw new ContextManagementError('contextManager requires contextLimits');
          }
          validateContextLimits(contextLimits);
          if (historyBytes(history) > contextLimits.maxHistoryBytes) {
            yield await manageContext('budget');
          }
        }
        if (
          modelMetadata &&
          (modelMetadata.id !== model || modelMetadata.provider !== provider.name)
        )
          throw new ContextManagementError('model metadata does not match selected model/provider');
        await attachSkillGuidance();
        let inputAccounting: RequestInputTokenEstimate | undefined;
        if (effectiveModelLimits) {
          const inputBound = () => {
            inputAccounting = countInput({
              model,
              messages: requestHistory(),
              system: systemPrompt,
              tools: toToolSchemas(activationState.tools),
              maxTokens,
              ...(modelMetadata ? { modelMetadata } : {}),
            });
            inputAccounting = {
              ...inputAccounting,
              effectiveLimit: effectiveModelLimits.contextTokens,
              reservedOutput: maxTokens,
            };
            return inputAccounting.tokens;
          };
          let inputTokens = inputBound();
          if (
            inputAccounting?.enforce !== false &&
            inputTokens >= effectiveModelLimits.contextTokens &&
            params.contextManager &&
            contextLimits
          ) {
            yield await manageContext('budget');
            await attachSkillGuidance();
            inputTokens = inputBound();
          }
          // maxTokens is a ceiling, not a promise to consume that many tokens.
          // Preserve all input; reserve only positive remaining context. If the
          // input itself fills the window, compaction or a clear failure is required.
          const remaining =
            inputAccounting?.enforce === false
              ? effectiveModelLimits.contextTokens
              : effectiveModelLimits.contextTokens - inputTokens;
          if (!Number.isSafeInteger(remaining) || remaining <= 0)
            throw new ContextManagementError(
              'request input leaves no output room in effective model limits',
            );
          maxTokens = Math.min(outputCeiling, remaining);
          if (inputAccounting?.enforce !== false)
            assertRequestFits(inputTokens, maxTokens, effectiveModelLimits);
          if (inputAccounting) inputAccounting.reservedOutput = maxTokens;
        }
        request.messages = requestHistory();
        request.system = systemPrompt;
        request.maxTokens = maxTokens;
        validateModelRequest(request, provider.name, modelMetadata);
        requestStart = Date.now();
        recordTrace({
          type: 'provider_request',
          provider: provider.name,
          model,
          purpose: 'main',
          ...(effectiveModelLimits
            ? { modelLimits: { ...effectiveModelLimits, outputTokens: maxTokens } }
            : {}),
          ...(inputAccounting ? { inputAccounting } : {}),
          messageCount: history.length,
          systemBytes: systemPrompt.reduce((n, s) => n + Buffer.byteLength(s.text, 'utf8'), 0),
          iso: nowIso(),
        });
        providerStarted = true;
        for await (const event of provider.stream(request)) {
          if (firstEventAt === undefined) firstEventAt = Date.now();
          if (event.type === 'assistant_message') {
            assistant = event.message;
          }
          if (event.type === 'usage_delta') {
            usage = mergeUsage(usage, event.usage);
          }
          if (event.type === 'message_stop') {
            stopReason = event.stop_reason;
          }
          yield event;
        }
        break;
      } catch (err) {
        if (err instanceof ContextManagementError && err.info)
          yield { type: 'context_management', info: err.info };
        if (signal?.aborted) {
          recordTrace({
            type: 'interrupt',
            stage: `turn-${turn}-stream`,
            iso: nowIso(),
          });
          await maybeFireStop('interrupted');
          return { reason: 'interrupted' };
        }
        if (
          providerStarted &&
          params.contextManager &&
          contextLimits &&
          !toolsDispatched &&
          firstEventAt === undefined &&
          isContextOverflowError(err) &&
          overflowRecoveries < (contextLimits.maxOverflowRetries ?? 1)
        ) {
          overflowRecoveries += 1;
          try {
            yield await manageContext('overflow');
            continue;
          } catch (reductionError) {
            if (reductionError instanceof ContextManagementError && reductionError.info)
              yield { type: 'context_management', info: reductionError.info };
            await maybeFireStop(signal?.aborted ? 'interrupted' : 'error');
            return signal?.aborted
              ? { reason: 'interrupted' }
              : {
                  reason: 'error',
                  error:
                    reductionError instanceof Error
                      ? reductionError
                      : new Error(String(reductionError)),
                };
          }
        }
        const error = err instanceof Error ? err : new Error(String(err));
        await maybeFireStop('error');
        return { reason: 'error', error };
      }
    }

    recordTrace({
      type: 'provider_response',
      provider: provider.name,
      model,
      purpose: 'main',
      usage: usage ?? {},
      latencyMs: Date.now() - requestStart,
      ...(firstEventAt !== undefined ? { ttftMs: firstEventAt - requestStart } : {}),
      stopReason: stopReason ?? 'end_turn',
      iso: nowIso(),
    });

    if (!assistant) {
      await maybeFireStop('error');
      return {
        reason: 'error',
        error: new Error('provider stream ended without an assistant_message'),
      };
    }

    history.push(assistant);

    const toolUseBlocks = assistant.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');

    // Loop detection runs once per turn, PRE-dispatch. Snapshot = this turn's
    // tool calls + the concatenated assistant text. What happens next is the
    // policy in `loopDetector.mode`: in `enforce`, guidance while
    // `occurrence < maxStrikes` and an abort at `maxStrikes`; in `warn`,
    // guidance every time and never an abort; in `off` the detector already
    // returned null. The productivity ledger that feeds `no-progress` is
    // filled POST-dispatch (see `observeResults` below), so a no-progress
    // verdict surfaces on the check that FOLLOWS the Kth unproductive
    // result — one turn late, deliberately (spec §3.3).
    const detection = guarded(
      () =>
        loopDetector.addAndCheck({
          toolCalls: toolUseBlocks.map((b) => ({
            name: b.name,
            input: b.input,
          })),
          assistantText: assistantText(assistant),
        }),
      null,
    );
    // `pendingGuidanceText` carries the loop-detector guidance into the next
    // user message we emit this turn. Anthropic requires that an assistant
    // message containing `tool_use` be IMMEDIATELY followed by a user message
    // containing matching `tool_result` blocks — pushing a separate text-only
    // guidance message between them produces "tool_use ids were found
    // without tool_result blocks immediately after" (HTTP 400). When the
    // assistant emitted no tool_use (content-only loop), we emit guidance as
    // its own user message; nothing to orphan.
    let pendingGuidanceText: string | undefined;
    const consumeGuidance = (msg: Message): Message => {
      if (!pendingGuidanceText || msg.role !== 'user') return msg;
      const merged: Message = {
        role: 'user',
        content: [...msg.content, { type: 'text', text: pendingGuidanceText }],
      };
      pendingGuidanceText = undefined;
      return merged;
    };

    if (detection) {
      loopDetectionCount++;
      // `warn` never aborts — it guides on every detection. `enforce` guides
      // while the strike count is below `maxStrikes` and aborts on the strike
      // that reaches it (spec §3.4).
      const isAbort =
        loopDetector.mode === 'enforce' && loopDetectionCount >= loopDetector.maxStrikes;
      const action: LoopDetectionInfo['action'] =
        loopDetector.mode === 'warn' ? 'warn' : isAbort ? 'abort' : 'guidance';
      const info: LoopDetectionInfo = {
        detector: detection.detector,
        hash: detection.hash,
        repetitionCount: detection.repetitionCount,
        occurrence: loopDetectionCount,
        reason: detection.reason,
        action,
        mode: loopDetector.mode,
        ...(detection.window !== undefined ? { window: detection.window } : {}),
      };
      yield { type: 'loop_detected', info } as StreamEvent;
      recordTrace({
        type: 'loop_detected',
        detector: detection.detector,
        repetitionCount: detection.repetitionCount,
        hash: detection.hash,
        reason: detection.reason,
        action,
        mode: loopDetector.mode,
        ...(detection.window !== undefined ? { window: detection.window } : {}),
        iso: nowIso(),
      });
      if (isAbort) {
        // Abort strike: if this turn's assistant message contained tool_use
        // blocks, we must yield matching tool_result blocks before returning.
        // Anthropic requires every tool_use to be IMMEDIATELY followed by a
        // tool_result; without this the persisted history (REPL turnMessages,
        // sessionDb) is left in a 400-rejected state and the next user message
        // is unrecoverable. Mirrors the signal-aborted dispatch path below.
        // See docs/07-history/postmortems/loop-detector-orphaned-tool-use.md.
        if (toolUseBlocks.length > 0) {
          const msg = synthesizeToolResultMessage(
            toolUseBlocks,
            'tool call interrupted by loop detector',
          );
          history.push(msg);
          yield msg;
        }
        await maybeFireStop('error');
        return {
          reason: 'error',
          error: new Error(`aborted by loop guard (${detection.detector}): ${detection.reason}`),
        };
      }
      // Guidance strike: carry the nudge into THIS turn's next user message
      // (the tool_result emitted after dispatch), so the loop continues with a
      // course correction. On a content-only turn there are no tool_use blocks
      // to dispatch — so this turn TERMINATES below at the
      // `toolUseBlocks.length === 0` branch (a content-only turn never
      // continues). Pushing a standalone guidance user message here would leave
      // history ending on a user message that can never be acted on; the NEXT
      // user turn would then append a second consecutive user message →
      // Anthropic 400 "roles must alternate" → session broken. So we only set
      // pendingGuidanceText when there IS a continuation (tool_use present);
      // the loop_detected event + trace above still fire either way,
      // preserving the telemetry.
      if (toolUseBlocks.length > 0) {
        pendingGuidanceText = `Loop guard: ${detection.reason} Change what you send, verify the earlier result, or stop and report.`;
      }
    }

    if (stopReason === 'max_tokens') {
      if (toolUseBlocks.length > 0) {
        const msg = consumeGuidance(
          synthesizeToolResultMessage(toolUseBlocks, AMBIGUOUS_MAX_TOKENS_TOOL_NOTE),
        );
        history.push(msg);
        yield msg;
      }
      await maybeFireStop('max_tokens');
      return { reason: 'max_tokens' };
    }

    if (toolUseBlocks.length === 0) {
      // Mid-turn steering, turn-end delivery: the model composed a final
      // answer, but the operator sent a steer while it worked. Inject it as a
      // standalone user message (assistant→user alternation is legal here) and
      // CONTINUE the loop instead of finishing — the sov counterpart of the
      // claude Stop-hook delivery. Only poll when another model call is still
      // allowed (turn + 1 < maxTurns): consuming a steer on the FINAL
      // iteration would announce an injection the model never sees — leaving
      // it in the file lets the adapter's leftover drain deliver it honestly.
      const steerText =
        params.pollSteering && turn + 1 < maxTurns ? await params.pollSteering() : null;
      if (steerText !== null && steerText.length > 0) {
        const steerMsg: Message = {
          role: 'user',
          content: [{ type: 'text', text: steerText }],
        };
        history.push(steerMsg);
        yield steerMsg;
        continue;
      }
      if (params.memoryManager && originalUserText !== undefined) {
        await params.memoryManager.syncTurn(originalUserText, assistantText(assistant));
      }
      await maybeFireStop('completed');
      return { reason: 'completed' };
    }

    toolPool = activationState.tools;
    if (toolPool.length === 0) {
      const msg = consumeGuidance(
        synthesizeToolResultMessage(
          toolUseBlocks,
          'tool call could not run: no tools were provided',
        ),
      );
      history.push(msg);
      yield msg;
      await maybeFireStop('error');
      return {
        reason: 'error',
        error: new Error(
          `assistant requested ${toolUseBlocks.length} tool call(s) but no tools were provided`,
        ),
      };
    }

    if (!toolCtx) {
      const msg = consumeGuidance(
        synthesizeToolResultMessage(
          toolUseBlocks,
          'tool call could not run: no toolContext was provided',
        ),
      );
      history.push(msg);
      yield msg;
      await maybeFireStop('error');
      return {
        reason: 'error',
        error: new Error('tool_use encountered but no toolContext was passed in QueryParams'),
      };
    }

    // Propagate the query-level signal into the tool context so long-running
    // tools (BashTool's subprocess) and permission prompts can abort on
    // Ctrl-C. Phase 2 omitted this — latent until Phase 3 made it observable.
    const turnCtx: ToolContext = signal ? { ...toolCtx, signal } : toolCtx;
    const previousNames = turnCtx.activeToolNames;
    const previousParentPool = turnCtx.parentToolPool;
    const restoreHostInventory = (): void => {
      if (turnCtx !== params.toolContext) return;
      // biome-ignore lint/performance/noDelete: restore the caller's exact optional-field shape
      if (previousNames === undefined) delete turnCtx.activeToolNames;
      else turnCtx.activeToolNames = previousNames;
      // biome-ignore lint/performance/noDelete: restore the caller's exact optional-field shape
      if (previousParentPool === undefined) delete turnCtx.parentToolPool;
      else turnCtx.parentToolPool = previousParentPool;
    };
    const effectiveNames = new Set(activationState.tools.map((tool) => tool.name));
    turnCtx.activeToolNames = [...effectiveNames];
    const parentNames = turnCtx.parentToolPool
      ? new Set(turnCtx.parentToolPool.map((tool) => tool.name))
      : effectiveNames;
    turnCtx.parentToolPool = activationState.tools.filter((tool) => parentNames.has(tool.name));
    if (skillsEnabled) {
      turnCtx.activeToolNames = activationState.tools.map((tool) => tool.name);
      turnCtx.activeToolsets = inferActiveToolsets(turnCtx.activeToolNames, turnCtx.activeToolsets);
    }
    if (skillsEnabled && canUseTool) {
      turnCtx.canUseTool = createSkillChildPermission(
        activationState,
        inheritedChildPermission !== params.canUseTool ? inheritedChildPermission : undefined,
        inheritedActivation,
      );
    }

    if (params.persistBeforeTools && assistant) {
      try {
        await params.persistBeforeTools(assistant);
      } catch {
        restoreHostInventory();
        const msg = consumeGuidance(
          synthesizeToolResultMessage(
            toolUseBlocks,
            'tool call was not run: transcript write failed',
          ),
        );
        history.push(msg);
        yield msg;
        await maybeFireStop('error');
        return {
          reason: 'error',
          error: new PersistBeforeRunError(),
        };
      }
    }

    let dispatchedResult: Message | undefined;
    let resultYielded = false;
    try {
      toolsDispatched = true;
      for await (const msg of runTools(
        toolUseBlocks,
        turnCtx,
        toolPool,
        canUseTool,
        hookRunner,
        recordTrace,
        params.persistToolExecution,
      )) {
        let out = consumeGuidance(msg);
        dispatchedResult = out;
        // Mid-turn steering, tool-boundary delivery: steers usually arrive
        // while a long tool runs, so poll after the batch and merge the text
        // into the batch's single user message PRE-yield — the same mechanism
        // as the loop-detector guidance. This preserves role alternation and
        // tool_use→tool_result adjacency, and rides the normal persistence
        // path (the yielded message IS what hosts persist), so transcripts
        // stay faithful and --resume reconstructs exact context. Guards run
        // BEFORE the poll so a steer is never consumed when it can't be
        // delivered: the merge target must be a user message, and another
        // model call must still be allowed (turn + 1 < maxTurns) — otherwise
        // the file is left for the adapter's leftover drain.
        if (params.pollSteering && out.role === 'user' && turn + 1 < maxTurns) {
          const steerText = await params.pollSteering();
          if (steerText !== null && steerText.length > 0) {
            out = {
              role: 'user',
              content: [...out.content, { type: 'text', text: steerText }],
            };
          }
        }
        if (params.persistAfterTools) {
          try {
            await params.persistAfterTools(out);
          } catch (error) {
            throw new ToolStorageError(error, out);
          }
        }
        history.push(out);
        resultYielded = true;
        yield out;
      }
      // Phase 13.3 — notify the review manager after a successful tool
      // batch. Sub-agent calls are silently no-op'd by the session-id
      // guard inside ReviewManager, so this unconditional call is safe.
      toolCtx.reviewManager?.onToolIteration(toolCtx.sessionId);
      // Progress-aware loop guard, POST-dispatch (spec §3.3 step 2). One entry
      // per tool_use block of this turn, paired by `tool_use_id` with the
      // `tool_result` blocks runTools just emitted (the message pushed last).
      // This only feeds the productivity ledger — it never fires; the verdict
      // lands on the NEXT pre-dispatch check.
      {
        const resultsById = collectToolResults(history[history.length - 1]);
        const observed = toolUseBlocks.flatMap((block) => {
          const result = resultsById.get(block.id);
          // A tool_use with no tool_result cannot happen via runTools (it
          // synthesizes one for every block). Skipping rather than inventing an
          // empty result keeps the ledger honest if that ever changes.
          if (result === undefined) return [];
          return [
            {
              name: block.name,
              input: block.input,
              text: flattenToolResultText(result.content),
              isError: result.is_error === true,
            },
          ];
        });
        guarded(() => loopDetector.observeResults(observed), undefined);
      }
      // Phase 13.3 — stall / no-op detection. Tracks file edits, memory
      // writes, decisions, and tool errors per turn over a 3-turn sliding
      // window. Emits an advisory trace event on stall — never blocks.
      {
        const fileEditTools = new Set(['FileEdit', 'FileWrite']);
        const memoryWriteTools = new Set(['memory', 'memory_propose']);
        let fileEditCount = 0;
        let memoryWriteCount = 0;
        let toolErrorCount = 0;
        for (const block of toolUseBlocks) {
          if (fileEditTools.has(block.name)) fileEditCount += 1;
          if (memoryWriteTools.has(block.name)) memoryWriteCount += 1;
        }
        // Tool errors are surfaced via tool_result blocks with is_error=true.
        // Inspect the most recent user message (synthesized by runTools) for them.
        const lastMsg = history[history.length - 1];
        if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
          for (const c of lastMsg.content) {
            if (
              typeof c === 'object' &&
              c !== null &&
              'type' in c &&
              c.type === 'tool_result' &&
              'is_error' in c &&
              c.is_error === true
            ) {
              toolErrorCount += 1;
            }
          }
        }
        const summary: TurnSummary = {
          fileEditCount,
          memoryWriteCount,
          decisionCount: 0, // TODO(phase 13.3+): wire decision tracking when infrastructure lands
          toolErrorCount,
          // ux-fixes round 2 — any tool call (read or write) counts as
          // progress so research-only turns don't trip the stall detector.
          toolCallCount: toolUseBlocks.length,
        };
        recentTurnSummaries.push(summary);
        if (recentTurnSummaries.length > 6) recentTurnSummaries.shift();
        const stall = detectStall(recentTurnSummaries);
        if (stall.stalled) {
          recordTrace({
            type: 'stall_detected',
            reason: stall.reason,
            turn,
            iso: nowIso(),
          });
        }
      }
      // Microcompaction: clear stale tool results before the next provider
      // call. Fires INSIDE the turn loop (mid-prompt), but tool_results
      // from the current user-prompt burst are protected by a turn-boundary
      // exclusion in `collectCompactableRefs` so the agent can still
      // reference them in the next iteration's assistant message. See
      // src/compact/microcompact.ts header for the rationale (backlog
      // Item 22, soak case G4).
      const mcConfig = params.microcompactConfig ?? DEFAULT_MICROCOMPACT_CONFIG;
      const toolNameMap = buildToolNameMap(history);
      if (shouldMicrocompact(history, mcConfig, toolNameMap)) {
        const { messages: compacted, result: mcResult } = microcompact(
          history,
          toolNameMap,
          mcConfig,
        );
        if (mcResult.cleared > 0) {
          history.length = 0;
          history.push(...compacted);
          recordTrace({
            type: 'microcompact',
            cleared: mcResult.cleared,
            estimatedTokensSaved: mcResult.estimatedTokensSaved,
            keptRecent: mcResult.keptRecent,
            iso: nowIso(),
          });
          yield { type: 'microcompact', info: mcResult } as StreamEvent;
        }
      }
      // Backlog item 24 — checkin guard. Accumulate per-turn tool-call count
      // after microcompaction so history is clean before we pause.
      totalToolCallCount += toolUseBlocks.length;
      if (
        params.maxToolCallsBeforeCheckin !== undefined &&
        totalToolCallCount >= params.maxToolCallsBeforeCheckin
      ) {
        // A supervised check-in is waiting_user, so Stop waits for that
        // terminal. An unsupervised pause stays a segment boundary.
        if (params.logicalTurn) await maybeFireStop('checkin');
        return { reason: 'checkin', toolCallCount: totalToolCallCount };
      }
    } catch (err) {
      // runTools has joined every started task. Keep real results if a later
      // host callback fails, and never append a second result for the same id.
      let error: Error;
      let message: string;
      try {
        error = err instanceof Error ? err : new Error(String(err));
        // Error subclasses can expose a throwing message getter. Read it
        // inside the guard before preserving the already completed receipt.
        const reported = error.message;
        message = String(reported);
        if (typeof reported !== 'string') error = new Error(message);
      } catch {
        message = 'host callback failed with an unreadable error';
        error = new Error(message);
      }
      if (!resultYielded) {
        const msg =
          (err instanceof ToolStorageError ? err.resultMessage : undefined) ??
          dispatchedResult ??
          consumeGuidance(
            synthesizeToolResultMessage(
              toolUseBlocks,
              `tool orchestration failed before a result was available: ${message}`,
            ),
          );
        history.push(msg);
        yield msg;
      }
      if (signal?.aborted && !(err instanceof ToolStorageError)) {
        recordTrace({
          type: 'interrupt',
          stage: `turn-${turn}-tool-dispatch`,
          iso: nowIso(),
        });
        await maybeFireStop('interrupted');
        return { reason: 'interrupted' };
      }
      await maybeFireStop('error');
      return { reason: 'error', error };
    } finally {
      restoreHostInventory();
    }
  }

  await maybeFireStop('max_turns');
  return { reason: 'max_turns' };
}

/** Fire the Stop hook. Failures are swallowed — a misbehaving Stop hook must
 *  not turn a 'completed' run into an 'error'. */
async function fireStopHook(
  runner: import('../hooks/types.js').HookRunner,
  sessionId: string,
  cwd: string,
  reason: StopHookReason,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await runner('Stop', { hookEventName: 'Stop', session_id: sessionId, cwd, reason }, signal);
  } catch {
    // Stop hooks are observers; never propagate.
  }
}

/** True when stored text already opens with the preamble and a closed block.
 *  Mentioning `<memory-context>` is not itself a fence. */
function hasLeadingClosedMemoryFence(text: string): boolean {
  if (!text.startsWith(FENCE_PREAMBLE)) return false;
  const rest = text.slice(FENCE_PREAMBLE.length).trimStart();
  const open = '<memory-context>';
  const close = '</memory-context>';
  if (!rest.startsWith(open)) return false;
  return rest.indexOf(close) >= open.length;
}

/** Reapply the memory fence to the original user message after rehydration.
 *  Tool-result tails have no user text, so they are skipped. The caller's
 *  messages are not mutated, and a fence that is already present is left as-is. */
async function reinjectMemoryFence(
  messages: Message[],
  memory: { prefetchSnapshot(userMsg: string): Promise<string> },
): Promise<Message[]> {
  const history = [...messages];
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (!isHumanUserMessage(msg)) continue;
    if (msg.content.some((block) => block.type === 'tool_result')) continue;
    const textIndex = msg.content.findIndex((block) => block.type === 'text');
    const block = msg.content[textIndex];
    if (!block || block.type !== 'text') continue;
    const snapshot = await memory.prefetchSnapshot(block.text);
    const trimmed = snapshot.trim();
    // Already present only when this snapshot is stored, or the text starts
    // with the preamble and a closed <memory-context> block. A bare tag
    // mention still receives the current snapshot once.
    if (!trimmed || block.text.includes(trimmed) || hasLeadingClosedMemoryFence(block.text)) {
      return history;
    }
    const next = injectMemoryIntoUserText(block.text, snapshot);
    if (next === block.text) return history;
    const content = [...msg.content];
    content[textIndex] = { type: 'text', text: next };
    history[i] = { ...msg, content };
    return history;
  }
  return history;
}

function rewriteLatestUserText(messages: Message[], next: string): Message[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isHumanUserMessage(message)) continue;
    const idx = message.content.findIndex((block) => block.type === 'text');
    if (idx === -1) continue;
    const updatedContent = message.content.slice();
    updatedContent[idx] = { type: 'text', text: next };
    const out = messages.slice();
    out[i] = { ...message, content: updatedContent };
    return out;
  }
  return messages;
}

/** Return the memory/recall context prepended to the latest user message's
 *  first text block. Both injectors prepend their block and keep
 *  `originalUserText` as the trailing suffix, so the prefix is everything
 *  before that suffix. Returns '' when no injection happened (the block equals
 *  the original text) or the block no longer ends with the original text. */
function extractInjectedPrefix(messages: Message[], originalUserText: string): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isHumanUserMessage(message)) continue;
    const block = message.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') return '';
    if (block.text === originalUserText) return '';
    if (block.text.endsWith(originalUserText)) {
      return block.text.slice(0, block.text.length - originalUserText.length);
    }
    return '';
  }
  return '';
}

/** A truncated tool call is not a request to guess. The note is the synthetic result. */
export const AMBIGUOUS_MAX_TOKENS_TOOL_NOTE =
  'tool call was not executed because the assistant response hit max_tokens before completing the turn';

function isHumanUserMessage(message: Message | undefined): message is UserMessage {
  return message?.role === 'user' && message.origin !== 'runtime';
}

function latestUserText(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isHumanUserMessage(message)) continue;
    const text = message.content.find((block) => block.type === 'text');
    return text?.type === 'text' ? text.text : undefined;
  }
  return undefined;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');
}

function synthesizeToolResultMessage(blocks: ToolUseBlock[], content: string): Message {
  return {
    role: 'user',
    content: blocks.map((block) => ({
      type: 'tool_result' as const,
      tool_use_id: block.id,
      content,
      is_error: true,
    })),
  };
}

// toToolSchemas + zodToJsonSchemaShallow moved to src/mcp/schemaSerialization.ts
// in Phase 12 — they now also handle deferred-tool descriptions and
// MCP-supplied JSON Schemas. Imported at the top of this file.

/** Wrap an optional trace handler with a no-throw shim. Returns a no-op
 *  recorder when none is supplied so call sites don't need null checks. */
function makeTraceRecorder(
  handler: ((event: TraceEvent) => void) | undefined,
): (event: TraceEvent) => void {
  if (!handler) return () => {};
  return (event) => {
    try {
      handler(event);
    } catch {
      // A misbehaving recorder must not turn a working session into an error.
    }
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

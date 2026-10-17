import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { logicalSegmentStop } from '../core/query.js';
import type { Message, Terminal, TokenUsage } from '../core/types.js';
import {
  PersistBeforeRunError,
  ProviderHttpError,
  ProviderStreamError,
  SessionPersistenceError,
  SubscriptionHttpError,
  SubscriptionRefreshError,
  SubscriptionStreamError,
  ToolStorageError,
} from '../providers/errors.js';
import type { RunResult } from './createAgent.js';

export const LOGICAL_TURN_RECOVERY_CAPABILITY = {
  owner: 'sov',
  version: 1,
  mode: 'automatic',
} as const;

/** Short enough that a crashed owner can be resumed, long enough to cover one refresh gap. */
export const LOGICAL_TURN_LEASE_MS = 30_000;
export const LOGICAL_TURN_LEASE_RENEW_MS = 10_000;

/** A failed row may resume only when finishReason or lastCause is one of these. */
const SAFE_TRANSIENT_FAILURES = new Set([
  'transient_provider',
  'rate_limited',
  'provider_unavailable',
  'provider_timeout',
]);

export type LogicalTurnStatus =
  | 'admitted'
  | 'running'
  | 'continuing'
  | 'completed'
  | 'waiting_user'
  | 'cancelled'
  | 'failed'
  | 'exhausted'
  | 'stalled';

export type LogicalTurnCounters = {
  segments: number;
  modelCalls: number;
  toolCalls: number;
  providerRetries: number;
  contextRecoveries: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  estimatedCostUsd: number;
};

export type LogicalTurnBinding = {
  route?: string;
  provider: string;
  authKind?: string;
  model: string;
  effort?: string;
  toolset?: string;
  permissionMode?: string;
  policyDigest?: string;
  /** Allow-list pin. Absent on rows written before skill approval was pinned. */
  skillApprovalDigest?: string;
  /** MCP server pin. Absent on rows written before MCP identity was pinned. */
  mcpIdentityDigest?: string;
  cwd: string;
  bundleIdentity?: string;
};

export type LogicalTurnRecord = {
  version: 1;
  logicalTurnId: string;
  originalUserMessageId?: number;
  sessionId: string;
  activeSessionId: string;
  compactedSessionIds: string[];
  binding: LogicalTurnBinding;
  bindingDigest: string;
  segmentLimit: number;
  logicalModelCallLimit: number;
  deadlineAt?: number;
  status: LogicalTurnStatus;
  lastCause?: Terminal['reason'] | 'deadline' | 'unsafe' | 'invalid';
  progressFingerprint?: string;
  repeatedNoProgress: number;
  runtimeContinuationIds: string[];
  finalReply?: string;
  finishReason?: string;
  counters: LogicalTurnCounters;
  createdAt: number;
  updatedAt: number;
};

export interface LogicalTurnStore {
  createLogicalTurn(record: LogicalTurnRecord): void;
  loadLogicalTurn(logicalTurnId: string): LogicalTurnRecord | null;
  /** Persist only while `owner` still holds the lease. */
  saveLogicalTurn(record: LogicalTurnRecord, owner: string): void;
  readLogicalTurnLease(
    logicalTurnId: string,
  ): { owner: string | null; expiresAt: number | null } | null;
  acquireLogicalTurnLease(
    logicalTurnId: string,
    owner: string,
    expiresAt: number,
    now: number,
  ): boolean;
  /** Extend our lease. Does not take a free, expired, or foreign lease. */
  renewLogicalTurnLease(logicalTurnId: string, owner: string, expiresAt: number): boolean;
  releaseLogicalTurnLease(logicalTurnId: string, owner: string): void;
}

export type LogicalTurnContinuation = {
  logicalTurnId: string;
  sessionId: string;
  activeSessionId: string;
  cause: 'max_turns' | 'max_tokens' | 'transient_provider';
  segment: number;
  cumulative: LogicalTurnCounters;
  limits: { modelCalls: number; deadlineAt?: number };
};

export type LogicalTurnResult = {
  logicalTurnId: string;
  status: LogicalTurnStatus;
  code?:
    | 'continuation_exhausted'
    | 'continuation_stalled'
    | 'recovery_unsafe'
    | 'recovery_state_invalid';
  activeSessionId: string;
  finalSegment?: RunResult;
  counters: LogicalTurnCounters;
  finishReason: string;
  reply: string;
};

export class LogicalTurnLeaseError extends Error {
  constructor() {
    super('logical turn is already active');
    this.name = 'LogicalTurnLeaseError';
  }
}

type LeaseBinding = {
  logicalTurnId: string;
  owner: string;
  store: LogicalTurnStore;
  /** Aborted when this owner loses the lease. Independent of the caller's stop signal. */
  signal: AbortSignal;
  lost: boolean;
  /** Stop deferred by the segment in flight. Kept if the host drops the terminal. */
  stop?: (() => Promise<void>) | undefined;
};

const leaseBindings = new AsyncLocalStorage<LeaseBinding>();
const activeSegments = new Map<string, { owner: string; lose: () => void }>();

function displaceSegment(logicalTurnId: string, owner: string, lose: () => void): void {
  const previous = activeSegments.get(logicalTurnId);
  activeSegments.set(logicalTurnId, { owner, lose });
  if (previous && previous.owner !== owner) previous.lose();
}

function clearSegment(logicalTurnId: string, owner: string): void {
  if (activeSegments.get(logicalTurnId)?.owner === owner) activeSegments.delete(logicalTurnId);
}

/** Remember the Stop closure for the segment on this async stack. */
export function rememberLogicalSegmentStop(fire: () => Promise<void>): void {
  const binding = leaseBindings.getStore();
  if (binding) binding.stop = fire;
}

/** Signal for the segment running on this async stack. Lease loss aborts it. */
export function logicalTurnWorkSignal(external?: AbortSignal): AbortSignal | undefined {
  const segment = leaseBindings.getStore()?.signal;
  if (!segment) return external;
  if (!external || external === segment) return segment;
  return AbortSignal.any([external, segment]);
}

/** Transcript and tool-journal writes from a dispossessed segment must fail closed. */
export function assertLogicalTurnWriteLease(): void {
  const binding = leaseBindings.getStore();
  if (!binding) return;
  if (binding.lost) throw new LogicalTurnLeaseError();
  if (binding.store.readLogicalTurnLease(binding.logicalTurnId)?.owner !== binding.owner) {
    throw new LogicalTurnLeaseError();
  }
}

export type LogicalTurnSupervisorOptions = {
  store: LogicalTurnStore;
  binding: LogicalTurnBinding;
  sessionId: string;
  originalUserMessageId?: number;
  initialMessages: Message[];
  /** Lease-held work that must finish before the first model segment, such as compaction. */
  prepare?: () => Promise<void> | void;
  runSegment: (input: {
    messages: Message[];
    activeSessionId: string;
    segment: number;
    continuation: boolean;
    remainingModelCalls: number;
    /** Aborted when this owner's renewal fails. Also active on the async stack. */
    signal: AbortSignal;
  }) => Promise<RunResult>;
  rehydrate: (activeSessionId: string) => Message[];
  /** Returns false for started/unknown effects or an invalid transcript. */
  recoverySafe: (activeSessionId: string) => boolean;
  /**
   * Durable progress facts. See `LogicalTurnProgressSnapshot`.
   * Fields outside that shape are not progress.
   */
  progressSnapshot?: (activeSessionId: string) => unknown;
  /**
   * One continuation read, shared by the safety check, the id fingerprint, and
   * the next segment. When set, that boundary does not call the other three.
   * `messages` is read after a max_tokens marker is saved.
   */
  readBoundary?: (activeSessionId: string) => {
    safe: boolean;
    /** Id-level facts. A tool-result body is not progress. */
    progress?: unknown;
    messages: () => Message[];
  };
  persistRuntimeContinuation?: (input: {
    activeSessionId: string;
    id: string;
    text: string;
  }) => void;
  onContinuing?: (event: LogicalTurnContinuation) => void;
  onTrace?: (event: LogicalTurnTraceEvent) => void;
  signal?: AbortSignal;
  logicalTurnId?: string;
  activeSessionId?: string;
  segmentLimit?: number;
  logicalModelCallLimit?: number;
  deadlineAt?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Spec 5.8 facts. A new transcript row, completed receipt, cursor, compaction
 * child, saved assistant-text length, or terminal cause changes the fingerprint.
 * Task id and state are included when the host already reports them.
 */
export type LogicalTurnProgressSnapshot = {
  transcriptIds?: readonly (string | number)[];
  transcriptCount?: number;
  /** Tool receipts. Only `completed` entries are durable progress. */
  receipts?: readonly unknown[];
  cursor?: string | null;
  compactionChildId?: string;
  tasks?: readonly unknown[];
};

export type LogicalTurnTraceEvent = {
  type:
    | 'logical_turn_start'
    | 'segment_start'
    | 'segment_end'
    | 'recovery_start'
    | 'recovery_end'
    | 'provider_retry'
    | 'logical_turn_end';
  logicalTurnId: string;
  segment: number;
  cause?: string;
  counters: LogicalTurnCounters;
  activeSessionId: string;
  elapsedMs: number;
  outcome?: LogicalTurnStatus;
};

const EMPTY_COUNTERS: LogicalTurnCounters = {
  segments: 0,
  modelCalls: 0,
  toolCalls: 0,
  providerRetries: 0,
  contextRecoveries: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  estimatedCostUsd: 0,
};

export async function superviseLogicalTurn(
  options: LogicalTurnSupervisorOptions,
): Promise<LogicalTurnResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const bindingDigest = digest(options.binding);
  let record = options.logicalTurnId ? options.store.loadLogicalTurn(options.logicalTurnId) : null;
  if (options.logicalTurnId && !record) {
    return invalidResult(options.logicalTurnId, options.sessionId, 'recovery_state_invalid');
  }
  if (record && record.bindingDigest !== bindingDigest) {
    return invalidResult(record.logicalTurnId, record.activeSessionId, 'recovery_state_invalid');
  }
  if (record?.status === 'completed' || record?.status === 'waiting_user') {
    return {
      logicalTurnId: record.logicalTurnId,
      status: record.status,
      activeSessionId: record.activeSessionId,
      counters: { ...record.counters },
      finishReason: record.finishReason ?? record.status,
      reply: record.finalReply ?? '',
    };
  }
  if (record?.status === 'cancelled') {
    return invalidResult(record.logicalTurnId, record.activeSessionId, 'recovery_state_invalid');
  }
  if (record?.status === 'failed' && !isSafeTransientFailure(record)) {
    return storedFailure(record);
  }
  if (!record) {
    const createdAt = now();
    record = {
      version: 1,
      logicalTurnId: randomUUID(),
      ...(options.originalUserMessageId !== undefined
        ? { originalUserMessageId: options.originalUserMessageId }
        : {}),
      sessionId: options.sessionId,
      activeSessionId: options.activeSessionId ?? options.sessionId,
      compactedSessionIds: [],
      binding: structuredClone(options.binding),
      bindingDigest,
      segmentLimit: options.segmentLimit ?? 10,
      logicalModelCallLimit: options.logicalModelCallLimit ?? 100,
      ...(options.deadlineAt !== undefined ? { deadlineAt: options.deadlineAt } : {}),
      status: 'admitted',
      repeatedNoProgress: 0,
      runtimeContinuationIds: [],
      counters: { ...EMPTY_COUNTERS },
      createdAt,
      updatedAt: createdAt,
    };
    options.store.createLogicalTurn(record);
  }
  const resuming = options.logicalTurnId !== undefined;
  const held = { record };
  const leaseOwner = randomUUID();
  let leased = false;
  const segmentAbort = new AbortController();
  const binding: LeaseBinding = {
    logicalTurnId: record.logicalTurnId,
    owner: leaseOwner,
    store: options.store,
    signal: segmentAbort.signal,
    lost: false,
  };
  let rejectInFlight: ((error: Error) => void) | undefined;
  const loseLease = (): void => {
    binding.lost = true;
    if (!segmentAbort.signal.aborted) segmentAbort.abort(new LogicalTurnLeaseError());
    rejectInFlight?.(new LogicalTurnLeaseError());
  };
  const onExternalAbort = (): void => {
    if (!segmentAbort.signal.aborted) segmentAbort.abort(options.signal?.reason);
  };
  if (options.signal) {
    if (options.signal.aborted) onExternalAbort();
    else options.signal.addEventListener('abort', onExternalAbort);
  }
  const leaseExpiresAt = (): number => now() + LOGICAL_TURN_LEASE_MS;
  const renewLease = (): boolean =>
    options.store.renewLogicalTurnLease(held.record.logicalTurnId, leaseOwner, leaseExpiresAt());
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const pause = (ms: number): Promise<void> => {
    if (options.sleep) return options.sleep(ms);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, ms);
      timers.add(timer);
    });
  };
  const clearPauses = (): void => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
  const withHeartbeat = async <T>(start: () => Promise<T>): Promise<T> => {
    if (binding.lost) throw new LogicalTurnLeaseError();
    let stopped = false;
    let settled = false;
    let rejectLost: (error: Error) => void = () => {};
    const lost = new Promise<never>((_, reject) => {
      rejectLost = reject;
    });
    const rejectMine = (error: Error): void => {
      if (!settled) rejectLost(error);
    };
    rejectInFlight = rejectMine;
    const beat = (async () => {
      while (!stopped && !settled) {
        await pause(LOGICAL_TURN_LEASE_RENEW_MS);
        if (stopped || settled) return;
        if (!renewLease()) {
          loseLease();
          return;
        }
      }
    })().catch((error: unknown) => {
      if (settled || binding.lost) return;
      rejectLost(error instanceof Error ? error : new LogicalTurnLeaseError());
    });
    // The segment keeps the binding after this race rejects, so a late write still sees the loss.
    const work = leaseBindings.run(binding, start);
    void work.catch(() => {});
    try {
      const outcome = await Promise.race([work, lost]);
      if (binding.lost) throw new LogicalTurnLeaseError();
      return outcome;
    } catch (error) {
      if (binding.lost) throw new LogicalTurnLeaseError();
      throw error;
    } finally {
      settled = true;
      stopped = true;
      if (rejectInFlight === rejectMine) rejectInFlight = undefined;
      clearPauses();
      void beat;
    }
  };

  const trace = (event: Omit<LogicalTurnTraceEvent, 'logicalTurnId' | 'elapsedMs'>): void => {
    options.onTrace?.({
      ...event,
      logicalTurnId: held.record.logicalTurnId,
      elapsedMs: Math.max(0, now() - startedAt),
    });
  };
  const save = (): void => {
    if (!renewLease()) throw new LogicalTurnLeaseError();
    held.record.updatedAt = now();
    options.store.saveLogicalTurn(held.record, leaseOwner);
  };
  let pendingStop: (() => Promise<void>) | undefined;
  const fireTerminalStop = async (): Promise<void> => {
    const fire = pendingStop;
    pendingStop = undefined;
    if (!fire) return;
    try {
      await fire();
    } catch {
      // Stop hooks are observers; a failure must not change the terminal.
    }
  };
  const finish = async (
    status: LogicalTurnStatus,
    finishReason: string,
    finalSegment?: RunResult,
    code?: LogicalTurnResult['code'],
  ): Promise<LogicalTurnResult> => {
    held.record.status = status;
    held.record.finishReason = finishReason;
    if (finalSegment)
      held.record.finalReply =
        finalSegment.finalAssistant?.content
          .filter((block) => block.type === 'text')
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join('') ?? '';
    save();
    trace({
      type: 'logical_turn_end',
      segment: held.record.counters.segments,
      cause: finishReason,
      counters: { ...held.record.counters },
      activeSessionId: held.record.activeSessionId,
      outcome: status,
    });
    const outcome: LogicalTurnResult = {
      logicalTurnId: held.record.logicalTurnId,
      status,
      ...(code !== undefined ? { code } : {}),
      activeSessionId: held.record.activeSessionId,
      ...(finalSegment !== undefined ? { finalSegment } : {}),
      counters: { ...held.record.counters },
      finishReason,
      reply: held.record.finalReply ?? '',
    };
    // The segment suppressed Stop. Fire it once this outcome is durable.
    await fireTerminalStop();
    return outcome;
  };

  try {
    const activeLease = options.store.readLogicalTurnLease(record.logicalTurnId);
    if (
      activeLease?.owner &&
      activeLease.owner !== leaseOwner &&
      activeLease.expiresAt !== null &&
      activeLease.expiresAt > now()
    ) {
      throw new LogicalTurnLeaseError();
    }
    if (resuming && !options.recoverySafe(record.activeSessionId)) {
      return {
        logicalTurnId: record.logicalTurnId,
        status: 'failed',
        code: 'recovery_unsafe',
        activeSessionId: record.activeSessionId,
        counters: { ...record.counters },
        finishReason: 'unsafe_effect',
        reply: record.finalReply ?? '',
      };
    }
    if (
      !options.store.acquireLogicalTurnLease(
        record.logicalTurnId,
        leaseOwner,
        leaseExpiresAt(),
        now(),
      )
    ) {
      throw new LogicalTurnLeaseError();
    }
    leased = true;
    binding.logicalTurnId = record.logicalTurnId;
    displaceSegment(record.logicalTurnId, leaseOwner, loseLease);
    const reloaded = options.store.loadLogicalTurn(record.logicalTurnId);
    if (!reloaded)
      return invalidResult(record.logicalTurnId, record.activeSessionId, 'recovery_state_invalid');
    record = reloaded;
    held.record = record;
    if (record.bindingDigest !== bindingDigest) {
      return invalidResult(record.logicalTurnId, record.activeSessionId, 'recovery_state_invalid');
    }
    if (record.status === 'completed' || record.status === 'waiting_user') {
      return {
        logicalTurnId: record.logicalTurnId,
        status: record.status,
        activeSessionId: record.activeSessionId,
        counters: { ...record.counters },
        finishReason: record.finishReason ?? record.status,
        reply: record.finalReply ?? '',
      };
    }
    if (record.status === 'cancelled') {
      return invalidResult(record.logicalTurnId, record.activeSessionId, 'recovery_state_invalid');
    }
    // Reloaded after the lease. A non-transient failure must not start work.
    if (record.status === 'failed' && !isSafeTransientFailure(record)) {
      return storedFailure(record);
    }
    if (resuming && !options.recoverySafe(record.activeSessionId))
      return await finish('failed', 'unsafe_effect', undefined, 'recovery_unsafe');
    record.status = 'running';
    save();
    const prepare = options.prepare;
    if (prepare) await withHeartbeat(() => Promise.resolve(prepare()));
    trace({
      type: 'logical_turn_start',
      segment: record.counters.segments,
      counters: { ...record.counters },
      activeSessionId: record.activeSessionId,
    });
    let messages =
      record.counters.segments > 0
        ? options.rehydrate(record.activeSessionId)
        : [...options.initialMessages];
    let transientAttempts = 0;
    for (;;) {
      // Deadline wins over a shared abort. A user stop before the deadline stays cancelled.
      if (isDeadlineTerminal(options.signal, record.deadlineAt, now()))
        return await finish('exhausted', 'deadline', undefined, 'continuation_exhausted');
      if (options.signal?.aborted) return await finish('cancelled', 'cancelled', undefined);
      const remaining = record.logicalModelCallLimit - record.counters.modelCalls;
      if (remaining <= 0)
        return await finish('exhausted', 'model_call_limit', undefined, 'continuation_exhausted');
      const segment = record.counters.segments + 1;
      if (!renewLease()) throw new LogicalTurnLeaseError();
      trace({
        type: 'segment_start',
        segment,
        counters: { ...record.counters },
        activeSessionId: record.activeSessionId,
      });
      let result: RunResult;
      try {
        const activeSessionId = record.activeSessionId;
        binding.stop = undefined;
        result = await withHeartbeat(() =>
          options.runSegment({
            messages,
            activeSessionId,
            segment,
            continuation: segment > 1,
            remainingModelCalls: remaining,
            signal: segmentAbort.signal,
          }),
        );
      } catch (error) {
        // Persist the deadline terminal. A real abort is stored cancelled.
        // Storage faults stay untouched so the host reports them. A lost lease
        // must not overwrite the worker that now owns the record.
        // A host can drop the returned terminal when the deadline abort wins
        // the race. The segment still left its Stop on the lease binding.
        if (!(error instanceof LogicalTurnLeaseError) && !storageFault(error)) {
          if (isDeadlineTerminal(options.signal, record.deadlineAt, now())) {
            if (binding.stop) pendingStop = binding.stop;
            return await finish('exhausted', 'deadline', undefined, 'continuation_exhausted');
          }
          if (options.signal?.aborted) await finish('cancelled', 'cancelled', undefined);
        }
        throw error;
      }
      const previousCause = record.lastCause;
      const previousSessionId = record.activeSessionId;
      record.activeSessionId = result.sessionId;
      if (
        previousSessionId !== result.sessionId &&
        !record.compactedSessionIds.includes(previousSessionId)
      ) {
        record.compactedSessionIds.push(previousSessionId);
        record.counters.contextRecoveries++;
      }
      record.counters.segments++;
      record.counters.modelCalls += result.iterationsUsed;
      record.counters.toolCalls += result.toolCallCount;
      addUsage(record.counters, result.usage, result.estimatedCostUsd);
      record.lastCause = result.terminal.reason;
      const deferredStop = logicalSegmentStop(result.terminal);
      if (deferredStop) pendingStop = deferredStop;
      trace({
        type: 'segment_end',
        segment,
        cause: result.terminal.reason,
        counters: { ...record.counters },
        activeSessionId: record.activeSessionId,
      });

      if (result.terminal.reason === 'completed')
        return await finish('completed', 'completed', result);
      if (result.terminal.reason === 'checkin')
        return await finish('waiting_user', 'checkin', result);
      if (isDeadlineTerminal(options.signal, record.deadlineAt, now()))
        return await finish('exhausted', 'deadline', result, 'continuation_exhausted');
      if (result.terminal.reason === 'interrupted' || options.signal?.aborted)
        return await finish('cancelled', 'cancelled', result);

      if (result.terminal.reason === 'error') {
        const transient = transientDelay(
          result.terminal.error,
          transientAttempts,
          hasCommittedOutput(result),
        );
        if (transient === undefined || transientAttempts >= 2)
          return await finish('failed', 'failed', result);
        if (!options.recoverySafe(record.activeSessionId))
          return await finish('failed', 'unsafe_effect', result, 'recovery_unsafe');
        transientAttempts++;
        record.counters.providerRetries++;
        save();
        trace({
          type: 'provider_retry',
          segment,
          cause: result.terminal.error?.name ?? 'transient_provider',
          counters: { ...record.counters },
          activeSessionId: record.activeSessionId,
        });
        // Cancellation during the wait must not start the next attempt.
        await withHeartbeat(() => sleepWithSignal(transient, options.signal, pause));
        if (isDeadlineTerminal(options.signal, record.deadlineAt, now()))
          return await finish('exhausted', 'deadline', undefined, 'continuation_exhausted');
        if (options.signal?.aborted) return await finish('cancelled', 'cancelled', undefined);
        messages = options.rehydrate(record.activeSessionId);
        continue;
      }

      transientAttempts = 0;
      const boundary = options.readBoundary?.(record.activeSessionId);
      const safe = boundary ? boundary.safe : options.recoverySafe(record.activeSessionId);
      if (!safe) return await finish('failed', 'unsafe_effect', result, 'recovery_unsafe');
      const supplied = boundary
        ? boundary.progress
        : options.progressSnapshot?.(record.activeSessionId);
      const facts = progressFacts(supplied);
      const hydrated = needsHydratedFacts(facts)
        ? boundary
          ? boundary.messages()
          : options.rehydrate(record.activeSessionId)
        : undefined;
      const fingerprint = progressFingerprint({
        facts,
        hydrated,
        cause: result.terminal.reason,
        assistantTextLength: assistantTextLength(result),
        activeSessionId: record.activeSessionId,
      });
      record.repeatedNoProgress =
        record.progressFingerprint === fingerprint && previousCause === result.terminal.reason
          ? record.repeatedNoProgress + 1
          : 0;
      record.progressFingerprint = fingerprint;
      // The first unchanged continuation is one recovery. Stall on the second.
      if (record.repeatedNoProgress >= 2)
        return await finish(
          'stalled',
          `repeated:${repeatedAction(result)}`,
          result,
          'continuation_stalled',
        );

      if (result.terminal.reason === 'max_tokens') {
        const id = `${record.logicalTurnId}:output:${segment}`;
        const text =
          'Continue the interrupted answer without repeating text already saved. Do not start a new task.';
        if (!record.runtimeContinuationIds.includes(id)) {
          options.persistRuntimeContinuation?.({
            activeSessionId: record.activeSessionId,
            id,
            text,
          });
          record.runtimeContinuationIds.push(id);
        }
      }
      record.status = 'continuing';
      save();
      trace({
        type: 'recovery_start',
        segment,
        cause: result.terminal.reason,
        counters: { ...record.counters },
        activeSessionId: record.activeSessionId,
      });
      const continuation: LogicalTurnContinuation = {
        logicalTurnId: record.logicalTurnId,
        sessionId: record.sessionId,
        activeSessionId: record.activeSessionId,
        cause: result.terminal.reason,
        segment,
        cumulative: { ...record.counters },
        limits: {
          modelCalls: record.logicalModelCallLimit,
          ...(record.deadlineAt !== undefined ? { deadlineAt: record.deadlineAt } : {}),
        },
      };
      options.onContinuing?.(continuation);
      messages = boundary ? boundary.messages() : options.rehydrate(record.activeSessionId);
      record.status = 'running';
      save();
      trace({
        type: 'recovery_end',
        segment,
        cause: result.terminal.reason,
        counters: { ...record.counters },
        activeSessionId: record.activeSessionId,
      });
    }
  } finally {
    clearPauses();
    options.signal?.removeEventListener('abort', onExternalAbort);
    clearSegment(record.logicalTurnId, leaseOwner);
    if (leased) options.store.releaseLogicalTurnLease(record.logicalTurnId, leaseOwner);
  }
}

function addUsage(
  counters: LogicalTurnCounters,
  usage: TokenUsage | undefined,
  estimatedCostUsd: number | undefined,
): void {
  counters.inputTokens += usage?.inputTokens ?? 0;
  counters.outputTokens += usage?.outputTokens ?? 0;
  counters.cacheCreationInputTokens += usage?.cacheCreationInputTokens ?? 0;
  counters.cacheReadInputTokens += usage?.cacheReadInputTokens ?? 0;
  counters.estimatedCostUsd += estimatedCostUsd ?? 0;
}

function assistantTextLength(result: RunResult): number {
  return (
    result.finalAssistant?.content.reduce(
      (total, block) => total + (block.type === 'text' ? block.text.length : 0),
      0,
    ) ?? 0
  );
}

function repeatedAction(result: RunResult): string {
  if (result.distinctToolNames.length === 1) {
    const name = result.distinctToolNames[0];
    if (name) return name;
  }
  return result.terminal.reason;
}

type ProgressFacts = {
  transcriptIds?: readonly (string | number)[];
  transcriptCount?: number;
  receipts: readonly unknown[];
  cursor?: unknown;
  hasCursor: boolean;
  compactionChildId?: string;
  tasks?: unknown;
};

function needsHydratedFacts(facts: ProgressFacts): boolean {
  return (
    (facts.transcriptIds === undefined && facts.transcriptCount === undefined) || !facts.hasCursor
  );
}

function progressFacts(snapshot: unknown): ProgressFacts {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return { receipts: [], hasCursor: false };
  }
  const record = snapshot as Record<string, unknown>;
  const facts: ProgressFacts = {
    receipts: completedReceipts(record.receipts),
    hasCursor: Object.hasOwn(record, 'cursor'),
  };
  const ids = idList(record.transcriptIds);
  if (ids) facts.transcriptIds = ids;
  if (typeof record.transcriptCount === 'number' && Number.isFinite(record.transcriptCount)) {
    facts.transcriptCount = record.transcriptCount;
  }
  if (facts.hasCursor) facts.cursor = record.cursor;
  if (typeof record.compactionChildId === 'string' && record.compactionChildId.length > 0) {
    facts.compactionChildId = record.compactionChildId;
  }
  if (record.tasks !== undefined) facts.tasks = record.tasks;
  return facts;
}

function progressFingerprint(input: {
  facts: ProgressFacts;
  hydrated: readonly Message[] | undefined;
  cause: string;
  assistantTextLength: number;
  activeSessionId: string;
}): string {
  const derived =
    input.facts.transcriptIds === undefined && input.facts.transcriptCount === undefined
      ? transcriptIdentity(input.hydrated ?? [])
      : undefined;
  const cursor = input.facts.hasCursor
    ? input.facts.cursor
    : logicalTurnCursor(input.hydrated ?? []);
  return digest({
    transcriptIds: input.facts.transcriptIds ?? derived?.transcriptIds ?? [],
    transcriptCount:
      input.facts.transcriptCount ?? derived?.transcriptCount ?? input.hydrated?.length ?? 0,
    receipts: input.facts.receipts,
    cursor: cursor ?? null,
    compactionChildId: input.facts.compactionChildId ?? input.activeSessionId,
    activeSessionId: input.activeSessionId,
    ...(input.facts.tasks !== undefined ? { tasks: input.facts.tasks } : {}),
    assistantTextLength: input.assistantTextLength,
    cause: input.cause,
  });
}

function transcriptIdentity(messages: readonly Message[]): {
  transcriptIds: string[];
  transcriptCount: number;
} {
  const transcriptIds: string[] = [];
  for (const message of messages) {
    if (message.role === 'user' && message.id) transcriptIds.push(`user:${message.id}`);
    for (const block of message.content) {
      if (block.type === 'tool_use') transcriptIds.push(`use:${block.id}`);
      else if (block.type === 'tool_result') transcriptIds.push(`result:${block.tool_use_id}`);
    }
  }
  return { transcriptIds, transcriptCount: messages.length };
}

/** Latest pagination cursor in transcript order. A tool result wins over its request. */
export function logicalTurnCursor(
  messages: readonly {
    content: readonly { type: string; content?: string; input?: unknown }[];
  }[],
): string | undefined {
  let cursor: string | undefined;
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_result' && typeof block.content === 'string') {
        const found = cursorInJson(block.content);
        if (found !== undefined) cursor = found;
      } else if (block.type === 'tool_use') {
        const found = cursorOnInput(block.input);
        if (found !== undefined) cursor = found;
      }
    }
  }
  return cursor;
}

function cursorOnInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const cursor = (input as { cursor?: unknown }).cursor;
  return typeof cursor === 'string' ? cursor : undefined;
}

function cursorInJson(content: string): string | undefined {
  try {
    return cursorInValue(JSON.parse(content) as unknown);
  } catch {
    return undefined;
  }
}

function cursorInValue(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as { nextCursor?: unknown; data?: unknown };
  if (typeof record.nextCursor === 'string') return record.nextCursor;
  if (record.data && typeof record.data === 'object') {
    const nested = (record.data as { nextCursor?: unknown }).nextCursor;
    if (typeof nested === 'string') return nested;
  }
  return undefined;
}

function idList(value: unknown): (string | number)[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids: (string | number)[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' && typeof entry !== 'number') return undefined;
    ids.push(entry);
  }
  return ids;
}

function completedReceipts(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => {
    if (Array.isArray(entry)) return entry[1] === 'completed';
    if (entry && typeof entry === 'object' && 'state' in entry) {
      return (entry as { state?: unknown }).state === 'completed';
    }
    return false;
  });
}

function transientDelay(
  error: Error | undefined,
  attempt: number,
  committed = false,
): number | undefined {
  if (!error || error.name === 'AbortError') return undefined;
  if (error instanceof ProviderHttpError) {
    if (![429, 502, 503, 504].includes(error.status)) return undefined;
    const retryAfter = headerValue(error.headers, 'retry-after');
    const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
    const base =
      Number.isFinite(seconds) && seconds >= 0
        ? Math.min(10_000, Math.floor(seconds * 1000))
        : Math.min(10_000, 100 * 2 ** attempt);
    return withJitter(base);
  }
  if (error instanceof SubscriptionRefreshError && error.retryable)
    return withJitter(Math.min(10_000, error.retryAfterMs ?? 100 * 2 ** attempt));
  // Subscription transports already apply their bounded before-delivery retry
  // policy. Retrying the terminal stream error here would multiply requests.
  if (error instanceof SubscriptionStreamError) return undefined;
  // requestAttempt owns 429/502/503/504: at most three sends, Retry-After
  // capped at 10 seconds. Another segment would send past that budget.
  if (error instanceof SubscriptionHttpError) return undefined;
  // Timeout or connection loss only before this attempt committed output.
  if (committed || !isPreDeliveryTransportFault(error)) return undefined;
  return withJitter(Math.min(10_000, 100 * 2 ** attempt));
}

/** Resolves early when `signal` aborts. The caller decides deadline versus cancel. */
function sleepWithSignal(
  ms: number,
  signal: AbortSignal | undefined,
  wait: (ms: number) => Promise<void>,
): Promise<void> {
  if (!signal) return wait(ms);
  if (signal.aborted) return Promise.resolve();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    onAbort = () => resolve();
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const delay = wait(ms);
  // An injected wait can reject after abort already settled the race.
  void delay.catch(() => {});
  return Promise.race([delay, aborted]).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  });
}

function hasCommittedOutput(result: RunResult): boolean {
  return (result.finalAssistant?.content ?? []).some(
    (block) => block.type !== 'text' || block.text.length > 0,
  );
}

function isPreDeliveryTransportFault(error: Error): boolean {
  if (
    error instanceof ProviderHttpError ||
    error instanceof ProviderStreamError ||
    error instanceof SubscriptionHttpError ||
    error instanceof SubscriptionStreamError ||
    error instanceof SubscriptionRefreshError ||
    error instanceof PersistBeforeRunError ||
    error instanceof SessionPersistenceError ||
    error instanceof ToolStorageError
  )
    return false;
  return isTimeoutFault(error) || isConnectionLoss(error);
}

function isTimeoutFault(error: Error): boolean {
  return walkCauses(error, (current) => {
    if (current.name === 'TimeoutError') return true;
    const code = errorCode(current);
    return (
      code === 'ETIMEDOUT' ||
      code === 'UND_ERR_CONNECT_TIMEOUT' ||
      code === 'UND_ERR_HEADERS_TIMEOUT' ||
      code === 'UND_ERR_BODY_TIMEOUT'
    );
  });
}

function isConnectionLoss(error: Error): boolean {
  return walkCauses(error, (current) => {
    const code = errorCode(current);
    if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET') return true;
    const message = current.message.toLowerCase();
    return (
      message.includes('econnreset') ||
      message.includes('socket hang up') ||
      message.includes('fetch failed')
    );
  });
}

function walkCauses(error: Error, match: (current: Error) => boolean): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    if (current.name === 'AbortError') return false;
    if (match(current)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function errorCode(error: Error): string | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function withJitter(baseMs: number): number {
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(baseMs * 0.2)));
  return Math.min(10_000, baseMs + jitter);
}

function headerValue(
  headers: ProviderHttpError['headers'],
  name: string,
): string | null | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name);
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  return value;
}

function storageFault(error: unknown): boolean {
  return (
    error instanceof PersistBeforeRunError ||
    error instanceof SessionPersistenceError ||
    error instanceof ToolStorageError
  );
}

/** A deadline reason or a reached deadlineAt. A user stop before that time stays cancelled. */
function isDeadlineTerminal(
  signal: AbortSignal | undefined,
  deadlineAt: number | undefined,
  nowMs: number,
): boolean {
  if (signal?.aborted && signal.reason === 'deadline') return true;
  return deadlineAt !== undefined && nowMs >= deadlineAt;
}

function isSafeTransientFailure(record: LogicalTurnRecord): boolean {
  return [record.finishReason, record.lastCause].some(
    (cause) => cause !== undefined && SAFE_TRANSIENT_FAILURES.has(cause),
  );
}

function storedFailure(record: LogicalTurnRecord): LogicalTurnResult {
  return {
    logicalTurnId: record.logicalTurnId,
    status: 'failed',
    activeSessionId: record.activeSessionId,
    counters: { ...record.counters },
    finishReason: record.finishReason ?? 'failed',
    reply: record.finalReply ?? '',
  };
}

function invalidResult(
  logicalTurnId: string,
  activeSessionId: string,
  code: NonNullable<LogicalTurnResult['code']>,
): LogicalTurnResult {
  return {
    logicalTurnId,
    status: 'failed',
    code,
    activeSessionId,
    counters: { ...EMPTY_COUNTERS },
    finishReason: code,
    reply: '',
  };
}

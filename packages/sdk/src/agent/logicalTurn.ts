import { createHash, randomUUID } from 'node:crypto';
import { logicalSegmentStop } from '../core/query.js';
import type { Message, Terminal, TokenUsage } from '../core/types.js';
import {
  PersistBeforeRunError,
  ProviderHttpError,
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
  }) => Promise<RunResult>;
  rehydrate: (activeSessionId: string) => Message[];
  /** Returns false for started/unknown effects or an invalid transcript. */
  recoverySafe: (activeSessionId: string) => boolean;
  progressSnapshot?: (activeSessionId: string) => unknown;
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
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
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
  const withHeartbeat = async <T>(work: Promise<T>): Promise<T> => {
    let stopped = false;
    let settled = false;
    let rejectLost: (error: Error) => void = () => {};
    const lost = new Promise<never>((_, reject) => {
      rejectLost = reject;
    });
    const beat = (async () => {
      while (!stopped && !settled) {
        await pause(LOGICAL_TURN_LEASE_RENEW_MS);
        if (stopped || settled) return;
        if (!renewLease()) {
          if (!settled) rejectLost(new LogicalTurnLeaseError());
          return;
        }
      }
    })().catch((error: unknown) => {
      if (settled) return;
      rejectLost(error instanceof Error ? error : new LogicalTurnLeaseError());
    });
    try {
      return await Promise.race([work, lost]);
    } finally {
      settled = true;
      stopped = true;
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
    if (resuming && !options.recoverySafe(record.activeSessionId))
      return await finish('failed', 'unsafe_effect', undefined, 'recovery_unsafe');
    record.status = 'running';
    save();
    if (options.prepare) await withHeartbeat(Promise.resolve(options.prepare()));
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
      if (options.signal?.aborted) return await finish('cancelled', 'cancelled', undefined);
      if (record.deadlineAt !== undefined && now() >= record.deadlineAt)
        return await finish('exhausted', 'deadline', undefined, 'continuation_exhausted');
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
        result = await withHeartbeat(
          options.runSegment({
            messages,
            activeSessionId: record.activeSessionId,
            segment,
            continuation: segment > 1,
            remainingModelCalls: remaining,
          }),
        );
      } catch (error) {
        // Deadline and storage faults already have their own terminals.
        // Persist cancellation, then rethrow so the host keeps a pivoted session.
        // A lost lease must not overwrite the worker that now owns the record.
        if (
          !(error instanceof LogicalTurnLeaseError) &&
          options.signal?.aborted &&
          !preservesAbortCause(error, record.deadlineAt, now())
        )
          await finish('cancelled', 'cancelled', undefined);
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
      if (result.terminal.reason === 'interrupted' || options.signal?.aborted)
        return await finish('cancelled', 'cancelled', result);

      if (result.terminal.reason === 'error') {
        const transient = transientDelay(result.terminal.error, transientAttempts);
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
        await withHeartbeat(sleep(transient));
        messages = options.rehydrate(record.activeSessionId);
        continue;
      }

      transientAttempts = 0;
      if (!options.recoverySafe(record.activeSessionId))
        return await finish('failed', 'unsafe_effect', result, 'recovery_unsafe');
      const snapshot = options.progressSnapshot?.(record.activeSessionId) ?? messages;
      const fingerprint = digest({
        snapshot,
        cause: result.terminal.reason,
        assistantTextLength: assistantTextLength(result),
      });
      record.repeatedNoProgress =
        record.progressFingerprint === fingerprint && previousCause === result.terminal.reason
          ? record.repeatedNoProgress + 1
          : 0;
      record.progressFingerprint = fingerprint;
      if (record.repeatedNoProgress >= 1)
        return await finish('stalled', 'no_progress', result, 'continuation_stalled');

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
      messages = options.rehydrate(record.activeSessionId);
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

function transientDelay(error: Error | undefined, attempt: number): number | undefined {
  if (!error) return undefined;
  if (error instanceof ProviderHttpError || error instanceof SubscriptionHttpError) {
    if (![429, 502, 503, 504].includes(error.status)) return undefined;
    const retryAfter =
      error instanceof ProviderHttpError ? headerValue(error.headers, 'retry-after') : undefined;
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
  return undefined;
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

function preservesAbortCause(
  error: unknown,
  deadlineAt: number | undefined,
  nowMs: number,
): boolean {
  if (
    error instanceof PersistBeforeRunError ||
    error instanceof SessionPersistenceError ||
    error instanceof ToolStorageError
  )
    return true;
  return deadlineAt !== undefined && nowMs >= deadlineAt;
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

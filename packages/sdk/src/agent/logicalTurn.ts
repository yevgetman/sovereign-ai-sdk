import { createHash, randomUUID } from 'node:crypto';
import type { Message, Terminal, TokenUsage } from '../core/types.js';
import {
  ProviderHttpError,
  SubscriptionHttpError,
  SubscriptionRefreshError,
  SubscriptionStreamError,
} from '../providers/errors.js';
import type { RunResult } from './createAgent.js';

export const LOGICAL_TURN_RECOVERY_CAPABILITY = {
  owner: 'sov',
  version: 1,
  mode: 'automatic',
} as const;

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
  saveLogicalTurn(record: LogicalTurnRecord): void;
  acquireLogicalTurnLease(
    logicalTurnId: string,
    owner: string,
    expiresAt: number,
    now: number,
  ): boolean;
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
  const leaseOwner = randomUUID();
  const leaseUntil = Math.max(record.deadlineAt ?? now() + 300_000, now() + 30_000);
  if (!options.store.acquireLogicalTurnLease(record.logicalTurnId, leaseOwner, leaseUntil, now()))
    throw new LogicalTurnLeaseError();

  const trace = (event: Omit<LogicalTurnTraceEvent, 'logicalTurnId' | 'elapsedMs'>): void => {
    options.onTrace?.({
      ...event,
      logicalTurnId: record.logicalTurnId,
      elapsedMs: Math.max(0, now() - startedAt),
    });
  };
  const save = (): void => {
    record.updatedAt = now();
    options.store.saveLogicalTurn(record);
  };
  const finish = (
    status: LogicalTurnStatus,
    finishReason: string,
    finalSegment?: RunResult,
    code?: LogicalTurnResult['code'],
  ): LogicalTurnResult => {
    record.status = status;
    record.finishReason = finishReason;
    if (finalSegment)
      record.finalReply =
        finalSegment.finalAssistant?.content
          .filter((block) => block.type === 'text')
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join('') ?? '';
    record.updatedAt = now();
    options.store.saveLogicalTurn(record);
    trace({
      type: 'logical_turn_end',
      segment: record.counters.segments,
      cause: finishReason,
      counters: { ...record.counters },
      activeSessionId: record.activeSessionId,
      outcome: status,
    });
    return {
      logicalTurnId: record.logicalTurnId,
      status,
      ...(code !== undefined ? { code } : {}),
      activeSessionId: record.activeSessionId,
      ...(finalSegment !== undefined ? { finalSegment } : {}),
      counters: { ...record.counters },
      finishReason,
      reply: record.finalReply ?? '',
    };
  };

  try {
    record.status = 'running';
    save();
    trace({
      type: 'logical_turn_start',
      segment: record.counters.segments,
      counters: { ...record.counters },
      activeSessionId: record.activeSessionId,
    });
    if (record.counters.segments > 0 && !options.recoverySafe(record.activeSessionId))
      return finish('failed', 'unsafe_effect', undefined, 'recovery_unsafe');
    let messages =
      record.counters.segments > 0
        ? options.rehydrate(record.activeSessionId)
        : [...options.initialMessages];
    let transientAttempts = 0;
    for (;;) {
      if (options.signal?.aborted) return finish('cancelled', 'cancelled', undefined);
      if (record.deadlineAt !== undefined && now() >= record.deadlineAt)
        return finish('exhausted', 'deadline', undefined, 'continuation_exhausted');
      const remaining = record.logicalModelCallLimit - record.counters.modelCalls;
      if (remaining <= 0)
        return finish('exhausted', 'model_call_limit', undefined, 'continuation_exhausted');
      const segment = record.counters.segments + 1;
      trace({
        type: 'segment_start',
        segment,
        counters: { ...record.counters },
        activeSessionId: record.activeSessionId,
      });
      const result = await options.runSegment({
        messages,
        activeSessionId: record.activeSessionId,
        segment,
        continuation: segment > 1,
        remainingModelCalls: remaining,
      });
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
      trace({
        type: 'segment_end',
        segment,
        cause: result.terminal.reason,
        counters: { ...record.counters },
        activeSessionId: record.activeSessionId,
      });

      if (result.terminal.reason === 'completed') return finish('completed', 'completed', result);
      if (result.terminal.reason === 'checkin') return finish('waiting_user', 'checkin', result);
      if (result.terminal.reason === 'interrupted' || options.signal?.aborted)
        return finish('cancelled', 'cancelled', result);

      if (result.terminal.reason === 'error') {
        const transient = transientDelay(result.terminal.error, transientAttempts);
        if (transient === undefined || transientAttempts >= 2)
          return finish('failed', 'failed', result);
        if (!options.recoverySafe(record.activeSessionId))
          return finish('failed', 'unsafe_effect', result, 'recovery_unsafe');
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
        await sleep(transient);
        messages = options.rehydrate(record.activeSessionId);
        continue;
      }

      transientAttempts = 0;
      if (!options.recoverySafe(record.activeSessionId))
        return finish('failed', 'unsafe_effect', result, 'recovery_unsafe');
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
        return finish('stalled', 'no_progress', result, 'continuation_stalled');

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
    options.store.releaseLogicalTurnLease(record.logicalTurnId, leaseOwner);
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

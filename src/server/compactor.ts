// Phase 16.1 M6 T2 — server-side compaction primitive.
//
// buildServerCompactor(runtime) returns a closure that wraps compactSession()
// with the runtime's provider/model/system-prompt + a same-provider summarize
// callback (M6-06: inline decision, no separate auxiliary model selection).
// Lineage is recorded inside compactSession itself
// (sessionDb.recordCompactionLineage at compactor.ts:141).
//
// Consumers: T3 (proactive check in turns route), T4 (overflow recovery in
// turns route), T5 (POST /sessions/:id/compact route).

import type { AssistantMessage, Message, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import {
  accumulateUsage,
  createUsageAccumulator,
  finalizeUsage,
} from '@yevgetman/sov-sdk/core/usageAccumulator';
import type { ReasoningEffort } from '@yevgetman/sov-sdk/providers/effort';
import {
  assertRequestFits,
  requestInputTokenBound,
  resolveModelLimits,
} from '@yevgetman/sov-sdk/providers/modelLimits';
import type { ModelRecord } from '@yevgetman/sov-sdk/providers/models/index';
import { validateModelRequest } from '@yevgetman/sov-sdk/providers/models/validateRequest';
import { estimateUsageCost, pricingSnapshotForModel } from '@yevgetman/sov-sdk/providers/pricing';
import type { ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import {
  COMPACTION_SUMMARY_MAX_TOKENS,
  type CompactResult,
  assistantTextBlocks,
  compactSession,
  compressionSystemPrompt,
} from '../compact/compactor.js';
import type { Runtime } from './runtime.js';

export type ServerCompactor = (
  history: readonly Message[],
  sessionId: string,
  signal: AbortSignal,
  options?: {
    onStreamEvent?: (event: StreamEvent) => void;
    modelMetadata?: ModelRecord;
    effort?: ReasoningEffort;
  },
) => Promise<CompactResult>;

export function buildServerCompactor(
  runtime: Pick<
    Runtime,
    'sessionDb' | 'resolvedProvider' | 'model' | 'systemSegments' | 'transcripts'
  >,
): ServerCompactor {
  return async function compact(history, sessionId, signal, options) {
    return compactSession({
      db: runtime.sessionDb,
      ...(runtime.transcripts !== undefined ? { transcripts: runtime.transcripts } : {}),
      sessionId,
      model: runtime.model,
      providerName: runtime.resolvedProvider.transport.name,
      systemPrompt: runtime.systemSegments,
      history: [...history],
      summarize: async (input) => {
        const previous = input.previousSummary
          ? `Previous handoff summary to merge:\n${input.previousSummary}\n\n`
          : '';
        // Skeleton headers from buildSummarizerPrompt are advisory; only
        // HANDOFF_SUMMARY_NOTE is consumed downstream by normalizeSummary /
        // extractLatestHandoffSummary, so the same-provider path can stay
        // simpler.
        const prompt = `${previous}Conversation transcript to compress:\n${input.transcript}\n\nReturn a structured summary preserving concrete facts, file paths, decisions, and remaining work.`;
        const metadata = options?.modelMetadata;
        // Exact owner-subscription identity policy. The optional marker is
        // structurally read so this host stays compatible with older DTOs.
        const ownerEvidence =
          metadata?.id === runtime.model &&
          metadata.auth === 'subscription' &&
          ((metadata.provider === 'grok' && metadata.routeId === 'grok-subscription') ||
            (metadata.provider === 'chatgpt' && metadata.routeId === 'chatgpt-subscription')) &&
          'ownerManaged' in metadata.metadata &&
          metadata.metadata.ownerManaged === true;
        const limits = metadata
          ? resolveModelLimits(
              {
                contextTokens: metadata.contextWindow,
                outputTokens: metadata.maxOutputTokens,
                stale: metadata.metadata.stale && !ownerEvidence,
              },
              { outputTokens: COMPACTION_SUMMARY_MAX_TOKENS },
            )
          : undefined;
        const request: ProviderRequest = {
          model: runtime.model,
          // Native callers carry their exact selection into internal work.
          // Existing gateway callers omit options and retain their defaults.
          ...(options?.effort !== undefined ? { effort: options.effort } : {}),
          ...(options?.modelMetadata ? { modelMetadata: options.modelMetadata } : {}),
          system: [{ text: compressionSystemPrompt(), cacheable: false }],
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          maxTokens: limits?.outputTokens ?? COMPACTION_SUMMARY_MAX_TOKENS,
          temperature: 0,
          cacheEnabled: false,
          signal,
        };
        if (metadata && limits) {
          const inputTokens = requestInputTokenBound(request.messages, request.system);
          request.maxTokens = Math.min(
            limits.outputTokens,
            Math.max(1, limits.contextTokens - inputTokens),
          );
          assertRequestFits(inputTokens, request.maxTokens, limits);
          request.outputBudgetEnforced = true;
          validateModelRequest(
            request,
            runtime.resolvedProvider.transport.name,
            options.modelMetadata,
          );
        }
        const stream = runtime.resolvedProvider.transport.stream(request);
        let usageAcc = createUsageAccumulator();
        let text = '';
        let lastAssistant: AssistantMessage | undefined;
        for await (const event of stream) {
          usageAcc = accumulateUsage(usageAcc, event);
          options?.onStreamEvent?.(event);
          if (event.type === 'text_delta') text += event.text;
          if (event.type === 'assistant_message') lastAssistant = event.message;
        }
        // Some providers emit only a final assistant_message event without
        // intermediate text deltas — mirror summarizeWithAuxiliary's
        // fallback (src/compact/compactor.ts) so the same-provider path
        // doesn't silently return '' for those providers.
        if (text.trim() === '' && lastAssistant) text = assistantTextBlocks(lastAssistant);
        signal.throwIfAborted();
        if (text.trim() === '') throw new Error('compaction summary was empty');
        const usage = finalizeUsage(usageAcc);
        const estimate = estimateUsageCost(
          runtime.resolvedProvider.transport.name,
          runtime.model,
          usage ?? {},
          options?.modelMetadata ? pricingSnapshotForModel(options.modelMetadata) : undefined,
        );
        const complete =
          estimate.complete && usage?.inputTokens !== undefined && usage.outputTokens !== undefined;
        const { amountUsd, ...receipt } = estimate;
        const costEstimate = {
          ...receipt,
          complete,
          ...(complete && amountUsd !== undefined ? { amountUsd } : {}),
          state:
            complete || estimate.state === 'subscription' ? estimate.state : ('unknown' as const),
        };
        return {
          summary: text,
          usedAuxiliary: false,
          ...(usage ? { usage } : {}),
          costEstimate,
          ...(complete && amountUsd !== undefined ? { estimatedCostUsd: amountUsd } : {}),
        };
      },
    });
  };
}

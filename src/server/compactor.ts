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

import {
  COMPACTION_SUMMARY_MAX_TOKENS,
  type CompactResult,
  assistantTextBlocks,
  compactSession,
  compressionSystemPrompt,
} from '../compact/compactor.js';
import type { AssistantMessage, Message } from '../core/types.js';
import type { Runtime } from './runtime.js';

export type ServerCompactor = (
  history: readonly Message[],
  sessionId: string,
  signal: AbortSignal,
) => Promise<CompactResult>;

export function buildServerCompactor(
  runtime: Pick<
    Runtime,
    'sessionDb' | 'resolvedProvider' | 'model' | 'systemSegments' | 'transcripts'
  >,
): ServerCompactor {
  return async function compact(history, sessionId, signal) {
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
        const stream = runtime.resolvedProvider.transport.stream({
          model: runtime.model,
          // NO `effort` here, deliberately: compaction is an internal
          // summarization op, not a user turn, so it never inherits the
          // session's reasoning-depth (mirrors the turns/cron/channel sites
          // that DO pass `effort: runtime.effort`). Keeps the summary request
          // byte-identical regardless of the live `/effort` level.
          system: [{ text: compressionSystemPrompt(), cacheable: false }],
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          maxTokens: COMPACTION_SUMMARY_MAX_TOKENS,
          temperature: 0,
          cacheEnabled: false,
          signal,
        });
        let text = '';
        let lastAssistant: AssistantMessage | undefined;
        for await (const event of stream) {
          if (event.type === 'text_delta') text += event.text;
          if (event.type === 'assistant_message') lastAssistant = event.message;
        }
        // Some providers emit only a final assistant_message event without
        // intermediate text deltas — mirror summarizeWithAuxiliary's
        // fallback (src/compact/compactor.ts) so the same-provider path
        // doesn't silently return '' for those providers.
        if (text.trim() === '' && lastAssistant) text = assistantTextBlocks(lastAssistant);
        if (text.trim() === '') throw new Error('compaction summary was empty');
        return text;
      },
    });
  };
}

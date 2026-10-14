// Transcript repair helpers. They preserve raw stored history while producing
// provider-valid message sequences for resume and rollback.

import type { ToolExecution } from '../persistence/sessionStore.js';
import type { ContentBlock, Message } from './types.js';

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>;
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>;

export type TranscriptRepairResult = {
  messages: Message[];
  insertedToolResults: number;
  repairedAssistantMessages: number;
};

export function repairMissingToolResults(
  messages: readonly Message[],
  executions?: readonly ToolExecution[],
  messageIds?: readonly number[],
): TranscriptRepairResult {
  const repaired: Message[] = [];
  let insertedToolResults = 0;
  let repairedAssistantMessages = 0;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message === undefined) continue;

    if (message.role !== 'assistant') {
      repaired.push(message);
      continue;
    }

    const uses = message.content.filter(isToolUseBlock);
    repaired.push(message);
    if (uses.length === 0) continue;

    const next = messages[i + 1];
    const nextResults = next?.role === 'user' ? next.content.filter(isToolResultBlock) : [];
    const nextResultIds = new Set(nextResults.map((block) => block.tool_use_id));
    const missing = uses.filter((block) => !nextResultIds.has(block.id));
    if (missing.length === 0) continue;

    const receipts = new Map(
      uses.map((use) => {
        const candidates =
          executions?.filter(
            (execution) =>
              execution.toolUseId === use.id &&
              (messageIds === undefined || execution.assistantMessageId === messageIds[i]),
          ) ?? [];
        // Repeated provider call IDs need their persisted assistant row ID.
        // Without it, ambiguous old receipts must never certify a later action.
        return [use.id, candidates.length === 1 ? candidates[0] : undefined] as const;
      }),
    );
    const syntheticResults = missing.map((use) => {
      const receipt = receipts.get(use.id);
      if (receipt?.state === 'completed' && receipt.result) return receipt.result;
      if (receipt?.result && receipt.state === 'interrupted') return receipt.result;
      return syntheticToolResult(use, receipt?.state === 'interrupted' ? 'interrupted' : 'unknown');
    });
    const appended = missing.flatMap(
      (use) => receipts.get(use.id)?.newMessages?.flatMap((message) => message.content) ?? [],
    );
    insertedToolResults += syntheticResults.length;
    repairedAssistantMessages++;

    if (next?.role === 'user') {
      // Merge the synthetic tool_result blocks INTO the following user message
      // and consume it (`i++`). This holds whether or not `next` already carries
      // tool_results: emitting the synthetics as their own `user` message and
      // leaving `next` for the following iteration produces TWO consecutive
      // `user` messages — itself a provider 400 ("roles must alternate"), the
      // very failure repair exists to prevent. tool_result blocks must LEAD the
      // user turn that answers the assistant tool_use, so order the merged
      // content results-first (existing + synthetic), then any non-result
      // content (e.g. a plain-text turn that arrived after a crash).
      const existingResults = next.content.filter(isToolResultBlock);
      const nonResults = next.content.filter((block) => !isToolResultBlock(block));
      repaired.push({
        role: 'user',
        content: [
          ...uses.map(
            (use) =>
              [...existingResults, ...syntheticResults].find(
                (result) => result.tool_use_id === use.id,
              ) as ToolResultBlock,
          ),
          ...appended,
          ...nonResults,
        ],
      });
      i++;
      continue;
    }

    // No following user message (transcript ends on the tool_use, or an
    // assistant message follows) — the synthetics stand alone as the answering
    // user turn.
    repaired.push({ role: 'user', content: [...syntheticResults, ...appended] });
  }

  return { messages: repaired, insertedToolResults, repairedAssistantMessages };
}

function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === 'tool_use';
}

function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
  return block.type === 'tool_result';
}

function syntheticToolResult(
  block: ToolUseBlock,
  state: 'interrupted' | 'unknown',
): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: block.id,
    content:
      state === 'unknown'
        ? `tool call ${block.name} did not have a persisted result; outcome unknown. The action may already have happened. Do not repeat a non-idempotent action without verifying its effect first; synthesized during transcript repair`
        : `tool call ${block.name} interrupted before execution; did not have a persisted result; synthesized during transcript repair`,
    is_error: true,
  };
}

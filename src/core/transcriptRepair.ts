// Transcript repair helpers. They preserve raw stored history while producing
// provider-valid message sequences for resume and rollback.

import type { ContentBlock, Message } from './types.js';

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>;
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>;

export type TranscriptRepairResult = {
  messages: Message[];
  insertedToolResults: number;
  repairedAssistantMessages: number;
};

export function repairMissingToolResults(messages: readonly Message[]): TranscriptRepairResult {
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

    const syntheticResults = missing.map(syntheticToolResult);
    insertedToolResults += syntheticResults.length;
    repairedAssistantMessages++;

    if (next?.role === 'user' && nextResults.length > 0) {
      repaired.push({ role: 'user', content: [...next.content, ...syntheticResults] });
      i++;
      continue;
    }

    repaired.push({ role: 'user', content: syntheticResults });
  }

  return { messages: repaired, insertedToolResults, repairedAssistantMessages };
}

function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === 'tool_use';
}

function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
  return block.type === 'tool_result';
}

function syntheticToolResult(block: ToolUseBlock): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: block.id,
    content: `tool call ${block.name} did not have a persisted result; synthesized during transcript repair`,
    is_error: true,
  };
}

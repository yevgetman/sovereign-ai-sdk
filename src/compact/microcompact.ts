// Microcompaction — per-part tool-result clearing. First-line defense before
// full compaction. Replaces stale tool results with short placeholders;
// no model call, no latency hit.
//
// Source of pattern: Qwen Code microcompact.ts (per-part clearing, compactable
// tool set, keep-recent logic). Trigger is context-percentage-based rather
// than Qwen's idle-timeout, better suited for continuous agent work.

import { estimateBlockTokens, estimateMessagesTokens } from '../core/tokenEstimate.js';
import type { ContentBlock, Message } from '../core/types.js';

export type MicrocompactConfig = {
  enabled: boolean;
  keepRecent: number;
  triggerThresholdPct: number;
  compactableTools: ReadonlySet<string>;
};

export const DEFAULT_MICROCOMPACT_CONFIG: MicrocompactConfig = {
  enabled: true,
  keepRecent: 5,
  triggerThresholdPct: 40,
  compactableTools: new Set([
    'Bash',
    'Read',
    'FileRead',
    'Write',
    'FileWrite',
    'Edit',
    'FileEdit',
    'Grep',
    'Glob',
  ]),
};

export type MicrocompactResult = {
  cleared: number;
  estimatedTokensSaved: number;
  keptRecent: number;
};

type ToolResultRef = {
  messageIndex: number;
  blockIndex: number;
  toolName: string;
  tokens: number;
};

export function microcompact(
  messages: Message[],
  toolNames: ReadonlyMap<string, string>,
  config: MicrocompactConfig,
): { messages: Message[]; result: MicrocompactResult } {
  const refs = collectCompactableRefs(messages, toolNames, config.compactableTools);
  if (refs.length <= config.keepRecent) {
    return { messages, result: { cleared: 0, estimatedTokensSaved: 0, keptRecent: refs.length } };
  }

  const toClear = refs.slice(0, refs.length - config.keepRecent);
  let tokensSaved = 0;
  const out = messages.map((msg, mi) => {
    const clearable = toClear.filter((r) => r.messageIndex === mi);
    if (clearable.length === 0) return msg;
    const newContent = (msg.content as ContentBlock[]).map((block, bi) => {
      const ref = clearable.find((r) => r.blockIndex === bi);
      if (!ref) return block;
      if (block.type !== 'tool_result') return block;
      const placeholder = `[Tool result cleared — ${ref.toolName}]`;
      const saved = ref.tokens - estimateBlockTokens({ ...block, content: placeholder });
      if (saved > 0) tokensSaved += saved;
      return { ...block, content: placeholder } as ContentBlock;
    });
    return { ...msg, content: newContent } as Message;
  });

  return {
    messages: out,
    result: {
      cleared: toClear.length,
      estimatedTokensSaved: tokensSaved,
      keptRecent: config.keepRecent,
    },
  };
}

export function shouldMicrocompact(
  messages: readonly Message[],
  config: MicrocompactConfig,
  toolNames: ReadonlyMap<string, string>,
): boolean {
  if (!config.enabled) return false;
  const totalTokens = estimateMessagesTokens(messages);
  if (totalTokens === 0) return false;

  let toolResultTokens = 0;
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    for (const block of msg.content) {
      if (block.type !== 'tool_result' || block.is_error) continue;
      const name = toolNames.get(block.tool_use_id);
      if (name && config.compactableTools.has(name)) {
        toolResultTokens += estimateBlockTokens(block);
      }
    }
  }

  return (toolResultTokens / totalTokens) * 100 > config.triggerThresholdPct;
}

function collectCompactableRefs(
  messages: readonly Message[],
  toolNames: ReadonlyMap<string, string>,
  compactableTools: ReadonlySet<string>,
): ToolResultRef[] {
  const refs: ToolResultRef[] = [];
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    if (!msg || msg.role !== 'user') continue;
    for (let bi = 0; bi < msg.content.length; bi++) {
      const block = msg.content[bi];
      if (!block || block.type !== 'tool_result') continue;
      if (block.is_error) continue;
      const name = toolNames.get(block.tool_use_id);
      if (!name || !compactableTools.has(name)) continue;
      if (block.content.startsWith('[Tool result cleared')) continue;
      refs.push({
        messageIndex: mi,
        blockIndex: bi,
        toolName: name,
        tokens: estimateBlockTokens(block),
      });
    }
  }
  return refs;
}

export function buildToolNameMap(messages: readonly Message[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        map.set(block.id, block.name);
      }
    }
  }
  return map;
}

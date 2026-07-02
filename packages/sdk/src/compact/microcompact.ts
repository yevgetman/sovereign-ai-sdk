// Microcompaction — per-part tool-result clearing. First-line defense before
// full compaction. Replaces stale tool results with short placeholders;
// no model call, no latency hit.
//
// Source of pattern: Qwen Code microcompact.ts (per-part clearing, compactable
// tool set, keep-recent logic). Trigger is context-percentage-based rather
// than Qwen's idle-timeout, better suited for continuous agent work.
//
// Current-turn protection (backlog Item 22, soak case G4): tool_results
// produced AFTER the latest real user prompt are excluded from eviction
// candidates regardless of how many older results are above the keepRecent
// floor. Without this, a single user prompt that triggers a 14-tool
// autonomous burst could see mid-burst results cleared before the agent's
// next assistant message references them, producing the "spinning in
// circles, results kept getting cleared" failure mode. The boundary is the
// index of the most recent user message that contains a `text` block —
// real user prompts always carry text; runTools-synthesized messages are
// pure tool_result. Standalone loop-guidance messages are also text-only
// and act as legitimate boundaries.

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
      // Defense-in-depth mirror of collectCompactableRefs: never overwrite a
      // non-string (array-shaped) tool_result body. Such blocks are excluded
      // from `refs` above, so this is only reachable if that guard changes —
      // keep it so a legal replayed transcript can never be corrupted here.
      if (typeof block.content !== 'string') return block;
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
  const currentTurnBoundary = findCurrentTurnBoundary(messages);
  const refs: ToolResultRef[] = [];
  for (let mi = 0; mi < messages.length; mi++) {
    // Tool results produced after the latest real user prompt belong to the
    // current burst and must not be evicted — the agent's next assistant
    // message may still reference them. See file header for rationale.
    if (mi >= currentTurnBoundary) continue;
    const msg = messages[mi];
    if (!msg || msg.role !== 'user') continue;
    for (let bi = 0; bi < msg.content.length; bi++) {
      const block = msg.content[bi];
      if (!block || block.type !== 'tool_result') continue;
      if (block.is_error) continue;
      const name = toolNames.get(block.tool_use_id);
      if (!name || !compactableTools.has(name)) continue;
      // A tool_result whose `content` is an array of blocks (image /
      // structured results) is a legal Anthropic wire shape that reaches us
      // when a consumer seeds/rehydrates a session or replays a real
      // transcript. The internal type says `string`, but TS is erased at
      // runtime. Such content has no `.startsWith` and is not the giant
      // text-blob case microcompaction targets, so treat it as
      // non-compactable and pass it through untouched (never a candidate).
      if (typeof block.content !== 'string') continue;
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

/**
 * Returns the index of the most recent user message that contains a `text`
 * content block — i.e. the start of the current user-prompt burst. Tool
 * results at or after this index are part of the in-flight turn and are
 * NOT eligible for eviction. When no such message exists (e.g. very early
 * history or a synthetic test fixture with only tool messages), returns
 * `messages.length` so the boundary excludes nothing — preserving the
 * pre-fix behaviour for those edge cases.
 */
function findCurrentTurnBoundary(messages: readonly Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== 'user') continue;
    const hasText = msg.content.some((block) => block.type === 'text');
    if (hasText) return i;
  }
  return messages.length;
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

/**
 * Merges user settings onto DEFAULT_MICROCOMPACT_CONFIG. Returns the default
 * reference unchanged when no settings are provided, so callers can use
 * reference equality to detect a no-op override.
 *
 * Settings field types match the Zod-inferred shape from
 * `MicrocompactionSchema` (each field is `T | undefined` under
 * `exactOptionalPropertyTypes`), so callers can pass `userSettings.microcompaction`
 * directly without coercion.
 */
export function buildMicrocompactConfig(settings?: {
  enabled?: boolean | undefined;
  keepRecent?: number | undefined;
  triggerThresholdPct?: number | undefined;
}): MicrocompactConfig {
  if (!settings) return DEFAULT_MICROCOMPACT_CONFIG;
  return {
    ...DEFAULT_MICROCOMPACT_CONFIG,
    ...(settings.enabled !== undefined ? { enabled: settings.enabled } : {}),
    ...(settings.keepRecent !== undefined ? { keepRecent: settings.keepRecent } : {}),
    ...(settings.triggerThresholdPct !== undefined
      ? { triggerThresholdPct: settings.triggerThresholdPct }
      : {}),
  };
}

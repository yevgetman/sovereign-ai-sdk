// Phase F channel-pipeline Fix 2(a) — bounded, pairing-safe history seeding.
//
// A per-(channel, sender) channel conversation accrues history forever on a
// reused session row. `runChannelTurn` re-seeds the WHOLE history into every
// turn, so without a cap a long-running conversation eventually overflows the
// model's context window — and because the overflowing message is already
// persisted, EVERY later message also overflows (the conversation is bricked,
// with no recovery, because compaction isn't viable here: it would pivot to a
// new child session id and break the deterministic `buildSessionKey` continuity
// the channel surface depends on).
//
// The fix is to seed only a bounded TAIL of the conversation. The oldest turns
// are "forgotten" from the immediate context — acceptable chat-window behavior;
// the memory + learning layers carry longer-term context. This module owns the
// truncation so the rule is unit-testable in isolation and `pipeline.ts` stays
// lean.
//
// Pairing-safe truncation: a raw tail can begin in the MIDDLE of a tool_use /
// tool_result pair, leaving the first seeded message an ORPHAN tool_result
// (a `user` message whose first/only blocks are tool_results with no preceding
// assistant `tool_use` in the seed). Anthropic rejects a dangling tool_result.
// So after taking the tail we drop any leading messages until the first is a
// safe boundary (an assistant message, or a user message that does NOT lead
// with a tool_result), then run `repairMissingToolResults` to synthesize any
// tool_result still missing for a tool_use INSIDE the retained window.

import { repairMissingToolResults } from '@yevgetman/sov-sdk/core/transcriptRepair';
import type { ContentBlock, Message } from '@yevgetman/sov-sdk/core/types';

/** Default cap on the number of prior messages seeded into a channel turn.
 *  ~40 messages is a generous chat window (≈20 back-and-forth turns) that
 *  stays comfortably under any provider context limit while preserving enough
 *  recent context for natural follow-ups. The memory + learning layers carry
 *  anything older. Sized as a single named constant so a future config knob has
 *  one place to thread through. */
export const DEFAULT_MAX_SEEDED_MESSAGES = 40;

/** True when `block` is a tool_result block. */
function isToolResultBlock(block: ContentBlock): boolean {
  return block.type === 'tool_result';
}

/** True when seeding `messages[0]` as the first message would dangle a
 *  tool_result with no matching tool_use earlier in the seed — i.e. a `user`
 *  message that leads with a tool_result. Such a seed is rejected by the
 *  provider, so we must drop leading messages until this is false. */
function leadsWithOrphanToolResult(message: Message | undefined): boolean {
  if (message === undefined) return false;
  if (message.role !== 'user') return false;
  // A user message that carries ANY tool_result block as its leading content is
  // an orphan when it heads the seed (the matching tool_use lived in the
  // assistant message we just truncated away). We treat "first block is a
  // tool_result" as the orphan signal — guidance/text user messages are safe.
  const first = message.content[0];
  return first !== undefined && isToolResultBlock(first);
}

/** Take the last `maxMessages` of `history`, then drop leading messages until
 *  the seed no longer starts with an orphan tool_result, then repair any
 *  tool_use left without a tool_result inside the retained window.
 *
 *  Returns the bounded, provider-valid seed plus the count of synthesized
 *  tool_result blocks (so the caller can log a repair note, matching the turns
 *  route). A history at or under the cap with no orphan head round-trips
 *  unchanged (modulo any repair the full history already needed). */
export function capSeededHistory(
  history: Message[],
  maxMessages: number = DEFAULT_MAX_SEEDED_MESSAGES,
): { messages: Message[]; insertedToolResults: number } {
  const bound = Math.max(1, maxMessages);
  // Bounded tail.
  let tail = history.length > bound ? history.slice(history.length - bound) : [...history];
  // Pairing-safe head: drop leading orphan tool_result messages so the seed
  // begins on an assistant message or a non-tool_result user message.
  let dropFrom = 0;
  while (dropFrom < tail.length && leadsWithOrphanToolResult(tail[dropFrom])) {
    dropFrom += 1;
  }
  if (dropFrom > 0) tail = tail.slice(dropFrom);
  // Repair any tool_use inside the retained window whose tool_result was
  // truncated off the end (or was never persisted, e.g. a prior crash).
  const { messages, insertedToolResults } = repairMissingToolResults(tail);
  return { messages, insertedToolResults };
}

// The turn observer: a small state machine that turns a gateway event stream
// into readable turn details.
//
// This is the piece worth extracting. Every fact below was learned the
// expensive way, from a console that showed the wrong thing first:
//
//   - Only `tool_use_start` carries the tool NAME; only `tool_use_done` carries
//     the completed INPUT. They must be paired BY BLOCK ID, because tool calls
//     interleave — pairing by arrival order attributes the wrong command to the
//     wrong tool the moment two run concurrently.
//   - Reasoning arrives as a delta storm. Recording every delta floods the ring;
//     recording only a COUNT tells a viewer nothing ("reasoning 4.2k" — about
//     what?). So blocks accumulate and flush once, with an opening preview.
//   - Any non-thinking event ends the current reasoning block.
//
// The observer never decides WHETHER a turn is live — that is the host's call,
// which is why `complete()` and `fail()` are explicit rather than inferred from
// the stream. A follower replaying session history would otherwise emit a turn
// summary for every historical turn.

import type { DebugCollector } from './collector.js';

/**
 * The subset of a gateway event this observer reads, described structurally so
 * the collector needs no dependency on a particular event union.
 */
export interface ObservableEvent {
  type: string;
  seq: number;
  /** Content-block index — the pairing key for tool name ↔ tool input. */
  block?: number;
  text?: string;
  tool?: string;
  input?: unknown;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
}

export interface TurnObserver {
  /** Feed one stream event. Never throws. */
  observe(event: ObservableEvent): void;
  /** The turn ended in a terminal error. Flushes any open reasoning first. */
  fail(error: string, eventSeq: number): void;
  /**
   * The turn completed. Call this ONLY for a turn the host considers live —
   * replayed history must not produce summaries.
   */
  complete(input: { finishReason: string; eventSeq: number }): void;
}

export interface TurnObserverOptions {
  sessionId: string;
  principal: string;
  /**
   * Narrowed to the ONE method the observer calls. A host whose own collector
   * speaks a richer vocabulary (its own `surface` union, its own word for a
   * principal) can pass it straight in without a cast, because this is the only
   * part of the contract that has to line up.
   */
  collector: Pick<DebugCollector, 'recordDetail'>;
  /** Cap for a reasoning block's preview (default 280). */
  reasoningPreviewChars?: number;
  /** Cap for a tool input summary (default 160). */
  toolInputChars?: number;
  /** Cap for an error message (default 160). */
  errorChars?: number;
}

const DEFAULT_REASONING_PREVIEW = 280;
const DEFAULT_TOOL_INPUT = 160;
const DEFAULT_ERROR = 160;

/**
 * Fields that carry the human-meaningful part of a tool's input, in preference
 * order. A raw JSON blob is the fallback, never the first choice.
 */
const MEANINGFUL_KEYS = [
  'command',
  'file_path',
  'path',
  'pattern',
  'query',
  'url',
  'prompt',
  'description',
] as const;

/**
 * One line that says what a tool call actually DID — the command, the file
 * path, the pattern. "Bash" alone tells a viewer nothing, which is the exact
 * complaint this function exists to answer.
 */
export function summariseToolInput(input: unknown, cap = DEFAULT_TOOL_INPUT): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return input.slice(0, cap);
  if (typeof input !== 'object') return String(input).slice(0, cap);

  const record = input as Record<string, unknown>;
  for (const key of MEANINGFUL_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.slice(0, cap);
  }
  try {
    return JSON.stringify(input).slice(0, cap);
  } catch {
    // A cyclic or otherwise unserialisable input is not worth failing over.
    return '';
  }
}

export function createTurnObserver(options: TurnObserverOptions): TurnObserver {
  const { sessionId, principal, collector } = options;
  const reasoningCap = options.reasoningPreviewChars ?? DEFAULT_REASONING_PREVIEW;
  const toolCap = options.toolInputChars ?? DEFAULT_TOOL_INPUT;
  const errorCap = options.errorChars ?? DEFAULT_ERROR;

  let thinkingChars = 0;
  let textChars = 0;
  const toolsUsed: string[] = [];
  /** block index → tool name, as announced by tool_use_start. */
  const blockTools = new Map<number, string>();
  let reasoningBlock: { block: number; text: string; lastSeq: number } | null = null;
  let latest: { tokensIn?: number; tokensOut?: number; cost?: number } = {};

  function flushReasoning(): void {
    const block = reasoningBlock;
    reasoningBlock = null;
    if (block === null || block.text.length === 0) return;
    collector.recordDetail(principal, {
      sessionId,
      kind: 'thinking',
      chars: block.text.length,
      preview: block.text.slice(0, reasoningCap),
      eventSeq: block.lastSeq,
    });
  }

  return {
    observe(event: ObservableEvent): void {
      try {
        if (event.type === 'thinking_delta') {
          const text = event.text ?? '';
          const block = event.block ?? 0;
          thinkingChars += text.length;
          // A new block index means the previous block is finished.
          if (reasoningBlock !== null && reasoningBlock.block !== block) flushReasoning();
          if (reasoningBlock === null) reasoningBlock = { block, text: '', lastSeq: event.seq };
          reasoningBlock.text += text;
          reasoningBlock.lastSeq = event.seq;
          return;
        }

        // Any non-thinking event ends the current reasoning block.
        flushReasoning();

        if (event.type === 'text_delta') {
          textChars += (event.text ?? '').length;
          return;
        }
        if (event.type === 'tool_use_start') {
          // The START is the ONLY carrier of the tool name — remember it against
          // the block so the DONE can find it however the calls interleave.
          const tool = event.tool ?? 'tool';
          blockTools.set(event.block ?? 0, tool);
          toolsUsed.push(tool);
          return;
        }
        if (event.type === 'tool_use_done') {
          const tool = blockTools.get(event.block ?? 0) ?? 'tool';
          const input = summariseToolInput(event.input, toolCap);
          collector.recordDetail(principal, {
            sessionId,
            kind: 'tool_call',
            tool,
            ...(input !== '' ? { input } : {}),
            eventSeq: event.seq,
          });
          return;
        }
        if (event.type === 'status_update') {
          // Kept for the turn summary; the host's metering keeps its own copy.
          latest = {
            ...(event.tokensIn !== undefined ? { tokensIn: event.tokensIn } : {}),
            ...(event.tokensOut !== undefined ? { tokensOut: event.tokensOut } : {}),
            ...(event.cost !== undefined ? { cost: event.cost } : {}),
          };
        }
      } catch {
        // Observation must never break the stream it observes.
      }
    },

    fail(error: string, eventSeq: number): void {
      try {
        flushReasoning();
        collector.recordDetail(principal, {
          sessionId,
          kind: 'turn_error',
          error: error.slice(0, errorCap),
          eventSeq,
        });
      } catch {
        // Same contract as observe().
      }
    },

    complete(input: { finishReason: string; eventSeq: number }): void {
      try {
        flushReasoning();
        collector.recordDetail(principal, {
          sessionId,
          kind: 'turn_end',
          finishReason: input.finishReason,
          toolCalls: toolsUsed.length,
          tools: [...new Set(toolsUsed)],
          thinkingChars,
          textChars,
          ...(latest.tokensIn !== undefined ? { tokensIn: latest.tokensIn } : {}),
          ...(latest.tokensOut !== undefined ? { tokensOut: latest.tokensOut } : {}),
          ...(latest.cost !== undefined ? { cost: latest.cost } : {}),
          eventSeq: input.eventSeq,
        });
      } catch {
        // Same contract as observe().
      }
    },
  };
}

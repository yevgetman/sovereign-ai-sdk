// Phase 10.5 — multi-heuristic loop detector. Three detectors, each
// independently armed, all fed by the same `addAndCheck(turn)` per-turn
// entry point. The orchestrator decides what to do with the detection
// (default policy: inject a guidance message on the first hit, break the
// turn loop on the second).
//
// Pattern source: build plan §10.5.7; Qwen Code's loopDetectionService.ts
// implements five detectors — we start with the three that are most
// universal (tool-loop, action-stagnation, content-loop). Read-file-
// specific and repetitive-thought detectors stay deferred until local-
// model testing surfaces a need they don't catch.

import { createHash } from 'node:crypto';

export type LoopDetector = {
  name: 'consecutive-identical' | 'action-stagnation' | 'content-loop';
};

export type LoopDetection = {
  detector: 'consecutive-identical' | 'action-stagnation' | 'content-loop';
  /** SHA-256 of the repeated unit (tool call hash / tool name hash /
   *  content chunk). Recorded in the trace for debugging. */
  hash: string;
  /** Number of consecutive (or windowed) repetitions. */
  repetitionCount: number;
};

/** Per-turn snapshot fed to the detector. The orchestrator builds this
 *  after each assistant message + tool dispatch, before deciding whether
 *  to continue the turn loop. */
export type TurnSnapshot = {
  /** Tool calls made this turn, in source order. Each is hashed by
   *  `<name>:<JSON.stringify(input)>` for the consecutive-identical
   *  detector. The action-stagnation detector uses just the name. */
  toolCalls: Array<{ name: string; input: unknown }>;
  /** Concatenation of every text block in the assistant message. */
  assistantText: string;
};

export type LoopDetectorOpts = {
  /** Threshold for "the model called the exact same tool with the exact
   *  same args N times in a row." Hit fires at N. Default 4. */
  consecutiveIdenticalThreshold?: number;
  /** Threshold for "the model called the same tool name N times in a row,
   *  regardless of args." Default 7. */
  actionStagnationThreshold?: number;
  /** Chunk size (characters) for the content-loop detector. Default 200. */
  contentChunkSize?: number;
  /** Threshold for "this content chunk appeared N times in the last
   *  windowed sample." Default 8. */
  contentRepeatThreshold?: number;
  /** Window-size multiplier for the content detector — the window holds
   *  `ceil(repeatThreshold * windowMultiplier)` recent chunks. Default 1.5. */
  contentWindowMultiplier?: number;
};

const DEFAULT_OPTS: Required<LoopDetectorOpts> = {
  consecutiveIdenticalThreshold: 4,
  actionStagnationThreshold: 7,
  contentChunkSize: 200,
  contentRepeatThreshold: 8,
  contentWindowMultiplier: 1.5,
};

/** Stateful per-session loop detector. Construct one at the start of
 *  `query()`, call `addAndCheck(snapshot)` after every turn. Returns the
 *  first detector that fires (priority: identical > stagnation > content),
 *  null when nothing fires. After firing, the triggering detector's
 *  history is cleared so a fresh run of repetitions is required to fire
 *  again — otherwise the same already-detected pattern would re-fire on
 *  every subsequent no-op turn. */
export class LoopDetectorState {
  private toolCallHashes: string[] = [];
  private toolNames: string[] = [];
  private contentHashes: string[] = [];
  private readonly opts: Required<LoopDetectorOpts>;

  constructor(opts: LoopDetectorOpts = {}) {
    this.opts = { ...DEFAULT_OPTS, ...opts };
  }

  addAndCheck(turn: TurnSnapshot): LoopDetection | null {
    for (const call of turn.toolCalls) {
      this.toolCallHashes.push(hashToolCall(call));
      this.toolNames.push(call.name);
    }
    if (turn.assistantText.length > 0) {
      for (const chunk of chunkText(turn.assistantText, this.opts.contentChunkSize)) {
        this.contentHashes.push(sha256(chunk));
      }
    }

    const identical = checkConsecutiveIdentical(
      this.toolCallHashes,
      this.opts.consecutiveIdenticalThreshold,
    );
    if (identical) {
      this.toolCallHashes = [];
      return {
        detector: 'consecutive-identical',
        hash: identical.value,
        repetitionCount: identical.count,
      };
    }

    const stagnation = checkConsecutiveIdentical(
      this.toolNames,
      this.opts.actionStagnationThreshold,
    );
    if (stagnation) {
      this.toolNames = [];
      return {
        detector: 'action-stagnation',
        hash: sha256(stagnation.value),
        repetitionCount: stagnation.count,
      };
    }

    const windowSize = Math.ceil(
      this.opts.contentRepeatThreshold * this.opts.contentWindowMultiplier,
    );
    const window = this.contentHashes.slice(-windowSize);
    const mostFrequent = countMostFrequent(window);
    if (mostFrequent.count >= this.opts.contentRepeatThreshold) {
      this.contentHashes = [];
      return {
        detector: 'content-loop',
        hash: mostFrequent.value,
        repetitionCount: mostFrequent.count,
      };
    }

    return null;
  }
}

function hashToolCall(call: { name: string; input: unknown }): string {
  return sha256(`${call.name}:${JSON.stringify(call.input)}`);
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

/** Walk back from the end; if the last value repeats `threshold` times
 *  consecutively, return it with its count. Otherwise null. */
function checkConsecutiveIdentical(
  arr: readonly string[],
  threshold: number,
): { value: string; count: number } | null {
  if (arr.length < threshold) return null;
  const last = arr[arr.length - 1];
  if (last === undefined) return null;
  let count = 1;
  for (let i = arr.length - 2; i >= 0 && arr[i] === last; i--) count++;
  return count >= threshold ? { value: last, count } : null;
}

function countMostFrequent(arr: readonly string[]): { value: string; count: number } {
  if (arr.length === 0) return { value: '', count: 0 };
  const counts = new Map<string, number>();
  for (const h of arr) counts.set(h, (counts.get(h) ?? 0) + 1);
  let bestValue = '';
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      bestValue = value;
      bestCount = count;
    }
  }
  return { value: bestValue, count: bestCount };
}

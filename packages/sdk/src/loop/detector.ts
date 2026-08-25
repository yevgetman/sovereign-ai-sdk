// Progress-aware loop guard — the detector core.
// Spec: specs/2026-08-25-progress-aware-loop-guard-design.md (§3.1–§3.5).
//
// Three detectors, all fed by one stateful per-session object:
//
//   consecutive-identical  same tool name + input N times in a row (default 4)
//   no-progress            the last K observed tool calls were ALL unproductive
//                          (default K = 8) — the model is re-reading, re-running
//                          or re-failing and nothing new is coming back
//   content-loop           the same chunk of assistant text repeats in a window
//
// Priority when several arm on the same check: identical > no-progress > content.
//
// `no-progress` replaces the old `action-stagnation` detector, which counted
// consecutive calls of the same tool NAME. For any turn whose tool scope is a
// single tool, that measured turn LENGTH rather than stuckness and killed long
// but perfectly productive runs (spec §1). Progress is now judged on what comes
// BACK from a call, not on what was sent: a call is productive when its result
// is new to this session, or when it is a successful side-effect tool.
//
// Two entry points around tool dispatch, same per-turn loop:
//   1. `addAndCheck(turn)`   — pre-dispatch; the only one that can fire.
//   2. `observeResults(...)` — post-dispatch; feeds the productivity ledger.
// A no-progress verdict therefore lands on the check that FOLLOWS the Kth
// unproductive result — one turn late, deliberately (spec §3.3).
//
// The orchestrator decides what to do with a detection (guidance on strike 1,
// abort at `maxStrikes` in `enforce` mode; never abort in `warn`; `mode: 'off'`
// and `HARNESS_LOOP_DETECTOR=off` disable detection entirely).

import { createHash } from 'node:crypto';
import { DEFAULT_LOOP_OPTIONS, type LoopMode, type LoopOptions } from './options.js';

export type { LoopMode, LoopOptions } from './options.js';

/** Tools whose successful call is progress by definition — they changed the
 *  world, so a repeated result tells us nothing. Hosts extend this set through
 *  `LoopOptions.sideEffectTools` (additive, never replacing). */
const BUILTIN_SIDE_EFFECT_TOOLS: readonly string[] = [
  'FileEdit',
  'FileWrite',
  'memory',
  'memory_propose',
];

/** Result text beyond this is not hashed (64 KiB). Bounds the hashing cost of a
 *  pathological tool result; two results that differ only past the cut are
 *  treated as the same result, which is the conservative direction. */
const RESULT_TEXT_LIMIT = 65_536;

/** LRU cap on the per-session set of seen result hashes. A session with more
 *  distinct results than this is not what the guard is for (spec §3.2). */
const SEEN_RESULTS_LIMIT = 2_000;

/** How much of a canonical input / error text a `reason` string quotes. */
const REASON_PREVIEW_CHARS = 80;

export type LoopDetection = {
  detector: 'consecutive-identical' | 'no-progress' | 'content-loop';
  /** SHA-256 of the repeated unit (tool call hash / unproductive-run signature /
   *  content chunk). Recorded in the trace for debugging. */
  hash: string;
  /** Number of consecutive (or windowed) repetitions. */
  repetitionCount: number;
  /** Human-readable, one sentence, names what repeated (tool + input preview +
   *  counts; the error text when the repeats are failures). The orchestrator
   *  puts this in the guidance message, the stream event and the abort error. */
  reason: string;
  /** no-progress only: the window size and how many of it were unproductive. */
  window?: { size: number; unproductive: number };
};

/** Per-turn snapshot fed to the pre-dispatch check. */
export type TurnSnapshot = {
  /** Tool calls made this turn, in source order. Hashed by
   *  `<name>:<canonicalJson(input)>` for the consecutive-identical detector. */
  toolCalls: Array<{ name: string; input: unknown }>;
  /** Concatenation of every text block in the assistant message. */
  assistantText: string;
};

/** One dispatched tool call and what it returned, handed to `observeResults`. */
export type ObservedToolResult = {
  name: string;
  input: unknown;
  /** Concatenated text blocks of the `tool_result` content. */
  text: string;
  /** The `is_error` flag on the `tool_result`. */
  isError: boolean;
};

type ResolvedOptions = Required<Omit<LoopOptions, 'sideEffectTools'>> & {
  sideEffectTools: readonly string[];
};

type ToolCallRecord = {
  hash: string;
  name: string;
  inputPreview: string;
};

type ContentChunk = {
  hash: string;
  preview: string;
};

type ObservedCall = {
  name: string;
  inputHash: string;
  inputPreview: string;
  errorPreview: string | undefined;
  productive: boolean;
};

type CallGroup = {
  label: string;
  count: number;
  errorCount: number;
  errorPreview: string | undefined;
};

/** Stateful per-session loop detector. Construct one at the start of `query()`,
 *  call `addAndCheck(snapshot)` before dispatching a turn's tool calls and
 *  `observeResults(...)` after they return. `addAndCheck` returns the first
 *  detector that fires, or null. After firing, the triggering detector's
 *  history is cleared so a fresh run of repetitions is required to fire again —
 *  otherwise the already-detected pattern would re-fire on every later turn. */
export class LoopDetectorState {
  readonly mode: LoopMode;
  readonly maxStrikes: number;

  private readonly opts: ResolvedOptions;
  private readonly sideEffectTools: ReadonlySet<string>;
  private readonly contentWindowSize: number;

  private toolCalls: readonly ToolCallRecord[] = [];
  private contentChunks: readonly ContentChunk[] = [];
  /** The last `noProgressWindow` observed calls, oldest first. */
  private recentCalls: readonly ObservedCall[] = [];
  /** Result hashes seen this session, insertion-ordered as an LRU. */
  private readonly seenResults = new Set<string>();

  constructor(opts: LoopOptions = {}) {
    this.opts = resolveOptions(opts);
    this.mode = this.opts.mode;
    this.maxStrikes = this.opts.maxStrikes;
    this.sideEffectTools = new Set([...BUILTIN_SIDE_EFFECT_TOOLS, ...this.opts.sideEffectTools]);
    this.contentWindowSize = Math.ceil(
      this.opts.contentRepeatThreshold * this.opts.contentWindowMultiplier,
    );
  }

  /** Pre-dispatch check. Ingests this turn's tool inputs and assistant text,
   *  then returns the highest-priority detection, or null. */
  addAndCheck(turn: TurnSnapshot): LoopDetection | null {
    if (this.isDisabled()) return null;
    this.ingest(turn);
    return this.checkIdentical() ?? this.checkNoProgress() ?? this.checkContentLoop();
  }

  /** Post-dispatch. Records whether each call was productive; never fires. */
  observeResults(results: ReadonlyArray<ObservedToolResult>): void {
    if (this.isDisabled() || results.length === 0) return;
    const observed = results.map((result) => this.observeOne(result));
    this.recentCalls = keepLast([...this.recentCalls, ...observed], this.opts.noProgressWindow);
  }

  /** `mode: 'off'` disables the guard for this session; the env kill switch
   *  disables it process-wide and wins over any configured mode. */
  private isDisabled(): boolean {
    return this.mode === 'off' || process.env.HARNESS_LOOP_DETECTOR === 'off';
  }

  private ingest(turn: TurnSnapshot): void {
    if (turn.toolCalls.length > 0) {
      const records = turn.toolCalls.map(toToolCallRecord);
      this.toolCalls = keepLast(
        [...this.toolCalls, ...records],
        this.opts.consecutiveIdenticalThreshold,
      );
    }
    if (turn.assistantText.length > 0) {
      const chunks = chunkText(turn.assistantText, this.opts.contentChunkSize).map(toContentChunk);
      this.contentChunks = keepLast([...this.contentChunks, ...chunks], this.contentWindowSize);
    }
  }

  private observeOne(result: ObservedToolResult): ObservedCall {
    const resultHash = hashResult(result);
    const alreadySeen = this.seenResults.has(resultHash);
    this.rememberResult(resultHash, alreadySeen);
    const isSuccessfulSideEffect = this.sideEffectTools.has(result.name) && !result.isError;
    const canonicalInput = canonicalJson(result.input);
    return {
      name: result.name,
      inputHash: sha256(`${result.name}:${canonicalInput}`),
      inputPreview: preview(canonicalInput),
      errorPreview: result.isError ? preview(collapseWhitespace(result.text)) : undefined,
      productive: !alreadySeen || isSuccessfulSideEffect,
    };
  }

  /** Insertion order is recency order: re-inserting a hit moves it to the back,
   *  and eviction always takes the front. */
  private rememberResult(hash: string, alreadySeen: boolean): void {
    if (alreadySeen) this.seenResults.delete(hash);
    this.seenResults.add(hash);
    while (this.seenResults.size > SEEN_RESULTS_LIMIT) {
      const oldest = this.seenResults.values().next().value;
      if (oldest === undefined) return;
      this.seenResults.delete(oldest);
    }
  }

  private checkIdentical(): LoopDetection | null {
    const run = trailingRun(this.toolCalls.map((call) => call.hash));
    if (run === null || run.count < this.opts.consecutiveIdenticalThreshold) return null;
    const last = this.toolCalls[this.toolCalls.length - 1];
    this.toolCalls = [];
    return {
      detector: 'consecutive-identical',
      hash: run.value,
      repetitionCount: run.count,
      reason: describeIdentical(last, run.count),
    };
  }

  private checkNoProgress(): LoopDetection | null {
    const size = this.opts.noProgressWindow;
    const calls = this.recentCalls;
    if (calls.length < size || calls.some((call) => call.productive)) return null;
    this.recentCalls = [];
    return {
      detector: 'no-progress',
      hash: sha256(calls.map((call) => call.inputHash).join('|')),
      repetitionCount: size,
      reason: describeNoProgress(calls, size),
      window: { size, unproductive: size },
    };
  }

  private checkContentLoop(): LoopDetection | null {
    const mostFrequent = countMostFrequent(this.contentChunks.map((chunk) => chunk.hash));
    if (mostFrequent.count < this.opts.contentRepeatThreshold) return null;
    const chunk = this.contentChunks.find((c) => c.hash === mostFrequent.value);
    this.contentChunks = [];
    return {
      detector: 'content-loop',
      hash: mostFrequent.value,
      repetitionCount: mostFrequent.count,
      reason: describeContentLoop(chunk, mostFrequent.count),
    };
  }
}

function resolveOptions(opts: LoopOptions): ResolvedOptions {
  return {
    mode: opts.mode ?? DEFAULT_LOOP_OPTIONS.mode,
    consecutiveIdenticalThreshold: positiveInt(
      opts.consecutiveIdenticalThreshold,
      DEFAULT_LOOP_OPTIONS.consecutiveIdenticalThreshold,
    ),
    noProgressWindow: positiveInt(opts.noProgressWindow, DEFAULT_LOOP_OPTIONS.noProgressWindow),
    contentChunkSize: positiveInt(opts.contentChunkSize, DEFAULT_LOOP_OPTIONS.contentChunkSize),
    contentRepeatThreshold: positiveInt(
      opts.contentRepeatThreshold,
      DEFAULT_LOOP_OPTIONS.contentRepeatThreshold,
    ),
    contentWindowMultiplier: atLeastOne(
      opts.contentWindowMultiplier,
      DEFAULT_LOOP_OPTIONS.contentWindowMultiplier,
    ),
    sideEffectTools: opts.sideEffectTools ?? DEFAULT_LOOP_OPTIONS.sideEffectTools,
    maxStrikes: positiveInt(opts.maxStrikes, DEFAULT_LOOP_OPTIONS.maxStrikes),
  };
}

/** Thresholds are validated by the config schema (Zod: positive ints). This is
 *  the embedded-API safety net — a caller bypassing the schema cannot degenerate
 *  the guard: a zero window would fire on every check and a zero chunk size
 *  would spin `chunkText` forever. Out-of-range values fall back to the default. */
function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

function atLeastOne(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return fallback;
  return value;
}

function toToolCallRecord(call: { name: string; input: unknown }): ToolCallRecord {
  const canonicalInput = canonicalJson(call.input);
  return {
    hash: sha256(`${call.name}:${canonicalInput}`),
    name: call.name,
    inputPreview: preview(canonicalInput),
  };
}

function toContentChunk(text: string): ContentChunk {
  return { hash: sha256(text), preview: preview(collapseWhitespace(text)) };
}

function hashResult(result: ObservedToolResult): string {
  const kind = result.isError ? 'error' : 'ok';
  return sha256(`${kind}:${result.text.slice(0, RESULT_TEXT_LIMIT)}`);
}

/** Stable JSON: object keys sorted recursively, runs of whitespace inside
 *  string values collapsed to a single space (so a reflowed command is the same
 *  command). Digits are deliberately NOT stripped — `skills/2-…` and
 *  `skills/3-…` are different reads, on purpose (spec §3.2). */
function canonicalJson(value: unknown): string {
  // `JSON.stringify` is typed as returning `string` but returns `undefined` for
  // a top-level `undefined` — a tool input we must not crash on.
  const json = JSON.stringify(canonicalize(value)) as string | undefined;
  return json ?? 'undefined';
}

function canonicalize(value: unknown): unknown {
  if (typeof value === 'string') return collapseWhitespace(value);
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = canonicalize(source[key]);
    }
    return sorted;
  }
  return value;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function preview(text: string): string {
  return text.length > REASON_PREVIEW_CHARS ? `${text.slice(0, REASON_PREVIEW_CHARS)}…` : text;
}

function describeIdentical(call: ToolCallRecord | undefined, count: number): string {
  const label = call === undefined ? 'the same tool call' : `\`${call.name} ${call.inputPreview}\``;
  return `Your last ${count} tool calls were the same call repeated — ${label}.`;
}

function describeNoProgress(calls: readonly ObservedCall[], size: number): string {
  const parts = groupCalls(calls).map(renderGroup);
  return `Your last ${size} tool calls returned nothing new — ${parts.join(', ')}.`;
}

function renderGroup(group: CallGroup): string {
  const allErrors = group.errorCount === group.count && group.errorPreview !== undefined;
  return allErrors
    ? `\`${group.label}\` (same error ${group.count}×: "${group.errorPreview}")`
    : `\`${group.label}\` (result already seen, ${group.count}×)`;
}

/** Groups the window by tool name + input preview, keeping first-seen order so
 *  the reason reads in the order the model made the calls (spec §3.4). */
function groupCalls(calls: readonly ObservedCall[]): CallGroup[] {
  const groups = new Map<string, CallGroup>();
  for (const call of calls) {
    const label = `${call.name} ${call.inputPreview}`;
    const existing = groups.get(label);
    const isError = call.errorPreview !== undefined;
    if (existing === undefined) {
      groups.set(label, {
        label,
        count: 1,
        errorCount: isError ? 1 : 0,
        errorPreview: call.errorPreview,
      });
      continue;
    }
    groups.set(label, {
      label,
      count: existing.count + 1,
      errorCount: existing.errorCount + (isError ? 1 : 0),
      errorPreview: existing.errorPreview ?? call.errorPreview,
    });
  }
  return [...groups.values()];
}

function describeContentLoop(chunk: ContentChunk | undefined, count: number): string {
  const quoted = chunk === undefined ? '' : ` — "${chunk.preview}"`;
  return `The same block of your reply repeated ${count}× in a row${quoted}.`;
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

function keepLast<T>(items: readonly T[], limit: number): readonly T[] {
  return items.length > limit ? items.slice(items.length - limit) : items;
}

/** The run of identical values at the end of the array, or null when empty. */
function trailingRun(values: readonly string[]): { value: string; count: number } | null {
  const last = values[values.length - 1];
  if (last === undefined) return null;
  let count = 1;
  for (let i = values.length - 2; i >= 0 && values[i] === last; i--) count++;
  return { value: last, count };
}

function countMostFrequent(values: readonly string[]): { value: string; count: number } {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
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

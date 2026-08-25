// Loop-guard options — the ONE shape shared by the detector, the config schema
// (`loop` block), `QueryParams.loop`, `AgentConfig.loop` and `PerTurn.loop`.
// Spec: specs/2026-08-25-progress-aware-loop-guard-design.md §3.4.

export type LoopMode = 'enforce' | 'warn' | 'off';

export type LoopOptions = {
  /** enforce = guidance, then abort at maxStrikes; warn = guidance only, never
   *  abort; off = no detection. Default 'enforce'. */
  mode?: LoopMode;
  /** Same tool name + same input N times in a row. Default 4. */
  consecutiveIdenticalThreshold?: number;
  /** The last K observed tool calls all unproductive (result already seen this
   *  session and not a successful side-effect tool). Default 8. */
  noProgressWindow?: number;
  /** Content-loop chunk size in characters. Default 200. */
  contentChunkSize?: number;
  /** Content-loop repeat threshold inside the window. Default 8. */
  contentRepeatThreshold?: number;
  /** Content-loop window = ceil(threshold * multiplier). Default 1.5. */
  contentWindowMultiplier?: number;
  /** Tools whose successful call always counts as progress. ADDITIVE to the
   *  built-in set (FileEdit, FileWrite, memory, memory_propose). */
  sideEffectTools?: readonly string[];
  /** Detections before an abort in enforce mode. Default 2. */
  maxStrikes?: number;
};

export const DEFAULT_LOOP_OPTIONS: Readonly<
  Required<Omit<LoopOptions, 'sideEffectTools'>> & { sideEffectTools: readonly string[] }
> = {
  mode: 'enforce',
  consecutiveIdenticalThreshold: 4,
  noProgressWindow: 8,
  contentChunkSize: 200,
  contentRepeatThreshold: 8,
  contentWindowMultiplier: 1.5,
  sideEffectTools: [],
  maxStrikes: 2,
};

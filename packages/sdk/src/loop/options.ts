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

/**
 * The LOOSE shape the parsed `loop` config block arrives in. Zod infers every
 * optional field as `T | undefined`, which under `exactOptionalPropertyTypes:
 * true` is a different type from `LoopOptions`'s "key may be absent". This
 * mapped type is that loose shape, named so callers can pass
 * `settings.loop` straight through with no coercion.
 */
export type LoopOptionsInput = {
  [K in keyof LoopOptions]?: LoopOptions[K] | undefined;
};

/**
 * Normalizes a parsed `loop` settings block into an exact `LoopOptions`:
 * every explicitly-`undefined` key is DROPPED, so an absent option stays
 * absent all the way down to the detector.
 *
 * Deliberately does NOT merge `DEFAULT_LOOP_OPTIONS` (the one difference from
 * `buildMicrocompactConfig`): the detector already applies the defaults, and
 * merging here would turn "host configured nothing" into "host configured
 * everything", losing the absent ⇒ absent guarantee the config plumbing is
 * built on. Returns `undefined` when there is nothing to say — no block, or a
 * block with no defined key — so the caller's conditional spread omits the
 * field entirely.
 *
 * Pure: no validation beyond the shape (Zod already validated), no mutation of
 * the input, and `sideEffectTools` is COPIED so the runtime never aliases the
 * caller's array.
 *
 * Spec: specs/2026-08-25-progress-aware-loop-guard-design.md §3.4, §3.6.
 */
export function buildLoopOptions(
  raw: LoopOptionsInput | null | undefined,
): LoopOptions | undefined {
  if (raw === null || raw === undefined) return undefined;
  const out: LoopOptions = {
    ...(raw.mode !== undefined ? { mode: raw.mode } : {}),
    ...(raw.consecutiveIdenticalThreshold !== undefined
      ? { consecutiveIdenticalThreshold: raw.consecutiveIdenticalThreshold }
      : {}),
    ...(raw.noProgressWindow !== undefined ? { noProgressWindow: raw.noProgressWindow } : {}),
    ...(raw.contentChunkSize !== undefined ? { contentChunkSize: raw.contentChunkSize } : {}),
    ...(raw.contentRepeatThreshold !== undefined
      ? { contentRepeatThreshold: raw.contentRepeatThreshold }
      : {}),
    ...(raw.contentWindowMultiplier !== undefined
      ? { contentWindowMultiplier: raw.contentWindowMultiplier }
      : {}),
    ...(raw.sideEffectTools !== undefined ? { sideEffectTools: [...raw.sideEffectTools] } : {}),
    ...(raw.maxStrikes !== undefined ? { maxStrikes: raw.maxStrikes } : {}),
  };
  return Object.keys(out).length === 0 ? undefined : out;
}

// Exact metadata and transport capabilities, not model-name family guessing.
import type { ReasoningEffort } from './effort.js';
import type { ModelRecord } from './models/types.js';
import { RouteError } from './routes/errors.js';

export type ReasoningControl = {
  parameter: 'openrouter' | 'openai' | 'xai';
  efforts: readonly ReasoningEffort[];
  /** off is no-control unless the transport can actually disable reasoning. */
  disableSupported: boolean;
  binary?: boolean;
  maxWireValue?: string;
};
const VERIFIED: Record<string, ReasoningControl> = {
  'xai:grok-4.6': {
    parameter: 'xai',
    efforts: ['off', 'low', 'medium', 'high', 'max'],
    disableSupported: false,
    maxWireValue: 'xhigh',
  },
  'openrouter:x-ai/grok-4.6': {
    parameter: 'openrouter',
    efforts: ['off', 'low', 'medium', 'high', 'max'],
    disableSupported: false,
  },
  'openrouter:moonshotai/kimi-k2.5': {
    parameter: 'openrouter',
    efforts: ['off', 'high'],
    disableSupported: true,
    binary: true,
  },
};

/** Bundled suggestions have no new evidence. Preserve established adapters,
 * while explicit unsupported/unknown discovered metadata stays conservative. */
export function hasReasoningMetadata(metadata: ModelRecord | undefined): boolean {
  return Boolean(
    metadata &&
      !(
        metadata.metadata.source === 'bundled-suggestions' &&
        metadata.capabilities.reasoning === 'unknown'
      ),
  );
}

/** Discovery may advertise reasoning without its depth or disable controls.
 * Such partial evidence must not replace a working established adapter.
 * Explicit unsupported evidence and narrower published controls still win. */
export function preservesEstablishedReasoning(
  metadata: ModelRecord | undefined,
  established: boolean,
): boolean {
  return Boolean(
    established &&
      metadata &&
      (metadata.capabilities.reasoning === 'unknown' ||
        (metadata.capabilities.reasoning === 'supported' &&
          !metadata.efforts?.length &&
          !metadata.reasoningControl)),
  );
}

export function reasoningControlFor(
  provider: string,
  model: string,
  metadata?: ModelRecord,
): ReasoningControl | undefined {
  if (metadata && (metadata.id !== model || metadata.provider !== provider))
    throw new RouteError('effort_unsupported', 'model metadata does not match request');
  if (hasReasoningMetadata(metadata) && metadata) {
    if (metadata.capabilities.reasoning === 'unsupported') return undefined;
    const established = VERIFIED[`${provider}:${model}`];
    if (
      established &&
      (metadata.metadata.stale || (!metadata.efforts?.length && !metadata.reasoningControl))
    )
      return established;
    if (metadata.metadata.stale || metadata.capabilities.reasoning !== 'supported')
      return undefined;
    // Model-specific verified adapter facts remain stricter than generic
    // publisher capability claims (Kimi has a toggle, not four depth levels).
    const advertisedEfforts = metadata.efforts?.length ? metadata.efforts : established?.efforts;
    if (!advertisedEfforts?.length) return undefined;
    const adapterParameter =
      provider === 'openrouter'
        ? 'openrouter'
        : provider === 'xai'
          ? 'xai'
          : provider === 'openai'
            ? 'openai'
            : undefined;
    if (!adapterParameter) return undefined;
    const control = metadata.reasoningControl ??
      established ?? {
        parameter: adapterParameter,
        disableSupported: false,
        ...(provider === 'xai' && advertisedEfforts.includes('max')
          ? { maxWireValue: 'xhigh' }
          : {}),
      };
    if (
      (provider === 'xai' && control.parameter !== 'xai') ||
      (provider === 'openrouter' && control.parameter !== 'openrouter') ||
      (provider === 'openai' && control.parameter !== 'openai') ||
      !['xai', 'openrouter', 'openai'].includes(provider)
    )
      return undefined;
    const efforts = advertisedEfforts.filter(
      (level) => level !== 'off' && (!established || established.efforts.includes(level)),
    );
    return {
      ...control,
      ...(established?.binary ? { binary: true } : {}),
      efforts: ['off', ...efforts],
    };
  }
  return VERIFIED[`${provider}:${model}`];
}

export function modelReasoningParams(
  control: ReasoningControl | undefined,
  effort: ReasoningEffort | undefined,
): { reasoning_effort?: string; reasoning?: { effort: string } | { enabled: boolean } } {
  if (effort === undefined) return {};
  if (!control) {
    if (effort !== 'off')
      throw new RouteError('effort_unsupported', 'reasoning controls are unknown for this model');
    return {};
  }
  if (!control.efforts.includes(effort))
    throw new RouteError(
      'effort_unsupported',
      `effort ${effort} is unsupported by this model transport`,
    );
  if (effort === 'off')
    return control.parameter === 'openrouter' && control.disableSupported
      ? { reasoning: { enabled: false } }
      : {};
  if (control.parameter === 'openrouter')
    return control.binary ? { reasoning: { enabled: true } } : { reasoning: { effort } };
  return { reasoning_effort: effort === 'max' ? (control.maxWireValue ?? 'high') : effort };
}

import { REASONING_EFFORTS } from '../effort.js';
import { fetchModelPages, object, positiveNumber } from './http.js';
import type { ModelDiscoverySource, ModelRecord } from './types.js';

const SOURCE = 'https://openrouter.ai/api/v1/models';
/** Exact IDs are retained. Author prefix is not an inference-host selection. */
export function normalizeOpenRouterModel(value: unknown): ModelRecord | undefined {
  const row = object(value);
  if (typeof row.id !== 'string' || !row.id.trim()) return undefined;
  const architecture = object(row.architecture);
  const input = Array.isArray(architecture.input_modalities)
    ? architecture.input_modalities
    : undefined;
  const output = Array.isArray(architecture.output_modalities)
    ? architecture.output_modalities
    : undefined;
  // Only known text-output models are agent candidates. Unknown modalities remain
  // visible, but never become a claim that a generation-only model is usable.
  if (output && !output.includes('text')) return undefined;
  const parameters = Array.isArray(row.supported_parameters) ? row.supported_parameters : undefined;
  const support = (parameter: string) =>
    parameters
      ? parameters.includes(parameter)
        ? ('supported' as const)
        : ('unsupported' as const)
      : ('unknown' as const);
  const rawPricing = object(row.pricing);
  const price = (key: string) => {
    const value = rawPricing[key];
    if (typeof value !== 'number' && typeof value !== 'string') return undefined;
    if (value === '') return undefined;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number * 1_000_000 : undefined;
  };
  const inputPrice = price('prompt');
  const outputPrice = price('completion');
  const provider = object(row.top_provider);
  const effortValues = Array.isArray(row.reasoning_efforts)
    ? row.reasoning_efforts.filter((value): value is (typeof REASONING_EFFORTS)[number] =>
        REASONING_EFFORTS.includes(value as (typeof REASONING_EFFORTS)[number]),
      )
    : undefined;
  return {
    id: row.id,
    displayName: typeof row.name === 'string' ? row.name : row.id,
    routeId: 'openrouter-api',
    provider: 'openrouter',
    auth: 'api_key',
    author: row.id.includes('/') ? row.id.split('/')[0] : undefined,
    capabilities: {
      textOutput: output ? 'supported' : 'unknown',
      tools: support('tools'),
      images: input ? (input.includes('image') ? 'supported' : 'unsupported') : 'unknown',
      reasoning: support('reasoning'),
    },
    contextWindow: positiveNumber(row.context_length),
    maxOutputTokens: positiveNumber(provider.max_completion_tokens),
    efforts: effortValues?.length ? effortValues : undefined,
    pricing:
      inputPrice !== undefined || outputPrice !== undefined
        ? {
            inputPerMillion: inputPrice,
            outputPerMillion: outputPrice,
            cacheReadPerMillion: price('input_cache_read'),
            cacheWritePerMillion: price('input_cache_write'),
            currency: 'USD',
            source: SOURCE,
            state: inputPrice === 0 && outputPrice === 0 ? 'free' : 'paid',
          }
        : undefined,
    availability: 'advertised',
    metadata: { source: SOURCE, stale: false },
  };
}
export function createOpenRouterModelSource(): ModelDiscoverySource {
  return {
    routeId: 'openrouter-api',
    async discover(options) {
      const rows = await fetchModelPages(SOURCE, options);
      const records = new Map<string, ModelRecord>();
      for (const row of rows) {
        const model = normalizeOpenRouterModel(row);
        if (model) records.set(model.id, model);
      }
      return [...records.values()];
    },
  };
}

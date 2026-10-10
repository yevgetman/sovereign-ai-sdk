import { listRoutes } from '../routes/catalog.js';
import type { ModelCatalog, ModelRecord } from './types.js';

const supports = new Set(['supported', 'unsupported', 'unknown']);
function safeText(value: unknown, max = 4096): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  );
}
function validDate(value: unknown, now: number): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now)
  );
}
/** Untrusted cache/source data cannot grant capabilities on another route. */
export function validateModelRecords(
  value: unknown,
  routeId: string,
  now: number,
): ModelRecord[] | undefined {
  if (!Array.isArray(value) || value.length > 50_000) return undefined;
  const route = listRoutes().find((candidate) => candidate.id === routeId);
  const ids = new Set<string>();
  const result: ModelRecord[] = [];
  for (const row of value) {
    if (
      !row ||
      typeof row !== 'object' ||
      !safeText(row.id) ||
      !safeText(row.displayName) ||
      row.routeId !== routeId ||
      !safeText(row.provider) ||
      !['api_key', 'subscription', 'custom'].includes(row.auth)
    )
      return undefined;
    if (route && (row.provider !== route.provider || row.auth !== route.auth)) return undefined;
    if (ids.has(row.id)) return undefined;
    ids.add(row.id);
    if (
      !row.capabilities ||
      !row.metadata ||
      !safeText(row.metadata.source) ||
      typeof row.metadata.stale !== 'boolean' ||
      !validDate(row.metadata.fetchedAt, now)
    )
      return undefined;
    if (!['advertised', 'account', 'unknown'].includes(row.availability)) return undefined;
    for (const key of ['contextWindow', 'maxOutputTokens']) {
      if (row[key] !== undefined && (!Number.isSafeInteger(row[key]) || row[key] <= 0))
        return undefined;
    }
    if (
      row.efforts !== undefined &&
      (!Array.isArray(row.efforts) ||
        !row.efforts.length ||
        row.efforts.some(
          (effort: unknown) => !['off', 'low', 'medium', 'high', 'max'].includes(String(effort)),
        ))
    )
      return undefined;
    if (row.pricing) {
      if (
        row.pricing.currency !== 'USD' ||
        !safeText(row.pricing.source) ||
        !validDate(row.pricing.fetchedAt, now)
      )
        return undefined;
      for (const key of [
        'inputPerMillion',
        'outputPerMillion',
        'cacheReadPerMillion',
        'cacheWritePerMillion',
      ]) {
        const price = row.pricing[key];
        if (
          price !== undefined &&
          (typeof price !== 'number' || !Number.isFinite(price) || price < 0)
        )
          return undefined;
      }
    }
    for (const key of ['author', 'inferenceHost']) {
      if (row[key] !== undefined && !safeText(row[key])) return undefined;
    }
    const model: ModelRecord = {
      id: row.id,
      displayName: row.displayName,
      routeId,
      provider: row.provider,
      auth: row.auth,
      author: row.author,
      inferenceHost: row.inferenceHost,
      capabilities: {
        textOutput: row.capabilities.textOutput,
        tools: row.capabilities.tools,
        images: row.capabilities.images,
        reasoning: row.capabilities.reasoning,
      },
      contextWindow: row.contextWindow,
      maxOutputTokens: row.maxOutputTokens,
      efforts: row.efforts ? [...row.efforts] : undefined,
      availability: row.availability,
      metadata: {
        source: row.metadata.source,
        fetchedAt: row.metadata.fetchedAt,
        stale: row.metadata.stale,
      },
      pricing: row.pricing
        ? {
            inputPerMillion: row.pricing.inputPerMillion,
            outputPerMillion: row.pricing.outputPerMillion,
            cacheReadPerMillion: row.pricing.cacheReadPerMillion,
            cacheWritePerMillion: row.pricing.cacheWritePerMillion,
            currency: 'USD',
            source: row.pricing.source,
            fetchedAt: row.pricing.fetchedAt,
            state: ['paid', 'free', 'subscription', 'unknown'].includes(row.pricing.state)
              ? row.pricing.state
              : 'unknown',
          }
        : undefined,
    };
    // Recognized additive control fields are kept, arbitrary source fields are not.
    if (row.toolChoices !== undefined) {
      if (
        !Array.isArray(row.toolChoices) ||
        row.toolChoices.some((choice: unknown) => !['auto', 'any', 'tool'].includes(String(choice)))
      )
        return undefined;
      Object.assign(model, { toolChoices: [...row.toolChoices] });
    }
    if (row.reasoningControl !== undefined) {
      const control = row.reasoningControl;
      if (
        !control ||
        !['openrouter', 'openai', 'xai'].includes(control.parameter) ||
        typeof control.disableSupported !== 'boolean' ||
        (control.binary !== undefined && typeof control.binary !== 'boolean') ||
        (control.maxWireValue !== undefined && !safeText(control.maxWireValue))
      )
        return undefined;
      Object.assign(model, {
        reasoningControl: {
          parameter: control.parameter,
          disableSupported: control.disableSupported,
          ...(control.binary === undefined ? {} : { binary: control.binary }),
          ...(control.maxWireValue === undefined ? {} : { maxWireValue: control.maxWireValue }),
        },
      });
    }
    for (const key of ['textOutput', 'tools', 'images', 'reasoning'] as const) {
      if (!supports.has(model.capabilities[key])) model.capabilities[key] = 'unknown';
    }
    result.push(model);
  }
  return result;
}
export function validateModelCatalog(
  value: unknown,
  routeId: string,
  now: number,
): ModelCatalog | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const catalog = value as ModelCatalog;
  if (
    catalog.version !== 1 ||
    catalog.routeId !== routeId ||
    !['current', 'stale', 'unavailable'].includes(catalog.state) ||
    !validDate(catalog.fetchedAt, now)
  )
    return undefined;
  const models = validateModelRecords(catalog.models, routeId, now);
  return models
    ? {
        version: 1,
        routeId,
        state: catalog.state,
        models,
        ...(catalog.fetchedAt ? { fetchedAt: catalog.fetchedAt } : {}),
      }
    : undefined;
}

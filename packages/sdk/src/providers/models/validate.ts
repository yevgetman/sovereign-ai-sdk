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
    const model = structuredClone(row) as ModelRecord;
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
  return models ? { ...catalog, models } : undefined;
}

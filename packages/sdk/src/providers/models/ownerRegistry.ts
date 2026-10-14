// Owner-supplied exact subscription facts. No discovery endpoint or entitlement claim.
import { containsCredentialMaterial } from './subscriptionCatalog.js';
import type { ModelCatalog, ModelRecord } from './types.js';
import { validateModelRecords } from './validate.js';

export function isOwnerGrokModel(model: ModelRecord | undefined, id: string): boolean {
  return Boolean(
    model &&
      model.id === id &&
      model.routeId === 'grok-subscription' &&
      model.provider === 'grok' &&
      model.auth === 'subscription' &&
      model.metadata.ownerManaged === true,
  );
}

/** Registry replacement is complete and atomic; retired rows remain as tombstones. */
export function validateOwnerGrokRegistry(value: unknown, now = Date.now()): ModelCatalog {
  const invalid = () => new Error('Invalid Grok owner model registry. No changes were saved.');
  if (!value || typeof value !== 'object' || containsCredentialMaterial(value)) throw invalid();
  const input = value as ModelCatalog;
  if (
    input.version !== 1 ||
    input.routeId !== 'grok-subscription' ||
    typeof input.fetchedAt !== 'string' ||
    !input.fetchedAt ||
    !Number.isFinite(Date.parse(input.fetchedAt)) ||
    Date.parse(input.fetchedAt) > now ||
    !Array.isArray(input.models) ||
    !input.models.length ||
    input.models.length > 50_000
  )
    throw invalid();
  const prepared = input.models.map((row) => {
    if (
      !row ||
      typeof row !== 'object' ||
      typeof row.id !== 'string' ||
      !/^[\x21-\x7e]{1,200}$/.test(row.id) ||
      !row.metadata?.source ||
      typeof row.metadata.fetchedAt !== 'string' ||
      !row.metadata.fetchedAt ||
      !Number.isFinite(Date.parse(row.metadata.fetchedAt)) ||
      Date.parse(row.metadata.fetchedAt) > now ||
      !row.capabilities ||
      typeof row.capabilities !== 'object' ||
      Array.isArray(row.capabilities) ||
      Object.values(row.capabilities).some(
        (value) => !['supported', 'unsupported', 'unknown'].includes(value),
      ) ||
      ['textOutput', 'tools', 'images', 'reasoning'].some((key) => !(key in row.capabilities)) ||
      (row.metadata.retired !== undefined && typeof row.metadata.retired !== 'boolean') ||
      (row.efforts !== undefined && !Array.isArray(row.efforts)) ||
      row.efforts?.some((effort) => !['low', 'medium', 'high', 'max'].includes(effort)) ||
      (row.efforts && row.capabilities.reasoning !== 'supported') ||
      (row.contextWindow !== undefined &&
        row.maxOutputTokens !== undefined &&
        row.maxOutputTokens > row.contextWindow) ||
      row.pricing ||
      row.reasoningControl
    )
      throw invalid();
    return {
      ...row,
      metadata: { ...row.metadata, stale: false, ownerManaged: true },
      ...(row.efforts?.length
        ? {
            reasoningControl: {
              parameter: 'grok' as const,
              disableSupported: false,
              maxWireValue: 'xhigh',
            },
          }
        : {}),
    };
  });
  const models = validateModelRecords(prepared, 'grok-subscription', now);
  if (!models) throw invalid();
  return presentOwnerGrokRegistry(
    {
      version: 1,
      routeId: 'grok-subscription',
      state: 'current',
      fetchedAt: input.fetchedAt,
      models,
    },
    now,
  );
}

/** Freshness is advisory for explicit owner facts, but remains visible per row. */
export function presentOwnerGrokRegistry(catalog: ModelCatalog, now = Date.now()): ModelCatalog {
  const catalogStale = !catalog.fetchedAt || now - Date.parse(catalog.fetchedAt) >= 3_600_000;
  const models = catalog.models.map((model) => ({
    ...model,
    metadata: {
      ...model.metadata,
      stale:
        catalogStale ||
        !model.metadata.fetchedAt ||
        now - Date.parse(model.metadata.fetchedAt) >= 3_600_000,
    },
  }));
  return {
    ...catalog,
    state: models.some((model) => model.metadata.stale) ? 'stale' : 'current',
    models,
  };
}

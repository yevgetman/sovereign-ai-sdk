// Pure owner-model identity policy. No runtime catalog or route dependencies.
import type { ModelRecord } from './types.js';

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

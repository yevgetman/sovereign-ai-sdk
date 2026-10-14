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

export function isOwnerChatGptModel(model: ModelRecord | undefined, id: string): boolean {
  return Boolean(
    model &&
      model.id === id &&
      model.routeId === 'chatgpt-subscription' &&
      model.provider === 'chatgpt' &&
      model.auth === 'subscription' &&
      model.metadata.ownerManaged === true,
  );
}
export function isOwnerSubscriptionModel(model: ModelRecord | undefined, id: string): boolean {
  return isOwnerGrokModel(model, id) || isOwnerChatGptModel(model, id);
}

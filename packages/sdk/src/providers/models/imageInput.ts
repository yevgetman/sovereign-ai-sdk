import { RouteError } from '../routes/errors.js';
import type { ProviderRequest } from '../types.js';
import type { ImageInputCertification, ModelRecord } from './types.js';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES_BYTES = 40 * 1024 * 1024;

/** Cache/registry data cannot copy a certificate to another exact route or model. */
export function parseImageInputCertification(
  value: unknown,
  routeId: string,
  modelId: string,
  now: number,
): ImageInputCertification | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (
    row.routeId !== routeId ||
    row.modelId !== modelId ||
    typeof row.source !== 'string' ||
    row.source.length > 2048 ||
    !/^https:\/\/[^\s]+$/.test(row.source) ||
    typeof row.verifiedAt !== 'string' ||
    typeof row.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(row.verifiedAt)) ||
    !Number.isFinite(Date.parse(row.expiresAt)) ||
    Date.parse(row.verifiedAt) > now ||
    Date.parse(row.expiresAt) <= Date.parse(row.verifiedAt) ||
    !['passed', 'failed', 'unverified'].includes(String(row.liveVerification)) ||
    !Array.isArray(row.mimeTypes) ||
    !row.mimeTypes.length ||
    row.mimeTypes.length > IMAGE_TYPES.length ||
    row.mimeTypes.some(
      (mime: unknown) => typeof mime !== 'string' || !IMAGE_TYPES.includes(mime),
    ) ||
    new Set(row.mimeTypes).size !== row.mimeTypes.length
  )
    return undefined;
  return {
    routeId,
    modelId,
    source: row.source,
    verifiedAt: row.verifiedAt,
    expiresAt: row.expiresAt,
    liveVerification: row.liveVerification as ImageInputCertification['liveVerification'],
    mimeTypes: [...row.mimeTypes] as string[],
  };
}

export function verifiedSubscriptionImageInput(
  model: ModelRecord | undefined,
  now = Date.now(),
): ImageInputCertification | undefined {
  if (
    !model ||
    model.auth !== 'subscription' ||
    model.metadata.stale ||
    model.metadata.retired ||
    model.capabilities.images !== 'supported' ||
    !['grok-subscription', 'chatgpt-subscription'].includes(model.routeId)
  )
    return undefined;
  const proof = parseImageInputCertification(
    model.imageInputCertification,
    model.routeId,
    model.id,
    now,
  );
  return proof?.liveVerification === 'passed' && Date.parse(proof.expiresAt) > now
    ? proof
    : undefined;
}

/** Subscription images require both exact live proof and bounded safe serialization. */
export function validateSubscriptionImageInput(req: ProviderRequest, model?: ModelRecord): void {
  const proof = verifiedSubscriptionImageInput(model);
  if (!proof)
    throw new RouteError(
      'unsupported_input',
      'Image input for this exact subscription model is not live-certified or its evidence is stale.',
    );
  let count = 0;
  let total = 0;
  for (const message of req.messages)
    for (const block of message.content) {
      if (block.type !== 'image') continue;
      if (!block.source || typeof block.source.data !== 'string')
        throw new RouteError('unsupported_input', 'Subscription image source is invalid.');
      const data = block.source.data;
      const bytes =
        Math.floor(data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
      count++;
      total += bytes;
      if (
        message.role !== 'user' ||
        !proof.mimeTypes.includes(block.source.media_type) ||
        !data.length ||
        data.length % 4 !== 0 ||
        bytes < 1 ||
        bytes > MAX_IMAGE_BYTES ||
        count > 10 ||
        total > MAX_IMAGES_BYTES ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
      )
        throw new RouteError(
          'unsupported_input',
          'Subscription image input exceeds verified type or attachment limits.',
        );
    }
}

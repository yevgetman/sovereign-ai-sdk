import { RouteError } from '../routes/errors.js';
import type { ProviderRequest } from '../types.js';
import { grokSubscriptionPin } from './grokPin.js';
import { isOwnerGrokModel, isOwnerSubscriptionModel } from './ownerModelPolicy.js';
import type { ImageInputCertification, ModelRecord } from './types.js';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES_BYTES = 40 * 1024 * 1024;

/** Evidence is also displayed in operator terminals; reject invisible controls. */
function safeEvidenceText(value: unknown, max = 2048): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    ![...value].some((char) => {
      const code = char.charCodeAt(0);
      return (
        code < 32 ||
        (code >= 127 && code <= 159) ||
        code === 0x061c ||
        code === 0x200e ||
        code === 0x200f ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
      );
    })
  );
}

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
    !safeEvidenceText(row.routeId) ||
    !safeEvidenceText(row.modelId, 4096) ||
    row.routeId !== routeId ||
    row.modelId !== modelId ||
    !safeEvidenceText(row.source) ||
    !/^https:\/\/[^\s]+$/.test(row.source) ||
    !safeEvidenceText(row.verifiedAt, 128) ||
    !safeEvidenceText(row.expiresAt, 128) ||
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
  const owner = model && isOwnerSubscriptionModel(model, model.id);
  const independent =
    model && isOwnerGrokModel(model, model.id) && model.id === 'grok-4.7'
      ? grokSubscriptionPin('grok-4.7')
      : undefined;
  if (
    !model ||
    model.auth !== 'subscription' ||
    (model.metadata.stale && !owner) ||
    model.metadata.retired ||
    model.capabilities.images !== 'supported' ||
    !['grok-subscription', 'chatgpt-subscription'].includes(model.routeId)
  )
    return undefined;
  const proof = parseImageInputCertification(
    model.imageInputCertification === undefined
      ? independent?.imageInputCertification
      : model.imageInputCertification,
    model.routeId,
    model.id,
    now,
  );
  return proof?.liveVerification === 'passed' && Date.parse(proof.expiresAt) > now
    ? proof
    : undefined;
}

/** Show independent transport proof without changing owner capability/provenance facts. */
export function effectiveSubscriptionImageModel(model: ModelRecord, now = Date.now()): ModelRecord {
  if (model.imageInputCertification !== undefined) return model;
  const proof = verifiedSubscriptionImageInput(model, now);
  return proof ? { ...model, imageInputCertification: proof } : model;
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

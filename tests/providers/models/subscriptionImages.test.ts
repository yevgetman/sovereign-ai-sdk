import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { findModel } from '../../../packages/sdk/src/providers/models/catalog.js';
import { grokSubscriptionPin } from '../../../packages/sdk/src/providers/models/grokPin.js';
import { verifiedSubscriptionImageInput } from '../../../packages/sdk/src/providers/models/imageInput.js';
import {
  presentOwnerSubscriptionRegistry,
  validateOwnerGrokRegistry,
} from '../../../packages/sdk/src/providers/models/ownerRegistry.js';
import type { ModelRecord } from '../../../packages/sdk/src/providers/models/types.js';
import { validateModelRecords } from '../../../packages/sdk/src/providers/models/validate.js';
import { validateModelRequest } from '../../../packages/sdk/src/providers/models/validateRequest.js';
import { responsesInput } from '../../../packages/sdk/src/providers/responses.js';
import { routeSupportsImages } from '../../../packages/sdk/src/providers/routes/catalog.js';
import type { ProviderRequest } from '../../../packages/sdk/src/providers/types.js';
import { modelPage } from '../../../src/cli/modelDiscovery.js';
import { modelDetails } from '../../../src/config/modelSuggestions.js';

let clock: ReturnType<typeof spyOn<typeof Date, 'now'>>;
beforeEach(() => {
  clock = spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-14T18:00:00.000Z'));
});
afterEach(() => clock.mockRestore());

function request(media = 'image/png'): ProviderRequest {
  return {
    model: 'grok-4.7',
    system: [],
    maxTokens: 64,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: media, data: 'Zml4dHVyZQ==' } },
        ],
      },
    ],
  };
}

test('live-certified exact grok-4.7 PNG is admitted while other subscription models remain fenced', () => {
  expect(routeSupportsImages('grok-subscription')).toBe(true);
  expect(() =>
    validateModelRequest(request(), 'grok', grokSubscriptionPin('grok-4.7')),
  ).not.toThrow();
  expect(() =>
    validateModelRequest(
      { ...request(), model: 'grok-4.6' },
      'grok',
      grokSubscriptionPin('grok-4.6'),
    ),
  ).toThrow();
  expect(() => validateModelRequest(request(), 'grok')).toThrow();
  expect(() => validateModelRequest({ ...request(), model: 'gpt-5.3-codex' }, 'chatgpt')).toThrow();
  expect(modelDetails(grokSubscriptionPin('grok-4.7'))).toContain('live-certified grok-4.7');
  expect(modelDetails(grokSubscriptionPin('grok-4.6'))).toContain('certification unavailable');
});

test('certificate is exact, fresh, live-proven and MIME-specific', () => {
  const pin = grokSubscriptionPin('grok-4.7');
  expect(() => validateModelRequest(request('image/jpeg'), 'grok', pin)).not.toThrow();
  for (const mime of ['image/gif', 'image/webp', 'text/html'])
    expect(() => validateModelRequest(request(mime), 'grok', pin)).toThrow();
  const certificate = (pin as ModelRecord & { imageInputCertification?: Record<string, unknown> })
    .imageInputCertification;
  expect(certificate).toBeDefined();
  for (const change of [
    { modelId: 'grok-4.6' },
    { routeId: 'grok-api' },
    { liveVerification: 'unverified' },
    { expiresAt: '2026-10-14T17:30:00.000Z' },
    { verifiedAt: '2999-01-01T00:00:00.000Z' },
  ]) {
    const model = { ...pin, imageInputCertification: { ...certificate, ...change } } as ModelRecord;
    expect(() => validateModelRequest(request(), 'grok', model)).toThrow();
  }
  expect(() =>
    validateModelRequest(request(), 'grok', { ...pin, metadata: { ...pin.metadata, stale: true } }),
  ).toThrow();
});

test('catalog validator preserves exact certification and rejects copied or secret-bearing evidence', () => {
  const pin = grokSubscriptionPin('grok-4.7');
  const verified = validateModelRecords([pin], 'grok-subscription', Date.now());
  expect(verified?.[0]).toEqual(pin);
  expect(
    (verified?.[0] as ModelRecord & { imageInputCertification?: unknown }).imageInputCertification,
  ).toBeDefined();
  const certificate = (pin as ModelRecord & { imageInputCertification?: Record<string, unknown> })
    .imageInputCertification;
  expect(
    validateModelRecords(
      [{ ...pin, imageInputCertification: { ...certificate, modelId: 'different' } }],
      'grok-subscription',
      Date.now(),
    ),
  ).toBeUndefined();
  const extra = validateModelRecords(
    [{ ...pin, imageInputCertification: { ...certificate, accessToken: 'never-retain' } }],
    'grok-subscription',
    Date.now(),
  );
  expect(JSON.stringify(extra)).not.toContain('never-retain');
});

test('certificate text rejects terminal controls, bidi controls and control-bearing dates', () => {
  const pin = grokSubscriptionPin('grok-4.7');
  const proof = pin.imageInputCertification;
  for (const change of [
    { source: 'https://docs.x.ai/path\u001b]52;c;AAAA\u0007' },
    { source: 'https://docs.x.ai/path\u009b31m' },
    { source: 'https://docs.x.ai/path\u202eexample' },
    { source: 'https://docs.x.ai/path\u2066example' },
    { verifiedAt: 'October 14, 2026\n17:16:08 UTC' },
    { expiresAt: 'November 13, 2026\n17:16:08 UTC' },
  ]) {
    const model = { ...pin, imageInputCertification: { ...proof, ...change } } as ModelRecord;
    expect(validateModelRecords([model], 'grok-subscription', Date.now())).toBeUndefined();
    expect(verifiedSubscriptionImageInput(model)).toBeUndefined();
    expect(modelDetails(model)).toContain('certification unavailable');
  }
});

test('certified serializer preserves multiple images across tool continuation without diagnostics', () => {
  const req = request();
  req.messages[0]?.content.push(
    { type: 'text', text: 'inspect both' },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'Zml4dHVyZQ==' } },
  );
  req.messages.push(
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'done' }] },
  );
  validateModelRequest(req, 'grok', grokSubscriptionPin('grok-4.7'));
  const items = responsesInput(req) as {
    type: string;
    content?: { type: string; image_url?: string }[];
  }[];
  expect(items[0]?.content?.filter((block) => block.type === 'input_image')).toEqual([
    { type: 'input_image', image_url: 'data:image/png;base64,Zml4dHVyZQ==' },
    { type: 'input_image', image_url: 'data:image/jpeg;base64,Zml4dHVyZQ==' },
  ]);
  expect(items.map((item) => item.type)).toEqual([
    'message',
    'function_call',
    'function_call_output',
  ]);
  for (const data of ['bad!data', '', 'a=', 'Zml4dHVyZQ==\n']) {
    const bad = request();
    const block = bad.messages[0]?.content[0];
    if (block?.type === 'image') block.source.data = data;
    expect(() => validateModelRequest(bad, 'grok', grokSubscriptionPin('grok-4.7'))).toThrow();
  }
});

test('subscription attachment count and decoded byte budgets remain bounded', () => {
  const overCount = request();
  const image = overCount.messages[0]?.content[0];
  if (!image) throw Error('missing image');
  overCount.messages[0]?.content.push(...Array(10).fill(image));
  expect(() => validateModelRequest(overCount, 'grok', grokSubscriptionPin('grok-4.7'))).toThrow();
  const large = request();
  const block = large.messages[0]?.content[0];
  if (block?.type !== 'image') throw Error('missing image');
  block.source.data = 'AAAA'.repeat(Math.ceil((20 * 1024 * 1024) / 3) + 1);
  expect(() => validateModelRequest(large, 'grok', grokSubscriptionPin('grok-4.7'))).toThrow();
  block.source.data = 'AAAA'.repeat(6 * 1024 * 1024);
  large.messages[0]?.content.push(block, block);
  expect(() => validateModelRequest(large, 'grok', grokSubscriptionPin('grok-4.7'))).toThrow();
});

test('legacy owner rows use independent exact transport proof and advisory metadata age', () => {
  const pin = grokSubscriptionPin('grok-4.7');
  const { imageInputCertification, reasoningControl, ...legacy } = pin;
  if (!imageInputCertification) throw Error('missing exact live proof');
  const now = Date.now();
  const register = (row: ModelRecord) =>
    validateOwnerGrokRegistry(
      {
        version: 1,
        routeId: 'grok-subscription',
        state: 'current',
        fetchedAt: new Date(now).toISOString(),
        models: [
          {
            ...row,
            metadata: {
              ...row.metadata,
              source: 'owner-reviewed',
              fetchedAt: new Date(now).toISOString(),
            },
          },
        ],
      },
      now,
    );
  const registered = register(legacy);
  const owner = registered.models[0];
  if (!owner) throw Error('missing owner row');
  expect(owner?.imageInputCertification).toBeUndefined();
  expect(verifiedSubscriptionImageInput(owner, now)).toBeDefined();
  expect(findModel(registered, 'grok-4.7').imageInputCertification).toEqual(
    imageInputCertification,
  );
  expect(
    modelPage(registered, { route: 'grok-subscription' }).models[0]?.imageInputCertification,
  ).toEqual(imageInputCertification);
  if (owner) expect(modelDetails(owner)).toContain('live-certified grok-4.7');
  if (owner) expect(modelDetails(owner)).toContain(`source:${imageInputCertification?.source}`);
  const aged = presentOwnerSubscriptionRegistry(
    register({ ...legacy, imageInputCertification }),
    now + 3600001,
  ).models[0];
  expect(aged?.metadata.stale).toBe(true);
  expect(verifiedSubscriptionImageInput(aged, now + 3600001)).toBeDefined();
  const unknown = register({
    ...legacy,
    capabilities: { ...legacy.capabilities, images: 'unknown' },
  }).models[0];
  expect(unknown?.capabilities.images).toBe('unknown');
  expect(() => validateModelRequest(request(), 'grok', unknown)).toThrow();
  for (const change of [
    { metadata: { ...owner?.metadata, retired: true } },
    { capabilities: { ...pin.capabilities, images: 'unsupported' as const } },
    {
      imageInputCertification: { ...imageInputCertification, liveVerification: 'failed' as const },
    },
    {
      imageInputCertification: {
        ...imageInputCertification,
        liveVerification: 'unverified' as const,
      },
    },
    {
      imageInputCertification: {
        ...imageInputCertification,
        expiresAt: '2026-10-14T17:30:00.000Z',
      },
    },
  ])
    expect(
      verifiedSubscriptionImageInput({ ...owner, ...change } as ModelRecord, now),
    ).toBeUndefined();
  expect(verifiedSubscriptionImageInput({ ...owner, id: 'grok-future' }, now)).toBeUndefined();
});

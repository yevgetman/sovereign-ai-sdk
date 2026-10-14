import { createHash } from 'node:crypto';
import { getEncoding } from 'js-tiktoken';
import type { RequestInputTokenEstimate } from './modelLimits.js';
import { requestInputTokenEstimate } from './modelLimits.js';
import { messagesToOpenAI } from './openai.js';
import { responsesInput, responsesTools } from './responses.js';
import type { ProviderRequest } from './types.js';

export type InputTokenAccounting = (request: ProviderRequest) => RequestInputTokenEstimate;
const encoders = new Map<string, ReturnType<typeof getEncoding>>();
// Hash-only bounded cache: repeated Kernel framing does not repeat BPE work,
// and no prompt text is retained by this cache.
const chunkCounts = new Map<string, number>();
const NATIVE = new Set(['openai', 'chatgpt', 'grok', 'xai', 'anthropic', 'openrouter']);

/** Published OpenAI mapping, deliberately not inferred for Grok/Claude or custom models.
 * https://github.com/openai/tiktoken/blob/main/tiktoken/model.py */
function encodingFor(provider: string, model: string): 'o200k_base' | 'cl100k_base' | undefined {
  let modelId = model;
  if (provider === 'openrouter') {
    if (!model.startsWith('openai/')) return undefined;
    modelId = model.slice('openai/'.length);
  } else if (provider !== 'openai' && provider !== 'chatgpt') return undefined;
  if (/^(gpt-5|gpt-4o|gpt-4\.1|gpt-4\.5|chatgpt-4o|o1($|-)|o3($|-)|o4-mini($|-))/.test(modelId))
    return 'o200k_base';
  if (/^(gpt-4($|-)|gpt-3\.5-turbo($|-))/.test(modelId)) return 'cl100k_base';
  return undefined;
}

/** One synchronous accounting port for admission, compaction and diagnostics.
 * No credentials/network. Unknown tokenizer/modalities remain advisory: never
 * reject or buy a summary solely because the UTF-8 upper bound is large. */
export function modelInputTokenAccounting(provider: string): InputTokenAccounting {
  return (request) => {
    const uncounted = new Set<string>();
    let images = 0;
    const messages = request.messages.map((message) => ({
      ...message,
      content: message.content.filter((block) => {
        if (block.type === 'image') {
          images++;
          uncounted.add('image');
          return false;
        }
        if (block.type === 'encrypted_reasoning' || block.type === 'redacted_thinking') {
          uncounted.add(block.type);
          return false;
        }
        return true;
      }),
    }));
    const safe = { ...request, messages };
    const encoding = encodingFor(provider, request.model);
    if (!encoding) {
      const bound = requestInputTokenEstimate(messages, request.system, request.tools);
      return {
        ...bound,
        uncountedImages: images,
        conservativeTokens: bound.tokens,
        source: `${provider}/${request.model}:utf8-upper-bound`,
        version: '1',
        complete: !NATIVE.has(provider) && uncounted.size === 0,
        enforce: !NATIVE.has(provider),
        uncountedModalities: [...uncounted, ...(NATIVE.has(provider) ? ['tokenizer'] : [])],
      };
    }
    // Count the serializer's structure, schemas, arguments and tool results,
    // not internal message IDs/host fields or base64 transport representations.
    const wire =
      provider === 'chatgpt'
        ? {
            instructions:
              request.system
                .map((segment) => segment.text)
                .join('\n')
                .trim() || 'You are a helpful assistant.',
            input: responsesInput(safe),
            tools: responsesTools(request.tools),
          }
        : {
            messages: messagesToOpenAI(messages, request.system),
            tools: request.tools?.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.input_schema,
              },
            })),
          };
    let encoder = encoders.get(encoding);
    if (!encoder) {
      encoder = getEncoding(encoding);
      encoders.set(encoding, encoder);
    }
    // Special-looking user strings are ordinary text, never tokenizer control.
    const serialized = JSON.stringify(wire);
    let measuredTokens = 0;
    // Bound BPE work on pathological repeated strings. Encoding independent
    // chunks may add boundary tokens, so this remains a conservative wire
    // estimate rather than a claim of exact provider input usage.
    for (let offset = 0; offset < serialized.length; offset += 1024) {
      const chunk = serialized.slice(offset, offset + 1024);
      const key = `${encoding}:${createHash('sha256').update(chunk).digest('hex')}`;
      let count = chunkCounts.get(key);
      if (count === undefined) {
        count = encoder.encode(chunk, [], []).length;
        if (chunkCounts.size >= 512) chunkCounts.delete(chunkCounts.keys().next().value as string);
        chunkCounts.set(key, count);
      }
      measuredTokens += count;
    }
    // Local wire-token measurement is not exact provider usage. Keep framing
    // headroom explicit and retain the bounded upstream-overflow recovery.
    const conservativeTokens =
      measuredTokens + 256 + messages.length * 16 + (request.tools?.length ?? 0) * 64;
    return {
      tokens: conservativeTokens,
      measuredTokens,
      conservativeTokens,
      complete: uncounted.size === 0,
      enforce: uncounted.size === 0,
      uncountedImages: images,
      uncountedModalities: [...uncounted],
      source: `${provider}/${request.model}:js-tiktoken/${encoding}:chunked-wire-estimate`,
      version: '1.0.21/framing-1',
    };
  };
}

/** Preserve the legacy numeric host-counter contract without claiming a
 * numeric value is a measured complete multimodal request. */
export function legacyInputTokenAccounting(tokens: number): RequestInputTokenEstimate {
  return {
    tokens,
    conservativeTokens: tokens,
    complete: true,
    enforce: true,
    uncountedImages: 0,
    uncountedModalities: [],
    source: 'host-numeric-counter',
    version: 'legacy',
  };
}

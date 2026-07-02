// Provider preflight checks. These run before a session starts real work so
// obvious credential, quota, or transport blockers fail before tool mutations.

import type { Message, SystemSegment } from '../core/types.js';
import {
  ProviderHttpError,
  isBillingExhausted,
  isCredentialUnavailable,
  isRateLimited,
} from './errors.js';
import type { LLMProvider } from './types.js';

export type ProviderPreflightKind =
  | 'credential'
  | 'billing'
  | 'rate_limit'
  | 'tool_support'
  | 'provider'
  | 'aborted'
  | 'unknown';

export type ProviderPreflightResult =
  | { ok: true }
  | { ok: false; kind: ProviderPreflightKind; message: string };

export async function preflightProvider(opts: {
  provider: LLMProvider;
  providerName: string;
  model: string;
  signal?: AbortSignal;
}): Promise<ProviderPreflightResult> {
  const system: SystemSegment[] = [
    {
      text: 'Provider health preflight. Reply briefly with OK.',
      cacheable: false,
    },
  ];
  const messages: Message[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: 'OK' }],
    },
  ];

  try {
    const stream = opts.provider.stream({
      model: opts.model,
      system,
      messages,
      maxTokens: 8,
      cacheEnabled: false,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    for await (const _event of stream) {
      // Drain the stream. The content is intentionally ignored.
    }
    return { ok: true };
  } catch (err) {
    return classifyProviderPreflightError(opts.providerName, opts.model, err);
  }
}

export async function preflightToolCalling(opts: {
  provider: LLMProvider;
  providerName: string;
  model: string;
  signal?: AbortSignal;
}): Promise<ProviderPreflightResult> {
  const system: SystemSegment[] = [
    {
      text: 'Provider tool-capability preflight. Reply briefly with OK.',
      cacheable: false,
    },
  ];
  const messages: Message[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: 'OK' }],
    },
  ];

  try {
    const stream = opts.provider.stream({
      model: opts.model,
      system,
      messages,
      maxTokens: 8,
      cacheEnabled: false,
      tools: [
        {
          name: 'preflight_noop',
          description: 'No-op tool used only to verify provider tool-call support.',
          input_schema: {
            type: 'object',
            additionalProperties: false,
            properties: {},
          },
        },
      ],
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    for await (const _event of stream) {
      // Drain the stream. The content is intentionally ignored.
    }
    return { ok: true };
  } catch (err) {
    return classifyProviderPreflightError(opts.providerName, opts.model, err);
  }
}

export function classifyProviderPreflightError(
  providerName: string,
  model: string,
  err: unknown,
): ProviderPreflightResult {
  const raw = err instanceof Error ? err.message : String(err);
  const message = raw || 'unknown provider preflight failure';
  if (err instanceof DOMException && err.name === 'AbortError') {
    return {
      ok: false,
      kind: 'aborted',
      message: `${providerName}/${model} preflight was aborted`,
    };
  }
  if (isBillingExhausted(err)) {
    return {
      ok: false,
      kind: 'billing',
      message: `${providerName}/${model} preflight failed: billing or credit balance is exhausted. ${message}`,
    };
  }
  if (isCredentialUnavailable(err)) {
    return {
      ok: false,
      kind: 'credential',
      message: `${providerName}/${model} preflight failed: credential is missing, invalid, or unauthorized. ${message}`,
    };
  }
  if (isRateLimited(err)) {
    return {
      ok: false,
      kind: 'rate_limit',
      message: `${providerName}/${model} preflight failed: provider is rate limited. ${message}`,
    };
  }
  if (isToolSupportError(message)) {
    return {
      ok: false,
      kind: 'tool_support',
      message: `${providerName}/${model} preflight failed: this model does not support tool calls. Choose a tool-capable model or start a no-tools conversational session. ${message}`,
    };
  }
  if (err instanceof ProviderHttpError) {
    return {
      ok: false,
      kind: 'provider',
      message: `${providerName}/${model} preflight failed with HTTP ${err.status}. ${message}`,
    };
  }
  return {
    ok: false,
    kind: 'unknown',
    message: `${providerName}/${model} preflight failed. ${message}`,
  };
}

function isToolSupportError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('does not support tools') ||
    lower.includes('tools are not supported') ||
    lower.includes('tool calls are not supported') ||
    lower.includes('does not support tool')
  );
}

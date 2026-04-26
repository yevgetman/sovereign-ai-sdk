// Purpose-aware auxiliary provider chain. Compression/title/web extraction
// can use cheap providers without changing the main chat provider.

import {
  NoAuxiliaryAvailableError,
  isBillingExhausted,
  isCredentialUnavailable,
} from './errors.js';
import { type ResolvedProvider, resolveProvider } from './resolver.js';

export type AuxiliaryPurpose = 'compression' | 'title' | 'web-extract';

const AUXILIARY_CHAINS: Record<AuxiliaryPurpose, Array<[string, string]>> = {
  compression: [
    ['openrouter', 'anthropic/claude-haiku-4.5'],
    ['anthropic', 'claude-haiku-4-5-20251001'],
    ['openai', 'gpt-4o-mini'],
    ['ollama', 'qwen2.5:3b'],
  ],
  title: [
    ['openrouter', 'anthropic/claude-haiku-4.5'],
    ['anthropic', 'claude-haiku-4-5-20251001'],
    ['openai', 'gpt-4o-mini'],
    ['ollama', 'qwen2.5:3b'],
  ],
  'web-extract': [
    ['openrouter', 'anthropic/claude-haiku-4.5'],
    ['anthropic', 'claude-haiku-4-5-20251001'],
    ['openai', 'gpt-4o-mini'],
    ['ollama', 'qwen2.5:3b'],
  ],
};

export function auxiliaryClient(purpose: AuxiliaryPurpose): ResolvedProvider {
  for (const [provider, model] of AUXILIARY_CHAINS[purpose]) {
    try {
      return resolveProvider(provider, model, { purpose });
    } catch (err) {
      if (isCredentialUnavailable(err) || isBillingExhausted(err)) continue;
      throw err;
    }
  }
  throw new NoAuxiliaryAvailableError(purpose);
}

export function gracefulAuxiliaryFallback(purpose: AuxiliaryPurpose): string {
  if (purpose === 'title') return 'skip title generation';
  if (purpose === 'web-extract') return 'return raw search/extract results';
  return 'compression unavailable — truncating';
}

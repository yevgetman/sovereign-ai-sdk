// Small built-in model registry. Resolver uses this for defaults and context
// lengths until config-driven/provider-discovered registries become necessary.

export type ProviderRegistryEntry = {
  provider: string;
  apiMode: 'anthropic' | 'openai' | 'ollama' | 'sov' | 'router';
  defaultModel: string;
  defaultBaseUrl: string;
  authEnvVar?: string;
  contextLength: number;
};

export const PROVIDER_REGISTRY: Record<string, ProviderRegistryEntry> = {
  anthropic: {
    provider: 'anthropic',
    apiMode: 'anthropic',
    defaultModel: 'claude-haiku-4-5-20251001',
    defaultBaseUrl: 'https://api.anthropic.com',
    authEnvVar: 'ANTHROPIC_API_KEY',
    contextLength: 200_000,
  },
  openai: {
    provider: 'openai',
    apiMode: 'openai',
    defaultModel: 'gpt-4o-mini',
    defaultBaseUrl: 'https://api.openai.com/v1',
    authEnvVar: 'OPENAI_API_KEY',
    contextLength: 128_000,
  },
  openrouter: {
    provider: 'openrouter',
    apiMode: 'openai',
    defaultModel: 'anthropic/claude-haiku-4.5',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    authEnvVar: 'OPENROUTER_API_KEY',
    contextLength: 200_000,
  },
  ollama: {
    provider: 'ollama',
    apiMode: 'ollama',
    defaultModel: 'qwen2.5:3b',
    defaultBaseUrl: 'http://localhost:11434',
    contextLength: 32_768,
  },
  // The local Sovereign L1 engine: a standalone OpenAI-compatible MLX server
  // on loopback. Keyless (no authEnvVar) — mirrors ollama's posture. The
  // engine advertises models under their real id (served-model-name defaults
  // to the model id itself, no alias), so defaultModel is the real model id.
  sov: {
    provider: 'sov',
    apiMode: 'sov',
    defaultModel: 'mlx-community/Qwen3-4B-4bit',
    defaultBaseUrl: 'http://127.0.0.1:8000/v1',
    contextLength: 32_768,
  },
  // The model-router organ's lane (apiMode 'router'): a generic OpenAI-compatible
  // routing proxy the caller asks with model `auto`, letting the router pick the
  // upstream. The current binding is a self-hosted Manifest instance on the
  // loopback default; keyed (mnfst_ key required, unlike the keyless sov lane).
  // contextLength 128k is a deliberate CONSERVATIVE FLOOR — the routed upstream
  // is unknown with model `auto`, so compaction math needs *a* number; pinning
  // providers.manifest.model to a real model id restores the exact MODEL_CONTEXT
  // lookup.
  manifest: {
    provider: 'manifest',
    apiMode: 'router',
    defaultModel: 'auto',
    defaultBaseUrl: 'http://localhost:2099/v1',
    authEnvVar: 'MANIFEST_API_KEY',
    contextLength: 128_000,
  },
};

const MODEL_CONTEXT: Record<string, number> = {
  'claude-sonnet-4-6': 200_000,
  'claude-opus-4-7': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
  'claude-3-5-haiku-latest': 200_000,
  'claude-3-5-haiku-20241022': 200_000,
  'anthropic/claude-haiku-4.5': 200_000,
  'anthropic/claude-haiku-4.5-20251001': 200_000,
  'anthropic/claude-3.5-haiku': 200_000,
  'anthropic/claude-3-5-haiku': 200_000,
  'gpt-4o-mini': 128_000,
  'gpt-4o': 128_000,
  'qwen2.5:3b': 32_768,
  'qwen2.5:7b': 32_768,
  'qwen2.5:14b': 32_768,
  'qwen2.5:32b': 32_768,
  'llama3.1:8b': 128_000,
  'llama3.1:70b': 128_000,
  'mistral-nemo': 128_000,
};

export function contextLengthFor(provider: string, model: string): number {
  return MODEL_CONTEXT[model] ?? PROVIDER_REGISTRY[provider]?.contextLength ?? 32_768;
}

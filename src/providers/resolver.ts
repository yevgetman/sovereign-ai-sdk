// Unified provider resolver. Every surface should come through here so model
// aliases, base URLs, credential selection, and rate-limit guard behavior do
// not fork across CLI/gateway/cron/API server.

import { join } from 'node:path';
import { loadSettings } from '../config/loader.js';
import type { ProviderConfig, Settings } from '../config/schema.js';
import type { AssistantMessage, Message, StreamEvent, SystemSegment } from '../core/types.js';
import { AnthropicProvider } from './anthropic.js';
import {
  type CredentialInput,
  CredentialPool,
  type CredentialStrategy,
} from './credentials/pool.js';
import { RateLimitGuard } from './credentials/rateGuard.js';
import { CredentialUnavailableError, ProviderHttpError, isRateLimited } from './errors.js';
import { MockProvider } from './mock.js';
import { PROVIDER_REGISTRY, contextLengthFor } from './models.js';
import { OllamaProvider } from './ollama.js';
import { OpenAIProvider } from './openai.js';
import { SovProvider } from './sov.js';
import type { AuthType, ProviderRequest, ToolSchema, Transport } from './types.js';

/** Call-site purpose used for auxiliary fallback and provider metadata. */
export type ProviderPurpose = 'main' | 'auxiliary' | 'compression' | 'title' | 'web-extract';

/** Provider, client metadata, and selected model returned by `resolveProvider()`. */
export type ResolvedProvider = {
  transport: Transport;
  client: unknown;
  baseUrl: string;
  model: string;
  contextLength: number;
  authType: AuthType;
  metadata: Record<string, unknown>;
};

/** Optional inputs for resolving providers in tests, CLI, and future surfaces. */
export type ResolveProviderOpts = {
  purpose?: ProviderPurpose;
  settings?: Settings;
  env?: NodeJS.ProcessEnv;
  harnessHome?: string;
};

type ProviderConfigMap = NonNullable<Settings['providers']>;

type SelectedCredential = {
  pool: CredentialPool;
  id: string;
  secret?: string;
  authType: AuthType;
};

/** Resolve config, credentials, rate guards, transport, model, and context length. */
export function resolveProvider(
  name?: string,
  model?: string,
  opts: ResolveProviderOpts = {},
): ResolvedProvider {
  const env = opts.env ?? process.env;
  // Phase 16.1 M3 — mock provider for tests + the offline TUI/server smoke.
  // Short-circuits credential/registry resolution so a turn can run with no
  // API key. `mock` is never persisted into settings; it's a one-call escape
  // hatch. Triggered by an explicit `mock` name, OR (only when no provider
  // is named at all) by SOV_TEST_MOCK_PROVIDER=1. A lingering env var must
  // not silently override an explicit provider request.
  if (name === 'mock' || (name === undefined && env.SOV_TEST_MOCK_PROVIDER === '1')) {
    const transport = new MockProvider();
    const resolvedModel = model ?? 'mock-haiku';
    return {
      transport,
      client: transport,
      baseUrl: 'mock://local',
      model: resolvedModel,
      contextLength: 200_000,
      authType: 'none',
      metadata: {
        provider: 'mock',
        apiMode: 'anthropic',
        purpose: opts.purpose ?? 'main',
      },
    };
  }
  const settings = opts.settings ?? loadSettings({ env });
  const providerName = normalizeProviderName(name ?? settings.defaultProvider ?? 'anthropic');
  const registry = PROVIDER_REGISTRY[providerName];
  if (!registry) throw new Error(`unknown provider: ${providerName}`);

  const providerConfig = providerConfigFor(settings.providers, providerName);
  const baseUrl = providerConfig?.baseUrl ?? registry.defaultBaseUrl;
  const resolvedModel =
    model ?? providerConfig?.model ?? settings.defaultModel ?? registry.defaultModel;

  const selected = selectCredential(providerName, providerConfig, registry.authEnvVar, env, opts);
  const numCtx =
    providerName === 'ollama'
      ? (providerConfig?.numCtx ?? contextLengthFor(providerName, resolvedModel))
      : undefined;
  const transport = instantiateTransport(
    providerName,
    registry.apiMode,
    baseUrl,
    selected?.secret,
    numCtx,
  );
  const guarded = wrapWithProviderHardening(transport, providerName, selected, opts);

  return {
    transport: guarded,
    client: transport,
    baseUrl,
    model: resolvedModel,
    contextLength: contextLengthFor(providerName, resolvedModel),
    authType: selected?.authType ?? (isKeylessProvider(providerName) ? 'none' : 'api_key'),
    metadata: {
      provider: providerName,
      apiMode: registry.apiMode,
      purpose: opts.purpose ?? 'main',
      ...(selected ? { credentialId: selected.id } : {}),
    },
  };
}

function normalizeProviderName(name: string): string {
  const lower = name.toLowerCase();
  if (lower === 'claude') return 'anthropic';
  if (lower === 'open-router') return 'openrouter';
  return lower;
}

/** Providers that resolve without any credential (local loopback engines).
 *  These default to authType 'none' and never throw when a key is absent. */
function isKeylessProvider(providerName: string): boolean {
  return providerName === 'ollama' || providerName === 'sov';
}

function providerConfigFor(
  providers: ProviderConfigMap | undefined,
  providerName: string,
): ProviderConfig | undefined {
  if (!providers) return undefined;
  if (providerName === 'anthropic') return providers.anthropic;
  if (providerName === 'openai') return providers.openai;
  if (providerName === 'openrouter') return providers.openrouter;
  if (providerName === 'ollama') return providers.ollama;
  if (providerName === 'sov') return providers.sov;
  return undefined;
}

function selectCredential(
  providerName: string,
  config: ProviderConfig | undefined,
  envVar: string | undefined,
  env: NodeJS.ProcessEnv,
  opts: ResolveProviderOpts,
): SelectedCredential | undefined {
  const inputs = credentialInputs(providerName, config, envVar, env);
  if (isKeylessProvider(providerName) && inputs.length === 0) return undefined;
  if (inputs.length === 0) throw new CredentialUnavailableError(providerName);

  const harnessHome = opts.harnessHome;
  const statePath = harnessHome ? join(harnessHome, 'credentials.json') : undefined;
  const pool = new CredentialPool(providerName, inputs, {
    ...(statePath ? { path: statePath } : {}),
    ...(config?.strategy ? { strategy: config.strategy as CredentialStrategy } : {}),
  });
  const selected = pool.select();
  if (!selected) throw new CredentialUnavailableError(providerName);
  if (!selected.secret && selected.credential.authType !== 'none') {
    throw new CredentialUnavailableError(providerName);
  }
  return {
    pool,
    id: selected.credential.id,
    ...(selected.secret !== undefined ? { secret: selected.secret } : {}),
    authType: selected.credential.authType,
  };
}

function credentialInputs(
  providerName: string,
  config: ProviderConfig | undefined,
  envVar: string | undefined,
  env: NodeJS.ProcessEnv,
): CredentialInput[] {
  const inputs: CredentialInput[] = [];
  const add = (secret: string | undefined, id: string | undefined, priority = 0) => {
    if (!secret) return;
    inputs.push({
      provider: providerName,
      authType: 'api_key',
      ...(id !== undefined ? { id } : {}),
      secret,
      priority,
    });
  };

  add(envVar ? env[envVar] : undefined, envVar);
  add(config?.apiKey, 'config-api-key', 10);
  for (const [i, key] of config?.apiKeys?.entries() ?? []) add(key, `config-api-key-${i}`, 20 + i);
  for (const [i, cred] of config?.credentials?.entries() ?? []) {
    add(cred.apiKey ?? cred.token, cred.id ?? `config-credential-${i}`, cred.priority ?? 30 + i);
  }
  return inputs;
}

function instantiateTransport(
  providerName: string,
  apiMode: 'anthropic' | 'openai' | 'ollama' | 'sov',
  baseUrl: string,
  apiKey: string | undefined,
  numCtx: number | undefined,
): Transport {
  if (apiMode === 'anthropic') {
    if (!apiKey) throw new CredentialUnavailableError(providerName);
    return new AnthropicProvider({ apiKey, baseURL: baseUrl }) as Transport;
  }
  if (apiMode === 'openai') {
    if (!apiKey) throw new CredentialUnavailableError(providerName);
    return new OpenAIProvider({ apiKey, baseURL: baseUrl, name: providerName }) as Transport;
  }
  if (apiMode === 'sov') {
    // Keyless local lane — never throws on a missing key; only attaches the
    // Authorization header when a key is explicitly configured.
    return new SovProvider({
      baseURL: baseUrl,
      name: providerName,
      ...(apiKey ? { apiKey } : {}),
    }) as Transport;
  }
  return new OllamaProvider({
    baseURL: baseUrl,
    ...(apiKey ? { apiKey } : {}),
    ...(numCtx !== undefined ? { numCtx } : {}),
  }) as Transport;
}

function wrapWithProviderHardening(
  transport: Transport,
  providerName: string,
  credential: SelectedCredential | undefined,
  opts: ResolveProviderOpts,
): Transport {
  const rateRoot = opts.harnessHome ? join(opts.harnessHome, 'rate_limits') : undefined;
  const guard = new RateLimitGuard(providerName, rateRoot ? { root: rateRoot } : {});

  return {
    name: transport.name,
    apiMode: transport.apiMode,
    toProviderMessages(messages: Message[], system?: SystemSegment[]) {
      return transport.toProviderMessages(messages, system);
    },
    toProviderTools(tools?: ToolSchema[]) {
      return transport.toProviderTools(tools);
    },
    buildKwargs(req: ProviderRequest) {
      return transport.buildKwargs(req);
    },
    normalizeResponse(raw: AsyncIterable<unknown>) {
      return transport.normalizeResponse(raw);
    },
    async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      await guard.beforeRequest(req.signal);
      try {
        const result = yield* transport.stream(req);
        if (credential) credential.pool.markOk(credential.id);
        return result;
      } catch (err) {
        if (isRateLimited(err)) {
          const state = guard.markRateLimited(err.headers, err.message);
          if (credential)
            credential.pool.markExhausted(credential.id, err.message, state.exhausted_until);
        } else if (err instanceof ProviderHttpError && (err.status === 401 || err.status === 403)) {
          if (credential) credential.pool.markAuthFailed(credential.id, err.message);
        }
        throw err;
      }
    },
  };
}

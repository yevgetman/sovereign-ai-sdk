import type { AssistantMessage, StreamEvent } from '../core/types.js';
import { messagesToOpenAI, parseSse, translateOpenAIStream } from './openai.js';
import {
  type AttemptDeps,
  defaultAttemptDeps,
  subscriptionAttempt,
} from './subscription/attempt.js';
import { KEYCHAIN_SERVICE } from './subscription/names.js';
import { formBody, recordFromTokenJson } from './subscription/oauth.js';
import type {
  SubscriptionCredentialPort,
  SubscriptionFetch,
  SubscriptionRecord,
} from './subscription/port.js';
import { exchangeUnderLock, loadFreshRecord } from './subscription/tokens.js';
import type { LLMProvider, ProviderRequest, ToolSchema } from './types.js';

const CHAT_URL = 'https://api.x.ai/v1/chat/completions';
const TOKEN_URL = 'https://auth.x.ai/oauth2/token';
export const GROK_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';

export type GrokProviderOpts = {
  port: SubscriptionCredentialPort;
  fetchImpl?: SubscriptionFetch;
  deps?: AttemptDeps;
};

/**
 * SuperGrok / X Premium+ over `api.x.ai`. A 403 is a tier block: no retry
 * and no second call with an API key.
 */
export class GrokSubscriptionProvider implements LLMProvider {
  readonly name = 'grok';
  private readonly port: SubscriptionCredentialPort;
  private readonly fetchImpl: SubscriptionFetch;
  private readonly deps: AttemptDeps;

  constructor(opts: GrokProviderOpts) {
    this.port = opts.port;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.deps = opts.deps ?? defaultAttemptDeps;
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
    let sentRecord: SubscriptionRecord | undefined;
    const response = await subscriptionAttempt({
      provider: this.name,
      ...(req.signal ? { signal: req.signal } : {}),
      tierBlockedOn403: true,
      deps: this.deps,
      send: () =>
        this.send(req, (record) => {
          sentRecord = record;
        }),
      refresh: () => this.refresh(sentRecord, req.signal),
    });
    if (!response.body) {
      throw new Error('subscription provider grok returned an empty stream');
    }
    return yield* translateOpenAIStream(parseSse(response.body));
  }

  private async send(
    req: ProviderRequest,
    remember: (record: SubscriptionRecord) => void,
  ): Promise<Response> {
    const record = await loadFreshRecord(
      this.name,
      KEYCHAIN_SERVICE.grok,
      this.port,
      this.deps.now,
      (current, signal) => this.exchange(current.refreshToken, signal),
      req.signal ? { signal: req.signal } : {},
    );
    remember(record);
    const tools = toGrokTools(req.tools);
    const body: Record<string, unknown> = {
      model: req.model,
      messages: messagesToOpenAI(req.messages, req.system),
      max_tokens: req.maxTokens,
      stream: true,
    };
    if (tools) body.tools = tools;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    return this.fetchImpl(CHAT_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${record.accessToken}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      ...(req.signal ? { signal: req.signal } : {}),
    });
  }

  private refresh(rejected: SubscriptionRecord | undefined, signal?: AbortSignal): Promise<void> {
    return exchangeUnderLock(
      this.name,
      KEYCHAIN_SERVICE.grok,
      this.port,
      (current, exchangeSignal) => this.exchange(current.refreshToken, exchangeSignal),
      rejected,
      signal ? { signal } : {},
    ).then(() => undefined);
  }

  private async exchange(refreshToken: string, signal?: AbortSignal) {
    const response = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      redirect: 'error',
      ...(signal ? { signal } : {}),
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: formBody({
        grant_type: 'refresh_token',
        client_id: GROK_OAUTH_CLIENT_ID,
        refresh_token: refreshToken,
      }),
    });
    if (!response.ok) {
      throw new Error('grok refresh failed');
    }
    return recordFromTokenJson(this.name, await response.json(), this.deps.now(), refreshToken);
  }
}

function toGrokTools(tools: ToolSchema[] | undefined) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

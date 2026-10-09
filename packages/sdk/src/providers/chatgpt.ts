import { Buffer } from 'node:buffer';
import type { AssistantMessage, StreamEvent } from '../core/types.js';
import { VERSION } from '../version.js';
import {
  codexReasoning,
  responsesInput,
  responsesTools,
  translateResponsesSse,
} from './responses.js';
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
import type { LLMProvider, ProviderRequest } from './types.js';

/** Codex backend. Never `api.openai.com`. */
export const CHATGPT_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const CHATGPT_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

export type ChatGptProviderOpts = {
  port: SubscriptionCredentialPort;
  fetchImpl?: SubscriptionFetch;
  deps?: AttemptDeps;
};

/**
 * ChatGPT / Codex subscription over `chatgpt.com`. The request never uses
 * `api.openai.com`. A 401 refreshes once.
 */
export class ChatGptSubscriptionProvider implements LLMProvider {
  readonly name = 'chatgpt';
  private readonly port: SubscriptionCredentialPort;
  private readonly fetchImpl: SubscriptionFetch;
  private readonly deps: AttemptDeps;

  constructor(opts: ChatGptProviderOpts) {
    this.port = opts.port;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.deps = opts.deps ?? defaultAttemptDeps;
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
    let sentRecord: SubscriptionRecord | undefined;
    const response = await subscriptionAttempt({
      provider: this.name,
      ...(req.signal ? { signal: req.signal } : {}),
      tierBlockedOn403: false,
      deps: this.deps,
      send: () =>
        this.send(req, (record) => {
          sentRecord = record;
        }),
      refresh: () => this.refresh(sentRecord, req.signal),
    });
    return yield* translateResponsesSse(response, this.name);
  }

  private async send(
    req: ProviderRequest,
    remember: (record: SubscriptionRecord) => void,
  ): Promise<Response> {
    assertCodexUrl(CHATGPT_RESPONSES_URL);
    const record = await loadFreshRecord(
      this.name,
      KEYCHAIN_SERVICE.chatgpt,
      this.port,
      this.deps.now,
      (current, signal) => this.exchange(current.refreshToken, signal),
      req.signal ? { signal: req.signal } : {},
    );
    remember(record);
    const body = codexBody(req);
    return this.fetchImpl(CHATGPT_RESPONSES_URL, {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${record.accessToken}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'user-agent': `sov/${VERSION}`,
        originator: 'sov',
        ...accountHeaders(record.accessToken),
      },
      body: JSON.stringify(body),
      ...(req.signal ? { signal: req.signal } : {}),
    });
  }

  private refresh(rejected: SubscriptionRecord | undefined, signal?: AbortSignal): Promise<void> {
    return exchangeUnderLock(
      this.name,
      KEYCHAIN_SERVICE.chatgpt,
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
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        'user-agent': `sov/${VERSION}`,
      },
      body: formBody({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CHATGPT_OAUTH_CLIENT_ID,
      }),
    });
    if (!response.ok) throw new Error('chatgpt refresh failed');
    return recordFromTokenJson(this.name, await response.json(), this.deps.now(), refreshToken);
  }
}

export function assertCodexUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'chatgpt.com') {
    throw new Error('chatgpt provider refuses a host other than chatgpt.com');
  }
  if (!parsed.pathname.startsWith('/backend-api/codex')) {
    throw new Error('chatgpt provider refuses a path outside the Codex backend');
  }
}

function codexBody(req: ProviderRequest): Record<string, unknown> {
  const instructions =
    req.system
      .map((segment) => segment.text)
      .join('\n')
      .trim() || 'You are a helpful assistant.';
  const body: Record<string, unknown> = {
    model: req.model,
    instructions,
    input: responsesInput(req),
    store: false,
    stream: true,
    reasoning: codexReasoning(req.effort),
  };
  const tools = responsesTools(req.tools);
  if (tools) body.tools = tools;
  if (req.toolChoice)
    body.tool_choice =
      req.toolChoice.type === 'tool'
        ? { type: 'function', name: req.toolChoice.name }
        : req.toolChoice.type === 'any'
          ? 'required'
          : 'auto';
  // The Codex subscription backend rejects max_output_tokens and temperature.
  // It sets its own output limit; this route does not send unsupported fields.
  return body;
}

function accountHeaders(accessToken: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const parts = accessToken.split('.');
  if (parts.length < 2 || !parts[1]) return headers;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      'https://api.openai.com/auth'?: {
        chatgpt_account_id?: unknown;
        chatgpt_data_residency?: unknown;
        chatgpt_compute_residency?: unknown;
      };
    };
    const auth = payload['https://api.openai.com/auth'];
    const accountId = auth?.chatgpt_account_id;
    if (typeof accountId === 'string' && accountId.length > 0) {
      headers['ChatGPT-Account-ID'] = accountId;
    }
    const residency = auth?.chatgpt_data_residency ?? auth?.chatgpt_compute_residency;
    if (typeof residency === 'string' && residency.trim().length > 0) {
      headers['x-openai-internal-codex-residency'] = residency.trim();
    }
  } catch {
    // A malformed token fails as HTTP 401, not as a thrown decode error.
  }
  return headers;
}

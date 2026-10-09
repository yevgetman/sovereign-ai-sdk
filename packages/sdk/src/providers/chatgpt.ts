import { Buffer } from 'node:buffer';
import type {
  AssistantMessage,
  ContentBlock,
  StopReason,
  StreamEvent,
  TokenUsage,
} from '../core/types.js';
import { VERSION } from '../version.js';
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
    return yield* translateCodexSse(response);
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
    input: toCodexInput(req),
    store: false,
    stream: true,
    max_output_tokens: req.maxTokens,
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  const tools = toCodexTools(req.tools);
  if (tools) body.tools = tools;
  return body;
}

function toCodexTools(tools: ToolSchema[] | undefined) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
  }));
}

function toCodexInput(req: ProviderRequest): unknown[] {
  const items: unknown[] = [];
  for (const message of req.messages) {
    for (const block of message.content) {
      if (block.type === 'text' && message.role === 'user') {
        items.push({
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: block.text }],
        });
      } else if (block.type === 'text' && message.role === 'assistant') {
        items.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: block.text }],
        });
      } else if (block.type === 'tool_use') {
        items.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        });
      } else if (block.type === 'tool_result') {
        items.push({
          type: 'function_call_output',
          call_id: block.tool_use_id,
          output: block.content,
        });
      }
    }
  }
  return items;
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

async function* translateCodexSse(
  response: Response,
): AsyncGenerator<StreamEvent, AssistantMessage> {
  yield { type: 'message_start' };
  const textParts: string[] = [];
  const toolBlocks: ContentBlock[] = [];
  let usage: TokenUsage | undefined;
  let sawEvent = false;
  const raw = await response.text();
  if (raw.trim().length === 0) {
    throw new Error('subscription provider chatgpt returned an empty stream');
  }
  for (const event of sseData(raw)) {
    sawEvent = true;
    const type = typeof event.type === 'string' ? event.type : '';
    if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
      textParts.push(event.delta);
      yield { type: 'text_delta', text: event.delta };
    }
    if (type === 'response.output_item.done') {
      const item = event.item;
      if (item && typeof item === 'object') {
        const row = item as Record<string, unknown>;
        if (row.type === 'function_call') {
          const id = typeof row.call_id === 'string' ? row.call_id : String(row.id ?? 'tool');
          const name = typeof row.name === 'string' ? row.name : 'tool';
          const input = parseArgs(row.arguments);
          const block: ContentBlock = { type: 'tool_use', id, name, input };
          toolBlocks.push(block);
          yield { type: 'tool_use_delta', id, partial: input };
        }
      }
    }
    if (type === 'response.completed') {
      usage = usageFrom(event.response);
    }
  }
  if (!sawEvent) throw new Error('subscription provider chatgpt returned an empty stream');
  if (usage) yield { type: 'usage_delta', usage };
  const content: ContentBlock[] = [];
  const text = textParts.join('');
  if (text.length > 0) content.push({ type: 'text', text });
  content.push(...toolBlocks);
  const stopReason: StopReason = toolBlocks.length > 0 ? 'tool_use' : 'end_turn';
  const message: AssistantMessage = { role: 'assistant', content };
  yield { type: 'message_stop', stop_reason: stopReason };
  yield { type: 'assistant_message', message };
  return message;
}

function sseData(raw: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (data.length === 0 || data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (parsed && typeof parsed === 'object') events.push(parsed as Record<string, unknown>);
    } catch {
      // Ignore a non-JSON keep-alive line.
    }
  }
  return events;
}

function parseArgs(value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function usageFrom(response: unknown): TokenUsage | undefined {
  if (!response || typeof response !== 'object') return undefined;
  const usage = (response as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const row = usage as { input_tokens?: unknown; output_tokens?: unknown };
  const out: TokenUsage = {};
  if (typeof row.input_tokens === 'number') out.inputTokens = row.input_tokens;
  if (typeof row.output_tokens === 'number') out.outputTokens = row.output_tokens;
  return out;
}

// Mock provider for tests and the M3 first-turn smoke. Implements the
// `Transport` shape resolveProvider() returns: a deterministic synthetic
// turn — one text message ("Hello world.") — with no network call. Used
// when `name === 'mock'` or `SOV_TEST_MOCK_PROVIDER=1`.
//
// Phase 16.1 M3: the foreground (TUI/server) needs an end-to-end turn
// without API credentials so smoke tests and CI runs are reliable. The
// model and StreamEvent shape match exactly what `query()` already
// consumes so no special-casing is needed downstream.

import type {
  AssistantMessage,
  ContentBlock,
  Message,
  StreamEvent,
  SystemSegment,
} from '../core/types.js';
import type { ApiMode, ProviderRequest, ToolSchema, Transport } from './types.js';

export class MockProvider implements Transport<Message, ToolSchema, unknown, never> {
  readonly name = 'mock';
  readonly apiMode: ApiMode = 'anthropic';

  toProviderMessages(messages: Message[], _system?: SystemSegment[]): Message[] {
    return messages;
  }

  toProviderTools(tools?: ToolSchema[]): ToolSchema[] | undefined {
    return tools;
  }

  buildKwargs(_req: ProviderRequest): unknown {
    return {};
  }

  async *normalizeResponse(
    _raw: AsyncIterable<never>,
  ): AsyncGenerator<StreamEvent, AssistantMessage> {
    return yield* this.stream({} as ProviderRequest);
  }

  async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
    yield { type: 'message_start' };
    yield { type: 'text_delta', text: 'Hello' };
    yield { type: 'text_delta', text: ' world.' };
    yield {
      type: 'usage_delta',
      usage: { inputTokens: 0, outputTokens: 2 },
    };
    yield { type: 'message_stop', stop_reason: 'end_turn' };
    const content: ContentBlock[] = [{ type: 'text', text: 'Hello world.' }];
    const assistant: AssistantMessage = { role: 'assistant', content };
    yield { type: 'assistant_message', message: assistant };
    return assistant;
  }
}

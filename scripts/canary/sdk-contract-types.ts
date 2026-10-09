// Authored against the documented Agent Casa public surface. No private code.
import {
  createAgent, buildTool, createInMemorySessionStore, resolveProvider,
  type AssistantMessage, type Message, type StreamEvent, type RunResult,
  type StoredMessage, type SystemSegment, type Session, type CreateSessionInput,
  type SaveMessageInput, type TokenUsage, type ProviderRequest,
  type ConductProvider, type MicrocompactConfig, type MicrocompactInfo,
  type SessionStore, type LLMProvider,
} from '@yevgetman/sov-sdk';
import { z } from 'zod';

const store: SessionStore = createInMemorySessionStore();
const provider: LLMProvider = {
  name: 'consumer-type-fixture',
  async *stream(_request: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
    const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'fixture' }] };
    yield { type: 'assistant_message', message };
    return message;
  },
};
const tool = buildTool({ name: 'Fixture', inputSchema: z.object({ value: z.string() }),
  description: () => 'Type fixture', async call(input) { return { data: input.value }; } });
const agent = createAgent({ provider, model: 'fixture', tools: [tool], sessionStore: store });
const history: Message[] = store.loadMessages('fixture').map((row: StoredMessage) => ({ role: row.role, content: row.content }));
const generator: AsyncGenerator<StreamEvent | Message, RunResult> = agent.run(history, { sessionId: 'fixture' });
void generator; void resolveProvider;
// Freeze the persistence and optional config shapes the consumer names.
export function consumerTypes(input: CreateSessionInput, message: SaveMessageInput,
  usage: TokenUsage, system: SystemSegment[], conduct: ConductProvider,
  compact: MicrocompactConfig, info: MicrocompactInfo): Session | null {
  const sessionId = store.upsertSession(input);
  store.saveMessage(sessionId, message);
  store.recordTokenUsage(sessionId, usage, 0);
  createAgent({ provider, model: 'fixture', systemPrompt: system, conduct, microcompactConfig: compact });
  void info;
  return store.getSession(sessionId);
}

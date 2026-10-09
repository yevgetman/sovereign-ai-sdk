// Repeatable OFFLINE TEST envelope. This is not a production capacity promise.
// Prints a standalone JSON report; redirect it to save a benchmark artifact.
import { performance } from 'node:perf_hooks';
import { SessionWorkQueue, createAgent, createInMemorySessionStore } from '@yevgetman/sov-sdk';
import type { AssistantMessage, LLMProvider, Message } from '@yevgetman/sov-sdk';

const envelope = {
  sessions: 16,
  turnsPerSession: 8,
  seedHistoryMessages: 32,
  messageCharacters: 512,
  mockProviderDelayMs: 2,
  maxActiveSessions: 4,
  maxQueued: 128,
  maxQueuedPerSession: 8,
};
const queue = new SessionWorkQueue(envelope);
const store = createInMemorySessionStore();
const provider: LLMProvider = {
  name: 'offline-load-mock',
  async *stream() {
    await new Promise<void>((resolve) => setTimeout(resolve, envelope.mockProviderDelayMs));
    const message: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'x'.repeat(envelope.messageCharacters) }],
    };
    yield { type: 'usage_delta', usage: { inputTokens: 16, outputTokens: 16 } };
    yield { type: 'message_stop', stop_reason: 'end_turn' };
    yield { type: 'assistant_message', message };
    return message;
  },
};
const agent = createAgent({ provider, model: 'mock', sessionStore: store });
const seeds: Message[] = Array.from({ length: envelope.seedHistoryMessages }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: [{ type: 'text', text: 's'.repeat(envelope.messageCharacters) }],
}));
const queueWait: number[] = [];
const latency: number[] = [];
const eventLoopDelay: number[] = [];
const startRss = process.memoryUsage().rss;
let peakRss = startRss;
let peakActive = 0;
let peakQueued = 0;
let lastTick = performance.now();
const startedAt = performance.now();
const sample = setInterval(() => {
  const now = performance.now();
  eventLoopDelay.push(Math.max(0, now - lastTick - 5));
  lastTick = now;
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  const state = queue.snapshot();
  peakActive = Math.max(peakActive, state.active);
  peakQueued = Math.max(peakQueued, state.queued);
}, 5);
let completed = 0;
try {
  const jobs: Promise<void>[] = [];
  for (let turn = 0; turn < envelope.turnsPerSession; turn++) {
    for (let session = 0; session < envelope.sessions; session++) {
      const submittedAt = performance.now();
      const sessionId = `load-${session}`;
      jobs.push(
        queue.submit(sessionId, async (signal) => {
          queueWait.push(performance.now() - submittedAt);
          const persisted = store.loadMessages(sessionId);
          const history: Message[] =
            persisted.length > 0
              ? persisted.map(({ role, content }) => ({ role, content }))
              : seeds.slice();
          history.push({
            role: 'user',
            content: [{ type: 'text', text: 'u'.repeat(envelope.messageCharacters) }],
          });
          const gen = agent.run(history, { sessionId, signal });
          for (;;) {
            const step = await gen.next();
            if (step.done) {
              if (step.value.terminal.reason !== 'completed')
                throw new Error(`unexpected terminal: ${step.value.terminal.reason}`);
              completed++;
              break;
            }
          }
          latency.push(performance.now() - submittedAt);
        }),
      );
      peakActive = Math.max(peakActive, queue.snapshot().active);
      peakQueued = Math.max(peakQueued, queue.snapshot().queued);
    }
  }
  await Promise.all(jobs);
} finally {
  clearInterval(sample);
  await queue.shutdown(false);
}
const durationMs = performance.now() - startedAt;
const percentile = (values: number[], fraction: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
};
const histories = Array.from({ length: envelope.sessions }, (_, i) =>
  store.loadMessages(`load-${i}`),
);
console.log(
  JSON.stringify(
    {
      scope:
        'offline in-process TEST envelope; not a production certification or distributed guarantee',
      runtime: {
        node: process.versions.node,
        bun: process.versions.bun ?? null,
        platform: process.platform,
        arch: process.arch,
      },
      envelope,
      results: {
        completed,
        durationMs,
        turnsPerSecond: completed / (durationMs / 1000),
        queueWaitMs: {
          p50: percentile(queueWait, 0.5),
          p95: percentile(queueWait, 0.95),
          max: Math.max(...queueWait),
        },
        totalLatencyMs: {
          p50: percentile(latency, 0.5),
          p95: percentile(latency, 0.95),
          max: Math.max(...latency),
        },
        eventLoopDelayMs: {
          sampleIntervalMs: 5,
          samples: eventLoopDelay.length,
          p95: percentile(eventLoopDelay, 0.95),
          max: Math.max(0, ...eventLoopDelay),
        },
        rssBytes: {
          start: startRss,
          peak: Math.max(peakRss, process.memoryUsage().rss),
          final: process.memoryUsage().rss,
        },
        admission: { peakActive, peakQueued, final: queue.snapshot() },
        history: {
          sessions: histories.length,
          messages: histories.reduce((sum, messages) => sum + messages.length, 0),
          serializedBytes: Buffer.byteLength(JSON.stringify(histories)),
        },
      },
      limits: [
        'Mock-provider latency and memory only; no real rate limits or provider throughput.',
        'No async/durable/distributed queue or cross-process lease.',
        'Shutdown waits for all callbacks; no guaranteed time bound for uncooperative work.',
        'No exactly-once tool effects or automatic replay after persistence failure.',
      ],
    },
    null,
    2,
  ),
);

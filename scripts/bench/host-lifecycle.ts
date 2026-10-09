// Repeatable OFFLINE TEST envelope. This is not a production capacity promise.
// Prints a standalone JSON report; redirect it to save a benchmark artifact.
import { performance } from 'node:perf_hooks';
import { SessionWorkQueue, createAgent, createInMemorySessionStore } from '@yevgetman/sov-sdk';
import type { AssistantMessage, LLMProvider, Message } from '@yevgetman/sov-sdk';

const durationFlag = process.argv.indexOf('--duration-seconds');
const requestedSeconds = durationFlag === -1 ? 0 : Number(process.argv[durationFlag + 1]);
if (
  !Number.isFinite(requestedSeconds) ||
  requestedSeconds < 0 ||
  requestedSeconds > 300 ||
  (durationFlag !== -1 && requestedSeconds === 0)
) {
  throw new Error('--duration-seconds must be a positive duration up to 300 seconds');
}
const envelope = {
  sessions: 16,
  turnsPerSession: 8,
  seedHistoryMessages: 32,
  messageCharacters: 512,
  mockProviderDelayMs: 2,
  maxActiveSessions: 4,
  maxQueued: 128,
  maxQueuedPerSession: 8,
  durationSeconds: requestedSeconds,
  historyPolicy:
    'fresh store and 16 new session ids after each joined 128-turn cohort; 32 seed messages, at most 48 stored messages/session',
  metricWindowSamples: 4096,
  injectedProviderErrorEvery: requestedSeconds > 0 ? 97 : 0,
};
const queue = new SessionWorkQueue(envelope);
let store = createInMemorySessionStore();
let providerRequests = 0;
const provider: LLMProvider = {
  name: 'offline-load-mock',
  async *stream() {
    await new Promise<void>((resolve) => setTimeout(resolve, envelope.mockProviderDelayMs));
    providerRequests++;
    if (
      envelope.injectedProviderErrorEvery > 0 &&
      providerRequests % envelope.injectedProviderErrorEvery === 0
    ) {
      throw new Error('injected soak disconnect');
    }
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
let agent = createAgent({ provider, model: 'mock', sessionStore: store });
const seeds: Message[] = Array.from({ length: envelope.seedHistoryMessages }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: [{ type: 'text', text: 's'.repeat(envelope.messageCharacters) }],
}));
// Keep telemetry memory bounded independently of the run duration.
class SampleWindow {
  readonly values: number[] = [];
  count = 0;
  max = 0;
  record(value: number): void {
    this.values[this.count % envelope.metricWindowSamples] = value;
    this.count++;
    this.max = Math.max(this.max, value);
  }
}
const queueWait = new SampleWindow();
const latency = new SampleWindow();
const eventLoopDelay = new SampleWindow();
const startRss = process.memoryUsage().rss;
let peakRss = startRss;
let peakActive = 0;
let peakQueued = 0;
let lastTick = performance.now();
const startedAt = performance.now();
const sample = setInterval(() => {
  const now = performance.now();
  eventLoopDelay.record(Math.max(0, now - lastTick - 5));
  lastTick = now;
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  const state = queue.snapshot();
  peakActive = Math.max(peakActive, state.active);
  peakQueued = Math.max(peakQueued, state.queued);
}, 5);
let completed = 0;
let attempted = 0;
let batches = 0;
let providerErrors = 0;
let admissionErrors = 0;
let unexpectedErrors = 0;
let cancelled = 0;
let finalHistories: ReturnType<typeof store.loadMessages>[] = [];
let maxHistoryMessagesPerSession = 0;
try {
  do {
    store = createInMemorySessionStore();
    agent = createAgent({ provider, model: 'mock', sessionStore: store });
    const cohort = batches++;
    const jobs: Promise<void>[] = [];
    for (let turn = 0; turn < envelope.turnsPerSession; turn++) {
      for (let session = 0; session < envelope.sessions; session++) {
        const submittedAt = performance.now();
        const sessionId = `load-${cohort}-${session}`;
        attempted++;
        jobs.push(
          queue.submit(sessionId, async (signal) => {
            queueWait.record(performance.now() - submittedAt);
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
                const terminal = step.value.terminal;
                if (terminal.reason === 'completed') completed++;
                else if (
                  terminal.reason === 'error' &&
                  terminal.error.message.includes('injected soak disconnect')
                )
                  providerErrors++;
                else if (terminal.reason === 'interrupted') cancelled++;
                else throw new Error(`unexpected terminal: ${terminal.reason}`);
                break;
              }
            }
            latency.record(performance.now() - submittedAt);
          }),
        );
        peakActive = Math.max(peakActive, queue.snapshot().active);
        peakQueued = Math.max(peakQueued, queue.snapshot().queued);
      }
    }
    const outcomes = await Promise.allSettled(jobs);
    for (const outcome of outcomes)
      if (outcome.status === 'rejected') {
        if (outcome.reason?.code === 'queue_full' || outcome.reason?.code === 'closed')
          admissionErrors++;
        else unexpectedErrors++;
      }
    finalHistories = Array.from({ length: envelope.sessions }, (_, i) =>
      store.loadMessages(`load-${cohort}-${i}`),
    );
    maxHistoryMessagesPerSession = Math.max(
      maxHistoryMessagesPerSession,
      ...finalHistories.map((rows) => rows.length),
    );
    if (admissionErrors || unexpectedErrors || cancelled) break;
  } while (requestedSeconds > 0 && performance.now() - startedAt < requestedSeconds * 1000);
} finally {
  clearInterval(sample);
  await queue.shutdown(false);
}
const durationMs = performance.now() - startedAt;
const percentile = (values: number[], fraction: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
};
const histories = finalHistories;
const validation = {
  countsConsistent:
    attempted === completed + providerErrors + admissionErrors + unexpectedErrors + cancelled,
  admissionWithinLimits:
    peakActive <= envelope.maxActiveSessions && peakQueued <= envelope.maxQueued,
  noPendingWork:
    queue.snapshot().active === 0 && queue.snapshot().queued === 0 && queue.snapshot().closed,
  historyWithinLimit:
    maxHistoryMessagesPerSession <= envelope.seedHistoryMessages + 2 * envelope.turnsPerSession,
  noUnexpectedFailures: admissionErrors === 0 && unexpectedErrors === 0 && cancelled === 0,
};
if (!Object.values(validation).every(Boolean)) process.exitCode = 1;
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
      validation,
      results: {
        attempted,
        completed,
        batches,
        providerRequests,
        errors: {
          injectedProvider: providerErrors,
          admission: admissionErrors,
          unexpected: unexpectedErrors,
          cancelled,
        },
        durationMs,
        turnsPerSecond: completed / (durationMs / 1000),
        queueWaitMs: {
          samples: queueWait.count,
          retainedSamples: queueWait.values.length,
          p50: percentile(queueWait.values, 0.5),
          p95: percentile(queueWait.values, 0.95),
          max: queueWait.max,
        },
        totalLatencyMs: {
          samples: latency.count,
          retainedSamples: latency.values.length,
          p50: percentile(latency.values, 0.5),
          p95: percentile(latency.values, 0.95),
          max: latency.max,
        },
        eventLoopDelayMs: {
          sampleIntervalMs: 5,
          samples: eventLoopDelay.count,
          p95: percentile(eventLoopDelay.values, 0.95),
          max: eventLoopDelay.max,
        },
        rssBytes: {
          start: startRss,
          peak: Math.max(peakRss, process.memoryUsage().rss),
          final: process.memoryUsage().rss,
        },
        admission: { peakActive, peakQueued, final: queue.snapshot() },
        history: {
          retainedCohorts: 1,
          maxMessagesPerSession: maxHistoryMessagesPerSession,
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

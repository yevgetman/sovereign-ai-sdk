import { describe, expect, test } from 'bun:test';
import {
  SessionWorkQueue,
  SessionWorkQueueError,
  createAgent,
  createInMemorySessionStore,
} from '@yevgetman/sov-sdk';
import type { AssistantMessage, LLMProvider, Message } from '@yevgetman/sov-sdk';

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const limits = { maxActiveSessions: 2, maxQueued: 4, maxQueuedPerSession: 2 };

function mockProvider(): LLMProvider {
  return {
    name: 'mock',
    async *stream(request) {
      const text = request.messages.at(-1)?.content.find((b) => b.type === 'text');
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: text?.type === 'text' ? `reply:${text.text}` : 'reply' }],
      };
      yield { type: 'message_stop', stop_reason: 'end_turn' };
      yield { type: 'assistant_message', message };
      return message;
    },
  };
}

async function drain<T>(gen: AsyncGenerator<unknown, T>): Promise<T> {
  for (;;) {
    const step = await gen.next();
    if (step.done) return step.value;
  }
}

describe('SessionWorkQueue public host contract', () => {
  test('same-session writes serialize; independent sessions run concurrently', async () => {
    const queue = new SessionWorkQueue(limits);
    const firstGate = deferred();
    const firstStarted = deferred();
    const events: string[] = [];
    const first = queue.submit('a', async () => {
      events.push('a1-start');
      firstStarted.resolve();
      await firstGate.promise;
      events.push('a1-end');
    });
    const second = queue.submit('a', async () => {
      events.push('a2');
    });
    const independent = queue.submit('b', async () => {
      events.push('b');
    });
    await firstStarted.promise;
    await independent;
    expect(events).toEqual(['a1-start', 'b']);
    expect(queue.snapshot()).toEqual({ active: 1, queued: 1, closed: false });
    firstGate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['a1-start', 'b', 'a1-end', 'a2']);
    await queue.shutdown();
  });

  test('queued cancellation never runs and frees admission capacity', async () => {
    const queue = new SessionWorkQueue({ ...limits, maxActiveSessions: 1, maxQueued: 1 });
    const gate = deferred();
    const first = queue.submit('a', async () => {
      await gate.promise;
    });
    const controller = new AbortController();
    let calls = 0;
    const queued = queue.submit(
      'b',
      async () => {
        calls++;
      },
      controller.signal,
    );
    const rejected = queued.catch((error: unknown) => error);
    controller.abort();
    expect(await rejected).toMatchObject({ code: 'cancelled' });
    const replacement = queue.submit('b', async () => {
      calls++;
    });
    gate.resolve();
    await Promise.all([first, replacement]);
    expect(calls).toBe(1);
    await queue.shutdown();
  });

  test('global and per-session queues are bounded without consuming a slot', async () => {
    const queue = new SessionWorkQueue({
      ...limits,
      maxActiveSessions: 1,
      maxQueued: 2,
      maxQueuedPerSession: 1,
    });
    const gate = deferred();
    const first = queue.submit('a', async () => {
      await gate.promise;
    });
    const a = queue.submit('a', async () => {});
    await expect(queue.submit('a', async () => {})).rejects.toMatchObject({ code: 'queue_full' });
    const b = queue.submit('b', async () => {});
    await expect(queue.submit('c', async () => {})).rejects.toMatchObject({ code: 'queue_full' });
    expect(queue.snapshot()).toEqual({ active: 1, queued: 2, closed: false });
    gate.resolve();
    await Promise.all([first, a, b]);
    await queue.shutdown();
  });

  test('shutdown cancels pending work and joins a started uncooperative callback', async () => {
    const queue = new SessionWorkQueue(limits);
    const gate = deferred();
    const started = deferred();
    let effect = false;
    let ended = false;
    const active = queue.submit('a', async (signal) => {
      started.resolve();
      await gate.promise;
      expect(signal.aborted).toBe(true);
      effect = true;
    });
    const activeRejected = active.catch((error: unknown) => error);
    const queued = queue.submit('a', async () => {
      throw new Error('must not run');
    });
    const queuedRejected = queued.catch((error: unknown) => error);
    await started.promise;
    const shutdown = queue.shutdown().then(() => {
      ended = true;
    });
    expect(await queuedRejected).toMatchObject({ code: 'closed' });
    expect(ended).toBe(false);
    expect(effect).toBe(false);
    await expect(queue.submit('b', async () => {})).rejects.toBeInstanceOf(SessionWorkQueueError);
    gate.resolve();
    await shutdown;
    expect(await activeRejected).toMatchObject({ code: 'cancelled' });
    expect(effect).toBe(true);
    expect(queue.snapshot()).toEqual({ active: 0, queued: 0, closed: true });
  });

  test('graceful shutdown can escalate to cancellation and remains idempotent', async () => {
    const queue = new SessionWorkQueue(limits);
    const gate = deferred();
    const started = deferred();
    let signal: AbortSignal | undefined;
    const job = queue.submit('a', async (s) => {
      signal = s;
      started.resolve();
      await gate.promise;
    });
    const rejected = job.catch((error: unknown) => error);
    await started.promise;
    const graceful = queue.shutdown(false);
    expect(signal?.aborted).toBe(false);
    const cancelled = queue.shutdown();
    expect(cancelled).toBe(graceful);
    expect(signal?.aborted).toBe(true);
    gate.resolve();
    await graceful;
    expect(await rejected).toMatchObject({ code: 'cancelled' });
  });

  test('public agent integration reloads durable history only after prior writes', async () => {
    const queue = new SessionWorkQueue(limits);
    const store = createInMemorySessionStore();
    const agent = createAgent({ provider: mockProvider(), model: 'mock', sessionStore: store });
    const run = (input: string) =>
      queue.submit('serialized', async (signal) => {
        const history: Message[] = store
          .loadMessages('serialized')
          .map(({ role, content }) => ({ role, content }));
        history.push({ role: 'user', content: [{ type: 'text', text: input }] });
        return drain(agent.run(history, { sessionId: 'serialized', signal }));
      });
    const results = await Promise.all([run('one'), run('two'), run('three')]);
    expect(results.map((r) => r.terminal.reason)).toEqual(['completed', 'completed', 'completed']);
    expect(store.loadMessages('serialized').map((m) => m.content)).toEqual([
      [{ type: 'text', text: 'one' }],
      [{ type: 'text', text: 'reply:one' }],
      [{ type: 'text', text: 'two' }],
      [{ type: 'text', text: 'reply:two' }],
      [{ type: 'text', text: 'three' }],
      [{ type: 'text', text: 'reply:three' }],
    ]);
    await queue.shutdown();
  });

  test('failed transcript writes reject the job and release session ownership', async () => {
    const queue = new SessionWorkQueue(limits);
    const base = createInMemorySessionStore();
    let fail = true;
    const store = {
      ...base,
      saveMessage: (...args: Parameters<typeof base.saveMessage>) => {
        if (fail) throw new Error('injected durable write failure');
        return base.saveMessage(...args);
      },
    };
    const agent = createAgent({ provider: mockProvider(), model: 'mock', sessionStore: store });
    await expect(
      queue.submit('write-failure', async (signal) =>
        drain(agent.run('first', { sessionId: 'write-failure', signal })),
      ),
    ).rejects.toThrow('session persistence failed');
    expect(queue.snapshot().active).toBe(0);
    fail = false;
    const result = await queue.submit('write-failure', async (signal) =>
      drain(agent.run('second', { sessionId: 'write-failure', signal })),
    );
    expect(result.terminal.reason).toBe('completed');
    expect(store.loadMessages('write-failure')).toHaveLength(2);
    await queue.shutdown();
  });

  test('rejects invalid limits and pre-aborted work without calling it', async () => {
    for (const value of [-1, 0, 1.5, Number.POSITIVE_INFINITY])
      expect(() => new SessionWorkQueue({ ...limits, maxActiveSessions: value })).toThrow();
    const queue = new SessionWorkQueue({
      maxActiveSessions: 1,
      maxQueued: 0,
      maxQueuedPerSession: 0,
    });
    const signal = AbortSignal.abort();
    await expect(
      queue.submit(
        'a',
        async () => {
          throw new Error('must not run');
        },
        signal,
      ),
    ).rejects.toMatchObject({ code: 'cancelled' });
    await queue.shutdown();
  });
});

for (const fault of ['disconnect', 'rate_limit', 'timeout']) {
  test(`offline provider ${fault} leaves queue admission usable`, async () => {
    const queue = new SessionWorkQueue(limits);
    const agent = createAgent({
      provider: {
        name: 'fault',
        // biome-ignore lint/correctness/useYield: fixture fails before its first stream event.
        async *stream() {
          throw new Error(`injected ${fault}`);
        },
      },
      model: 'mock',
    });
    const result = await queue.submit('fault', async (signal) =>
      drain(agent.run('go', { sessionId: 'fault', signal })),
    );
    expect(result.terminal.reason).toBe('error');
    expect(await queue.submit('fault', async () => 'next job')).toBe('next job');
    await queue.shutdown();
  });
}

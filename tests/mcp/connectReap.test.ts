// Regression for finding #42 — on a connect TIMEOUT the in-flight
// client.connect(transport) must be CANCELLED via an abort signal (not merely
// raced and abandoned), its late rejection must never surface as an
// unhandledRejection, and connectAndList must AWAIT the abandoned connect after
// closing the transport so a stdio child is reaped, not orphaned.

import { describe, expect, test } from 'bun:test';
import { connectAndList, connectWithTimeout } from '../../src/mcp/client.js';

type Calls = { transportClosed: number; clientClosed: number };

function fakeTimers() {
  let nextId = 1;
  const callbacks = new Map<number, () => void>();
  const setTimeoutFn = ((cb: () => void): number => {
    const id = nextId++;
    callbacks.set(id, cb);
    return id;
  }) as unknown as typeof setTimeout;
  const clearTimeoutFn = (() => {}) as unknown as typeof clearTimeout;
  const fire = () => {
    for (const cb of [...callbacks.values()]) cb();
  };
  return { setTimeoutFn, clearTimeoutFn, fire };
}

describe('connect timeout — cancel + reap (finding #42)', () => {
  test('connectWithTimeout threads an abort signal and aborts the connect on timeout', async () => {
    const timers = fakeTimers();
    let seenSignal: AbortSignal | undefined;
    const client = {
      connect: (_t: unknown, options?: { signal?: AbortSignal }) => {
        seenSignal = options?.signal;
        // A connect that only settles when its signal is aborted (the SDK
        // behaviour we rely on: the signal cancels the in-flight initialize).
        return new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      },
    };

    const promise = connectWithTimeout(client as never, {} as never, 50, {
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    timers.fire(); // trip the timeout

    await expect(promise).rejects.toThrow(/timeout/i);
    // The connect was actually handed a signal, and the timeout aborted it.
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal?.aborted).toBe(true);
  });

  test('a late rejection of the abandoned connect does not surface as unhandledRejection', async () => {
    const timers = fakeTimers();
    let rejectConnect: ((e: Error) => void) | undefined;
    const client = {
      connect: () =>
        new Promise<void>((_resolve, reject) => {
          rejectConnect = reject;
        }),
    };

    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      seen.push(reason);
    };
    process.on('unhandledRejection', onUnhandled as never);

    try {
      const promise = connectWithTimeout(client as never, {} as never, 50, {
        setTimeoutFn: timers.setTimeoutFn,
        clearTimeoutFn: timers.clearTimeoutFn,
      });
      timers.fire();
      await expect(promise).rejects.toThrow(/timeout/i);

      // The abandoned connect now rejects LATE, after the timeout was thrown.
      rejectConnect?.(new Error('late connect failure'));
      // Let microtasks + a macrotask flush so any unhandledRejection would fire.
      await new Promise((r) => setTimeout(r, 20));

      expect(seen.length).toBe(0);
    } finally {
      process.off('unhandledRejection', onUnhandled as never);
    }
  });

  test('connectAndList closes the transport AND reaps the abandoned connect on timeout', async () => {
    const timers = fakeTimers();
    const calls: Calls = { transportClosed: 0, clientClosed: 0 };
    let connectSettledObserved = false;

    const transport = {
      async start() {},
      async send() {},
      async close() {
        calls.transportClosed++;
      },
    };
    const client = {
      // Settles only once aborted — mirrors the SDK cancelling its connect.
      connect: (_t: unknown, options?: { signal?: AbortSignal }) =>
        new Promise<void>((resolve) => {
          options?.signal?.addEventListener('abort', () => {
            connectSettledObserved = true;
            resolve();
          });
        }),
      listTools: async () => ({ tools: [{ name: 'echo' }] }),
      async close() {
        calls.clientClosed++;
      },
    };

    const promise = connectAndList(client as never, transport as never, 50, {
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    timers.fire(); // trip the connect timeout

    await expect(promise).rejects.toThrow(/timeout/i);
    expect(calls.transportClosed).toBeGreaterThanOrEqual(1);
    // The abandoned connect was reaped (it settled via the abort, and
    // connectAndList awaited it) rather than left orphaned.
    expect(connectSettledObserved).toBe(true);
  });

  test('connectAndList teardown is not wedged by a connect that never settles', async () => {
    const timers = fakeTimers();
    const calls: Calls = { transportClosed: 0, clientClosed: 0 };
    const transport = {
      async start() {},
      async send() {},
      async close() {
        calls.transportClosed++;
      },
    };
    const client = {
      // Never settles and ignores the abort + transport.close — the bounded
      // reap must still let teardown complete (the rejection is swallowed).
      connect: () => new Promise<void>(() => {}),
      listTools: async () => ({ tools: [{ name: 'echo' }] }),
      async close() {
        calls.clientClosed++;
      },
    };

    const promise = connectAndList(client as never, transport as never, 50, {
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    timers.fire();

    // Must reject with the timeout within the reap budget, not hang forever.
    await expect(promise).rejects.toThrow(/timeout/i);
    expect(calls.transportClosed).toBeGreaterThanOrEqual(1);
  }, 10_000);
});

// Focused tests for the connect-timeout race in the MCP client pool.
//
// The race must NOT leak its timer: a successful connect (the common path,
// and the one that matters for short-lived processes — one-shot CLI,
// per-request OpenAI/cron pools, tests) must clear the pending reject timer
// so it never keeps the event loop alive past exit.
//
// The timer functions are injected so we can assert clear-on-settle without
// touching real timers or the global event loop.

import { describe, expect, test } from 'bun:test';
import { connectWithTimeout } from '../../src/mcp/client.js';

type FakeClient = { connect: (transport: unknown) => Promise<void> };

/** Injectable timer pair that records set/clear calls and lets the caller
 *  drive the registered timeout callback manually. */
function fakeTimers() {
  let nextId = 1;
  const set = new Set<number>();
  const cleared: number[] = [];
  const callbacks = new Map<number, () => void>();
  const setTimeoutFn = ((cb: () => void): number => {
    const id = nextId++;
    set.add(id);
    callbacks.set(id, cb);
    return id;
  }) as unknown as typeof setTimeout;
  const clearTimeoutFn = ((id: number): void => {
    cleared.push(id);
    set.delete(id);
  }) as unknown as typeof clearTimeout;
  return {
    setTimeoutFn,
    clearTimeoutFn,
    /** Timer ids still pending (set but not cleared). */
    pending: () => [...set],
    cleared,
    fire: (id: number) => callbacks.get(id)?.(),
  };
}

describe('connectWithTimeout', () => {
  test('clears the timeout timer on a successful connect (no dangling timer)', async () => {
    const timers = fakeTimers();
    const client: FakeClient = { connect: async () => {} };

    await connectWithTimeout(client as never, {} as never, 15_000, {
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    // The timer that would reject after 15s must have been cleared, so it
    // can't keep a short-lived process's event loop alive.
    expect(timers.cleared.length).toBe(1);
    expect(timers.pending()).toEqual([]);
  });

  test('clears the timeout timer even when connect rejects', async () => {
    const timers = fakeTimers();
    const client: FakeClient = {
      connect: async () => {
        throw new Error('connect failed');
      },
    };

    await expect(
      connectWithTimeout(client as never, {} as never, 15_000, {
        setTimeoutFn: timers.setTimeoutFn,
        clearTimeoutFn: timers.clearTimeoutFn,
      }),
    ).rejects.toThrow(/connect failed/);

    expect(timers.pending()).toEqual([]);
  });

  test('rejects with a timeout error when the timer fires before connect', async () => {
    const timers = fakeTimers();
    let resolveConnect: (() => void) | undefined;
    const client: FakeClient = {
      connect: () =>
        new Promise<void>((resolve) => {
          resolveConnect = resolve;
        }),
    };

    const promise = connectWithTimeout(client as never, {} as never, 50, {
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    // Fire the registered timeout callback before connect settles.
    for (const id of timers.pending()) timers.fire(id);

    await expect(promise).rejects.toThrow(/timeout/i);
    // Let the dangling connect settle so it doesn't leak past the test.
    resolveConnect?.();
  });
});

// FIX 4 — the connect path must never leak its transport (and, for stdio, the
// spawned subprocess) when the connect times out OR when listTools() throws
// after a successful connect. `connectAndList` wraps both steps and closes the
// transport on ANY failure, while leaving a healthy connection untouched.

import { describe, expect, test } from 'bun:test';
import { connectAndList } from '../../src/mcp/client.js';

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
    for (const cb of callbacks.values()) cb();
  };
  return { setTimeoutFn, clearTimeoutFn, fire };
}

/** A mock client+transport pair that records close() calls. `connect` and
 *  `listTools` behaviour are injectable. */
function mockPair(behavior: {
  connect: () => Promise<void>;
  listTools?: () => Promise<{ tools: Array<{ name: string }> }>;
}) {
  const calls: Calls = { transportClosed: 0, clientClosed: 0 };
  const transport = {
    async start() {},
    async send() {},
    async close() {
      calls.transportClosed++;
    },
  };
  const client = {
    connect: behavior.connect,
    listTools:
      behavior.listTools ??
      (async () => ({ tools: [{ name: 'echo' }] as Array<{ name: string }> })),
    async close() {
      calls.clientClosed++;
    },
  };
  return { client, transport, calls };
}

describe('connectAndList — leak-free failure handling', () => {
  test('closes the transport when the connect times out', async () => {
    const timers = fakeTimers();
    // A connect that never settles (a hung subprocess).
    const { client, transport, calls } = mockPair({
      connect: () => new Promise<void>(() => {}),
    });

    const promise = connectAndList(client as never, transport as never, 50, {
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    timers.fire(); // trip the timeout before connect settles

    await expect(promise).rejects.toThrow(/timeout/i);
    expect(calls.transportClosed).toBeGreaterThanOrEqual(1);
  });

  test('closes the transport when listTools throws after a successful connect', async () => {
    const timers = fakeTimers();
    const { client, transport, calls } = mockPair({
      connect: async () => {},
      listTools: async () => {
        throw new Error('listTools failed');
      },
    });

    await expect(
      connectAndList(client as never, transport as never, 5000, {
        setTimeoutFn: timers.setTimeoutFn,
        clearTimeoutFn: timers.clearTimeoutFn,
      }),
    ).rejects.toThrow(/listTools failed/);
    // A connected client must be torn down via its own close (which also closes
    // the transport in the real SDK); our mock records both seams.
    expect(calls.transportClosed + calls.clientClosed).toBeGreaterThanOrEqual(1);
  });

  test('does NOT close a healthy connection', async () => {
    const timers = fakeTimers();
    const { client, transport, calls } = mockPair({
      connect: async () => {},
      listTools: async () => ({ tools: [{ name: 'echo' }, { name: 'boom' }] }),
    });

    const listed = await connectAndList(client as never, transport as never, 5000, {
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    expect(listed.tools.map((t) => t.name)).toEqual(['echo', 'boom']);
    expect(calls.transportClosed).toBe(0);
    expect(calls.clientClosed).toBe(0);
  });
});

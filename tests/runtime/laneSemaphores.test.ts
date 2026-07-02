// Phase 13.4 — LaneSemaphores tests. A small wrapper that owns a Semaphore
// per lane (local / frontier) so the router (single-session escalations)
// and the sub-agent scheduler (parent dispatching N children) can share
// one set of caps. Both call sites acquire from the same instance so
// global limits apply regardless of who issues the request.

import { describe, expect, test } from 'bun:test';
import { LaneSemaphores } from '@yevgetman/sov-sdk/runtime/laneSemaphores';

describe('LaneSemaphores', () => {
  test('separate lanes have independent capacity', async () => {
    const lanes = new LaneSemaphores({ local: 1, frontier: 1 });
    const localR = await lanes.acquire('local');
    const frontierR = await lanes.acquire('frontier');
    // Both succeed immediately because the lanes don't share counters.
    expect(typeof localR).toBe('function');
    expect(typeof frontierR).toBe('function');
    localR();
    frontierR();
  });

  test('local lane serializes correctly when capacity is 1', async () => {
    const lanes = new LaneSemaphores({ local: 1, frontier: 4 });
    const order: number[] = [];
    const job = (n: number) =>
      lanes.acquire('local').then(async (release) => {
        order.push(n);
        // Hold briefly to ensure the next waiter actually queues.
        await new Promise((r) => setTimeout(r, 1));
        release();
      });
    await Promise.all([job(1), job(2), job(3)]);
    expect(order).toEqual([1, 2, 3]);
  });

  test('defaults expose unlimited concurrency when caps are not set', async () => {
    const lanes = new LaneSemaphores({});
    // We can acquire many times without blocking when caps are undefined.
    const releases = await Promise.all([1, 2, 3, 4, 5].map(() => lanes.acquire('local')));
    expect(releases).toHaveLength(5);
    for (const r of releases) r();
  });

  test('AbortSignal cancels a queued acquisition', async () => {
    const lanes = new LaneSemaphores({ local: 1 });
    const r1 = await lanes.acquire('local');
    const ctl = new AbortController();
    const queued = lanes.acquire('local', ctl.signal);
    setTimeout(() => ctl.abort(), 5);
    await expect(queued).rejects.toThrow(/abort/i);
    r1();
  });
});

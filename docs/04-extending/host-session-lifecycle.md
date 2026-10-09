# Host session ownership and shutdown

`SessionWorkQueue` is an optional, portable in-process host helper. It provides
one active callback per session, bounded admission and joined shutdown. Creating
an agent remains memory-only by default; this helper creates no files or stores.
It does not choose a deployment model or replace a durable cross-process lease.

## Use one owner for all writers

Create one queue instance for every writer sharing the same host-owned store.
Give it explicit caps; the example values below are illustrative, not a supported
production capacity. Load history inside the callback, after it acquires ownership.
Await the entire generator and persistence before returning the callback result.

```ts
import { SessionWorkQueue, createAgent, createInMemorySessionStore } from '@yevgetman/sov-sdk';
import type { Message } from '@yevgetman/sov-sdk';

const store = createInMemorySessionStore();
const agent = createAgent({ provider, model, sessionStore: store });
const queue = new SessionWorkQueue({
  maxActiveSessions: 4,
  maxQueued: 128,
  maxQueuedPerSession: 8,
});

const result = await queue.submit(sessionId, async (signal) => {
  const input: Message[] = store.loadMessages(sessionId)
    .map(({ role, content }) => ({ role, content }));
  input.push({ role: 'user', content: [{ type: 'text', text }] });
  const run = agent.run(input, { sessionId, signal });
  for (;;) {
    const step = await run.next();
    if (step.done) return step.value;
    // Send events through the host's chosen transport here.
  }
}, requestSignal);

await queue.shutdown(false); // close admission; join active work
```

A callback that launches work without awaiting it creates an orphan the queue
cannot track or join. The callback owns that work. All writers must use the same
queue, including routes that change model/session metadata. Multiple queue
instances, processes or workers have independent ownership. Do not treat this
helper as a distributed lease or a storage transaction.

## Admission, cancellation and failures

Independent sessions run concurrently up to `maxActiveSessions`. Jobs for each
session retain FIFO order. Waiting jobs count toward `maxQueued` and
`maxQueuedPerSession`; rejected jobs never call their callbacks. Zero queue caps
allow immediately runnable work and reject work that would wait.

`SessionWorkQueueError.code` distinguishes `queue_full`, `cancelled`, and `closed`.
The host chooses the transport response and retry policy. Running callbacks
receive a signal. When cancelled, a callback is joined before its submit promise
rejects, even if it ignores the signal. A queued cancelled job is removed without
running. Other callback exceptions propagate unchanged and release ownership.
Persistence failure must remain visible to the owner; the queue does not retry
or replay model calls or external effects.

`shutdown()` closes admission, rejects queued jobs and aborts active signals.
`shutdown(false)` closes admission and joins active jobs without aborting them.
A later call can escalate graceful shutdown to cancellation. Both modes wait
for every started callback. An uncooperative callback can keep shutdown pending;
a timeout that returns early would abandon work and is not supplied here.
`snapshot()` exposes counts and closed state, without owner text or session ids.

## Restart and limits

Queue state is memory-only and is lost on process death. The host must reload
its durable transcript and repair interrupted tool-result adjacency before
resuming. Preserve raw stored history and explicitly pass the repaired
`storedPrefixLength` when applicable. Do not replay an interrupted external tool
without a separate idempotency contract. The host-only SQLite restart fixture
proves this repair boundary; it does not prove exactly-once effects.

The deployment envelope, cross-process ownership, remote persistence, durable
admission and restart scheduling remain host decisions. See
[offline evidence](../07-history/audits/2026-10-09-host-lifecycle-evidence.md) for
measured TEST limits and rerun commands.

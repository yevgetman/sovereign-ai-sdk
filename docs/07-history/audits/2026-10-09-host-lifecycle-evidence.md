# Offline host lifecycle evidence — 2026-10-09

This measures an explicit **TEST envelope**, not certified production capacity.
No production deployment or distributed infrastructure has been selected.
No live provider call, owner database or paid service is used.

## Reproduce

Install the frozen dependencies. Build the SDK for Node package resolution.
Run `bun scripts/bench/host-lifecycle.ts` and
`node scripts/bench/host-lifecycle.ts`; each prints an independent JSON report.
Use `bun test tests/host packages/sdk/tests/surface.test.ts` for deterministic
fault, cancellation, history and restart assertions. Build the TUI before the
full suite. Packed Node/Bun consumers also exercise the public queue contract.

## Declared test envelope

16 sessions, eight turns per session, 32 seeded history messages per session,
512 characters per message, a scripted 2 ms provider delay, four active
sessions, 128 global queued jobs and eight queued jobs per session.
Every run completed 128 turns. Peak reservations were four active sessions and
124 queued jobs. After shutdown, active and queued counts were zero.
Final persisted history contained 768 messages; serialized bytes are measured
per run because fixture row ids and timestamps affect the encoding.
Event-loop delay is timer drift sampled every 5 ms, rather than a provider or
kernel scheduling guarantee. Memory values are process RSS and are sampled;
short allocations between samples can escape the observed peak.

## Repeat measurements

macOS arm64; Bun 1.3.13 and Node 25.9.0. Three fresh-process runs per runtime.

| Runtime / run | Duration ms | Queue wait p95 ms | Total latency p95 ms | Event-loop max ms | Peak RSS MiB | History bytes |
|---|---:|---:|---:|---:|---:|---:|
| bun / 1 | 93.35 | 87.90 | 90.37 | 2.45 | 123.98 | 518843 |
| bun / 2 | 94.15 | 84.60 | 88.08 | 2.20 | 127.38 | 518959 |
| bun / 3 | 109.45 | 91.44 | 95.15 | 2.78 | 124.92 | 518709 |
| node / 1 | 86.67 | 81.88 | 83.97 | 2.51 | 127.59 | 518831 |
| node / 2 | 89.14 | 84.29 | 86.39 | 1.41 | 126.98 | 518833 |
| node / 3 | 88.70 | 81.39 | 84.75 | 1.29 | 125.78 | 518777 |

## Fault and restart evidence

Promise-gated tests verify per-session serialization, independent sessions,
global/per-session admission overflow, queued cancellation, active cancellation,
shutdown escalation and joined uncooperative callbacks. Public agent integration
reloads history after prior writes. An injected store failure rejects the job,
releases ownership and permits later admission. Scripted disconnect, rate-limit
and timeout errors produce visible error terminals without wedging the queue.
These represent callback failure paths; they do not model real retry headers or
remote-provider availability.

The host-only SQLite test starts a real subprocess with explicit temporary home
and WAL database. It waits for the assistant tool-use boundary to be persisted,
then kills only that fixture subprocess. A new subprocess loads the two durable
rows, repairs the missing result in model context, and resumes without replaying
the tool. Raw stored history remains unchanged; only the new user and reply append.
SQLite integrity checks pass. The fixture never opens the owner's profile.

## Limits

The short load runs are not a sustained soak, distributed load test or service
level objective. There is no external-effect idempotency certification.
Queue callbacks must await their own work; orphan tasks fall outside ownership.
Shutdown remains pending for uncooperative active work. SIGKILL recovery concerns
transcript integrity, not completion of lost work. Production history limits,
provider throughput, worker count and durable leases remain owner/host decisions.

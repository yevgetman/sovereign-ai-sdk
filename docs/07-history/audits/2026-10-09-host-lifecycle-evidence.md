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

## Bounded 30-second offline soak

Run `bun scripts/bench/host-lifecycle.ts --duration-seconds 30` and
`node scripts/bench/host-lifecycle.ts --duration-seconds 30` in fresh processes.
The argument accepts a positive duration up to 300 seconds. It starts complete
128-turn cohorts until the duration expires, then joins the last cohort before
shutdown. A scripted provider disconnect occurs every 97th request in soak mode.
The default single-cohort load mode injects no errors.

History is explicitly bounded: each joined cohort rotates to a fresh in-memory
store and 16 new session ids. Each session begins with 32 seed messages and can
store at most 48 messages. Only the last cohort's rows remain referenced by the
report. This measures repeated queue/agent ownership, not growth of one permanent
conversation. Telemetry retains the last 4,096 observations per metric; reported
p50/p95 values describe that retained window. Max values and counters cover the
whole run. An unexpected error, cancellation or rejected admission fails the run.

Both runtimes ran on the same Mac while other offline source checks ran. These
are observed values on a shared test host, not an isolated throughput comparison.

| Runtime | Elapsed seconds | Cohorts | Attempted turns | Completed | Injected provider errors | Start / final / peak RSS MiB | Queue p95 ms | Latency p95 ms | Event-loop max ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| bun | 30.076 | 343 | 43904 | 43452 | 452 | 86.98 / 211.91 / 211.91 | 82.87 | 85.57 | 18.80 |
| node | 30.018 | 324 | 41472 | 41045 | 427 | 110.02 / 249.48 / 249.48 | 91.31 | 94.52 | 17.02 |

Both runs recorded zero admission failures, unexpected errors and cancellations.
Peak admission stayed at four active and 124 queued jobs. After every started
job was joined, shutdown reported zero active and queued jobs. Both retained
16 sessions, one cohort, and at most 48 messages per session. No owner data or
real-provider call was used. Full raw reports:
[Bun](2026-10-09-host-soak-bun.json), [Node](2026-10-09-host-soak-node.json).

RSS increased materially during the observed window. Those samples do not prove
memory stability, absence of leaks or a sustainable production capacity. Longer
runs with controlled host load and heap/GC profiling would be needed to explain
the growth. This 30-second offline soak supplies a bounded repeatability check,
not an operational service-level promise.

## Limits

The 128-turn load samples and the separate 30-second offline soak are not a
distributed load test, production certification or service-level objective. There is no external-effect idempotency certification.
Queue callbacks must await their own work; orphan tasks fall outside ownership.
Shutdown remains pending for uncooperative active work. SIGKILL recovery concerns
transcript integrity, not completion of lost work. Production history limits,
provider throughput, worker count and durable leases remain owner/host decisions.

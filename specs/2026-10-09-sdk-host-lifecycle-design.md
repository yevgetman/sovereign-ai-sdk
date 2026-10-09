# Portable host session lifecycle — bounded in-process ownership

**Scope:** independent portion of issue #15, authorized by the owner to address
all review issues through PRs. This additive helper does not choose Kernel's
production deployment. A distributed lease/storage design remains an owner decision.

## Contract

Export `SessionWorkQueue` with explicit active-session, global queued-job and
per-session queued-job caps. Keep one active callback for each session id.
Independent sessions may run concurrently. Queue jobs in FIFO order per session.
Reject excess admission before any callback begins. Cancellation removes a
queued job; running cancellation signals its callback and waits for completion.
Shutdown closes admission, rejects queued work, optionally signals active work,
and joins every started callback. No timeout may abandon started work.

Callbacks must await the complete agent generator, tool work and persistence.
Failures propagate unchanged and release session ownership. Do not retry failed
persistence, infer zero cost, replay tools or claim atomic external effects.
This queue has memory-only state, creates no files and never imports the
proprietary SQLite implementation. One instance coordinates one host's writers;
other instances/processes need an independently supplied durable lease.

## Evidence

Public API tests cover serialization, independent sessions, admission caps,
queued cancellation, uncooperative callback shutdown, failed durable writes,
provider error outcomes and recovery of admission. A separate host-only test
kills an isolated fixture subprocess after its assistant tool call is persisted
in a temporary SQLite WAL store. A new subprocess repairs model context without
rewriting raw history or rerunning the interrupted tool. No owner profile opens.

A repeatable mock-provider benchmark records queue latency, total latency, RSS,
event-loop delay samples, history size and peak admission for an explicit TEST
envelope. This is local measurement, not a production capacity certification.
Packed Node/Bun consumers exercise the additive public contract.

## Limits and remaining decisions

No distributed lease, async store, durable queue, crash-safe tool idempotency,
production envelope or hard shutdown deadline is introduced. An uncooperative
callback keeps shutdown pending. SIGKILL necessarily prevents cooperative join;
restart tests prove durable-history recovery, not completion of lost effects.
SDK additive API additions require a minor release under the stability policy;
this work does not authorize that release.

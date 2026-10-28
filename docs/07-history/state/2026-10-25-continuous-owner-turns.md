# Continuous owner turns

Unreleased work on `feat/continuous-owner-turns`. The public release remains SDK 0.16.3 and SOV 0.6.83. Do not treat this branch as installed.

An owner turn runs until it finishes, the owner stops it, it needs input, or a concrete failure blocks safe progress. There is no default ceiling on model calls, tool calls, segments, tokens, cost, or elapsed time. `null` means unlimited. An explicit SDK, parent, child, job, or `--deadline-ms` limit stays binding, and a child `null` cannot clear a parent ceiling.

Toolsets select tools. They do not set a call budget. The model and tool loop stays continuous. The host yields a new segment only when the next request needs compaction or an unsafe tool receipt is open. That yield is not a model call. Version-1 stored numeric ceilings and deadlines remain binding. A cancelled turn does not resume by itself.

The 2026-10-24 JulieWajo11Bot cancellation was a missing route, provider, and auth on `turn.continuing`. Telekit rejected that progress event and killed the child. The configured ceiling was 100 calls. The continuation event now carries the same route metadata as the terminal events.

`sov capabilities` advertises `continuousOwnerTurns`. Telekit reads that capability, not `sov routes`. On a capable SOV owner turn, a product-default timeout becomes no deadline. An explicit user or host limit stays. Codex and Claude timeouts are unchanged. Merge the SDK capability before or with the Telekit adapter.

Verification on 2026-10-25: `bun run lint`, `bun run typecheck`, and `env -u FORCE_COLOR bun run test` (**6738 pass / 31 skip / 0 fail**). No live provider, install, upgrade, or service restart.

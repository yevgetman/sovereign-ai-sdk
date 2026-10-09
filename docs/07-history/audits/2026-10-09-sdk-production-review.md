# SDK production review — 2026-10-09

**Verdict: retain the architecture and harden its lifecycle contracts before
using it as Kernel's production general-purpose harness.** The extracted SDK is
real and consumable. The production feature set is uneven across its consumers.
This is a focused review, not a certification that the codebase is bug-free.

## Scope and baseline

Reviewed `origin/master` at `3709b25` (runtime 0.6.75, SDK 0.12.0). The owner's
existing checkout was four commits behind and had unrelated instruction changes.
Review and documentation work used an isolated worktree of the remote source.

The source review followed `createAgent` → `query` → tool dispatch, scheduler
resources, persistence ports, OpenAI streaming, toolsets, package exports and CI.
It also examined gateway compaction and the new native headless SDK route host.
All reproduction fixtures used mock providers, memory state and local streams.
No paid model call, login, deployment or runtime modification was performed.

Reference checkouts were inspected at:

- Qwen Code: `8de1bcb2799e3c951968633c68aa56ec077fd128`.
- Hermes Agent: `e97923c38acba2066aff9c45e35fe1584a2155b2`.

These are local source snapshots, not a claim about the latest upstream release.
Comparison focused on context compression and child capability composition.
It is not an exhaustive feature-parity audit of Qwen, Hermes or Claude Code.

## What is already sound

- An async-generator agent loop with typed content blocks and injectable ports.
- Real Node/Bun package artifacts and installed-tarball purity/consumer checks.
- A machine-enforced boundary between MIT packages and proprietary host code.
- Provider selection, routing, usage accumulation, hooks, skills and MCP tools.
- A scheduler with per-parent caps, lane semaphores, path scopes and cancellation.
- Four turn toolsets: `chat`, `web`, `ops`, `coding`. Filtering narrows a supplied
  pool. Unknown toolsets fail before inference.
- Thousands of tests and explicit consumer/stability policies.

The July extraction was meaningful. A rewrite is not justified by the evidence
from this pass. Better models can help review and implement changes, but they
do not replace reproducible behavior and production checks.

## Reproduced defects

| ID | Severity | Trigger and consequence | Correction and tracking |
|---|---|---|---|
| F1 | High | Early exit from `parseSse()` leaves the body locked and uncancelled. Repeated abandoned turns can retain upstream resources. | Cancel unfinished streams and release readers in `finally`. [#10](https://github.com/yevgetman/sovereign-ai-sdk/issues/10) |
| F2 | High | A text chunk followed by EOF without completion becomes `terminal.reason=completed`. Consumers accept an incomplete answer as final. | Validate terminal stream state and return a typed incomplete-stream error. [#11](https://github.com/yevgetman/sovereign-ai-sdk/issues/11) |
| F3 | High | A 10 ms child deadline remains pending beyond 70 ms when a lane slot is held. The timeout starts after queue acquisition. | Start an absolute deadline before all waits. [#12](https://github.com/yevgetman/sovereign-ai-sdk/issues/12) |
| F4 | Medium | A throwing `resolveLane` leaves a reserved parent slot. A cap of one then rejects every retry despite no active child. | Cover resolution in the reservation's `finally`. [#13](https://github.com/yevgetman/sovereign-ai-sdk/issues/13) |
| F5 | High | A permission callback rejects during a concurrent batch. The turn returns an error while a slow sibling still runs; its side effect occurs after terminal return. | Contain per-tool failures and join every started sibling before returning. [#14](https://github.com/yevgetman/sovereign-ai-sdk/issues/14) |

Locations at the reviewed commit:

- F1: `packages/sdk/src/providers/openai.ts:720-750`.
- F2: `packages/sdk/src/providers/openai.ts:398-508`.
- F3: `packages/sdk/src/runtime/scheduler.ts:291-304,382-390`.
- F4: `packages/sdk/src/runtime/scheduler.ts:280-291`.
- F5: `packages/sdk/src/core/orchestrator.ts:226-235,447-449` and
  `packages/sdk/src/core/query.ts:687-713`.

Acceptance criteria and isolated evidence are in the linked issues. Suspected
security concerns are handled privately under the package's disclosure policy;
this public record contains no security reproductions.

## Kernel capability matrix

| Requirement | Current evidence | Production gap |
|---|---|---|
| General-purpose toolsets | `tool/toolset.ts` implements four fixed name filters. `coding` permits the assembled pool. | No public custom hierarchy/registry with named capability inheritance. MCP capabilities cannot be assigned to `web`/`ops` through this fixed filter. |
| Long sessions | `compact/microcompact.ts` clears selected stale results. | Full summary compaction and overflow retry are in `src/server/routes/turns.ts` and `src/server/compactor.ts`, outside the SDK. A long current tool burst is protected from microcompaction eviction. |
| Native headless sessions | `src/cli/sdkRunCommand.ts` owns hydration, repair and persistence boundaries. | Context overflow is returned as an error directing the caller to a new session. Gateway compaction behavior is not shared by this host. |
| Sub-agents | `runtime/scheduler.ts` supplies native child loops, scoped writes and lane limits. | Child configuration does not carry the parent's full hook/recall/Conduct configuration or configurable full compaction. Patterned `allowedTools` entries are explicitly name-only at this layer. Define an inherited child policy contract. |
| Cost control | `RunResult` reports summed usage and estimated cost. | Scheduler child results omit usage/cost and trajectories use cost zero. No tree-wide token/spend budget or depth-wide resource accounting. |
| Persistent operation | Injectable `SessionStore`; production SQLite implementation in the host. | Port methods are synchronous. Per-session serialization, transactions, crash recovery and distributed leases remain host responsibilities. They are not guaranteed by `createAgent`. |
| Scale | In-process child caps and lane/path locks. | No cross-process admission or lock coordination; no bounded queue contract. A supported concurrency, queue and session-size envelope has not been established by load evidence. |
| Compatibility | Surface-name snapshots and packed Node/Bun canaries. | Type shapes/defaults are not mechanically frozen. The named Agent Casa downstream canary is still specified rather than implemented. |

These are gaps against the requested production bar, not proof that every item
belongs in the SDK. Distributed leases, deployment topology, tenant admission
and OS sandboxing normally belong to the host. Portable compaction, bounded
delegation and explicit policy composition are candidate SDK primitives.

## Reference lessons worth adopting

Qwen's `packages/core/src/services/chatCompressionService.ts` checks the actual
context threshold, preserves legal tool-call split points, and rejects empty
or inflated summaries. This is a useful acceptance model for an SDK compaction
port. Qwen's sub-agent manager passes child tool configuration explicitly.

Hermes `tools/delegate_tool.py` applies a configurable compression cap to child
agents via `_apply_child_compression_cap`. Its compressor is available to children
as well as parent conversations. This closes the surface inconsistency we have.

Adopt these contracts and tests. Do not copy an entire application into our SDK
or treat a large feature list as proof of quality.

## Process and documentation gaps

At review start, GitHub had no open issues or PRs. The repo has substantial
file-based backlog and prior PR history, but the active queue was not expressed
in GitHub issues. Both classic protection and effective branch rules were absent.

PR CI includes package tests, lint, boundary, types and packed consumers. Most
runtime tests and Go tests run only in release preflight. CI still selects Bun
1.2.0 while this local source check used 1.3.13 and release records identify a
verified 1.4.2 compiler. Align pins through an explicit tested compatibility floor;
do not copy the local version into workflows without checking that floor.

The README and agent router emphasize the old harness. Their latest-state
pointer is June, and the router's August cache/image warning is stale: current
`providers/openai.ts` emits cache markers and `mcp/toolWrapper.ts` forwards images.
SDK docs need host recipes for sessions, child policy, context lifetime, errors,
permissions and shutdown, beyond the existing successful-turn quickstart.

This documentation PR adds a contribution guide, issue/PR templates, the PR
workflow marker, an embedding operations guide, and a proposed hardening spec.
It aligns shipping instructions with PRs. It does not claim that branch rules,
full-suite PR CI or runtime fixes have been deployed.

## Validation

macOS arm64, Bun 1.3.13, locked dependencies, Go-built TUI:

- `bun run lint`: 998 files clean; boundary 212 modules / 717 dependencies clean.
- `bun run typecheck`: pass.
- `bun run test`: **5,488 pass / 19 skip / zero fail**, 5,507 tests across
  523 files, 22,440 assertions, 86.22 seconds.
- `bun run build` and `bun run canary`: pass; packed SDK/protocol consumers
  pass under Node and Bun and their installed-artifact purity checks pass.
- Final documentation gate: lint/types pass again; full suite 5,488 pass / 19 skip /
  zero fail, 22,440 assertions, 82.66 seconds.
- `go test ./...` in `packages/tui`: all six tested packages pass.
- Embedding recipe: two serialized turns pass; all new relative document links resolve.
- Five reliability probes and one private policy probe reproduced their cases.

The first full test run omitted the TUI build because dependency lifecycle scripts
were disabled in the isolated install. It failed 16 tests with one error, principally
missing-binary failures. After `bun run tui:build`, the complete unchanged suite
passed. No failing test was skipped to obtain the reported green result.

No live-provider semantic battery, load/soak test, crash-recovery exercise, complete
gateway tenant audit or dependency advisory scan was performed. Passing existing
tests and the package canary does not negate the separately reproduced defects.

## Read next

- [Contribution process](../../../CONTRIBUTING.md)
- [Embedding operations](../../04-extending/embedding-an-agent.md)
- [Proposed hardening spec](../../../specs/2026-10-09-sdk-production-hardening-design.md)

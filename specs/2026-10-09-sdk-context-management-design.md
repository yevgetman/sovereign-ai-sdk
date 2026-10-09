# Injected SDK context management

**Scope:** issue #15's portable context port and legacy persistence compatibility.
The owner approved addressing the review queue. This implements its proposed
injection boundary, not a new summarization engine or a license change.

## Contract

`ContextManagementPort.reduce()` receives a snapshot of model history, provider,
model, output token cap, cancellation signal and host limits. `ContextLimits`
requires an explicit UTF-8 JSON `maxHistoryBytes`; it may supply the model's
`contextWindowTokens`. Bytes are not presented as token estimates. The host owns
model discovery, tokenization, semantic summary quality and actual summarization.

AgentConfig, PerTurn and QueryParams accept optional contextManager/contextLimits.
Both must be supplied together. Omitted ports preserve existing behavior. Before
a provider request, history above the byte envelope goes through the port.
A genuine context overflow may trigger one reduction/retry across the run,
only before any provider event has become visible and before any tools dispatch.
The cap may be set to zero. Errors after output or external effects never replay.

A replacement must shrink, fit the byte envelope for proactive reduction, retain
the latest message verbatim, and contain valid complete adjacent tool-call/result
pairs with unique IDs. Empty/malformed histories and unresolved/orphan calls fail
closed. Model history is independent of createAgent's complete transcript and
verbatim persistence cursor. Summary messages are never persisted as user turns.

## Accounting and lifecycle

A content-free `context_management` stream event reports applied/rejected status,
reason, before/after bytes and optional host-supplied usage/cost. Valid billing
metadata is counted even when a replacement is rejected. Provider usage retains
its cumulative-per-call semantics; summary usage is added once. Main-provider
usage is priced at its own model; summary costs use the host's separate estimate.

Unknown summary cost makes aggregate estimatedCostUsd absent. Missing summary
usage makes the optional RunResult.usageComplete false. Legacy numeric-only
SessionStore.recordTokenUsage cannot express unknown aggregate cost: its combined
usage/cost write is skipped in that case. Hosts receive measured tokens in the
RunResult and events and must handle unpriced accounting separately. Transcript
messages remain durable. A future unpriced persistence capability is out of scope.

Cancellation is cooperative: the supplied port must observe its signal and settle.
The SDK awaits it, checks cancellation before accepting the replacement and does
not detach background work. An uncooperative host port cannot be forcibly stopped.

## Native children and compatibility

Native child policy carries the same optional AgentConfig port/limits explicitly.
The port is MIT interface/validation code; the existing proprietary compactor is
not imported, moved, or redistributed. A reusable compaction implementation's
license placement remains the owner's decision.

SessionStore.truncateMessages becomes an optional legacy capability. The built-in
in-memory store's concrete type retains the required method. If conduct
regeneration needs to undo early persisted writes and the method is missing,
RegenerationRollbackUnavailableError ends the run before replay. Ordinary legacy
stores keep working; no private consumer checkout changes are required.

## Validation

Deterministic tests cover defaults, per-turn override, parent context reduction,
full transcript rehydration without duplicate rows, early tool persistence,
complete tool adjacency, invalid replacements and rejected-summary accounting,
cooperative cancellation, overflow retry caps and no retry after output/tools.
Packed Node/Bun consumers validate the compiled API and lifecycle. Aggregate
native-child policy tests exercise inheritance after the independent policy work
is combined. No live model calls or installed runtime update are authorized here.

## Read next

- `packages/sdk/README.md`
- `docs/05-conventions/consumer-contract.md`
- `plans/2026-10-09-sdk-context-management.md`

# The SDK consumer contract

**A standing rule.** `@yevgetman/sov-sdk` has downstream consumers outside this repo.
This doc names them, names the surface they depend on, and states what changing that
surface obliges you to do. Read it before touching anything listed under "The pinned
surface."

The MIT open-core packages (`packages/sdk`, `packages/protocol`) are the *only*
supported consumption path. The harness, gateway, and learning layer are proprietary
and carry no external contract — consumers must never import them.

## The consumers

| Consumer | Repo | Consumes | How |
|---|---|---|---|
| **Agent Casa runtime** | `real-estate-agent-runtime` (private) | `@yevgetman/sov-sdk`, `@yevgetman/decorum` | In-process library with injected ports. Checkout `521a2ee` pins SDK 0.9.2; isolated candidate 0.13.0 tests pass. |
| **Kernel runtime / kernel-sweep** | `kernel-runtime` | `TurnLogRecord`, `TurnLogSink` SDK types | Vendored SDK 0.13.0 source pin; listed in draft runtime 0.50.68. |
| **Appleo / resume-as-code-platform** | `resume-as-code-platform` | the gateway (one process per account) | Out-of-process; not this contract. |
| **Kernel Mac app** | `kernel-installer` | the gateway (node-scoped sessions) | Out-of-process; not this contract. |

Agent Casa exercises the in-process engine; Kernel-sweep binds the public turn-log
types. Appleo and the Mac app use the gateway contract, not an SDK import. A pin
in source or a draft release manifest is not proof of deployment. Verify actual
imports with `rg "@yevgetman/sov-sdk" src/` in the consumer checkout. This inventory
records verified source use, not current customer or node activity.

## The pinned surface

Three runtime entry points, two injected ports, and a type surface. Verified against
Agent Casa checkout `521a2ee` on 2026-10-09. Kernel-sweep additionally binds
`TurnLogRecord` and `TurnLogSink` (`packages/kernel-sweep/src/sink.ts`).

**Runtime entry points** (called directly):

1. **`createAgent()`** — the composition entry. One agent composed per turn from
   provider + model + system prompt + tools + an injected `SessionStore`.
2. **`buildTool()`** — the tool-declaration factory. Every workspace tool the consumer
   defines is built through it.
3. **`resolveProvider()`** — the provider factory (`resolveProvider('anthropic', …)`).

**Injected ports** (the consumer supplies the implementation; the SDK calls it):

4. **`SessionStore`** — the persistence port. Agent Casa injects a SQLite-backed
   implementation so all history and usage land in its own database.
5. **`LLMProvider`** — the model port. Both a mock (deterministic, offline) and
   Anthropic are built behind it; swapping is a config change.

**Type surface** (exported types the consumer's own signatures are written against —
changing their shape is as breaking as changing a function):
`AssistantMessage` · `Message` · `StreamEvent` · `RunResult` · `StoredMessage` ·
`SystemSegment` · `Session` · `CreateSessionInput` · `SaveMessageInput` · `TokenUsage` ·
`ProviderRequest` · `ConductProvider` · `MicrocompactConfig` · `MicrocompactInfo`.

## The named behavioral invariant — verbatim rehydration

**The SDK persists conversation history and expects the caller to hand back a history
head that byte-for-byte matches what was previously stored.** If the supplied head
diverges — a reordered message, a stripped row, an edited character — the SDK treats it
as a seed to persist in full; a host that supplies already-stored content can
therefore duplicate rows. `PerTurn.storedPrefixLength` is an explicit host assertion
that overrides prefix comparison. Derive it from stored rows under the single-writer
lock; an incorrect boundary can omit or duplicate content.

This is a **contract, not an implementation detail.** Consumers have built real
constraints on it: Agent Casa never scrubs blocked replies from history, serializes
every writer to a session through a single turn queue, and re-keyed sessions during a
schema migration without touching a byte of message content — all *because* of this
invariant. A change to rehydration semantics is breaking even if every type signature
is unchanged.

## Obligations when you change the surface

A change to the listed entry points/ports, either consumer's exported type shapes, or the
rehydration invariant:

- is **semver-major**, or minor with an explicit migration note in the changelog;
- requires the **downstream canary green** before release (see below);
- must be called out in the SDK-scoped section of the changelog — separately from
  harness changes, which consumers do not read.

Additive-only changes (new optional fields, new exports) are minor. The 0.8.0
attestation-evidence release is the model: two optional Conduct Port additions,
byte-identical when unused, tested as such.

## The downstream canary

Run Agent Casa's actual suite against the packed SDK before upgrading it. For
turn-log shape changes, also typecheck and run the affected Kernel-sweep checks
against its candidate pin. Compatibility evidence does not upgrade either consumer. The
isolated runner and manual CI workflow are documented in
[production gates](production-pr-gates.md). If it fails, fix the SDK or land an
explicit migration; do not replace actual consumer evidence with an export-only
fixture.

> **Status:** actual local runner implemented. Private CI requires a read-only
> `AGENT_CASA_READ_TOKEN`; automatic checks on every SDK PR are not enabled.
> The original supply-line specification is `me/projects/agent-casa-supply-line.md`
> WS-C. Until private CI is configured, run the real isolated consumer locally
> whenever the pinned surface changes.

## Why this exists

Agent Casa upgraded 0.1.0 → 0.7.0 in one step with no call-site rewrites, purely
because it consumes only the public surface and injects its own ports. That discipline
is the asset. This doc exists so the next change doesn't spend it by accident.

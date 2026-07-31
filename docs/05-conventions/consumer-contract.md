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
| **Agent Casa runtime** | `real-estate-agent-runtime` (private) | `@yevgetman/sov-sdk`, `@yevgetman/decorum` | In-process library; injects its own ports. Pinned exact version. |
| **Appleo / resume-as-code-platform** | `resume-as-code-platform` (private) | the gateway (one process per account) | Out-of-process; not this contract. |
| **Kernel Mac app** | `kernel-installer` (private) | the gateway (node-scoped sessions) | Out-of-process; not this contract. |

Only Agent Casa consumes the SDK as an in-process library, so it is the contract's
binding case. Verify the surface below against its imports before assuming it's stale:
`grep -rn "from '@yevgetman/sov-sdk'" src/` in that repo.

## The pinned surface

Three runtime entry points, two injected ports, and a type surface. Verified against
Agent Casa 2026-07-31.

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
as a new conversation and re-persists the entire history, permanently duplicating rows.

This is a **contract, not an implementation detail.** Consumers have built real
constraints on it: Agent Casa never scrubs blocked replies from history, serializes
every writer to a session through a single turn queue, and re-keyed sessions during a
schema migration without touching a byte of message content — all *because* of this
invariant. A change to rehydration semantics is breaking even if every type signature
is unchanged.

## Obligations when you change the surface

A change to any of the five entry points/ports, the exported type shapes, or the
rehydration invariant:

- is **semver-major**, or minor with an explicit migration note in the changelog;
- requires the **downstream canary green** before release (see below);
- must be called out in the SDK-scoped section of the changelog — separately from
  harness changes, which consumers do not read.

Additive-only changes (new optional fields, new exports) are minor. The 0.8.0
attestation-evidence release is the model: two optional Conduct Port additions,
byte-identical when unused, tested as such.

## The downstream canary

CI in this repo builds Agent Casa's test suite against SDK `HEAD` so breaks surface at
commit time, not at upgrade time. If it goes red, you broke a consumer — fix it here or
land a migration note; don't route around it.

> **Status:** specified, not yet built (spec: `me/projects/agent-casa-supply-line.md`,
> WS-C). Until it exists, changes to the pinned surface must be verified by hand
> against the consumer repo.

## Why this exists

Agent Casa upgraded 0.1.0 → 0.7.0 in one step with no call-site rewrites, purely
because it consumes only the public surface and injects its own ports. That discipline
is the asset. This doc exists so the next change doesn't spend it by accident.

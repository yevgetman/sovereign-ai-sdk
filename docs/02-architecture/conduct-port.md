# Conduct Port

The **Conduct Port** is the SDK's vendor-neutral seam set for an *agent-behavior
governance engine* — the choke points where persona, input gating, tool policy,
and output delivery can be shaped by an external provider. The SDK owns the
seams; a bound engine owns the policy. The first consumer is **decorum** (the
Conduct & Persona Engine); the SDK imports nothing from it.

The whole surface is one optional interface, `ConductProvider`
(`packages/sdk/src/core/conductPort.ts:116`), barrel-exported from
`@yevgetman/sov-sdk/core/conductPort`. Every capability is optional. **Absent a
bound provider, behavior is byte-identical to today** — the null-provider
invariant, pinned by the whole existing suite plus the dedicated contract tests.

## Seam map (as landed)

| Seam | Where it fires | Anchor |
|------|----------------|--------|
| `personaSegments` | system-prompt composition, after the cacheable prefix | `packages/sdk/src/agent/createAgent.ts:275` (via `insertPersonaSegments`, `core/conductSegments.ts`) |
| `preGate` | over the FINAL post-rewrite user text (after the UserPromptSubmit hook) | `packages/sdk/src/core/query.ts:183` |
| `triage` | once, pre-model; fail-open; `refuse` short-circuits to a refusal | `packages/sdk/src/core/query.ts:234` |
| `toolPolicy` | deny-first wrapper OUTSIDE the `canUseTool` cascade | `packages/sdk/src/agent/createAgent.ts:343` → `composeConductCanUseTool` (`core/conductToolPolicy.ts:11`) |
| `outputGuard` | drive loop: `onDelta` hold + `onFinal` replace/block | `packages/sdk/src/agent/createAgent.ts:410` (delta) / `:420` (final), via `substituteAssistantText` (`core/conductOutput.ts`) |
| `allowPerTurnInstructions` (D23) | gateway wire boundary — drops `PostTurnRequest.instructions` | `src/server/routes/turns.ts:308` |

The wrapper binds one provider per runtime (`RuntimeOptions.conduct` →
`Runtime.conduct`, `src/server/runtime.ts:301`/`:436`), threaded onto every
`SessionContext`. The other surfaces thread the same reference: channels
(`src/channels/pipeline.ts:200`), cron (`src/cron/wiring.ts:251`), OpenAI-compat
(`src/openai/routes/chatCompletions.ts:292`), missionRun
(`src/cli/missionRun.ts:284`). The behavioral proof of a full gated gateway turn
lives in `tests/server/turnsConduct.test.ts`; the no-bypass source proof in
`tests/conduct/seamCoverage.test.ts`.

## Surface discipline (D23)

Turns carry a `ConductSurface` — `'user'` or `'internal'`. Persona, preGate, and
triage run on **`'user'` turns only** (a sub-agent's internal sub-turns keep the
parent's persona and don't re-gate). `toolPolicy` and `outputGuard` are
**floors — they run on every turn**, internal ones included.

## Failure posture

Every SDK seam **fails open**: a throwing `personaSegments` falls back to the
base prompt, a throwing `triage`/`outputGuard` lets the original flow through.
The SDK never decides policy — it routes to the engine and degrades to
today's behavior on error. Deliberate denial (`preGate` deny, `triage` refuse,
`outputGuard` block) is an explicit verdict from the engine, not a failure.

## Subprocess trust boundary

A `ConductProvider` is an in-process object; **it cannot cross a process
boundary**. Sub-agents that run as subprocesses (`subprocessExecutor`) are a
NAMED trust boundary: the child re-binds its own provider at boot from its own
config, exactly as it binds its own model and tools. The parent does not (and
cannot) inject its live provider into the child. This is by design, not a gap.

## Audit

Every stage emits a typed, **content-free** `ConductAuditEvent`
(`conductPort.ts:105`) to the optional `auditSink` — `stage`
(`persona`/`pregate`/`triage`/`tool`/`output`), `sessionId`, `surface`, a
`verdict` label, optional `latencyMs`, and `iso`. Never message text: verdict
labels, ids, and latency only. The sink is wrapped no-throw by the SDK.

## Boundaries & known caveats

- **missionRun's `conduct` opt is dangling by design.** The option is threaded
  (`src/cli/missionRun.ts:284`) but the CLI does not yet feed a provider into
  it; it's the seam for a future caller, kept honest rather than removed.
- **Zone-2 depth channel — ASSESSED in 1d, DEFERRED to 1f.** decorum's D29 §5
  anchored digest wants to sit at *true depth* — roughly four messages from the
  context end, just before the latest turn — so its identity re-anchoring lands
  where the model's attention is strongest. The port cannot express that today:
  a `SystemSegment` carries only `{ text, cacheable }`, and every provider passes
  the `system` array **separately from and ahead of** `messages`. A segment is
  structurally at position 0, before all history. Adding an additive
  `depth?: number` to the segment type is byte-neutral, but *honoring* it means
  lifting that segment out of the `system` array and splicing it into `messages`
  at `length - depth` — and that one semantic demand spreads into all three of
  the areas this task was told to stay out of: **(1) per-provider prompt
  formatting** — Anthropic (`systemToSdk` vs `messagesToSdk`), OpenAI, Ollama,
  and the mock each translate `system` and `messages` through separate paths and
  would each need depth-splicing, and a `SystemSegment` has no `role` to become a
  message with; **(2) caching** — Anthropic marks a contiguous stable *system*
  prefix and separately caches the trailing three messages (`cacheFrom =
  length - 3`); a block spliced into mid-history lands inside that rolling window
  and shifts the boundary every turn, breaking the "stable content stays
  contiguous" contract that `insertPersonaSegments` upholds; **(3) history
  management** — `length - depth` is only meaningful against the finalized,
  post-compaction/-recall/-steering `messages`, so placement is a per-turn
  computation, and the injected block then re-enters the next turn's compaction
  and token-budget math (`budget.ts` / `tokenEstimate.ts` count segments and
  messages on separate ledgers). `SystemSegment` threads through ~18 source
  files; this is not "one assembly function + ≤2 call sites." A dead `depth?`
  field would advertise a capability the port does not honor — the exact
  anti-pattern the decorum doc's "approximation, made explicit" guards against.
  **Verdict: the approximation stands** — the digest rides as the final
  non-cacheable system segment (`core/conductSegments.ts`,
  `insertPersonaSegments`); a real depth-anchored injection point is a 1f port
  extension. Decorum-side rationale: `docs/architecture.md`, "Zone → segment
  mapping."
- **SSE reconciliation — released deltas are a verified prefix (1d, CLOSED BY
  CONTRACT).** The 1b caveat ("deltas may show pre-substitution text while
  persistence holds gated text") is reconciled now that a **hold-by-default**
  governor is bound. decorum's streaming governor never releases a span until
  the sentence containing it has been screened, so **every released delta is
  verified text**. On the pass path the concatenation of the released deltas
  plus the `onStreamEnd` held-tail flush is **exactly the final delivered +
  persisted message** — what streams is what the governor released, and the two
  converge. The old divergence only ever existed for a leak-then-check governor;
  a holding governor has nothing to substitute after the fact on a clean turn.
  - **The bounded, honest residue (D21):** a `block`/`replace` — or a
    `regenerate` — that fires **after** text was already released. Streamed
    bytes cannot be retracted, so the client keeps the released **prefix of the
    ORIGINAL** model text while the final delivered + persisted message is the
    substituted refusal (**never a prefix of that refusal** — the client reads
    it as an explicit correction). decorum's Task-9 policy only emits
    `regenerate` when nothing was released, narrowing this to
    block/replace-after-release. Property test:
    `tests/conduct/streamConvergence.test.ts`; documented in-code in
    `createAgent.ts` (the output-gate drive loop).

## Pointers

- Spec: `~/code/me/specs/2026-07-08-sov-conduct-module-design.md` (design
  decisions D1–D30).
- Decorum adapter contract (inert skeleton): `src/conduct/decorumAdapter.ts` —
  binds as `RuntimeOptions.conduct` at boot once the engine lands.

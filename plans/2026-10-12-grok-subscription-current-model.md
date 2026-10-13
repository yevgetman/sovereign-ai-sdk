# Grok subscription current-model implementation

Build map for the two-id pin in
`specs/2026-10-12-grok-subscription-current-model-design.md`. Not a second spec.
The §8 live probe is out of scope and stays unrun. Do not write that the pin
is qualified.

> **Status:** planned 2026-10-12. Publisher-documented route behavior only.

### Phase 1 — Exact two-id pin
**Status:** planned

`grok-4.7` becomes the default. `knownModels` is exactly `grok-4.7` and
`grok-4.6`. `modelsAuthoritative` is true only for `grok-subscription`. Pin
records set tools `supported`, images `unsupported`, and source
`xai-docs-2026-10-10` with `stale: false`. Only `grok-4.7` gets
`contextWindow: 500000`. `grok-4.6` keeps the 32768 unknown floor. Re-apply the
pin after failed subscription discovery, stale catalog reads, and an empty
`readModelCatalogSnapshot`. `UNKNOWN_CONTEXT_TOKENS` stays 32768. The provider
refuses every other id with `model_unsupported` and no fetch. Caller-source
metadata still fails tools when the pin was not applied. Images stay refused.

Files: `packages/sdk/src/providers/subscription/names.ts`,
`packages/sdk/src/providers/routes/catalog.ts`,
`packages/sdk/src/providers/models/grokPin.ts`,
`packages/sdk/src/providers/models/catalog.ts`,
`packages/sdk/src/providers/models/index.ts`,
`src/cli/modelDiscovery.ts`, route and catalog tests.

### Phase 2 — Effort
**Status:** planned

Route efforts are `low` / `medium` / `high` / `max`. Absent or configured `off`
selects `high` on this route only. `auto` resolves to `high`. Explicit `off`
throws `effort_unsupported`. Body is `reasoning: { effort }` plus
`include: ['reasoning.encrypted_content']`, `store: false`, never
`reasoning_effort`, never `previous_response_id`. `max` wires to `xhigh`
through one helper that does not change ChatGPT or direct-xAI bytes.
`modelReasoning` keys are `grok:grok-4.7` and `grok:grok-4.6`. Leave
`xai:grok-4.6` alone. ChatGPT absent/`off` stays `low`.

Files: `packages/sdk/src/providers/grok.ts`,
`packages/sdk/src/providers/effort.ts`,
`packages/sdk/src/providers/modelReasoning.ts`,
`packages/sdk/src/providers/responses.ts` (helper call only if needed),
`packages/sdk/src/providers/models/types.ts`,
`packages/sdk/src/providers/models/validate.ts`, effort tests.

### Phase 3 — Encrypted reasoning replay
**Status:** planned

Add assistant content `{ type: 'encrypted_reasoning'; encryptedContent; id?; status? }`.
Capture it from the terminal Responses `output` and from `output_item.done`,
deduped by `id`. `responsesInput` replays it only when `grok.ts` sets the flag.
ChatGPT throws. Anthropic `signature` and `redacted_thinking` still throw.
`sdkRunCommand` allows a stored block only on `grok-subscription`.
`contextManagement` accepts a non-empty block. `estimateBlockTokens` counts
`encryptedContent` as text, not an image.

Files: `packages/sdk/src/core/types.ts`,
`packages/sdk/src/providers/responses.ts`,
`packages/sdk/src/providers/grok.ts`,
`packages/sdk/src/providers/anthropic.ts` (exhaustiveness only),
`packages/sdk/src/compact/contextManagement.ts`,
`packages/sdk/src/core/tokenEstimate.ts`,
`src/cli/sdkRunCommand.ts`, `src/compact/compactor.ts` (do not render ciphertext),
replay and resume tests.

### Phase 4 — Docs
**Status:** planned

Replace the usage sentence "Grok subscription remains off-only" with the §2.3
effort table. Keep the direct-xAI `grok-4.6` sentence. No Telekit edits. No
INDEX edits. A factual Unreleased changelog line is allowed only if it does not
say verified or qualified. One short `DECISIONS.md` row points at this plan and
states the probe is unrun.

Files: `docs/03-cli-reference/usage.md`, `CHANGELOG.md`, `DECISIONS.md`.

## Acceptance

Spec §6 checks 1–11, unit and fixture only. No live xAI/OAuth call. No
`XAI_API_KEY` read. `createSubscriptionModelSource` still throws
"Subscription model discovery unavailable".

## Read next

- `specs/2026-10-12-grok-subscription-current-model-design.md`
- `docs/03-cli-reference/usage.md` (reasoning effort)
- `tests/providers/routes.test.ts`
- `tests/providers/responses.test.ts`

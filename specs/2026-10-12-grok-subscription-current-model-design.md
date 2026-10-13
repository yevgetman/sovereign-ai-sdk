# Grok subscription: current model, tools, context, effort, encrypted reasoning — design

**Status:** draft. Written 2026-10-12. This file authorizes no code. A later plan needs a separate green light.
**Id:** grok-subscription-current-model
**Date:** 2026-10-12
**Updated:** 2026-10-12
**Author:** Julie
**Code base:** `origin/master` at the time of writing (working tree is behind and is not the source of these facts).
**Docs checked:** xAI developer docs, last updated 2026-10-10, [Reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning) and [Grok 4.7](https://docs.x.ai/developers/grok-4-7).

---

## 0. Decision

`grok-subscription` (provider `grok`, auth `subscription`) must be able to run the current flagship, `grok-4.7`, on `POST https://api.x.ai/v1/responses` with the Owner's existing Grok OAuth item. A Kernel/Telekit coding turn must get past the local context check. The turn must be able to send tools, set effort, and send encrypted reasoning back on the next turn.

The pin is not qualified until the live probe in §8 has been recorded. This spec does not claim that probe has been run.

How later models arrive is `specs/2026-10-12-subscription-model-catalog-design.md`. That spec does not undo this two-id pin. Telekit's owner text and the rule that `auto` is whatever Sov resolved are `telekit/specs/2026-10-12-sov-route-failure-and-effort-design.md`. Grok Build and Codex menus are a separate Telekit spec and are not copied onto this route.

ChatGPT subscription stays as it is, except where one shared `max` → `xhigh` map is extracted. That extraction must keep today's ChatGPT bytes. Direct API-key xAI (`provider` `xai`, route `grok-api`) stays on Chat Completions `reasoning_effort`. The verified row `xai:grok-4.6` does not apply to provider `grok` and must not be retargeted.

---

## 1. What is broken

Facts below match `origin/master`. They are the contract this change replaces.

| Fact | Where |
|---|---|
| Route id `grok-subscription`, provider `grok`, auth `subscription`. Default model `grok-4.6` (`SUBSCRIPTION_DEFAULT_MODEL.grok`). `knownModels` is only that default. | `packages/sdk/src/providers/subscription/names.ts`, `packages/sdk/src/providers/routes/catalog.ts` |
| `SUBSCRIPTION_ROUTE_EFFORTS.grok` is `['off']` because "Grok currently has no verified effort parameter." | `catalog.ts` |
| `GrokSubscriptionProvider` POSTs `https://api.x.ai/v1/responses`. If `req.effort` is set and is not `off`, it throws `RouteError` `effort_unsupported`. The body has `model`, `input`, `instructions`, `max_output_tokens`, `stream`, `store: false`, and `tools` when present. It does not send `reasoning.effort`. | `packages/sdk/src/providers/grok.ts` |
| `createSubscriptionModelSource` throws `Subscription model discovery unavailable`. `fallbackModelCatalog` marks bundled models' text, tools, images, and reasoning `unknown`, metadata source `bundled-suggestions`, `stale: true`, catalog state `unavailable`. `findModel` for an id not in the catalog returns source `caller` with every capability `unknown`. | `packages/sdk/src/providers/models/direct.ts`, `catalog.ts` |
| `validateModelRequest` refuses tools when `capabilities.tools` is not `supported`, unless the record is `bundled-suggestions`, a direct API provider (`api_key` and `anthropic` / `openai` / `xai`), or a custom serializer. Provider `grok` is none of those. A caller-entered `grok-4.7` dies locally with `unsupported_input` ("Tool support for the selected model is unknown") before any network call. Bundled `grok-4.6` skips that check. | `packages/sdk/src/providers/models/validateRequest.ts` |
| `UNKNOWN_CONTEXT_TOKENS` is 32768. Stale evidence cannot expand that floor. `requestInputTokenEstimate` is the UTF-8 byte length of `JSON.stringify({ messages, system, tools })` plus 256. It is not a tokenizer. | `packages/sdk/src/providers/modelLimits.ts` |
| Headless `sov` always attaches model metadata (`readModelCatalogSnapshot` → `findModel`). Subscription discovery never succeeds, so the snapshot is the stale bundled catalog (or a failed refresh marked stale). `query` then resolves limits. A Kernel/Telekit coding turn's prompt plus tool schemas exceeds 32768, so a fresh "hi" on `grok-4.6` throws `ContextManagementError` before fetch. `sdkRunCommand` maps that error to `context_overflow`. | `src/cli/modelDiscovery.ts`, `src/cli/sdkRunCommand.ts`, `packages/sdk/src/core/query.ts` |
| Supplied trace, not re-run for this spec: `478cceeb` at `2026-10-13T03:25:00Z`, `session_end` reason `error`, about 6ms. Telekit shows "The session is too large." That string is not in this repo. | — |
| `responsesInput` throws `unsupported_input` for a thinking block with `signature` ("signed reasoning history cannot be replayed on this route") and for `redacted_thinking` ("encrypted reasoning history cannot be replayed on this route"). The SSE translator does not keep a reasoning item. `store` stays false, so the service will not rehydrate it. | `packages/sdk/src/providers/responses.ts` |
| `VERIFIED` in `modelReasoning.ts` has `xai:grok-4.6` (efforts `off` / `low` / `medium` / `high` / `max`, `disableSupported: false`, `maxWireValue: 'xhigh'`). The key is provider `xai`, not `grok`. `modelReasoningParams` emits Chat Completions `reasoning_effort`. | `packages/sdk/src/providers/modelReasoning.ts` |
| `ROUTE_IMAGE_SUPPORT['grok-subscription']` is false. Provider `grok` rejects images in `validateModelRequest` even if a record said otherwise. | `catalog.ts`, `validateRequest.ts` |
| Route model lists are not authoritative (`modelsAuthoritative` is hardcoded false). An unknown id is refused only when it matches another vendor's family. `grok-4.7` is not on the list and is not family-incompatible, so the route layer lets it through. The tool check above is what stops it. | `routes/catalog.ts`, `routes/validate.ts` |

Publisher facts this design uses, and does not treat as a completed OAuth probe:

- `grok-4.7` is the flagship. Responses API. Context 500,000. Tools are supported. Image input is on the API. Reasoning effort is `low` / `medium` / `high` (default) / `xhigh`. Reasoning cannot be disabled. On Responses, `grok-4.7` always returns `reasoning.encrypted_content`, and the client must send that reasoning item back on the next request when `store` is false.
- `grok-4.6` and `grok-4.5` also support `reasoning.effort` and cannot disable reasoning. `xhigh` is documented for 4.6 and later. This spec does not copy a context-window number onto 4.6 or 4.5.
- The wire object is `reasoning: { effort: "<level>" }`, not `reasoning_effort`.
- A reasoning item in `output` has `type: "reasoning"` and `encrypted_content`. The documented replay is that item, unchanged, in the next request's `input`.

Installed Grok CLI `grok models` on this Mac (grok.com login) lists default `grok-4.7`, plus `grok-4.7-build-fast`, `grok-4.6`, and `grok-4.5`. That list is evidence of the Grok Build subscription. It is not proof that the SOV Responses OAuth path serves each id. Do not copy it onto this route.

---

## 2. What changes

### 2.1 Exact model pin

Two ids, spelled in full. No prefix rule. No "anything starting with `grok-`".

| Id | Role | Tools | Context used for the local budget | Effort |
|---|---|---|---|---|
| `grok-4.7` | New built-in default (`SUBSCRIPTION_DEFAULT_MODEL.grok`) | `supported` on the pin record | `500_000`, metadata `stale: false`, source `xai-docs-2026-10-10` | `low` `medium` `high` `max` |
| `grok-4.6` | Stays on the allowlist so an existing pin still resolves | `supported` on the pin record | No number is invented. Stays on the 32768 unknown floor until a later verified window is written | Same effort map as 4.7 |

`knownModels` is exactly those two ids. `grok-subscription` becomes model-authoritative. `buildRecord` today forces `modelsAuthoritative: false` for every route. Add a per-route flag, default false. Set it true only for `grok-subscription`. Do not flip ChatGPT or the API-key routes.

Refusal, before any network call:

- `grok-4.7-build-fast`, `grok-4.5`, `grok-foo`, and any other id: `model_unsupported`.
- The provider itself also refuses an id outside the two-id list with `model_unsupported`, so a direct `GrokSubscriptionProvider` call cannot prefix-guess.
- A caller-source record for an id that is not a pin still fails `validateModelRequest` when tools are present. The legacy `bundled-suggestions` skip is not how the new pin authorizes tools.

`grok-4.6` with a Kernel-sized prompt still throws `context_overflow`. Say that in the route record's tests. Do not paper over it with the 4.7 window.

The 500,000 figure is the publisher's documented window. It is not a measured fill on the OAuth path, and it is not a tokenizer count. The local check still compares `requestInputTokenEstimate` (JSON UTF-8 bytes plus 256) with that window. Bytes against a token window are a conservative bound for typical UTF-8. Do not replace the estimator. Do not raise `UNKNOWN_CONTEXT_TOKENS`. Do not let stale evidence expand the floor.

`maxOutputTokens` stays unset. Unknown output remains 8192 (`UNKNOWN_OUTPUT_TOKENS`). The publisher line "no text output limit" is not copied into a made-up cap. Host `maxTokens` (default 12000) is still clamped by that unknown output cap, which is today's behavior whenever model metadata is present.

Images on the pin stay `unsupported`. See §3.

Availability stays `unknown`. Do not mark the pin `account` before the probe.

### 2.2 The pin must survive failed discovery

`createSubscriptionModelSource` still throws `Subscription model discovery unavailable`. There is no subscription model list to fetch, and this spec does not add one. No API key is read to discover models.

`fallbackModelCatalog`, `findModel`, `createModelDiscovery` read/refresh, and `readModelCatalogSnapshot` must re-apply the exact pin after the usual stale/unavailable marking.

Invariant: a failed or missing subscription refresh cannot set `grok-4.7` `stale: true`, drop `contextWindow`, or return source `caller` for that id. If the pin is marked stale, `resolveModelLimits` clamps 500,000 back to 32768 and the "hi" failure returns. A test locks the invariant.

`grok-4.6` has no context pin, so stale bundled handling still clamps it to 32768.

### 2.3 Effort

Sov and Telekit vocabulary stays the global enum: `off | low | medium | high | max`. This route does not adopt the Grok Build menu (`low | medium | high | xhigh`).

| Caller value | This route | Wire `reasoning.effort` |
|---|---|---|
| `low` | send | `low` |
| `medium` | send | `medium` |
| `high` | send | `high` |
| `max` | send | `xhigh` |
| `auto`, or effort omitted at route resolution | resolve to `high`, then send | `high` |
| `off` | `effort_unsupported` | do not omit the field and call that off |

`off` is not a disable. The publisher cannot disable reasoning on these models. Omitting `reasoning` is the publisher default `high`, so labeling that omission `off` is a lie. `/effort auto` on this route means `high`.

`buildRecord` today does `settings.thinking.effort ?? 'off'`, then falls through to the first listed level when `off` is absent. For this route that first level would be `low`. Special-case `grok-subscription` only: a configured effort of absent or `off` selects `high`. An explicit configured `low`, `medium`, `high`, or `max` still wins. ChatGPT's absent/`off` fallback stays `low`. Do not change `codexReasoning`: `off` throws, `undefined` maps to `low`, `max` maps to `xhigh`, and the object keeps `summary: 'auto'`.

`SUBSCRIPTION_ROUTE_EFFORTS.grok` becomes `['low', 'medium', 'high', 'max']`. It does not contain `off`.

`reasoningControlFor('grok', id)` returns a control for the two pinned ids only:

- efforts: `low`, `medium`, `high`, `max` (no `off`)
- `disableSupported: false`
- `maxWireValue: 'xhigh'`
- parameter value that means Responses `reasoning.effort`, not Chat Completions `reasoning_effort`

Do not reuse parameter `'xai'` for that. `modelReasoningParams` must not emit `reasoning_effort` for the new parameter. `grok.ts` writes `reasoning: { effort }` itself. The `xai:grok-4.6` row stays, including its `off` = omit behavior on the API-key lane.

`effortsForModel` prefers `reasoningControlFor`. Both the catalog list and that control must advertise the same four levels. A pin with `capabilities.reasoning: 'supported'` and no grok control would collapse the route to `['off']` (`hasReasoningMetadata` and no adapter). Do not leave the pin in that state.

Provider send rules:

- Delete the throw that rejects every effort other than `off`.
- `off` throws `effort_unsupported`.
- `undefined` on a direct provider call sends `high` (same meaning as auto). The route layer still resolves auto before `stream`.
- Always send `reasoning: { effort: <wire> }`. Do not send `reasoning_effort`. Do not send Codex `summary`.
- Also send `include: ["reasoning.encrypted_content"]`. `grok-4.7` returns the field even without `include`. `store` is false, and 4.6 is not documented as always-on, so the request asks explicitly. Do not send `previous_response_id`.

A shared helper may map `max` → `xhigh` for ChatGPT and Grok. If it is extracted, ChatGPT request bodies stay byte-identical, including the `off` error text.

### 2.4 Tools

The two pin records set `capabilities.tools` to `supported`. `validateModelRequest` then allows tools for those records without treating provider `grok` as a direct API provider and without depending on the bundled-suggestions exception.

The body shape stays the existing `responsesTools` / `tool_choice` mapping. No new tool types. Server-side tools (web search, X search, code execution) are not added.

### 2.5 Encrypted reasoning across turns

Do not store the ciphertext in `thinking.signature` or `redacted_thinking`. Those stay Anthropic. `responsesInput` keeps throwing for both on every route, including Grok. The host check in `sdkRunCommand` that refuses stored signed thinking and `redacted_thinking` for non-Anthropic providers stays.

Add one content block, assistant messages only:

```ts
{ type: 'encrypted_reasoning'; encryptedContent: string; id?: string; status?: string }
```

`encryptedContent` is the server's `encrypted_content` string, copied, not decoded.

Capture it from the terminal response `output` array (the source of truth already walked in `translateResponsesSse`). A streaming `output_item.done` may also carry it. Dedupe by `id` when both appear. Ignore items with an empty or non-string `encrypted_content`. Do not persist summary text as the ciphertext. Reasoning-summary deltas may still surface as `thinking_delta`. A `thinking` block without `signature` stays non-replayable, as today.

On the next Grok request, `responsesInput` emits one input item per block, in content order, after flushing any pending message text (same flush rule as `function_call`):

```json
{ "type": "reasoning", "encrypted_content": "<copied>", "id": "<if stored>", "status": "<if stored>" }
```

Do not add `summary` or other fields the stored block does not have. Do not reorder the item away from the assistant turn it belonged to.

`responsesInput` gains an explicit replay flag, default off. `grok.ts` sets it. ChatGPT does not. With the flag off, this block throws `unsupported_input` and is not sent. With the flag on, only this block is replayed. Anthropic signatures and `redacted_thinking` still throw.

Resume fence in `sdkRunCommand`: a stored `encrypted_reasoning` block is allowed only when the selected route is `grok-subscription`. Any other route, including `grok-api` and `chatgpt-subscription`, refuses the stored session with `unsupported_input` before fetch. Ciphertext from this route must not be sent to another backend.

`contextManagement` must accept the block as opaque non-empty content. It must not use the "unknown context block" path. `estimateBlockTokens` must count `encryptedContent` as text. It must not fall through to the image branch.

The JSON byte estimator already stringifies message content, so the ciphertext counts toward the context budget. Do not add a second estimator.

A history reduction that drops the block is out of scope for the compactor. The probe in §8 is an unsummarized second turn.

---

## 3. What stays refused

- Photos and other image inputs on `grok-subscription`. `ROUTE_IMAGE_SUPPORT` stays false. The provider-`grok` image throw in `validateModelRequest` stays. `responsesInput`'s `input_image` branch is not a claim of support. API docs list image input. This route does not, until a separate verified serializer spec.
- Any model id that is not exactly `grok-4.7` or `grok-4.6`.
- Name-prefix allows.
- `effort: 'off'` as a successful request.
- Disabling reasoning.
- Replaying Anthropic signed thinking or `redacted_thinking` on this route.
- Replaying `encrypted_reasoning` on any route except `grok-subscription`.
- `reasoning_effort` on the subscription body.
- API-key fallback, `XAI_API_KEY`, or a second call after a 403. A 403 stays a tier block.
- `previous_response_id` and `store: true`.
- Raising the global unknown context floor, or letting a stale catalog expand it.
- Treating the Grok CLI catalog, or `grok-4.5` / `grok-4.7-build-fast`, as route models.
- Calling the pin qualified before §8 is recorded.

---

## 4. Non-goals

- No API-key fallback and no change to `grok-api` / provider `xai`, except a shared `max` → `xhigh` helper that keeps ChatGPT and direct-xAI bodies stable.
- No redesign of ChatGPT subscription. Its efforts stay `low|medium|high|max`. Its auto/absent default stays `low`. Its `summary: 'auto'` stays. Its `off` error stays.
- No copying of the Grok CLI catalog onto this route.
- No Telekit string changes, including "The session is too large." That copy is another spec. This repo's `context_overflow` text stays.
- No image serializer.
- No server-side xAI tools, no `prompt_cache_key`, no pricing change.
- No new subscription discovery endpoint.
- No tokenizer and no change to `UNKNOWN_CONTEXT_TOKENS` or `UNKNOWN_OUTPUT_TOKENS`.
- No invented context window for `grok-4.6`.
- No compactor policy change.
- No claim that the §8 probe has already passed.

---

## 5. Files likely to change

- `packages/sdk/src/providers/subscription/names.ts` — default model `grok-4.7`.
- `packages/sdk/src/providers/routes/catalog.ts` — efforts, known models, authoritative flag, default effort `high` when config is absent or `off`.
- `packages/sdk/src/providers/routes/types.ts` — only if the authoritative flag needs a definition field. The "efforts always contain `off`" comment is already false for ChatGPT. Do not "fix" it by adding `off` to Grok.
- `packages/sdk/src/providers/grok.ts` — effort wire, include, model allowlist, replay flag.
- `packages/sdk/src/providers/responses.ts` — capture and flagged replay. ChatGPT call shape stays unless the shared effort helper's signature forces a touch. Bytes for ChatGPT must not change.
- `packages/sdk/src/providers/chatgpt.ts` — only if the shared map is extracted. Behavior frozen.
- `packages/sdk/src/providers/modelReasoning.ts` — `grok:grok-4.7` and `grok:grok-4.6` controls. Do not edit the meaning of `xai:grok-4.6`.
- `packages/sdk/src/providers/models/catalog.ts` and `findModel` — pin re-applied after stale discovery.
- `packages/sdk/src/providers/models/types.ts` — only if `reasoningControl.parameter` gains the Responses value.
- `packages/sdk/src/core/types.ts` — `encrypted_reasoning` block.
- `packages/sdk/src/compact/contextManagement.ts` — accept the block.
- `packages/sdk/src/core/tokenEstimate.ts` — count it as text, not as an image.
- `src/cli/sdkRunCommand.ts` — allow the block only for `grok-subscription`.
- `src/cli/modelDiscovery.ts` — snapshot path must not leave the 4.7 pin stale.
- `docs/03-cli-reference/usage.md` — the sentence "Grok subscription remains off-only" becomes the §2.3 table. The direct-xAI `grok-4.6` sentence stays.
- Tests that lock the old contract, at least: `tests/providers/routes.test.ts`, `tests/providers/modelReasoning.test.ts`, `tests/providers/subscription.test.ts`, `tests/providers/responses.test.ts`, `tests/providers/modelLimits.test.ts`, `tests/providers/models/catalog.test.ts`, `tests/cli/sdkRunCommand.test.ts`, `tests/cli/routes-discovery.test.ts`.

Not in this change: Telekit, INDEX files, the Grok CLI, `grok-api` request bodies.

---

## 6. Acceptance checks

Unit and fixture checks, no live account:

1. `getRoute('grok-subscription').defaultModel` is `grok-4.7`. `models` is exactly `grok-4.7` and `grok-4.6`. `modelsAuthoritative` is true. Other routes stay non-authoritative.
2. With `thinking.effort` unset, this route's `defaultEffort` is `high`. `auto` resolves to `high`. Configured `low` still resolves to `low`. `off` throws `effort_unsupported`. ChatGPT absent/`off` still resolves to `low`.
3. A Grok subscription body for `max` contains `reasoning: { effort: 'xhigh' }` and `include: ['reasoning.encrypted_content']`, `store: false`, and no `reasoning_effort`. `high` sends `high`. `off` throws before fetch. Direct xAI `grok-4.6` still sends `reasoning_effort` and still omits it for `off`.
4. `grok-4.7-build-fast`, `grok-4.5`, and `not-a-grok` throw `model_unsupported` with no fetch. A tool request whose metadata is source `caller` for `grok-4.7` still throws `unsupported_input` if the pin was not applied. The pin record does not.
5. Image input on provider `grok` still throws `unsupported_input`. `ROUTE_IMAGE_SUPPORT['grok-subscription']` is false.
6. Pin record for `grok-4.7`: `contextWindow` 500000, `stale` false, source `xai-docs-2026-10-10`, tools `supported`, images `unsupported`. `resolveModelLimits` returns 500000. A byte estimate above 32768 and below 500000 passes `assertRequestFits` for that record and still fails for stale `grok-4.6`.
7. After `createSubscriptionModelSource().discover()` fails, and after `readModelCatalogSnapshot` on an empty cache, `findModel` for `grok-4.7` is still that pin (`stale` false, window 500000). `UNKNOWN_CONTEXT_TOKENS` is still 32768.
8. A fixture SSE terminal `output` item `{ type: 'reasoning', id, encrypted_content, status }` becomes one `encrypted_reasoning` block. The next `responsesInput` for Grok contains that item unchanged, in order with the assistant text and function calls. The same block on ChatGPT throws `unsupported_input`. A `signature` thinking block and a `redacted_thinking` block still throw on Grok.
9. `sdkRunCommand` resumes a history that contains `encrypted_reasoning` on `grok-subscription`, and refuses it on `chatgpt-subscription` and `grok-api`.
10. `contextManagement` accepts a history whose only non-text assistant extra is a non-empty `encrypted_reasoning` block. `estimateBlockTokens` does not read `source` on that block.
11. No test sends `XAI_API_KEY` as a fallback for this provider. A 403 fixture still does not retry with an API key.

---

## 7. Qualification

Do not call the pin qualified in a changelog, release note, or doc headline until §8 is filled in with a real run. Landing the publisher-documented window in code is allowed. Writing "verified on the subscription" is not.

---

## 8. Live probe (not run)

One useful task on the Owner's existing `sov login grok` item. No API key. Route `grok-subscription`. Model `grok-4.7`. One explicit Sov effort, not `auto` and not `off` (use `max` so the wire value is `xhigh`, or `high` if `max` is what is under test — record which). One tool the model actually calls. A second model request in the same session that includes the tool result and the first response's reasoning item.

Record all of the following. Do not record the ciphertext, the access token, or the refresh token.

- UTC time, SOV build, route id, provider `grok`, auth `subscription`.
- Model id echoed by the service, if present, else the id sent.
- Sov effort sent, and the wire `reasoning.effort` on both requests.
- Proof both requests used the OAuth bearer and did not send `XAI_API_KEY`.
- First response: HTTP success, one function-call name, `stop` / terminal status, sha256 of `encrypted_content`, and the item `id` if any.
- Second request: sha256 of the replayed `encrypted_content` equals the first, the item sits in `input` with the tool result, `store` is false.
- Second response: HTTP success and a terminal `response.completed` or a documented incomplete that is only `max_output_tokens`. A refusal, a missing-model error, or a reasoning-replay error means the pin is not qualified.
- Session or trace id.
- A one-line statement that the request contained no image.

The probe does not fill 500,000 tokens. It does not qualify `grok-4.6`, `grok-4.5`, or `grok-4.7-build-fast`. It does not qualify image input.

If the service rejects `grok-4.7` on this OAuth path, stop. Do not point the default at another CLI id inside this spec's implementation. Write down the error and leave the pin unqualified.

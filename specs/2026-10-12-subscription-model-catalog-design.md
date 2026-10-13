# Keep subscription model catalogs current without guessing

**Date:** 2026-10-12
**Status:** draft
**Scope:** `chatgpt-subscription` and `grok-subscription` only. No implementation, release, or installed upgrade is authorized by this document.

SOV subscription catalogs for Grok and ChatGPT stay current only from a per-account read that uses the subscription access token, or from a reviewed pin. They do not stay current by guessing from a model-name prefix, an API-key model list, or a CLI catalog.

## Current facts

Verified on `origin/master` unless noted.

`createSubscriptionModelSource` (`packages/sdk/src/providers/models/direct.ts`) always throws `Subscription model discovery unavailable`. Its comment states that no subscription discovery endpoint is known and that no API credential or login is touched. `refresh` therefore stays `unavailable`, with no `fetchedAt`. The offline fallback (`fallbackModelCatalog`) returns bundled suggestions only: stale, `availability: unknown`, `auth: subscription`, capabilities unknown. Those suggestions are not a successful discovery timestamp. The direct-discovery test forbids any fetch on this path.

API-key discovery already exists and remains the mechanism for API routes:

| Provider | Endpoint |
|---|---|
| xAI | `https://api.x.ai/v1/language-models` |
| OpenAI | `https://api.openai.com/v1/models` |
| Anthropic | `https://api.anthropic.com/v1/models` |

`normalizeDirectModel` reads publisher capability fields (`tools`, input modalities, `reasoning_effort`, with `xhigh` mapped to `max`). A direct model is selectable for tools and effort only when that payload says so. Missing fields stay unknown. Retired rows and non-text output are dropped. An authenticated list proves account listing, not that a generation endpoint will run the ID. This spec does not redesign that path.

Subscription pins today (`SUBSCRIPTION_DEFAULT_MODEL` in `packages/sdk/src/providers/subscription/names.ts`):

| Route | Built-in default | `knownModels` |
|---|---|---|
| `chatgpt-subscription` | `gpt-5.3-codex` | that one ID |
| `grok-subscription` | `grok-4.6` | that one ID |

`modelsAuthoritative` is false. ChatGPT subscription efforts are already `low` / `medium` / `high` / `max` (the Codex body maps `max` to `xhigh`). Grok subscription efforts are only `off`, because no verified effort parameter exists on that transport. Changing the Grok request body, effort wire, or reasoning replay is a different spec. This document does not respecify that body.

These are different products, observed 2026-10-12, and are not subscription-endpoint proof:

- Telekit's Codex harness default is already `gpt-6.1-sol` (`CODEX_MODEL` in `telekit/config.py` on `origin/main`, `f69b9d4892d768a8e3368137a35364d179d22b26`).
- Grok Build CLI on this Mac (`grok` 1.0.41, logged in with grok.com) lists default `grok-4.7` plus `grok-4.7-build-fast`, `grok-4.6`, and `grok-4.5`.

An API-key model list and a CLI catalog are not proof that the subscription Responses/Codex or Grok subscription endpoint will serve that ID with the subscription OAuth token. `grok-4.7` was selectable in Telekit and then failed. That failure stands.

Policy already in this SDK (`packages/sdk/src/providers/modelReasoning.ts`): exact metadata, not model-name family guessing. Unknown typed IDs stay refused for tools and for unverified effort. Do not allow "if it starts with `grok-` or `gpt-`, inherit capabilities." Family checks may still reject a foreign publisher ID. They never grant tools, effort, vision, or a context window.

## Decision

This branch's reviewed Grok pin is exact id `grok-4.6` (`SUBSCRIPTION_DEFAULT_MODEL.grok` and the one-element `knownModels` list). `grok-4.7` is not a reviewed pin and not a proven read on this branch. PR 63 owns any move of that pin; this catalog spec does not perform it. Further ids, including `grok-4.5`, `grok-4.7-build-fast`, and any ChatGPT id past `gpt-5.3-codex`, still need one of the two ways below. Until a separate Grok request-body change lands, a Grok probe on this branch still uses only `off`.

Two ways an ID may be used on a subscription route. Nothing else.

1. **Reviewed pin.** The built-in default and its one-element `knownModels` entry, moved together in one release, after the probe gate below. Offline bundled suggestions follow that list and stay non-authoritative.
2. **Proven per-account catalog.** A read with that account's subscription access token, once a documented catalog endpoint for that subscription transport is proven. Tools, effort, and context window come only from that payload.

Until that read works, `createSubscriptionModelSource` keeps throwing `Subscription model discovery unavailable`. Do not invent a URL, send the subscription token to the three API-key endpoints, or copy API-key `ModelRecord`s onto a subscription route. A 200 from an undocumented guessed URL is not proof. Claude-Max HTTP stays refused. Discovery does not start login.

### What "proven" means

The endpoint is documented for the subscription transport, accepts the existing subscription OAuth access token (not an API key), and returns IDs that the same subscription generation endpoint will serve. The response schema is fixture-tested against the same capability fields `normalizeDirectModel` already understands. Implementation may add the read only after that proof. This spec does not name an endpoint, because none is known.

### Probe gate for a new default

A new default is a reviewed release pin plus one live useful-task probe. The probe is a gate. It is not something this spec claims has been done. No pass is recorded here for `gpt-6.1-sol`, `grok-4.7`, `grok-4.7-build-fast`, `grok-4.5`, or any other ID besides the pins above.

The probe, when a release wants a new pin:

- Runs on the SOV subscription transport with the subscription OAuth access token and the exact candidate ID.
- Is a useful task: an instruction that needs one tool call the subscription loop already supports, then a short final answer. It is not a models-list GET, not an API-key generation, and not a Codex or Grok Build CLI invocation.
- Uses only effort that transport already honors. ChatGPT may use `low`, `medium`, `high`, or `max`. Until the Grok request-body sibling lands, Grok still honors `off` only, so a Grok probe cannot claim a new effort. After that sibling, a Grok probe uses `low`, `medium`, `high`, or `max`. This catalog spec does not define the Grok reasoning body.
- Passes only when that endpoint accepts the ID and returns a completed assistant result. Model-not-found, auth failure, empty output, or a failed tool call blocks the pin.
- Must not store or print the access token. It is release evidence, not a default paid CI job.

The bundled offline suggestion moves in the same release as that default-model change, because the fallback is built from the route's `knownModels`. API-key defaults and API-key `knownModels` do not move with a subscription pin.

### Selectable versus default

A qualified catalog entry is selectable for the account that fetched it. It does not become the route default.

Qualified means all of the following: the catalog state is `current` for that account, the ID is exact, text output is not `unsupported`, and the field required for the choice is explicitly supported. Tools are selectable only when the payload says tools are supported. An effort other than what the transport already sends is selectable only when the payload lists it and the transport already honors it. Context window is taken only from a positive publisher field (`max_input_tokens`, `context_window`, or `context_length`), never copied from another model.

Grok subscription transport still sends no effort parameter. A future payload may record published Grok efforts, but those levels stay not selectable until the separate request-body spec says the transport can send them. Recording is not permission to change the body.

Changing the default is a reviewed edit of `SUBSCRIPTION_DEFAULT_MODEL` and the matching one-element `knownModels` list. A newer ID appearing in a catalog must not silently replace the default, rewrite `settings.routes.<routeId>.defaultModel`, or rewrite `settings.providers.*.model`. Operator route overrides remain explicit. An override that is not in the proven catalog is not auto-substituted; without exact supported metadata it is refused for tools and for unverified effort, same as any other typed unknown ID.

If a successful current catalog omits the pinned default, the pin stays the default and is reported missing from the account list. The runtime does not jump to another ID. The next reviewed release decides whether to repin, and only after the probe gate.

Static `modelsAuthoritative` stays false. Account-catalog authority applies only to that account's current read. It never flips the built-in route flag from a failed, empty, or stale read.

## Failure behavior

| Condition | Result |
|---|---|
| Endpoint missing or unproven | Throw `Subscription model discovery unavailable`. No network, no login, no API credential. Offline bundled suggestions only. |
| 401 / 403 | Not a current catalog. Do not cache an empty success, do not retry with an API key, do not copy the API-key catalog, do not start login from discovery, do not log the token. Keep the reviewed pin and stale bundled suggestions. |
| Empty list | Not a successful current catalog. Do not clear the pin and do not treat emptiness as a new default. |
| Retired or non-text row | Omit from the selectable list, same as `normalizeDirectModel`. If the pinned default is retired, keep the pin, mark it unavailable, and do not substitute. |
| Payload without capability fields | The ID may be account-listed. Tools, images, reasoning, efforts, and context window stay unknown. Unknown is not tool-selectable and is not effort-selectable beyond what is already verified for that exact ID. Do not inherit from `grok-` or `gpt-` prefixes, from `grok-4.6`, or from `gpt-5.3-codex`. |
| Typed ID with no exact metadata | Refused for tools and for unverified effort. The Telekit `grok-4.7` failure is the example: menu or CLI selectability is not capability. |

Refresh failure must not change the selected model or the payment route. Stale data may tighten what is offered. It must not expand tools, effort, or context window.

## Cache

The catalog cache is per local owner, per subscription account, and per route (`chatgpt-subscription` or `grok-subscription`). The cache key is a non-secret account identity already tied to that Keychain item (`SOV_SUB_CHATGPT` or `SOV_SUB_GROK`). It is never the access token, refresh token, or API key, and it is never `public`.

The cache must not outlive the account. Logout and account change delete that owner's entries for that route. A later account must not read the previous account's rows. Owners do not share a catalog, including two OS users on one machine and two subscription accounts on one route.

Records hold model metadata only. No token, authorization header, or cookie is written to the record, the key, or logs. Durable state, if any, lives in the local owner's harness state, not in the package and not in a world-readable or cross-user path. The default in-memory discovery cache is not a substitute for this isolation once a durable port exists.

API-key caches stay on their own keys (`routeId` plus the API account id). A subscription refresh must not invalidate, overwrite, or share them. Subscription `auth` stays `subscription`. Subscription `routeId` stays the subscription route. Bundled suggestions stay `source: bundled-suggestions` and are never relabeled as a fresh subscription fetch.

## What subscription freshness must not break

Leave `createDirectModelSource`, the three endpoints, `normalizeDirectModel`, alias resolution, and API-key account cache isolation as they are. Subscription work must not:

- call `api.x.ai`, `api.openai.com`, or `api.anthropic.com` with a subscription token, or the reverse
- attach API-key capability, pricing, or availability onto a subscription ID
- change API-key `knownModels`, `PROVIDER_REGISTRY` defaults, or OpenRouter discovery
- make a missing subscription catalog look like a current API catalog
- widen direct-route family guessing while narrowing subscription guessing

Direct models remain tool- and effort-selectable only from their own payload. Subscription models do not borrow that payload by sharing a name.

## Non-goals

- Telekit menu UI. Telekit's Codex default `gpt-6.1-sol` is a different product, not a SOV subscription pin.
- Grok Build or Codex CLI alias tables. The Grok Build CLI list above is a different product.
- The Grok subscription request-body, effort, and reasoning-replay design. That sibling owns whether Grok `off` stops being the only sent effort. This spec only refuses to send or inherit effort the transport does not already honor.
- Claude-Max HTTP, new login flows, and API-key discovery redesign.
- Claiming the useful-task probe has already passed for any candidate ID.

## Validation when implemented

Fixture tests, not live inference in CI: endpoint missing still throws and performs zero fetches; 401/403 and empty bodies stay non-current and do not call the API-key URLs; retired rows drop; missing capability fields stay unknown and fail tool selection; a `grok-` or `gpt-` prefix does not copy another ID's tools, efforts, or context window; two account keys cannot read each other; logout drops the cache; cache fixtures contain no token strings; a newer catalog ID does not change `SUBSCRIPTION_DEFAULT_MODEL` or `knownModels`. Existing direct-discovery tests keep passing unchanged. A release that changes a subscription default cites the probe result separately. This draft does not include that citation.

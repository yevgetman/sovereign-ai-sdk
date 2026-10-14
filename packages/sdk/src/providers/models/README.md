# Model discovery contract (version 1)

Import the shared model catalog from `@yevgetman/sov-sdk`. `createModelDiscovery()`
uses memory only by default. `read(source)` never fetches or reads credentials;
`refresh(source)` explicitly invokes an injected source with cancellation and a
bounded deadline. Hosts can inject fetch, clock and cache ports. Cache keys must
include a caller-scoped, non-secret account identity when account availability is
returned. Subscription catalogs use `${service}:${identity}`. `service` is the
Keychain service name and `identity` defaults to that name, so the default key
is `SOV_SUB_CHATGPT:SOV_SUB_CHATGPT` or `SOV_SUB_GROK:SOV_SUB_GROK`. The disk id
is the route id plus that string. Do not put tokens in cache keys or records.

Exact model ID, authentication route, model author and inference host are separate
fields. Public catalog membership means advertised availability, not entitlement
or tested inference. Capabilities are supported, unsupported or unknown. Missing
limits or prices remain missing. Caller-entered IDs survive absent discovery and
delisting. Consumers must display stale metadata and must not silently select a
new model or payment route. Offline bundled IDs are suggestions, not certification.

Catalog version 1 is additive. Ignore unknown fields when reading. Reject an
unsupported catalog version and use explicit unknown fallback; do not reinterpret
unknown enum values as supported. New capability fields must default to unknown.
Future breaking schema changes require a new version and a migration adapter.
Model metadata should be captured as an immutable snapshot for each turn.

Cache reads and writes have bounded waits too. Failed refreshes persist stale
evidence when possible and keep a fail-safe stale snapshot in the current service
when persistence fails. Writes are serialized: an older cache port that ignores
a timeout cannot overwrite a newer successful refresh. Each source or cache-port
wait is bounded by `timeoutMs`; a refresh can include several such waits.

## OpenRouter public discovery

Pass `createOpenRouterModelSource()` to `refresh`. It fetches the documented
public `/api/v1/models` catalog without credentials. Candidate records preserve
exact IDs and author prefixes. Explicit non-text output models are excluded;
missing modality/capability metadata remains unknown. Prices are USD per million
tokens. Inference hosts are not inferred from the author prefix.

Pagination accepts same-origin continuation URLs and cursor pages with hard
page, record and response-byte limits. Redirects are refused. Refresh failures
retain stale cached records; they never change the selected model or route.
Arbitrary response/cache fields are removed before records reach host output.

## Direct API and subscription discovery

`createDirectModelSource({provider, apiKey, accountId})` accepts only caller-
authorized credentials. It never looks in the environment or host files. The
non-secret account ID isolates caches. The source captures provider, endpoint,
authorization and account identity at construction; reusing the caller options
object cannot redirect an existing source or its credentials. Anthropic and OpenAI use their documented
models endpoints; xAI uses its language-model catalog for modality metadata.
Missing provider fields stay unknown. Available IDs from an authenticated list
are account-listed availability, not proof of a successful generation request.
`resolveModelAlias(id, aliases)` follows only explicit aliases and rejects cycles.

`createSubscriptionModelSource(routeId, accountKey?)` keeps ChatGPT and Grok
subscription suggestions separate. No subscription catalog endpoint is known, so
`discover` still throws `Subscription model discovery unavailable` and does not
fetch. A cold Grok cache returns the unavailable publisher pin for `grok-4.7`
and `grok-4.6`; availability stays `unknown`. The pin is not a live account
probe. It is re-applied with `stale: false` and the documented window
(both exact pins are 500000). ChatGPT has unavailable bundled suggestions when no
owner registry is imported. When a timestamped account catalog already exists, failure returns that catalog as stale, keeps its `fetchedAt`, and
tightens the account rows. Failure does not mark the catalog current. It does
not borrow API records, start login, or add Claude-Max HTTP support. The cache
key is `${service}:${identity}` (default `SOV_SUB_CHATGPT:SOV_SUB_CHATGPT` or
`SOV_SUB_GROK:SOV_SUB_GROK`). The disk id is the route id plus that string. It
is never a token and never `public`.
`applySubscriptionAccountCatalog` normalizes a payload the caller already holds.
It does not move `SUBSCRIPTION_DEFAULT_MODEL`. Custom sources can implement other
SDK providers without changing the six built-in authentication routes.

`validateOwnerSubscriptionRegistry(value, routeId)` validates explicit owner-managed
version-1 ChatGPT or Grok subscription catalogs. `validateOwnerChatGptRegistry()`
and the existing `validateOwnerGrokRegistry()` are route-specific helpers. The
registry preserves provenance, review time, unknown facts and retired tombstones. New IDs are selectable only with matching route/model owner
metadata. SOV's disk adapter binds these records to a private non-secret login
epoch; token refresh preserves that epoch and login/logout rotates it. Owner
facts stay usable with visible stale freshness until re-imported. This path does
not implement network discovery or certify account entitlement. See
`docs/03-cli-reference/sdk-routes.md` for the import command and JSON example.

Provider references: [Anthropic models](https://platform.claude.com/docs/en/api/models/list),
[OpenAI models](https://developers.openai.com/api/reference/resources/models/methods/list),
[xAI models](https://docs.x.ai/developers/rest-api-reference/inference/models).


Anthropic's `capabilities.effort` flags supply exact supported depth levels.
Its independent `thinking.types.enabled/adaptive` flags supply the available
wire modes in `anthropicThinkingModes`. An explicit empty mode list means no
supported thinking mode; omitted metadata stays unknown. New model IDs use
these published facts without family-name rules. The Anthropic transport owns
how each advertised mode becomes a request.

`anthropicEffortSupported` records whether `output_config.effort` is accepted.
This is independent of `thinking.type=enabled` with `budget_tokens`. A model can
support budget-based thinking while rejecting the separate output effort field.

# Model discovery contract (version 1)

Import the shared model catalog from `@yevgetman/sov-sdk`. `createModelDiscovery()`
uses memory only by default. `read(source)` never fetches or reads credentials;
`refresh(source)` explicitly invokes an injected source with cancellation and a
bounded deadline. Hosts can inject fetch, clock and cache ports. Cache keys must
include a caller-scoped, non-secret account identity when account availability is
returned. Do not put tokens in cache keys or records.

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
non-secret account ID isolates caches. Anthropic and OpenAI use their documented
models endpoints; xAI uses its language-model catalog for modality metadata.
Missing provider fields stay unknown. Available IDs from an authenticated list
are account-listed availability, not proof of a successful generation request.
`resolveModelAlias(id, aliases)` follows only explicit aliases and rejects cycles.

`createSubscriptionModelSource(routeId)` keeps ChatGPT and Grok subscription
suggestions separate. Without a supported subscription discovery interface, their
metadata and availability remain unknown. Explicit refresh returns unavailable
with stale offline suggestions, never a current discovery timestamp. It does not fetch, borrow API records,
start login or add Claude-Max HTTP support. Custom sources can implement other
SDK providers without changing the six built-in authentication routes.

Provider references: [Anthropic models](https://platform.claude.com/docs/en/api/models/list),
[OpenAI models](https://developers.openai.com/api/reference/resources/models/methods/list),
[xAI models](https://docs.x.ai/developers/rest-api-reference/inference/models).


Anthropic's `capabilities.effort` flags supply exact supported depth levels.
Its independent `thinking.types.enabled/adaptive` flags supply the available
wire modes in `anthropicThinkingModes`. An explicit empty mode list means no
supported thinking mode; omitted metadata stays unknown. New model IDs use
these published facts without family-name rules. The Anthropic transport owns
how each advertised mode becomes a request.

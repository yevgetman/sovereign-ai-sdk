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

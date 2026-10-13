# Subscription model catalog implementation

Fixture policy for `chatgpt-subscription` and `grok-subscription`. No subscription
catalog URL is named. The useful-task probe gate has not been run. Moving the
Grok pin to `grok-4.7` belongs to sibling PR 63. This branch keeps
`SUBSCRIPTION_DEFAULT_MODEL.grok` at `grok-4.6`, leaves `knownModels` one id
wide, and does not edit the Grok request body, effort wire, or reasoning replay.

> **Status:** implemented 2026-10-12. `createSubscriptionModelSource` still throws
> `Subscription model discovery unavailable` and performs zero fetches. No
> endpoint is named. The probe gate has not been run. The Grok pin move belongs
> to PR 63.

### Phase 1 — Pure account-catalog normalization
**Status:** complete (2026-10-12)

Normalize a caller-supplied payload only. Same drop and capability rules as
`normalizeDirectModel`: retired and non-text rows drop; missing capability
fields stay unknown; context window comes only from a positive
`max_input_tokens`, `context_window`, or `context_length`. A `grok-` or `gpt-`
prefix does not copy tools, efforts, images, or context from another id.
`auth` stays `subscription`. `routeId` stays the subscription route. Source is
`subscription-account-catalog`, never `bundled-suggestions` and never an API
host. Bundled suggestions are not relabeled as a fetch. No API-key pricing,
reasoning control, or availability is attached. `availability: account` is set
only when the caller supplied an account catalog. Applying a payload does not
change `SUBSCRIPTION_DEFAULT_MODEL`, `knownModels`, route defaults, or
`modelsAuthoritative` (stays false). A missing or retired pin is reported and
not replaced. 401, 403, and empty lists are not current and are not cached as
success.

### Phase 2 — Disk cache isolation
**Status:** complete (2026-10-12)

The durable key is the non-secret Keychain service name (`SOV_SUB_GROK` or
`SOV_SUB_CHATGPT`), never the access token, refresh token, API key, or
`public`. Files live under the local harness home, per route, per account key.
Logout and login (account change) delete that owner's route directory without
reading credential bytes. The same service name is reused after an account
change, so the whole route directory is cleared, not one guessed file. Two
account keys cannot read each other. Owners do not share a directory. API-key
caches, including `ambiguous-account-pool` and `unconfigured`, stay on the
existing flat paths. Because `discover()` still throws, refresh must not write
a current subscription catalog and must not drop the reviewed pin from
`fallbackModelCatalog`. A negative cache, if stored, stays non-current and
cannot expand tools, effort, or context. Records are model metadata only.

### Phase 3 — Fixture tests
**Status:** complete (2026-10-12)

No live model probe. Cover the spec's validation list and keep the existing
direct-discovery tests, including the subscription path that forbids any fetch.

## Files

- `packages/sdk/src/providers/models/subscriptionCatalog.ts` — pure normalize, apply, selectability, token refusal
- `packages/sdk/src/providers/models/direct.ts` — subscription cache key only; discover still throws; direct source unchanged
- `packages/sdk/src/providers/routes/validate.ts` — subscription account-catalog efforts do not inherit another id
- `packages/sdk/src/providers/models/validateRequest.ts` — stale subscription tool claims do not count as support
- `packages/sdk/src/providers/subscription/login.ts` — identity-changed hook, no credential bytes
- `src/cli/modelDiscovery.ts` — disk path, refusal of `:public`, logout/login wipe
- `src/main.ts` — wire the wipe on login and logout
- `tests/providers/models/subscriptionCatalog.test.ts` — fixtures
- `packages/sdk/src/providers/models/README.md` — cache key and still-no-endpoint note

## Acceptance

- Missing endpoint throws and performs zero fetches. No token is sent to `api.x.ai`, `api.openai.com`, or `api.anthropic.com`.
- 401, 403, and empty bodies are not current catalogs and do not copy the API-key catalog or start login.
- Retired and non-text rows drop. Missing capabilities stay unknown and fail tool selection.
- A prefix does not copy another id's tools, efforts, images, or context window.
- Two account keys and two harness homes cannot read each other. Logout drops that route's subscription files. API-key cache files remain.
- Cache fixtures contain no `authorization`, `bearer`, `sk-`, `access_token`, or `refresh_token`.
- A newer catalog id does not change `SUBSCRIPTION_DEFAULT_MODEL`, `knownModels`, or `modelsAuthoritative`.
- Existing direct-discovery tests pass unchanged.
- No probe result is cited. PR 63 owns the Grok pin move.

## Read next

- `specs/2026-10-12-subscription-model-catalog-design.md`
- `packages/sdk/src/providers/models/direct.ts`
- `src/cli/modelDiscovery.ts`
- `tests/providers/models/direct.test.ts`

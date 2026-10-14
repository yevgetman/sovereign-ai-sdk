# Native SDK routes

SOV owns credentials and the agent loop. A local adapter selects one route and starts
`sov run --sdk`. This path opens no HTTP listener or TUI and starts no other harness.
Legacy `sov run --json --stdin` keeps the existing server path.

## Authentication routes

| Route | Transport | Authentication |
|---|---|---|
| `openrouter-api` | OpenRouter | API key |
| `anthropic-api` | Anthropic | API key |
| `openai-api` | OpenAI | API key |
| `grok-api` | Direct xAI | API key |
| `chatgpt-subscription` | ChatGPT Codex backend | SOV subscription login |
| `grok-subscription` | xAI Responses backend | SOV subscription login |

Configure API keys through the normal SOV provider configuration or provider environment
variables. Direct xAI uses `providers.xai` and `XAI_API_KEY`. OpenRouter-hosted Grok
is a separate OpenRouter model and payment path.

Subscription login is attended and external to an adapter:

```sh
sov login chatgpt
sov login grok
sov logout chatgpt
sov logout grok
```

Tokens stay in SOV's Keychain items. Login writes, refresh and logout share the same
OS-account lock. A pending refresh cannot restore a logout. A turn does not open a
browser or start a login. Existing Codex, Grok Build and Claude Code logins are not
imported. Claude subscriptions are not supported by this host.

## Discovery and local status

```sh
sov capabilities --json
sov routes --json
sov models --route openrouter-api --json
sov models --route openrouter-api --refresh --json --limit 50
sov models --route openrouter-api --json --author anthropic --search sonnet
sov auth status --route chatgpt-subscription --json
```

Each command emits one JSON object with `schemaVersion: 1`. Model reads use the local
validated snapshot, with offline bundled suggestions when none is available. Only
`models --refresh` requests provider metadata. It never starts inference or refreshes
subscription tokens. Public OpenRouter discovery needs no key. Direct API discovery
uses the first configured account selected by environment/config precedence. A credential
pool's other accounts can have different model availability; this is not their combined catalog. Subscription suggestions do not prove entitlement.

`models` separates authentication route, model author and inference host. Author filtering
does not select the host. Results retain exact IDs, capability uncertainty, metadata age,
context/output limits and pricing provenance. Pagination uses `--offset` (0–1000000) and
`--limit` (1–100), with `nextOffset: null` on the last page. Filters are limited to 256
characters. Invalid options return a safe error with exit code 2. Cache files live under
the active SOV profile's `model-catalog/` directory; credentials are never stored there.
Account-scoped caches do not borrow another account's catalog. Failed refreshes preserve
stale metadata and exact configured model IDs. Use `capabilities.modelDiscovery` to
check this additive machine interface without changing the existing route contract.

Status is read-only:
it does not call the provider, refresh tokens, open a browser or write credentials.
`credentialState` is `missing`, `present`, `expired`, `unreadable` or `unavailable`.
An expired token with a refresh token reports `refreshable: true`.
`present` proves local presence only. It does not prove inference entitlement.

Routes provide models, default model, efforts and per-model effort constraints.
The catalog is conservative and is not a network model listing. Unknown valid model
names may be attempted on the selected backend. Known foreign-provider names fail.
A backend model refusal does not change the model or payment path.

ChatGPT Codex effort levels are `low`, `medium`, `high` and `max` (`xhigh` on the wire).
`off` is refused for this backend. Grok subscription exposes the same four levels
(`xhigh` on the wire for `max`). `auto` or an omitted effort uses the route
default. That default is `high` only when `thinking.effort` is missing or `off`.
A stored `low`, `medium`, or `max` wins. `--effort off` throws
`effort_unsupported` and does not fetch.
The bundled Grok subscription records are `grok-4.7` and `grok-4.6`.
Both use the documented 500000-token context window. The output limit stays
unknown unless supplied by exact model evidence. [xAI documents Grok 4.6](https://docs.x.ai/developers/models/grok-4.6)
with text/image input, function calling and low/medium/high/xhigh reasoning.
Model image capability is separate from this transport: subscription image input
still fails because its image serializer is not verified.

### Owner-managed Grok subscription registry

No documented subscription catalog endpoint is configured. Owners can add or
retire exact IDs without a source change, release or upgrade. Import a JSON
catalog with `sov models --route grok-subscription --registry FILE --json`.
This explicit write requires an existing SOV Grok login. It never refreshes a
token, starts inference or changes a saved route, model or effort. `--registry`
cannot be combined with `--refresh` or another route.

The file uses version 1 normalized catalog records. For example (fixture facts;
replace these with verified facts for the exact subscription model):

```json
{
  "version": 1,
  "routeId": "grok-subscription",
  "fetchedAt": "2026-10-14T00:00:00.000Z",
  "models": [{
    "id": "grok-exact-owner-id",
    "displayName": "grok-exact-owner-id",
    "routeId": "grok-subscription",
    "provider": "grok",
    "auth": "subscription",
    "capabilities": {
      "textOutput": "supported",
      "tools": "supported",
      "images": "unknown",
      "reasoning": "supported"
    },
    "contextWindow": 500000,
    "efforts": ["low", "medium", "high", "max"],
    "availability": "unknown",
    "metadata": {
      "source": "owner-reviewed publisher source for this exact ID",
      "fetchedAt": "2026-10-14T00:00:00.000Z",
      "stale": false
    }
  }]
}
```

`metadata.source` records provenance. Each row's `metadata.fetchedAt` records its
review time. Limits must be positive safe integers; omit unknown context/output
limits. Capabilities must explicitly be `supported`, `unsupported` or `unknown`.
Omit unknown efforts. Valid published efforts are low/medium/high/max, with max
sent as xhigh by this transport. Missing effort evidence refuses inference for
that exact owner model; it does not borrow a bundled model's controls. Credential
material, API routes, arbitrary wire controls and prices are rejected.

Import replaces the whole owner registry atomically. To retire a model, retain
its row with `metadata.retired: true`. Tombstones are omitted from selectable
menus and reported in `retiredModels`. A saved retired model stays saved, but
inference refuses it. This also applies to a retired bundled ID. Keep tombstones
for retired bundled IDs so their fallback suggestion cannot authorize them.

Normal `routes`, `models`, `/model`, config model menus and `sov run --sdk` use this same
registry. Add a new row or change facts and re-import to refresh it. After one
hour, catalog/row freshness reports stale; owner-reviewed facts remain explicit
limits and controls until changed by the owner. This durable policy differs from
stale remote discovery metadata, which stays conservative. `--refresh` cannot
fetch subscription models; it reports that the registry needs re-import and
keeps every saved dial unchanged. The `catalogKind` and `catalogNotice` fields
identify this owner-managed state.

Registry files have private permissions under the active profile's
`model-catalog/subscription/grok-subscription/`. They are bound to a non-secret
OS-account login epoch. SOV login/logout rotates that epoch under the credential
mutex even without optional catalog hooks, so a different login cannot use a
prior account's file across profiles. Token refresh does not rotate it. Import
bootstraps an epoch for a pre-existing login. Out-of-band Keychain edits do not
constitute a supported SOV account switch; use SOV login/logout to switch accounts.
Offline reads inspect only the epoch file and never read credentials.

`/new` clears the transcript only. Saved route, model and effort remain in force.
A context/model error therefore needs a model/metadata correction, not another
`/new`. Model menu and catalog diagnostics state this. No registry operation
switches payment or authentication routes, and owner facts do not prove account
entitlement.

## One native turn

```sh
printf '%s' '{"inputVersion":1,"text":"Check this folder","instructions":"","images":[]}' |
  sov run --sdk --route chatgpt-subscription --json --stdin --input-format json \
    --db /absolute/path/sessions.db --toolset coding --permission-mode default
```

The route is required. Legacy `--provider` conflicts with SDK mode. `--model auto`
and `--effort auto` use route defaults. When `rejectedConfiguredDefault` is set,
the catalog does not present built-in `grok-4.7` as the selected default: omission
and `--model auto` require that exact ID to be registered or the configured default changed.
An explicit allowlisted model still accepts `--effort auto`. A route never borrows an unrelated API key,
model, account or external harness. The SDK path does not perform a billable startup
preflight or automatic context summarization.

Input defaults to plain text for direct callers. JSON input accepts only
`inputVersion`, `text`, `instructions` and `images`. Instructions append to the base
bundle prompt for this turn and do not become durable user history. Adapters must
keep forwarded and learned text in user data.

Images use ordered absolute local paths and a declared media type. The host validates
file type, media signature, count and byte limits before inference. No attachment
URL is fetched. Unsupported images fail instead of disappearing. Discovery lists
supported route input encodings; an individual model can still reject image input.

Toolsets are `chat`, `web`, `ops` and `coding`. Omitted means `coding`. The selected
pool constrains both model schemas and execution, including delegated children.
Permission prompts have no headless UI and are denied immediately. SDK auxiliary
work stays on the selected provider/model; an unconfigured alternate fails.

`--resume <session-id>` reads the existing SOV database. The SDK is the sole message
writer. Assistant tool calls are durably saved before tool execution. Interrupted
calls receive explicit interrupted results on resume and are not executed again.
Incompatible stored image or encrypted reasoning history is retained and refused.

`--steer-file` keeps the existing JSONL steering input. SIGINT and SIGTERM cancel
provider and tools and emit a typed terminal failure. Cleanup has a bounded wait.

## Machine events

`session.started` reports the session id, route, provider, authentication, model,
effort, toolset and permission mode. Text, thinking and tool progress follow the
existing JSONL event vocabulary. Tool block ids identify each call.

Each recognized request ends with exactly one `turn.completed` or `turn.error`.
Completion contains `reply`, `sessionId`, `finishReason` and route metadata.
Errors contain safe text and a stable code. No provider response body, token or key
is included. Missing and truncated terminal streams are failures.

Exit codes are 0 for completion, 1 for turn failure, 2 for invalid input/options,
130 for SIGINT and 143 for SIGTERM. A Grok 403 reports `tier_blocked` and never
switches to a paid API key.

## Verification limits

Offline tests prove request serialization, loop/persistence behavior, error handling
and cross-process credential coordination. They do not prove account eligibility.
Live proof still needs authorized keys for all API routes and eligible ChatGPT/Grok
logins, followed by subscription tool cycles and resumed turns. Do not infer this
proof from local credential presence or a mock provider.

## Shared model selection and turn evidence

`/model`, `/config edit providers.<provider>.model`, the default model setting,
and task-lane model settings read the same offline catalog snapshot. Direct
routes show models. OpenRouter shows model authors, then their exact model IDs.
Use `--author <author>` or `--search <text>` to narrow an OpenRouter picker.
Use `--custom` to enter an exact ID. A missing or retired current ID remains
visible until you choose a replacement. Picking a model does not change routes.

Catalog rows show tools, images, reasoning efforts, context window and account
availability. Unknown values remain unknown. Offline or stale catalogs tell you
to run `sov models --route <route> --refresh`; opening a picker never contacts
providers. Subscription suggestions do not certify account entitlement.

SOV captures the selected model's evidence at the start of each turn on the
gateway, channel, cron, OpenAI facade and native SDK host paths. Delegated
children resolve their own exact model snapshot through an injected host port;
parent model metadata and prices cannot certify a different child. The native
`sov sdk run` route receives that evidence before reasoning validation. The
agent receives the same model-bound capability, pricing and limit snapshot.
Fresh published context windows can grow beyond former static provider values.
Stale remote discovery or unknown evidence uses the SDK's conservative limits. Owner-managed Grok records keep their explicitly reviewed limits with visible freshness. Explicit output
budgets still cap the output reservation. Gateway proactive compaction uses
those same limits, system/schema/history accounting and output reservation.
Required capabilities and the model-specific effort selection are checked before
paid history summarization. This includes both per-turn effort and the current
session effort. A system
or tool-schema overflow is refused rather than repeatedly summarized.
Custom transports retain their established host limit contract.

For unverified windows, SOV removes only duplicated generated tool descriptions
from the system prompt and lists the actual scoped tool names. Provider request
schemas still carry descriptions and parameter definitions. Standing directives,
project files and per-turn instructions remain intact. Output is a ceiling: the
SDK can reserve fewer tokens to fit the input in the conservative window. It
reports that actual reservation in the trace. An irreducible input overflow
produces a clear context-budget error before inference.

Model menus and the first-turn context budget use the active runtime node’s catalog and account settings. Config model changes and discard actions use that same node’s config path. An explicit config-path environment override still takes precedence.

Context-budget reports keep a frozen turn snapshot while its provider and model match the current selection. After a model or provider change, they read the active node’s current model evidence, including changes made from another session.

Custom OpenRouter-compatible endpoints do not reuse the official public catalog.
Their model metadata remains unknown until a caller provides endpoint-specific
evidence. Cache identity includes a nonsecret endpoint hash. Absent `baseUrl` or
the official `https://openrouter.ai/api/v1` (with an optional trailing slash) keeps
public discovery available. A custom-endpoint refresh does not fetch or infer.


Direct discovery requires one distinct configured API secret. If a credential
pool can rotate between accounts, model metadata stays unavailable rather than
borrowing the first account's catalog. Discovery does not select a pool slot,
read credential status, or change rotation state. Duplicate slots with the same
secret retain single-account discovery.

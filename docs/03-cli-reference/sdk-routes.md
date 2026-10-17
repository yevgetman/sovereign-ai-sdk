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
`capabilities.logicalTurnRecovery` names SOV-owned automatic recovery
(`owner` `sov`, `version` 1, `mode` `automatic`).

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
Model image capability is separate from exact subscription transport certification.
Only `grok-4.7` has live image-input proof: two bounded PNG perception turns passed
on 2026-10-14 with correct visual answers and no credential writes or refresh.
Its image certificate permits PNG/JPEG, cites the
[xAI image contract](https://docs.x.ai/developers/model-capabilities/images/understanding),
and expires on 2026-11-13. Unknown, stale or expired exact-model certification
refuses images. Grok 4.6 and ChatGPT have no live image proof and remain refused.
Legacy owner rows for exact Grok 4.7 can use the independent bundled proof.
Owner review age remains advisory; certificate age controls image eligibility.
Explicit owner retirement, unsupported/unknown images or failed/unverified/expired proof
is preserved. Effective model records and operator copy show the proof source.
Certificate URLs and dates reject terminal and bidi controls before display.

### Owner-managed subscription registries

No documented subscription catalog endpoint is configured. Owners can add or
retire exact IDs without a source change, release or upgrade. Import a JSON
catalog with `sov models --route grok-subscription --registry FILE --json`.
For ChatGPT, use `sov models --route chatgpt-subscription --registry FILE --json`
and set both `routeId` fields to `chatgpt-subscription` and `provider` to `chatgpt`.
Use an exact model ID and verified subscription facts; do not copy limits or
entitlement claims from the OpenAI API-key catalog.
This explicit write requires an existing SOV login for the selected subscription.
It never refreshes a token, starts inference or changes a saved route, model or effort. `--registry`
cannot be combined with `--refresh` or an API-key route.

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
sent as xhigh by both subscription transports. Missing effort evidence refuses inference for
that exact owner model; it does not borrow a bundled model's controls. Availability
must be `unknown`: owner review does not certify entitlement. Credential material, API routes, arbitrary wire controls and prices are rejected.

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
`model-catalog/subscription/<route-id>/`. They are bound to a non-secret
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
preflight. It automatically compacts growing history on the same selected
provider/model and authentication route. It does not switch to an auxiliary or
API-key route for compaction.

Input defaults to plain text for direct callers. JSON input accepts only
`inputVersion`, `text`, `instructions` and `images`. Instructions append to the base
bundle prompt for this turn and do not become durable user history. Adapters must
keep forwarded and learned text in user data.

Images use ordered absolute local paths and a declared media type. The host validates
file type, media signature, count and byte limits before inference. No attachment
URL is fetched. Unsupported images fail instead of disappearing. Discovery lists
supported route input encodings; an individual model can still reject image input.
Subscription attachments require current exact-model live certification before
credential resolution or runtime boot. Resume rechecks stored images against the
selected exact model before inference. Tool continuations retain the original
image blocks. Compaction carries older reference images into the child once;
the original tail remains intact. Image token costs remain explicitly uncounted
when no verified model-aware image counter is available.

Toolsets are `chat`, `web`, `ops` and `coding`. Omitted means `coding`. The selected
pool constrains both model schemas and execution, including delegated children.
Permission prompts have no headless UI and are denied immediately. SDK auxiliary
work stays on the selected provider/model; an unconfigured alternate fails.

`--resume <session-id>` reads the existing SOV database. The SDK is the sole message
writer. Assistant tool calls are durably saved before tool execution. Each tool's
completion receipt is journaled immediately, and the canonical batch is saved
before the next model request. Resume restores completed receipts without running
the tool again. An intent recorded before execution is interrupted; a started
call with no receipt has an unknown outcome. Native runs refuse unsafe existing
receipt history before paid summary or inference and require operator inspection.
An unknown non-idempotent effect must be verified before it is repeated. A receipt write failure returns
`storage_failed` and stops before another model request.
Incompatible stored image or encrypted reasoning history is retained and refused.
Grok and ChatGPT subscriptions store complete reasoning output items, including empty
`summary` and unknown fields, and replays it unchanged in terminal output order.
The block's internal route marker confines it to `grok-subscription`. SDK transports
also refuse it on API-key and foreign-provider routes before a fetch. A reasoning
stream without a terminal output array fails because its original order cannot
be verified. Legacy lossy reasoning blocks cannot be repaired; start a new subscription
session after upgrading. Stored history stays intact.

`--steer-file` keeps the existing JSONL steering input. SIGINT and SIGTERM cancel
provider and tools and emit a typed terminal failure. Cleanup has a bounded wait.

## Native context recovery

The native host uses the selected model's frozen context/output limits, scoped
tool schemas and effective system prompt to check the configured proactive
threshold. It compacts before a drive when reducible history reaches that limit.
A provider overflow may then cause one compact-and-retry, independent of an
earlier proactive compaction. The abandoned drive and the summary call are
charged before that retry, and the retry's max turns are the logical model
calls still remaining. No retry starts when none remain. A second overflow is
a typed `context_overflow` failure. A no-op compaction does not retry an
unchanged request. If the fixed system/tool schemas or mandatory retained
tail cannot fit, the host refuses before paid summary work or a child pivot.
Capability refusal precedes paid summarization. The summary request carries the
same selected effort and frozen model evidence, and must fit that model's actual
input/output budget before transport starts.

Each successful compaction creates a durable child with parent lineage, a guarded
summary and the retained tail. Retry reloads the newest durable transcript,
including real completed tool receipts. It rebuilds the child's session context,
effort, tools, skill continuity, trace/evidence target and stored-prefix boundary.
Drive persistence does not duplicate the child's seeded rows. Completed tool
actions are not run again.
An unknown effect still needs verification; compaction does not prove exactly-once
external effects.

## Machine events

`session.started` reports the session id, route, provider, authentication, model,
effort, toolset and effective `permissionMode`. `requestedPermissionMode` records
the explicit CLI mode, or `null` when omitted. These two permission fields also
persist in each session's `sdkTurns` metadata. Text, thinking and tool progress
follow the existing JSONL event vocabulary. Tool block ids and sequence values
remain unique across retry drives. `compaction_complete` reports the parent
`sessionId` and new `activeSessionId`. Terminal results report the newest
`activeSessionId` only when the existing session and its receipt history form a
usable durable target. `sessionId` carries the same id for existing adapters.
When a target is absent or unsafe, `sessionId` is `null` and `activeSessionId` is
omitted. Save a usable id before the next `--resume`. Telekit's SOV result parser
reads `activeSessionId` with `sessionId` as fallback; both `turn.completed` and
`turn.error` remain final events. No new terminal event type is introduced.

An explicit `--permission-mode default` overrides configured `ask` or `bypass`
and uses normal rules and tool self-checks. Omit the option to use the existing
layered settings and user configuration cascade. Headless permission requests
are denied because this surface has no interactive approver.

Each recognized request ends with exactly one `turn.completed` or `turn.error`.
Completion contains `reply`, `sessionId`, `activeSessionId`, `logicalTurnId`,
`finishReason`, cumulative counters and route metadata. `session.started`
includes that same `logicalTurnId` for a new turn and for
`--continue-logical-turn`, and advertises `capabilities.logicalTurnRecovery`.
A `turn.error` after the id is assigned also carries it, including storage
and lease failures. The SQLite row is then the one named by that id.
`--resume` starts a different logical turn; it does not continue this one. A bounded segment that ends at
`max_tokens` or `max_turns` emits `turn.continuing`, reloads durable state and
continues without replaying the original prompt. The toolset segment defaults
are chat 1, web 6, ops 8 and coding 100 model calls. Those numbers bound model
calls inside one segment. They are not a count of segments, and the durable row
does not store a segment-count limit. The logical-turn default is 100 model
calls. `--deadline-ms` covers the complete logical turn, and
`--continue-logical-turn` aborts at the stored deadline when this invocation
omits `--deadline-ms`, including a tool that is still blocked.

A deliberate `checkin` emits `turn.completed` with `outcome: "waiting_user"`.
Exhaustion, two unchanged progress fingerprints, unsafe receipts and invalid
recovery state emit `turn.error` with `continuation_exhausted`,
`continuation_stalled`, `recovery_unsafe` or `recovery_state_invalid`. Use
`--continue-logical-turn <id>` with `--sdk --json` to continue stored work
without a replacement prompt. A live owner keeps a short lease, so a second
continuation does not run tools or start another worker. While that lease is
unexpired the event is `logical_turn_leased` with `recoverable: true`,
`nextAction: "continue_logical_turn"`, and `retryAfterMs` set to the time left
on the lease. It is not `nextAction: "none"`. The message says a live owner is
busy and a crashed owner can be continued after the lease expires. After a
crash the lease expires in about 30 seconds, and the same id is accepted only
when receipt recovery is safe.
Route, model, effort, toolset, permissions, working directory and bundle
identity stay bound to the stored record.
Cancellation emits `outcome: "interrupted"`. Exhaustion and a deadline emit
`outcome: "exhausted"`. A repeated no-progress fingerprint emits
`outcome: "stalled"`. `finishReason` is `repeated:<action>`, naming the
terminal cause or the single repeated tool. One unchanged continuation is
not a stall. A new transcript row, pagination cursor, or compaction child
is progress. Other errors emit `outcome: "failed"`.

Native runs opt in to committing approved completed assistant messages before
exposing them. A cooperative cancelled drive gets at most one second to settle
its messages, tool receipts and usage before its terminal result. Stream teardown
then keeps its existing bounded wait. Automatic recovery requires an existing
session with a durable user message and coherent tool receipts. Completed
receipts are reused. `started` or `unknown` effects stop recovery before paid
work. An unsettled drive, missing session, or storage failure sets
`recoverable: false`. Failed final storage verification also refuses completed
success and keeps the completed canonical rows and observed usage for inspection.
Safe pre-session interruptions, rate limits and transient token-service failures
report `nextAction: "retry"`. A malformed token-service response reports
`nextAction: "check_provider"` with `recoverable: false`; check provider status
before retrying. An unsafe existing session reports `nextAction: "inspect_session"`. No requested resume id is created
just to satisfy a recovery claim. Completed journal receipts survive resume without executing the tool again.
Terminal usage sums all attempted main drives and summary requests. Cost receipts
retain each component and report a complete total only when every component is
known. Subscription provenance and missing usage/cost remain explicit. Cancellation
reports observed partial usage and does not turn missing data into zero.
Errors contain safe text and a stable code. No provider response body, token or key
is included. A subscription HTTP error can also include an `upstream` object
with bounded status, a recognized code and fixed safe message text. Arbitrary
provider text and unknown codes are redacted, including request echoes and
ciphertext. `provider_request_rejected` identifies an upstream HTTP 4xx request
rejection; `auth_expired`, `tier_blocked`, `model_unsupported`, `rate_limited` and
`context_overflow` keep their specific meanings. Missing and truncated terminal
streams are failures.

Subscription requests share a maximum of three model HTTP calls across connection,
status and stream failures. One 401 refresh remains allowed within that budget.
HTTP 200 streams can retry on EOF, reset or a malformed first frame before semantic
output. A lifecycle `message_start` alone does not prevent retry. It emits once. Text,
reasoning, tool intent (including added items and argument fragments), usage and
terminal responses prevent replay. Readers close before bounded backoff;
`Retry-After` waits above 10 seconds fail, and cancellation stops the next request.
The selected route, model and credential path stay fixed.

Token refresh has a separate maximum of three exchanges inside one 20-second
exchange deadline. Only an explicit OAuth `invalid_grant` response requests a new
login. A model inference 401 after successful refresh is a request rejection, not
proof that the refresh grant is invalid. Refresh 429, provider 5xx, connection
failure, timeout, malformed response and credential-store failure keep distinct
typed outcomes. `SubscriptionRefreshError.reason` contains only a fixed safe
failure class. Route mapping reports `rate_limited`, `provider_unavailable`,
`provider_timeout`, `provider_response_invalid`, `provider_request_rejected`, or
`credential_unavailable` as appropriate. It never retains endpoint bodies or
underlying errors. Bounded `Retry-After` waits run inside the exchange deadline;
waits above ten seconds fail without another exchange. Cancellation stops retries
and prevents a late exchange result from overwriting credentials. A failed
proactive refresh preserves the prior record, including a legacy login without an
account binding. Credential reads and writes remain inside the mutex and keep the
credential port's separate bounds (native Keychain: ten seconds per operation;
mutex acquisition: thirty seconds). The exchange deadline does not extend for
retries and does not evict a live credential-store operation.

SDK callers can inspect `SubscriptionStreamError` from the SDK root. Its `phase` is
`before_delivery` or `incomplete_delivery`; `reason` identifies the safe failure
class. It retains no original payload or transport error. Its `retryable` flag
describes an eligible failure cause; the subscription provider enforces the shared
attempt budget. Incomplete delivery never requests replay. Context/model refusals
keep their existing typed errors and do not retry. Native `turn.error` events retain
the fixed `deliveryPhase` and `deliveryReason` fields; incomplete delivery reports
`recoverable: false`.

Exit codes are 0 for completion (including `waiting_user` and a completed
continuation), 1 for a turn failure that is not a logical-turn stop, 2 for
invalid input or options, 3 for a logical-turn stop, 130 for SIGINT and 143
for SIGTERM. Exit 3 is no longer `needs_continuation`. A `max_tokens` or
`max_turns` segment emits `turn.continuing` and stays in the same process. A
`checkin` completes with `waiting_user` and exits 0. Do not start another
prompt on exit 3. That code used to mean the partial answer needed another
turn. It now means the logical turn has stopped.

These logical-turn stops all return 3. A deadline returns 3
(`continuation_exhausted`, reason `deadline`), including a deadline that
aborts the launch and a later `--continue-logical-turn` of that exhausted
record. A model-call cap returns 3 (`continuation_exhausted`, reason
`model_call_limit`), both when the running turn reaches the cap and when a
continuation is asked to resume it. A lease conflict returns 3
(`logical_turn_leased`) while another owner holds the turn. That stop is
recoverable: wait `retryAfterMs`, then continue the same id. It does not use
`nextAction: "none"`. A cancelled continuation
returns 3: `--continue-logical-turn` of a stored cancelled id is
`recovery_state_invalid` and does not call the model. An in-process cancel
is still SIGINT 130 or SIGTERM 143, not 3. A stall returns 3
(`continuation_stalled`), including resume of a stored stall. Invalid
recovery state returns 3 (`recovery_state_invalid`) for a skill-approval
mismatch, an MCP identity mismatch, a working-directory or permission-policy
mismatch, any other bound route, provider, auth, model, effort, toolset,
permission mode, or bundle mismatch, and a corrupt logical-turn record.
Unsafe recovery returns 3 (`recovery_unsafe`) when the stored session has no
usable receipt target, including a `started` or `unknown` tool receipt or an
ambiguous truncated tool call. That stop records `failed` with finish reason
`unsafe_effect` after the lease is held, then releases the lease. A later
`--continue-logical-turn` of that row is `continuation_failed` and does not
retry the unsafe decision or treat the turn as still running. Any other failed
logical result returns the same 3 when its status is not `completed` or
`waiting_user` and it is not rethrown as an interrupt or a provider failure.
A Grok 403 reports `tier_blocked`
and never switches to a paid API key.

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
Stale remote discovery or unknown evidence uses the SDK's conservative limits.
Owner-managed subscription records keep their explicitly reviewed limits with
visible freshness. Explicit output budgets still cap the output reservation.
Gateway and native proactive compaction use
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
with a supported local/host counter produces a context-budget error before inference.
For native models without a verified tokenizer, the byte upper bound is advisory:
it neither refuses a turn nor buys proactive compaction. The provider validates
these uncertain requests, with one bounded overflow-compaction retry. Images and
opaque reasoning remain uncounted until a verified host counter covers them.
`context.accounting` JSON events and provider-request traces expose local measured
text tokens, conservative tokens, source/version, incomplete modalities,
effective limit, output reservation, and whether the estimate enforces admission.
Local serialized-text counts are estimates of provider framing, not measured
publisher input usage.

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


## Grok reasoning continuation confinement

Grok and ChatGPT Responses reasoning items are stored whole and replayed unchanged in their
original output order. Their versioned provenance binds them to
`grok-subscription` or `chatgpt-subscription`, the exact model ID, and a random nonsecret login lineage. Each item can replay only on its original route.
A refresh preserves the lineage. Every supported new login creates a new lineage;
legacy credential records acquire one under the credential mutex before inference.
The lineage is not a token hash or an upstream account identifier. It confines
reasoning more narrowly than an account: logging in again requires a new session.
Changing model, route or login refuses replay before inference. Legacy reasoning
without complete items or provenance also requires a new session.

Injected credential ports must persist the optional `accountBinding` field.
Replacing a record without that field creates a new lineage. Out-of-band copying
of an entire credential record, including its lineage, is outside this identity
contract. No identity is inferred from the Keychain service name alone.

ChatGPT native resume accepts its own complete bound reasoning. It uses the same
versioned opaque-item contract and rejects foreign route, model and login state.
The request retains `store: false`. A missing or malformed ciphertext item is refused;
SOV never guesses replacement reasoning fields.

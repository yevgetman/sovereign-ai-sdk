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
`off` is refused for this backend. Grok subscription currently exposes only `off`,
which sends no effort override. Other values fail explicitly.

## One native turn

```sh
printf '%s' '{"inputVersion":1,"text":"Check this folder","instructions":"","images":[]}' |
  sov run --sdk --route chatgpt-subscription --json --stdin --input-format json \
    --db /absolute/path/sessions.db --toolset coding --permission-mode default
```

The route is required. Legacy `--provider` conflicts with SDK mode. `--model auto`
and `--effort auto` use route defaults. A route never borrows an unrelated API key,
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
Stale or unknown evidence uses the SDK's conservative limits. Explicit output
budgets still cap the output reservation. Gateway proactive compaction uses
those same limits, system/schema/history accounting and output reservation.
Required capabilities are checked before paid history summarization. A system
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

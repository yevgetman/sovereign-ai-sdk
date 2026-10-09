# SOV authentication routes and Telekit headless integration

**Date:** 2026-10-08  
**Status:** Approved by the Owner in Telegram: “looks good. proceed” (2026-10-08).  
**Owners:** Sovereign AI node (SOV runtime and SDK); Telekit node (bridge).  
**Research:** [Evidence and scope](2026-10-08-sov-auth-routing-research.md).  
**Dependencies:** SOV subscription providers merged in PR #7; SDK toolset and persistence ports; Telekit's merged `sov.toolset` decision work.

## 1. Decision

SOV owns credentials, login, refresh, provider requests, the agent loop, tools and session persistence. Telekit selects a non-secret route and starts SOV headlessly. All six requested authentication routes use the same SOV SDK loop.

The SDK runs inside the SOV process. Telekit does not import TypeScript or implement OAuth. SOV does not start Codex, Claude Code, Grok Build or Hermes to obtain a model or tool loop.

Login works directly through SOV outside Telekit. A Telegram login wrapper is a separate follow-up, not a dependency of this feature.

This contract replaces the earlier apex requirement that Python Telekit itself call `createAgent().run()` in-process. The SDK call is in-process within the SOV host. It also expands the prior Telekit toolset spec: the selected toolset must now reach and restrict the actual loop.

Each node implements its own code through its operator and review process. This document grants neither release publication nor daemon restart authority.

## 2. Result for the Owner

One harness remains available under `kernel`, `telekit` and `sov`. Its display name follows the installation. Authentication does not create another harness.

| Built-in route id | Provider | Authentication | Credential source |
|---|---|---|---|
| `openrouter-api` | OpenRouter | API key | SOV OpenRouter configuration or environment |
| `anthropic-api` | Anthropic / Claude | API key | SOV Anthropic configuration or environment |
| `openai-api` | OpenAI | API key | SOV OpenAI configuration or environment |
| `grok-api` | xAI / Grok | API key | SOV xAI configuration or `XAI_API_KEY` |
| `chatgpt-subscription` | OpenAI / ChatGPT | Subscription | SOV ChatGPT Keychain item |
| `grok-subscription` | xAI / Grok | Subscription | SOV Grok Keychain item |

Existing Telekit credits and OpenRouter lanes remain supported. OpenRouter-hosted Grok remains distinct from direct xAI API usage.

Completed ChatGPT flow:

1. Run `sov login chatgpt` on the Mac. Complete the provider's device login.
2. In Telegram, select `/harness kernel`, then `/provider route chatgpt-subscription`.
3. The harness card shows ChatGPT, subscription, model and local login status.
4. The next message runs SOV tools against that subscription backend.

The Grok flow uses `sov login grok` and `/provider route grok-subscription`. API-key routes require a SOV key and no subscription login.

Commands added below specify future behavior. The research artifact records what exists today.

## 3. Scope

Included: six routes; direct xAI API-key support; SOV-owned auth/status; SDK headless host; toolset enforcement; persistence and resume; streaming, images, cancellation and steering; Telekit controls/status; migration, documentation and live proof.

Deferred: Telegram OAuth relay/logout; Claude subscriptions; multiple subscription accounts per provider on one OS account; public gateway subscription access; new app/web screens; other Kernel surfaces; general model routing; TUI/gateway rewrites.

## 4. Route ownership, models and state

### 4.1 SOV route record

Expose versioned, non-secret route records:

```json
{
  "id": "chatgpt-subscription",
  "provider": "chatgpt",
  "auth": "subscription",
  "defaultModel": "<backend-supported-model>",
  "credentialRef": "subscription:chatgpt",
  "enabled": true
}
```

`provider` selects a transport. `auth` is `api_key` or `subscription`. Allowed combinations match section 2. Direct API-key xAI uses internal provider `xai`; existing subscription provider `grok` stays unchanged.

Built-in ids are reserved and stable. SOV owns default-model overrides through its existing configuration. Arbitrary custom route creation is outside this feature. Credential references are symbolic lookups, never keys/tokens. Route records and Telekit state contain no credentials.

API-key resolution retains SOV's existing environment/config precedence and credential-pool behavior within the selected provider. It cannot switch provider/authentication kind. Subscription storage retains the existing SOV Keychain services and OS-account identity.

Resolve routes through SOV's normal harness home and optional profile. An explicit route must not receive Telekit's credits-specific `HARNESS_HOME`. Telekit explicitly supplies its session DB. Environment key pins remain supported; secrets are not copied into a new Telekit store.

### 4.2 Model and effort compatibility

SOV supplies route defaults and model/effort compatibility. Validate names against the actual backend. Telekit must not convert OpenRouter model ids into direct xAI or ChatGPT ids.

Status performs no network discovery. Explicit SOV catalog refresh may query the selected provider. Verify default models against live service behavior during delivery rather than freezing stale SDK defaults.

Reject known incompatible models/effort before inference. A backend rejection of an otherwise unknown model produces `model_unsupported`; it does not silently select another model. Unsupported effort is an explicit error, not silent omission.

Existing automatic model/effort selection must stay within the selected route's supported choices. A failed automatic decision may use that route's declared default; it cannot change provider/authentication. Composite `/harness kernel <model> <effort>` changes validate all requested fields before saving any of them.

### 4.3 Telekit selection and precedence

Store route selection in the existing principal scope, like current provider settings. Selection survives `/new`. This feature does not add node/thread credential stores or change the existing scope.

Precedence:

1. Explicit saved SOV route.
2. With no explicit route, current Telekit provider/model/lane resolution.

Credential presence never selects a route. Adding a credits key, API key or login does not change the chosen payment method.

Store model/effort overrides separately per route within that principal scope. First use starts from SOV's route model default and the current valid SOV effort. Switching back restores valid route overrides. Legacy model/provider settings remain separate and unchanged.

Validate a route and its machine contract before saving selection. Missing credentials permit selection, but the card names the missing credential and a turn fails before inference. Unknown, disabled or unsupported routes leave state unchanged.

### 4.4 Migration and clearing

Upgrade/startup does not automatically select a route. Existing credits/OpenRouter/provider/model pins and sessions retain their payment path.

`/provider route off` clears the explicit route and restores legacy resolution. Confirmation names the restored provider/payment method. No credential is deleted.

With an explicit route selected, legacy `/provider <slug>` and clear/default arguments refuse to change billing implicitly. Explain `/provider route off`. Without an explicit route, existing provider commands retain their behavior. OpenCode behavior stays unchanged.

## 5. SOV machine interface

### 5.1 Read-only discovery

Add:

```text
sov capabilities --json
sov routes --json
sov auth status --route <id> --json
```

All outputs include `schemaVersion: 1`. Capabilities advertise SDK run, routes, structured input, toolsets, supported images, steering and JSONL compatibility. Routes list enabled built-ins, defaults and model/effort compatibility. A missing key/login does not hide a route.

Status includes route, provider, auth and `credentialState`: `missing`, `present`, `expired`, `unreadable` or `unavailable`. Expired access with a refresh token also reports `refreshable: true`. `present` means local credentials exist, not that inference entitlement is proved.

Status performs no refresh, login, browser open, network call or credential write. JSON is the only stdout content; diagnostics use stderr. Timeouts are bounded. Keychain/platform failures report unavailable, not missing credentials. No tokens, key fragments, credential records or unverified account identity appear in output.

Telekit probes the exact resolved executable. Cache capabilities by executable identity; invalidate on replacement. Never run interactive login as a probe.

### 5.2 SDK run mode

Extend the CLI additively:

```text
sov run --sdk --route <id> --json --stdin --input-format json
        --db <telekit-session-db> [--resume <session-id>]
        [--model <model>] [--effort <effort>] [--toolset <name>]
        [--permission-mode <mode>] [--steer-file <path>]
```

`--sdk` starts a local SDK host with no HTTP listener or TUI. Reuse shared composition for bundle/context, tools, permissions, hooks, skills and MCP. Call `createAgent().run()` once per requested turn; the SDK owns model/tool iterations.

`--route` is required in SDK mode. Conflicting legacy provider arguments are refused. Legacy `sov run` without `--sdk` remains compatible and uses its existing runtime path.

SDK input defaults to text for direct callers. Telekit sends this JSON envelope on stdin:

```json
{
  "inputVersion": 1,
  "text": "Owner message",
  "instructions": "Trusted bridge instructions appended to base system context",
  "images": [
    {"path": "/absolute/local/attachment.png", "mediaType": "image/png"}
  ]
}
```

Validate before model/tool calls. Instructions augment base context; they never replace bundle instructions. Telekit supplies them from its trusted bridge composition. Forwarded/user text stays user content. Instructions are ephemeral and do not accumulate in user history.

Images preserve list order. Read bounded local files and send native image content on supported backends. Do not fetch attachment URLs. Invalid/unreadable/unsupported media fails before inference. Silent omission is forbidden. Text/tool cycles are mandatory on every route; advertise image support only for verified supported paths.

Prompt, instructions and credential material stay off argv. Apply current attachment-size bounds. Reject unexpected envelope fields, including arbitrary execution controls.

### 5.3 Events and terminal result

Preserve compatible existing JSONL names/payloads. Add metadata without removing fields:

- `session.started`: session id, resumed, route, provider, auth, model, effort, toolset and permission mode.
- Existing text/thinking and tool progress events.
- Exactly one `turn.completed` or `turn.error` for a recognized machine request.

Completion retains reply, session id, finish reason and optional usage. Subscription usage is token/quota evidence; do not invent an API-dollar charge. Report the route actually used.

Errors retain safe text, nullable session id and recoverability. Add stable `code`: `invalid_input`, `route_unavailable`, `model_unsupported`, `effort_unsupported`, `credential_missing`, `auth_expired`, `credential_unavailable`, `tier_blocked`, `rate_limited`, `context_overflow`, `unsupported_input`, `interrupted`, `storage_failed` or `provider_failed`.

Exit codes: completion 0; turn failure 1; invalid input/usage 2; SIGINT 130; SIGTERM 143. Argument rejection before machine-request recognition may use stderr only. Telekit handles that case, malformed JSONL and process exit without a terminal event as failure.

Cleanup is bounded. Unknown additive events can be ignored. Truncated output or missing terminal events never count as successful replies.

## 6. Authentication lifecycle

Keep attended `sov login chatgpt|grok` and `sov logout chatgpt|grok`. SOV owns device authorization, browser link/code, polling, Keychain and refresh. Existing Claude Max refusal remains.

A normal turn never logs in, opens a browser or waits for authorization. Missing login gives a typed failure and the external SOV command. Do not import or delete Codex/Grok Build/Claude Code logins automatically.

### 6.1 Cross-process coordination

Use shared locking for every process using the same subscription credential identity. Login writes, refresh and logout use the same boundary. The current in-process Map alone is insufficient.

Requirements:

- Lock before exchanging/writing/deleting. Reread credentials under lock.
- For concurrent 401s, refresh only if the rejected token generation is still current. Otherwise use the already replaced token.
- Atomically replace Keychain credentials. Failed writes end the turn, not continue with stale credentials.
- Bound waits/network requests by cancellation and deadline. Dead processes cannot block future turns permanently.
- Logout cannot be undone by a pending refresh. Requests begun after logout fail as missing. An already sent request need not be retractable.
- Lock metadata contains no secrets. Test overlapping OS processes, crashes and logout.

### 6.2 Provider behavior

Reuse bounded subscription retry rules and test their complete bounds. One 401 refresh recovery is allowed; a second 401 ends the turn. Grok inference 403 reports `tier_blocked`. Refresh failure, limits and unsupported models never select another provider, auth method, account or model.

Retries stay on the selected route and cannot repeat tools already executed. Propagate cancellation through credential waits/refresh, model streams and tools.

Audit ChatGPT/Grok bodies, headers, effort, streams and tool serialization against fresh service behavior. Resolve the researched Grok Chat Completions versus Responses mismatch before claiming live support. This remains SOV work.

## 7. SDK host, tools and persistence

### 7.1 Composition and restrictions

Reuse SOV bundle, cwd, node context, skills, hooks, MCP and learning behavior. Factor shared host composition rather than duplicate a stripped-down server loop.

`--toolset` accepts `chat`, `web`, `ops`, `coding`; omitted is `coding`. Unknown names fail before stream. Pass it into the SDK so schemas and execution use the restricted pool. Existing SDK budgets apply unless an explicit host limit is narrower.

Skills, group/chat restrictions and deny rules only narrow tools. Preserve Telekit's authorized owner headless posture. Unanswerable headless permission prompts deny/fail promptly; never wait on a TTY. Do not broaden member/group grants.

Owner subscription credentials remain local-owner credentials. Public gateway principals cannot load them. Telekit checks its authenticated principal and existing credential delegation boundary. Selecting a route does not grant credential/tool access.

### 7.2 Single persistence owner

Use one SOV persistence writer backed by the existing Telekit SOV DB. Adapt SDK SessionStore/TranscriptStore as required. Do not also persist the same messages through legacy server callbacks.

Durably save each assistant tool call before its side effect. Required storage failure prevents execution. Save results with original call ids. Interrupted calls must not be executed again automatically on resume; use explicit interrupted results or a recoverable error.

Preserve compatible session ids/history and test current DB migration. If safe import is impossible, report it and retain the old record. Do not silently drop context.

Record route/provider/model per new turn. Continue normalized history across routes only when the backend supports it. Reject or explicitly hand off incompatible history; do not drop messages or change routes. Cross-harness handoff remains Telekit's responsibility.

Subscription overflow reports `context_overflow`. SDK mode adds no automatic summarizer or API-key compactor. Legacy compaction stays compatible. Auxiliary/delegation paths cannot borrow unrelated ambient credentials; unconfigured paths fail explicitly.

### 7.3 Control and streaming

Preserve text/thinking relay, tool progress, session accounting and steering format. Poll steering at safe loop boundaries. SIGINT/SIGTERM cancel provider/tools and clean up. Telekit timeouts and `/stop` remain effective.

Failures reach a terminal event even without assistant text. A typing indicator must not be the only result.

## 8. Telekit commands and cards

For the SOV harness:

- `/provider` shows explicit route or legacy provider/lane, six route choices and local credential state.
- `/provider route <id>` selects a route.
- `/provider route off` restores legacy settings with a payment-path confirmation.
- `/model` and `/effort` use route defaults/compatibility.

Other harnesses keep their current behavior. Update the public command reference and machine catalog.

Subscription card:

```text
Harness
Now — kernel
Provider — ChatGPT
Authentication — subscription
Login — present locally
Model — <selected model>
```

Missing login replaces the login row with `missing` and gives `sov login chatgpt`. Expired but refreshable state explains that SOV will attempt refresh on the next message. API cards show provider, API-key state and model without secrets.

Only legacy credits mode shows the credits warning. Explicit subscriptions never recommend buying credits or setting a Telekit credits key. Harness/provider/status/errors agree on the selected route.

`/login` for SOV gives the external command for the selected subscription. `/login status` delegates to read-only SOV status. API-key routes explain SOV key configuration. Telegram device-flow relay/logout stays deferred.

Missing SDK capability refuses the explicit route/turn with an actionable binary/version message. Never fall back to legacy run or credits. With no explicit route, an old binary can retain legacy behavior. Upgrades do not change routes.

## 9. Acceptance matrix

| Id | Required evidence |
|---|---|
| A1 | All six routes resolve to declared backend/auth; Grok API key is direct xAI, not OpenRouter. |
| A2 | External SOV login then headless inference works without Telegram login relay. |
| A3 | Secrets stay in SOV stores and never appear in state, status, logs, JSONL or errors. |
| A4 | Missing login, refresh failure, 403, limits and unsupported model end explicitly; no unselected provider/auth/model request. |
| A5 | Real concurrent processes refresh correctly; crash, cancellation, logout and write failure are covered. |
| A6 | SDK mode starts no listener, TUI or other harness; legacy CLI contracts still pass. |
| A7 | Toolset constrains schemas/execution; restrictions never add tools; Telekit's decision reaches SDK. |
| A8 | Tool calls save before effects; storage failure prevents execution; resume retains ids with no duplicate messages/repeated effects. |
| A9 | Streaming, tool cycle, multi-turn resume, steering, stop, timeout and terminal failures work through Telekit. |
| A10 | Supported images arrive in order; unsupported input fails before inference and never disappears. |
| A11 | Upgrade retains credits/OpenRouter/pins/sessions; explicit route wins even when a credits key is added. |
| A12 | Selection is principal-scoped, survives `/new`, and does not change another principal or SOV interactive default; composite dial changes are atomic. |
| A13 | Cards describe the actual route; subscriptions show no credits warning; missing capability never triggers billing fallback. |
| A14 | Each route completes authorized live inference; each subscription completes a tool cycle and resumed turn on an eligible account. |

Use fake credentials/HTTP offline. Use real processes for locking and headless contract checks. Tests do not read real Keychain or launch live login by default.

Live evidence records route/auth/model/backend, tool/result and terminal result with secrets removed. Token presence and mocked tests are not live proof. If a Grok tier rejects inference, record `tier_blocked` and leave it unverified; do not mark pass or change/buy a plan automatically.

Run SOV's configured lint, typecheck, boundary and full test gate. Run Telekit's full configured gate, including tests and applicable docs/build checks. Focused tests alone are insufficient.

## 10. Delivery and completion

1. Sovereign AI node builds route/auth/status and SDK machine contract.
2. Telekit node integrates controls, input, toolset and events against it.
3. Both nodes complete regression gates and authorized live proof.
4. Build/install compatible artifacts through normal product procedures. Verify binary resolution and a real Telegram flow. Restart/publication follow existing authority rules.

Update current-state docs as behavior ships. Use each product's required release procedure; this spec assigns no planned version. Keep private source/planning out of customer artifacts.

Completion requires the six-route matrix, migration proof, correct cards and installed Telegram verification. Report any missing live credential/tier evidence as remaining work rather than claim complete support.

## 11. Self-review

Reviewed against the Owner's accepted research direction: all six routes; external login; SOV-owned loop/auth; explicit Python/TypeScript boundary; unchanged legacy billing; principal-scoped state; capability refusal; process-safe refresh; single persistence writer; toolsets; images; no hidden paid fallback; mock/live distinction; separate shipping authority.

This spec changes no product code, credentials or installed runtime. Implementation planning follows explicit approval of this document.

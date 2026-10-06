# Headless subscription loop — design

**Status:** SPEC. Written 2026-10-06. This file authorizes no code. A later plan needs a separate green light.
**Author:** Julie
**Apex lock:** `~/code/me/ops/sov-headless-loop.md`
**Analysis (current state, not this contract):** `docs/02-architecture/hermes-loop-reference.md`, `docs/02-architecture/sov-loop-as-built.md`, `docs/02-architecture/hermes-to-sov-gap.md`
**Hermes pin for the login reference:** `~/code/hermes-agent` at `e97923c38acb` (2026-10-06). Re-read that tree at implementation time. Do not import it.

---

## 0. Decision

Kernel's routine headless turn calls `createAgent().run()` in this process. The turn uses the Owner's own ChatGPT, Claude Max, or SuperGrok login over HTTP. SOV runs the tools. The turn does not boot Claude Code, Codex, Grok Build, `sov run`, or `hermes -z`.

This spec closes the three gaps named in the apex lock:

1. Three subscription logins, as `LLMProvider`s.
2. A toolset chosen before the model call.
3. Loop hardening: retries on those providers, the existing step budget, and a tool call saved before it runs.

Hermes is the reference for the logins and for save-before-run. It is not the runtime.

---

## 1. Goals

1. A chat turn sends **no coding tool schema**.
2. A subscription turn bills the Owner's plan quota. It does not fall through to a pay-per-token API key.
3. A crash during a tool leaves the tool call already stored, so resume can see it.
4. Callers that set nothing keep today's behavior. Omitted toolset, omitted store, and the API-key providers stay as they are.

## 2. Non-goals

- Adopting Hermes, or shelling out to `hermes -z`.
- Porting Hermes gateway, desktop, cron, kanban, voice, or browser tools.
- `codex_app_server`, or any mode that hands the loop to a coding app.
- Replacing `src/runtime/subprocessExecutor.ts`. That `claude -p` path stays off by default, and stays barred from the gateway and from cron.
- Reselling a consumer subscription. The 2026-06-22 lock still holds. These logins are the Owner's, on this Mac.
- Building the model-router organ (`~/code/me/projects/model-router.md`). A toolset is not that router. Subscription-versus-API as a priced lane stays that organ's job.
- Context compression. A prompt that does not fit the model ends the turn. No summarizer in this spec.
- A second decision model. Glide is not a picker in this Kernel. Jev is the only picker, and it runs in the Kernel surface, not inside `query()`.
- A new CLI for the turn. `sov run` stays the machine CLI it already is. It is not the Kernel path.

---

## 3. Who does what

| Duty | Where |
|---|---|
| Pick the toolset, then call `run()` | Kernel surface (Telekit first). Not this repo's first code. |
| Map the toolset to tools, call the model, run tools, save the call first | This SDK |
| Read the Keychain and build the provider object | `loadSubscriptionProvider()` in this SDK, called by the local owner process |
| Serve a tenant | The gateway. It must not load these three providers. |

`run()` already returns `RunResult` (`packages/sdk/src/agent/createAgent.ts`). The Kernel surface reads `terminal`, `finalAssistant`, and `usage`. No new result type.

---

## 4. Subscription providers

### 4.1 Names

Three new providers. Each implements `LLMProvider` (`packages/sdk/src/providers/types.ts`). The cycle stays `query()`.

| Name | File | Login | HTTP host family |
|---|---|---|---|
| `chatgpt` | `packages/sdk/src/providers/chatgpt.ts` | ChatGPT / Codex subscription | `chatgpt.com` Codex backend. Not `api.openai.com`. |
| `claude-max` | `packages/sdk/src/providers/claudeMax.ts` | Claude Max subscription | `api.anthropic.com` Messages API. Not `claude -p`. |
| `grok` | `packages/sdk/src/providers/grok.ts` | SuperGrok or X Premium+ | `api.x.ai`. Not the Grok app. |

`packages/sdk/src/providers/anthropic.ts` and `openai.ts` stay the API-key providers. A missing OAuth item must not change their requests. A golden test locks one API-key Anthropic request to today's bytes.

String names `chatgpt`, `claude-max`, and `grok` resolve only when `resolveProvider` is called with `allowSubscriptionAuth: true` (`packages/sdk/src/providers/resolver.ts`). `createAgent` does not set that flag. The gateway does not set it. A gateway turn that names one of the three fails before any HTTP, with `CredentialUnavailableError`.

The Kernel path does not use the string. It calls `loadSubscriptionProvider(name, port)` and passes the returned object as `AgentConfig.provider`.

Do not add these names to the gateway provider list. Do not let `CredentialPool` rotate a subscription failure onto an API key. `isCredentialUnavailable` (`packages/sdk/src/providers/errors.ts`) must not treat the new error classes in §7 as a signal to try another secret.

### 4.2 Tokens

Subscription tokens live in the **macOS Keychain**. They do not go into `<harnessHome>/credentials.json`. The existing API-key pool is unchanged.

| Provider | Keychain service |
|---|---|
| `chatgpt` | `SOV_SUB_CHATGPT` |
| `claude-max` | `SOV_SUB_CLAUDE_MAX` |
| `grok` | `SOV_SUB_GROK` |

Account is the OS user who ran login. The item value is JSON: `accessToken`, `refreshToken`, `expiresAt` (unix milliseconds). Never log, trace, or persist those fields. A trace may record the provider name and `auth: "subscription"` only. Error text must redact the token strings.

Port: `packages/sdk/src/providers/subscription/port.ts`. The Mac adapter uses `security`. Tests inject a fake port. No test reads the real Keychain.

Refresh: if `expiresAt` is within 60 seconds, refresh once before the model call, then write the new JSON back. One refresh at a time per service, so two turns cannot rotate the same refresh token. A failed refresh throws `SubscriptionAuthExpiredError`. It does not fall through to an API key.

Who may read: the local owner process that called `loadSubscriptionProvider`. A turn with a gateway principal does not get this port.

### 4.3 Login

`sov login chatgpt|claude-max|grok` is an attended command. It opens the browser flow, writes the Keychain item, and prints no token. `sov logout` for the same names deletes the item. The headless turn never runs login.

The browser flow and the public client identity are copied from the Hermes provider at the pin above, after a fresh read. This repo does not depend on Hermes.

### 4.4 Claude Max — verify, then freeze

The call is HTTPS to the Anthropic Messages API with the OAuth token as Bearer. The request must identify as the Claude Code client the current subscription terms allow.

This spec does **not** freeze headers, the system-prompt stamp, or beta flags. Before the first live `claude-max` call is merged, the implementer re-reads:

- `agent/anthropic_adapter.py` and `agent/anthropic_credentials.py` at or after `e97923c38acb`
- Anthropic's current terms for third-party use of a consumer subscription

Ship only the shape those two agree on. If the terms forbid the call, do not merge `claude-max`. A version-only subprocess may read the local Claude Code version. `claude -p` is not allowed on this path.

### 4.5 ChatGPT

OAuth against the Codex backend Hermes uses (`plugins/model-providers/openai-codex`). Re-read that plugin before freezing the URL. There is no `codex_app_server` mode. A 401 refreshes once (§4.2). A second 401 is `SubscriptionAuthExpiredError`.

### 4.6 Grok and HTTP 403

Some SuperGrok tiers return HTTP 403 after a good login (Hermes guide `website/docs/guides/xai-grok-oauth.md`, issue 26847). That 403 is `SubscriptionTierBlockedError`. No retry. No second call with `XAI_API_KEY`. The error text says this login tier cannot use the HTTP path, and that an API-key provider is a separate explicit choice.

### 4.7 Retries

Retries live **inside** the three subscription `stream()` implementations. `query()` does not gain a retry loop. API-key providers stay single-attempt. The conduct `regenerate` loop in `createAgent` is a different mechanism and stays as it is.

| Outcome | What the provider does |
|---|---|
| 429, 500, 502, 503, 504, connection reset, empty stream | Retry. Three attempts total. |
| `Retry-After` of 10 seconds or less | Wait that long. |
| `Retry-After` over 10 seconds | Fail the turn. Do not wait. |
| No `Retry-After` | Wait 500 ms, then 1500 ms. Add up to 250 ms of jitter. |
| 401 | One refresh, then one new attempt. Second 401 → `SubscriptionAuthExpiredError`. |
| 403 on `grok` | `SubscriptionTierBlockedError` at once. |
| Other 4xx | No retry. |
| AbortSignal fires | Stop waiting. No further attempt. |

### 4.8 Byte-identical bar

With no subscription provider object and no `toolset`, a turn is today's turn. `subprocessExecutor` tests stay green without edits. `sov run` behavior stays as specified in `specs/2026-07-09-sov-run-machine-contract-design.md`.

---

## 5. Toolset

### 5.1 Field

Add `toolset?: "chat" | "web" | "ops" | "coding"` to `PerTurn` and to `AgentConfig` (`packages/sdk/src/agent/createAgent.ts`). Per-turn wins.

Omitted means **coding**, and coding means the pool `assembleToolPool` already returns (`src/tool/registry.ts`). Existing callers do not change schema.

An unknown string fails the turn **before** `provider.stream`, with `UnknownToolsetError`. It does not fall open.

### 5.2 Membership

Filter after `assembleToolPool` and after `isEnabled`. Never add a tool the assembler dropped. `AgentTool` stays dropped when no agents are loaded.

| Toolset | Tools the model may see |
|---|---|
| `chat` | None. The request carries no tool schemas. |
| `web` | `WebSearch`, `WebFetch` |
| `ops` | `memory`, `skills_list`, `skill_view`, `task_list`, `task_get`, `task_output`, `HarnessInfo` (only if the assembler supplied it) |
| `coding` | The assembled pool, unchanged. Includes `ToolSearch`, MCP tools, and `workflow_run` when the host supplied them. |

`chat`, `web`, and `ops` drop MCP tools, `ToolSearch`, `workflow_run`, shell, file tools, `AgentTool`, and `StaticSiteValidate`. A deferred tool must not be reachable by search on those three toolsets.

Do not use `buildToolScope` (`packages/sdk/src/tool/toolScope.ts`) for this filter. An empty allow-list there means "all tools". `chat` is the opposite: zero tools.

Also wrap `canUseTool`. A call whose name is outside the filtered pool returns `{ behavior: "deny", reason: "tool is outside the turn toolset" }`.

A skill's own `allowedTools` may narrow further. Intersection only. A skill cannot put `Bash` on a `chat` or `ops` turn.

Lane defaults in `src/router/lanes.ts` stay `allowedTools: null`. This spec does not retune task lanes. If a turn has both a lane allow-list and a toolset, the model sees the intersection.

### 5.3 Who picks

The SDK does not call Jev. It does not call `api.typesafe.ai`. Telekit (or another Kernel surface) picks, then passes `toolset`.

Jev contract for that caller, matching `telekit/jev_effort.py`:

- POST `https://api.typesafe.ai/v1/systemone`, model `jev-latest`, timeout 400 ms.
- Key from Keychain service `TYPESAFE_API_KEY`. Never log the key.
- Send at most 1000 characters of the user text.
- Closed choice: `chat`, `web`, `ops`, `coding`.
- Confidence under 0.5, timeout, HTTP error, or an unknown label → pass `toolset: "coding"`.

Fail closed is the coding pool, because a missed pick must still be able to do the work. The trace should show `coding` rather than an omitted field, so a fallback is visible.

### 5.4 Step budget

`maxTurns` already exists (`query()` default 100, `AgentConfig.maxTurns`). A caller-set `maxTurns` always wins.

When the caller set a toolset and did **not** set `maxTurns`:

| Toolset | Default `maxTurns` |
|---|---|
| `chat` | 1 |
| `web` | 6 |
| `ops` | 8 |
| `coding` | 100 |
| omitted | 100 (unchanged) |

The loop detector is unchanged (`specs/2026-08-25-progress-aware-loop-guard-design.md`).

---

## 6. Save the tool call, then run it

Today `persistTurn` in `createAgent.ts` writes messages **after** the run. A crash inside `runTools` (`packages/sdk/src/core/query.ts`) leaves no tool-call row.

New order, only when `sessionStore` is set, and only in the tool branch (after the assistant message is in history, before `runTools`):

1. `upsertSession` for this `sessionId` if the row is missing.
2. `saveMessage(sessionId, { role: "assistant", content, toolCalls })`.
   - `content` is the assistant message, including the `tool_use` blocks.
   - `toolCalls` is the `tool_use` block array from that message (`SaveMessageInput` in `packages/sdk/src/core/sessionPort.ts`).
3. On success, call `runTools`.
4. On throw, do not call `runTools`. Yield the same kind of synthetic `tool_result` the empty-pool branch already yields, with the text `tool call was not run: transcript write failed`. Return `terminal.reason = "error"` and `PersistBeforeRunError`.

No store means no early write. Embedders that omit `sessionStore` stay disk-free. The Kernel caller **must** pass a `SessionStore`, or this guarantee is off.

`persistTurn` must not write the early row again. Extend the prefix check so a stored transcript that is a verbatim prefix of the **full** message list sets the write cursor at `stored.length`. A stored transcript that is not a prefix still appends, as today. A stored list longer than the seed must not by itself force a full re-append.

---

## 7. Errors

New classes next to `packages/sdk/src/providers/errors.ts`. Each ends the turn as `Terminal.reason = "error"`. None of them triggers API-key rotation or compression.

| Class | When |
|---|---|
| `SubscriptionAuthExpiredError` | Refresh failed, or 401 after one refresh. |
| `SubscriptionTierBlockedError` | `grok` returned 403. |
| `ContextOverflowError` | The provider refused the prompt because it does not fit. No retry. |
| `UnknownToolsetError` | `toolset` is not one of the four names. |
| `PersistBeforeRunError` | The pre-tool `saveMessage` threw. |

---

## 8. Acceptance

Tests use fake HTTP and a fake Keychain port. No live OAuth. No real Keychain.

- API-key Anthropic request bytes match the golden fixture when no subscription credential exists.
- `chatgpt` never requests `api.openai.com`. `grok` 403 does not send a second request.
- 429 then 200 on a subscription provider: one retry, then success.
- 401, failed refresh: one refresh attempt, `SubscriptionAuthExpiredError`, no API-key request.
- Abort during the backoff: no further attempt.
- `toolset: "chat"` sends no tool schemas. `maxTurns` is 1 unless the caller set it.
- `toolset: "web"` schema names are only `WebSearch` and `WebFetch`.
- `toolset: "ops"` does not include `Bash`, `FileRead`, `FileWrite`, `FileEdit`, `AgentTool`, or `WebSearch`.
- Omitted `toolset` yields the same tool names as today.
- `"chatty"` fails before `stream`.
- A skill allow-list cannot add `Bash` on `ops`.
- With a fake store, `saveMessage` for the assistant `tool_use` is recorded before the tool's `execute`.
- A store that throws: `execute` is not called, and the terminal error is `PersistBeforeRunError`.
- After a successful early save, `persistTurn` does not insert that assistant row twice.
- With no store, tools still run and nothing is written.
- `resolveProvider("chatgpt")` without `allowSubscriptionAuth` throws, and performs no HTTP.
- `subprocessExecutor` tests pass unchanged.

---

## 9. Order for a later plan

This is not the plan.

1. Credential port, three providers, login/logout, retries, the tenant fence.
2. `toolset` filter, deny wrapper, `maxTurns` defaults.
3. Save-before-run and the `persistTurn` prefix fix.
4. Telekit calls `loadSubscriptionProvider`, then Jev, then `run()`. That change is in the Telekit repo. It is not a slice of this repo.

---

## Read next

- `docs/02-architecture/hermes-to-sov-gap.md` — the delta this spec decides
- `docs/02-architecture/sov-loop-as-built.md` — the cycle as it is today
- `docs/04-extending/extending.md` — how a provider is added
- `~/code/me/ops/sov-headless-loop.md` — the apex lock

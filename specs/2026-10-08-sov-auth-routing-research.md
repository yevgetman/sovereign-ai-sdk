# SOV authentication and Telekit integration — researched scope

Date: 2026-10-08. Status: proposed design and scope; implementation is not approved.

## Owner requirement

One SOV harness, displayed as Kernel or Telekit, must support:

| Provider | API key | Subscription |
|---|---|---|
| OpenRouter | Yes | No |
| Anthropic / Claude | Yes | No |
| OpenAI | Yes | Yes, ChatGPT login |
| xAI / Grok | Yes | Yes, Grok login |

SOV owns authentication, token refresh, provider requests, and tool execution.
Telekit selects a route and drives SOV headlessly. Subscription login works
outside Telekit. A thin Telegram login wrapper is optional and does not own OAuth.
Existing Telekit credits remain an explicit supported route.

## Evidence and limits

Research read Telekit HEAD bd566b8, origin/main, and the working tree; SOV source
50e333d. The Telekit working tree contains unrelated changes and is detached.
No existing changes were edited. Installed versions: Telekit 0.64.15, SOV 0.6.73.

1. SOV PR #7 is merged as a58ca6a. Source package versions are SOV 0.6.74 and
   SDK 0.11.0. The installed SOV binary predates the new login commands.
2. `packages/sdk/src/providers/subscription/load.ts` already builds ChatGPT and
   Grok provider objects. It refuses Claude Max and gateway principals.
3. `src/main.ts` already defines `sov login chatgpt|grok` and logout in source.
   Those commands perform the provider's device flow and store tokens in Keychain.
4. `src/cli/runCommand.ts` still boots the existing local HTTP/SSE server path.
   `src/server/runtime.ts` calls `resolveProvider` without subscription permission.
   Therefore the source CLI headless path also needs integration; installing a
   newer binary alone is insufficient.
5. `src/server/routes/turns.ts` already invokes `createAgent().run()`. The missing
   work is host wiring, not a new model/tool loop. That host owns persistence
   outside the SDK and does not pass the SDK's new store ports.
6. SOV's API-key registry and config schema have Anthropic, OpenAI and OpenRouter.
   They do not have direct xAI API-key configuration. `grok` currently identifies
   a subscription provider in the SDK resolver. Telekit's Grok provider currently
   maps to OpenRouter. Neither is direct xAI API-key support.
7. Telekit `agent.py` always passes an explicit provider/model to `sov run`.
   `config.py` chooses credits/OpenRouter/native API-key targets. There is no
   subscription route. `harness_auth.py` excludes SOV from its login wrapper.
8. Telekit's merged toolset work, 1575a7a and fd9158e, selects a toolset but the
   legacy CLI has no toolset argument. Its spec explicitly excludes subscription
   integration. The selected toolset is not yet applied by that legacy invocation.
9. SOV's refresh lock in `providers/subscription/tokens.ts` is an in-process Map.
   Concurrent Telekit subprocesses can still refresh the same Keychain item.
10. ChatGPT `toCodexInput` handles text and tool blocks but has no image branch.
    The Grok subscription implementation uses Chat Completions. The local Hermes
    guide describes its Grok OAuth path as Responses. Protocol parity needs a
    fresh check, not an assumption that mocked tests prove live service behavior.

Verification: `bun test tests/providers/subscription.test.ts
tests/agent/subscriptionLoop.test.ts` passed: 28 tests, 76 assertions. These use
fake HTTP and Keychain. No live login, model request, or token read was performed.

Provider reference: OpenAI documents separate ChatGPT and API-key authentication
at https://developers.openai.com/codex/auth . Local Hermes reference:
`~/code/hermes-agent/website/docs/guides/xai-grok-oauth.md` and
`plugins/model-providers/openai-codex`. These references are protocol inputs;
they are not proof that the present SOV implementation works on an owner's plan.

## Recommended boundary

Implement a SOV-owned SDK headless adapter with a stable machine contract.
Use `createAgent().run()` inside SOV; keep the Python bridge out of TypeScript
provider composition. Telekit can launch the SOV process, as it launches other
harnesses. It must not boot a coding product to borrow that product's loop.

Preserve the useful existing JSONL contract: session started, text/thinking,
tool progress, completed/error, usage and session id. Reuse the existing Telekit
event parser where compatible. Preserve legacy `sov run` callers. Exact command
and additive flags are an implementation-spec decision; proposed examples below
are not commands that exist today.

This revises the earlier apex requirement that Telekit itself call the SDK
in-process. Python cannot import the TypeScript SDK directly. The Owner's current
request puts the subscription path inside SOV and makes Telekit a thin caller.
The detailed implementation spec must record that boundary explicitly.

## Work package 1 — SOV route and credential contract

Owner: Sovereign AI node. Telekit specifies its consumer requirements here.

- Define provider, authentication kind, model, and optional credential/profile
  reference as separate fields. Do not infer payment method from model name.
- Provide six explicit routes from the table. Use an unambiguous internal xAI
  API-key name, for example `xai`; preserve existing `grok` subscription semantics.
- Add xAI registry/config support using `XAI_API_KEY` and the direct xAI transport.
  Keep OpenRouter-hosted Grok as a separate valid route.
- Store credentials and route definitions in SOV. Telekit stores only the selected
  non-secret route id, scoped to its existing principal/bot/thread rules.
- Validate route/model combinations before launch. Discover or validate models
  for the actual backend; a ChatGPT route does not promise the entire OpenAI API
  model catalog. Avoid stale SDK default model ids as launch policy.
- Define precedence: explicit selected route wins; existing saved settings migrate
  without changing their billing path. Credits must never override a subscription.
- Missing or rejected subscription credentials must never fall through to an API
  key, credits, another account, or another provider.
- Add safe machine-readable auth status: missing, present, expired, unreadable,
  unavailable platform; no tokens. Distinguish local token presence from a live
  inference check. Login/logout stay attended SOV commands.
- Add process-safe refresh coordination with reread under lock, atomic credential
  replacement, bounded waits and stale-lock recovery. Lock by credential identity.
  Cover overlapping refresh and logout. Do not rely on a Python-only lock.

## Work package 2 — SOV SDK headless host

Owner: Sovereign AI node. This is the largest part.

- Construct the chosen API-key or subscription provider inside SOV. Keep owner
  subscription access opt-in and unavailable to public gateway principals.
- Reuse bundle/context, system instructions, tools, skills, hooks, MCP and
  permission composition. Do not copy a second stripped-down agent loop.
- Apply the selected `chat|web|ops|coding` toolset before sending schemas.
  Skill/permission restrictions can narrow it but cannot add tools back.
- Connect persistence exactly once. Save tool calls before side effects and
  preserve tool-call/result pairing during resume. The current server store and
  SDK store ports must not both write the same messages.
- Preserve history, session ids, handoff and recoverable interrupted turns.
  Define compaction for subscription routes; an auxiliary API-key fallback is
  not allowed unless separately and explicitly configured.
- Preserve cancellation, timeouts, steering and tool progress. Emit terminal
  machine events even on login failure, interrupt or provider error.
- Audit subscription HTTP bodies, headers, stream parsing, effort mapping,
  tool arguments/results and actual backend model support against fresh primary
  source/reference behavior. Fix ChatGPT image serialization or explicitly refuse
  images before a call; never silently drop them.
- Preserve API-key behavior and all existing headless caller contracts.

## Work package 3 — Telekit consumer and user surfaces

Owner: Telekit node.

- Query SOV capabilities/routes/status and select the SOV-owned route.
  Route selection follows Telekit's existing per-principal scope.
- Pass prompt, model/effort overrides, selected toolset, cwd, session id and
  permission scope through the headless contract. Parse streaming events and
  preserve existing stop, queue, handoff and resume behavior.
- Replace unconditional credits warnings with the selected route's status.
  Show provider, API-key/subscription/credits, and usable/missing/expired state.
- Keep `sov`, `kernel` and `telekit` aliases for the same harness. A subscription
  does not require selecting the separate Codex or Grok Build harness.
- On missing subscription login, point to SOV's external login command. Normal
  message handling must not start login or wait on browser approval.
- Protect owner credentials from unauthorized shared-chat/multi-user use, using
  existing principal and permission boundaries. Do not blanket-disable authorized
  owner-controlled bots.
- Update manual, command cards, diagnostics and error mapping. Credits remain
  visible only where selected; no suggestion to buy credits to fix subscription.

Optional follow-up: expose SOV's device flow through Telekit's existing login
process wrapper. SOV still performs OAuth and writes credentials. The core route
must work with that wrapper absent. Telekit already has similar wrappers for
Codex/Grok/Claude; they delegate provider authentication to those executables.

## Work package 4 — integration proof and delivery

- Offline contract tests for all six routes and legacy credits/OpenRouter routes.
- Headless tests for chat, one real tool cycle, multi-turn resume, interruption,
  streaming errors, model/effort changes, images and concurrent credential refresh.
- Assert missing login, failed refresh, 403, quota/rate limits and unsupported
  models never trigger an unselected paid route. Keep secrets out of JSONL/logs.
- Verify group restrictions and that per-bot route selection does not change
  another bot or the default SOV interactive profile.
- Perform attended live login and inference for ChatGPT and Grok; prove one tool
  use and a resumed turn. Record actual backend, model and terminal result.
  A Grok login alone is not proof of inference entitlement: the present reference
  records a possible 403 tier block. Report that outcome without changing routes.
- Verify each direct API-key route with an authorized credential. Do not label
  an unavailable credential or tier as a passed live route.
- Run full configured gates in each changed repo. Then install compatible SOV
  and Telekit artifacts and repeat a real Telegram end-to-end check. Release
  planning and publication follow each node's release procedure.

## Dependency order and completion

1. Agree the SOV machine contract and route migration.
2. Build and verify SOV route/auth and headless host work.
3. Integrate Telekit selection, events, toolset and status against that contract.
4. Complete live proof and install the compatible pair.

This is a two-codebase integration. API-key xAI support, concurrency, persistence,
toolset application and protocol/image gaps make it more than a login command
change. Reuse the completed SDK providers and loop; do not rebuild Hermes.

Self-review: the design honors external login and SOV ownership; covers all six
routes; preserves existing credentials/billing routes; separates mocked evidence
from live proof; names process concurrency and persistence risks; keeps Telegram
login optional. No implementation, login, credential change, release or restart
is authorized by this research artifact.

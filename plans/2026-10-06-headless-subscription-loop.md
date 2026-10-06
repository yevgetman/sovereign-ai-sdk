# Headless subscription loop — plan

**Spec:** `specs/2026-10-06-headless-subscription-loop-design.md` (master `44e04b9`).
**Branch:** `feat/headless-subscription-loop`. Ship is a pull request. Do not merge.

## Terms gate (Claude Max)

Checked 2026-10-06 against https://code.claude.com/docs/en/legal-and-compliance and the Hermes pin `e97923c38acb`.

Anthropic's consumer terms allow a Max OAuth token only inside Claude Code and Anthropic's own apps. A third-party HTTP client is not allowed. The spec says: if the terms forbid the call, do not ship `claude-max`.

This plan does **not** copy Claude Code headers and does **not** send a Claude Max request. The name stays in the fence. `loadSubscriptionProvider('claude-max')` and `sov login claude-max` fail before the Keychain and before any HTTP.

ChatGPT and SuperGrok follow the Hermes login endpoints read at that pin. This repo does not import Hermes.

## Tasks

- [ ] Credential port, resolver fence, Claude Max refusal
- [ ] ChatGPT and SuperGrok providers, retries, login and logout
- [ ] Toolset filter, deny wrapper, `maxTurns` defaults
- [ ] Save the tool call before it runs, and the transcript prefix fix
- [ ] Acceptance tests, docs, quality gate, pull request

## Decisions the spec already made

- Tokens live in the Keychain (`SOV_SUB_CHATGPT`, `SOV_SUB_CLAUDE_MAX`, `SOV_SUB_GROK`). Tests inject a fake port.
- `resolveProvider('chatgpt' | 'claude-max' | 'grok')` throws `CredentialUnavailableError` unless `allowSubscriptionAuth: true`. `createAgent` does not set that flag. No credential-pool rotation.
- A supplied gateway principal does not receive the port.
- Omitted `toolset` stays today's pool and today's `maxTurns`. An unknown string fails before `stream`.
- `chat` sends no tool schemas. `web` is `WebSearch` and `WebFetch`. `ops` is the ops name list. `coding` is the pool already assembled.
- Retries live inside the subscription `stream()` only. Three attempts for 429 and 5xx. `Retry-After` over 10 seconds fails the turn. Grok HTTP 403 does not retry and does not use an API key.
- A prompt that does not fit throws `ContextOverflowError`. That class must not start context compression.
- With a session store, the unsaved transcript tail through the assistant tool call is written before `runTools`. `persistTurn` then continues from that prefix.

# SOV auth routing — progress for the Telekit coordinator

**Updated:** 2026-10-09 — Owner retired the stale Opus policy and authorized Codex. Existing partial tasks adopted in isolated worktrees. **Branch:** `feat/sov-auth-routing` in
`/Users/julie/code/sovereign-ai-sdk-auth-routing` (worktree of `sovereign-ai-sdk`).
**Contractor:** ctr_e49d95c67c96. Mirror copy: `/Users/julie/code/sovereign-ai-docs/.worktrees/ctr_e49d95c67c96/handoffs/`.

## Status

| Task | State |
|---|---|
| T1 routes, xai provider, status, cross-process lock | complete; integrated commit `218519e` |
| T2 shared host composition | complete; integrated stored-prefix commit `3e78608`, composition in final source |
| T3 provider protocol audit (ChatGPT/Grok, images, effort) | complete; Responses parser and transports in final source |
| T4 `sov run --sdk` host | complete; direct SDK, no listener/TUI, shared composition |
| T5 docs, gate, PR | fresh review and all final local gates complete; PR merge in progress |

## Contract as planned (spec §5) — changes are listed under "Contract changes"

- `sov capabilities --json` (planned keys: `sdkRun`, `routes`, `authStatus`, `toolsets`, `defaultToolset`,
  `images.routes[]`, `steering`, `jsonl.terminalEvents`, `jsonl.errorCodes`, `exitCodes`), `sov routes --json`
  (records: `id, provider, auth, defaultModel, credentialRef, enabled, models[], efforts[], defaultEffort`),, `sov auth status --route <id> --json`.
  Each prints one JSON object with `schemaVersion: 1` on stdout. Diagnostics go to stderr.
- `sov run --sdk --route <id> --json --stdin --input-format json --db <path> [--resume <id>]
  [--model m] [--effort e] [--toolset chat|web|ops|coding] [--permission-mode m] [--steer-file p]`.
- Stdin envelope: `{"inputVersion":1,"text":"…","instructions":"…","images":[{"path":"/abs.png","mediaType":"image/png"}]}`.
  Unknown fields are rejected.
- JSONL: `session.started` (adds `route`, `auth`, `toolset`), existing server events
  (`text_delta`, `thinking_delta`, `tool_use_start`, `tool_result`, …), then exactly one
  `turn.completed` or `turn.error` (adds `code`).
- Exit codes: 0 completed, 1 turn failure, 2 invalid input/usage, 130 SIGINT, 143 SIGTERM.

## Contract changes

1. (23:30) Aligned to the Telekit consumer in `telekit/sov_routes.py`:
   - `capabilities` top-level booleans `sdkRun`, `routes`, `structuredInput`, `toolsets`, `authStatus`, `images`
     are `true`. Details sit in separate keys: `toolsetNames`, `defaultToolset`, `imageRoutes[]`, `inputFormats`,
     `inputVersion`, `steering`, `jsonl`, `errorCodes`, `exitCodes`, `sov.version`.
   - `images: true` is global. Routes that are not in `imageRoutes` refuse images before inference with
     `turn.error.code = "unsupported_input"`. No image is dropped.
   - `routes[]` records: `defaultModel` is in `models`; `efforts` is never empty; optional `modelEfforts`
     values are subsets of `efforts`; optional `modelsAuthoritative`.
   - `auth status` echoes `route`, `provider`, `auth`, plus `credentialState` and `refreshable` (boolean).
   - `sov run --sdk` accepts `--model auto` and `--effort auto` as "use the route default".

## Final source implementation

- The actual source CLI and Telekit consumer accept the six stable routes: `openrouter-api`, `anthropic-api`, `openai-api`, `grok-api`, `chatgpt-subscription`, `grok-subscription`.
- API-key selection stays in its named provider; subscription selection stays in its named SOV-owned credentials. No provider, auth-mode or model fallback is permitted. `auto` selects the route default.
- SOV owns device login, refresh, logout and its credential mutex. Telekit only delegates to its public CLI. The process-safe bakery mutex coordinates expiry/401/logout, rejects PID reuse, and bounds cancellation; credential bytes stay out of machine output.
- Grok subscription uses `/v1/responses`. ChatGPT streams Codex Responses directly and sends supported reasoning controls. Completed/incomplete/truncated terminals cannot execute unfinished calls. Original function-call/result ids survive replay.
- Native execution reuses gateway host composition and one SDK DB writer. It persists calls before side effects, saves each new user row once, preserves old sessions and repairs orphan results without rerunning calls.
- Structured input keeps instructions separate, validates local regular-file image bytes/order/count and refuses unsupported routes. Advertised image routes are only the OpenRouter/Anthropic/OpenAI API routes; the subscription and direct xAI image capabilities remain disabled pending backend evidence.
- Chat/web/ops/coding toolsets apply at execution; headless permission asks deny. Steering, hook/skill/MCP/system/recall composition and learning remain available through the shared host.
- Completion and error events have actual route/provider/auth/model/effort metadata. Cancellation emits one terminal, suppresses late deltas and bounds cleanup.
- Deleted `docs/05-conventions/subagent-policy.md`, removed its active router/TOC rules, and restored the canonical AGENTS/importing-CLAUDE contract. Historical records remain historical.

## Fresh review and regression fixes

Fresh Codex review: `handoffs/2026-10-09-sov-final-review.md`. One High (native-only controls silently ignored without `--sdk`) and one Medium (final persistence errors classified as provider failures) were fixed and independently reproduced as passing. No remaining confirmed issue above Low. Final focused regression suite: **57 pass, zero fail, 348 assertions**. SDK export snapshot records `SessionPersistenceError`.

The final configured lint, boundary, typecheck, tests, build, open-package tests, packaged Node/Bun consumer canary and publish dry-runs pass and are recorded in `docs/06-testing/testing-log.md`. No actual publish operation occurs.

## Actual consumer probes

The coordinator can probe `/Users/julie/code/sovereign-ai-sdk-auth-routing/src/main.ts` with Bun. Read-only `capabilities --json`, `routes --json` and `auth status --route openai-api --json` emitted valid versioned records in isolated source CLI runs. Telekit's real `sov_routes.capabilities()` and `sov_routes.routes()` accepted those actual CLI records via a temporary source launcher. Missing-key native execution emitted one `credential_missing` terminal and started no inference. No fixture-only discovery claim is used.

## Delivery limits

Source integration is separate from published runtime delivery. No installed binary, restart, release tag, package version, real Keychain, attended login, live subscription eligibility, paid inference or actual Telegram turn was changed or verified. Approved acceptance A14 remains pending live evidence. Default model catalogs are non-authoritative. Normalized SOV histories do not retain provider-specific opaque Responses reasoning metadata; live multi-turn quality and account eligibility must be measured separately.

The original `/Users/julie/code/sovereign-ai-sdk` checkout has unrelated owner instruction edits and untracked files. Preserve it; use a clean isolated mainline worktree for the post-merge pull.

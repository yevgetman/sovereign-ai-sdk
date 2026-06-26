# Phase A — Secure Remote Gateway — Design Spec

**Date:** 2026-06-05
**Status:** Draft (pre-implementation)
**Parent roadmap:** `specs/2026-06-05-run-anywhere-harness-roadmap-design.md` (Phase A / module M1 — the root unlock)

## Goal

Make the **native HTTP+SSE agent protocol** reachable off-loopback, **safely**, via a long-lived authenticated **`sov gateway`** entrypoint — so any remote UI (web, iOS, a custom client) can drive the *rich interactive* protocol (turns, streaming, tool events, permission prompts, slash commands, skills), not just the stateless OpenAI completion surface. Single-user / single-token in this phase.

## The gap (verified 2026-06-05)

- Native server hard-binds `hostname: '127.0.0.1'` (`src/server/index.ts`, `src/server/port.ts`) — no host override.
- **Zero auth** on `src/server/` routes; no CORS.
- The native server is spawned **per-`sov`-invocation by the TUI launcher** (server + TUI together), not as a standalone long-lived headless service.
- By contrast `sov serve` (the OpenAI API, `src/openai/`) already has bearer auth (`src/openai/auth.ts`), a configurable host (`config.openaiServer.host`), refuse-to-boot-without-key, and a long-lived `Bun.serve`. **Phase A brings that same maturity to the native protocol** — reusing those patterns.

## Locked design decisions

| ID | Decision |
|---|---|
| **D1** | New **`sov gateway`** subcommand: a long-lived, **headless** server hosting the native protocol (no TUI spawn). Mirrors `sov serve`'s lifecycle — build runtime once, `Bun.serve`, SIGINT/SIGTERM graceful shutdown, park. Distinct from the per-invocation TUI launcher. |
| **D2** | **Host configurable, loopback default.** Resolution: `--host` > `SOV_GATEWAY_HOST` > `config.gateway.host` > `127.0.0.1`. Port: `--port` > `SOV_GATEWAY_PORT` > `config.gateway.port` > `8766` (distinct from `sov serve`'s 8765). Requires making the native bind host-configurable (today it's hardcoded). |
| **D3** | **Bearer auth** middleware on all `/sessions/*` routes (constant-time compare; mirror `src/openai/auth.ts`). `/health` stays unauthenticated (probe-friendly). Token: `SOV_GATEWAY_TOKEN` > `config.gateway.token`. |
| **D4** | **Refuse-to-boot-when-exposed-without-auth.** If the resolved host is NOT loopback (`127.0.0.1`/`::1`/`localhost`) AND no token is configured → hard exit with a clear message. Never expose an unauthenticated tool-running agent. On loopback, auth is optional (back-compat). |
| **D5** | **CORS** configurable: `config.gateway.corsOrigins: string[]` (default `[]` = same-origin only). When set, emit `Access-Control-Allow-Origin` for matching origins + handle preflight `OPTIONS` + the needed methods/headers. Required for browser clients (Phase C). |
| **D6** | **Reuse the existing native server.** `buildAppWithRuntime` + the routes are unchanged; Phase A *adds* auth + CORS middleware + host-configurable bind + the `sov gateway` entrypoint. The **TUI-launcher path is untouched** (stays loopback / no-auth — local + colocated, safe by isolation). The auth/CORS middleware applies only on the gateway path (gated by how the app is built). |
| **D7** | **Single-user / single-token.** One token = one full-access principal. Multi-user identity + authz is Phase E. |
| **D8** | **Session model unchanged.** The gateway serves the existing multi-session routes (`POST /sessions`, etc.) over the runtime's `sessionContexts` map. The single-subscriber bus + reconnect/replay (multi-client robustness) is **Phase B**; Phase A works with the existing per-turn-resubscribe model (as `sov drive` does today). |

## Components

**Create:**
- `src/server/auth.ts` — bearer-token middleware for the native server (generalize `src/openai/auth.ts` or a sibling; shared constant-time compare).
- `src/server/cors.ts` — CORS middleware (configurable origins + preflight handling).
- `src/cli/gatewayCommand.ts` — the `sov gateway` long-lived entrypoint (mirror `src/main.ts`'s `serve` wiring: resolve host/port/token, build runtime, start the native server with auth+CORS, SIGINT/SIGTERM → graceful stop + dispose, park).

**Modify:**
- `src/server/index.ts` + `src/server/port.ts` — accept a configurable `hostname` (default `127.0.0.1`) instead of hardcoding it.
- `src/server/app.ts` — optionally mount auth + CORS middleware (a `buildAppWithRuntime(runtime, { auth?, cors? })` option, off by default so the TUI path is unchanged).
- `src/config/schema.ts` — a `gateway` block: `{ host?, port?, token?, corsOrigins? }` (`.strict()`, all optional; default off).
- `src/main.ts` — register the `gateway` subcommand.

**Tests:**
- `tests/server/auth.test.ts` — 401 with no/wrong token, 200 with correct, on `/sessions/*`; `/health` unauth.
- `tests/server/cors.test.ts` — preflight `OPTIONS` + `Access-Control-Allow-Origin` for configured origins; absent for others.
- `tests/cli/gateway.refuseBoot.test.ts` — non-loopback host + no token → non-zero exit + message.
- `tests/server/gateway.endToEnd.test.ts` — full turn (`POST /sessions` → SSE events → `POST /turns` → `permission_request` → `POST /approvals`) over the gateway WITH a token, via MockProvider — proves the rich protocol works authenticated.

## Security posture (X1 for this phase)

- **Default loopback.** Exposure requires an explicit non-loopback host **and** a token (refuse otherwise, D4).
- The token is a **single full-access principal**: document plainly that exposing the gateway grants that principal the harness's full tool powers (Bash, file edit, web) under whatever permission policy is configured. Recommend exposing only behind a constrained permission policy + a dedicated bundle. (Per-principal/per-channel policy is Phase E/F.)
- Constant-time token compare; never log the token; CORS closed by default.

## Out of scope (later phases)

Multi-subscriber bus + reconnect/replay (B); persistent multi-session supervisor + service install (D); multi-user identity/authz + per-user scoping (E); channels (F); the web UI (C).

## Testing + ship

TDD throughout. Unit (auth, cors, refuse-boot, host bind) + integration (end-to-end authenticated turn via MockProvider). Full gate green. Update `docs/03-cli-reference/usage.md` (a "Remote gateway" section) + `docs/02-architecture/runtime-architecture.md` (the new surface). Commit/push; `sov upgrade`; cut a release (runtime change). Per `docs/05-conventions/autonomous-feature-builds.md`, this executes immediately into the build plan with no approval gate.

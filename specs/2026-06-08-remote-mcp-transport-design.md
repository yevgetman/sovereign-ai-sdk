# Remote MCP Transport (HTTP / SSE) — Design Spec

**Date:** 2026-06-08
**Status:** Approved for implementation (autonomous build)
**Arc:** **C** of the harness ecosystem-openness work — A+B (CC-skill import + tool-scope enforcement) shipped v0.6.29 → **C** (this) → **D** (plugin system, spec'd separately). C is the strongest near-term ecosystem surface: connect to hosted/remote MCP servers, not just stdio.

## Goal

Let the harness connect to **remote MCP servers** (Streamable HTTP, plus legacy SSE) in addition to the existing stdio servers — opening the broader MCP ecosystem ("MCP marketplace") to the harness with auth and a safe-by-default posture.

## Background (verified, file:line)

- SDK is `@modelcontextprotocol/sdk@1.29.0`. It ships `StreamableHTTPClientTransport` (`client/streamableHttp.js`, `constructor(url: URL, opts?)`) and `SSEClientTransport` (`client/sse.js`, **`@deprecated`**). `eventsource@3.0.7` is already installed (transitive SDK dep) → **SSE needs no new dependency**.
- Config: `McpServerConfigSchema` in `src/config/settings.ts:48-55` (`{ command, args?, env?, cwd? }`.strict()), keyed under `mcpServers` (`:62`), loaded by `loadMcpServerSettings` (`:166-187`, 3-layer concat, dup-alias = throw).
- Client: `src/mcp/client.ts` — `buildMcpClientPool` (~`:41-104`), `connectOne` (~`:106-143`) instantiates `StdioClientTransport`; existing `Promise.race` connect-timeout (`:121-129`, default 15s `:45`) + per-call timeout (`:22,83`, 60s) + log-and-skip on failure (`:51-58`).
- Tool wrapper `src/mcp/toolWrapper.ts:17-55` is **transport-agnostic** (uses only serverName/toolName/inputSchema; tools register `mcp__<server>__<tool>`, `shouldDefer:true`, permissioned by prefix). No stdio assumptions anywhere downstream.
- **Second consumer of `cfg.command`:** the status serializer at `src/server/runtime.ts:664-678` reads `cfg.command`/`cfg.args` unconditionally → must branch on type (TS error + wrong output otherwise).
- Env-first secret pattern to mirror: `src/channels/listeners.ts:33-41,131` + `gatewayCommand.ts:137-139` (env > config, trimmed, empty→absent, never logged).
- Repo gotcha: a nested `.default()` is a silent no-op unless the runtime gates absent-parent — test with empty/legacy config.

## Locked decisions

**D1 — Transports.** Support **Streamable HTTP** (primary — the current MCP standard, the marketplace target) and **legacy SSE** (secondary — ~free via the already-installed `eventsource`, widens reach during the migration window). **Defer OAuth** (static bearer/header auth covers the majority; the SDK's `authProvider` flow needs redirect/callback/token-persistence — v2). Skip WebSocket. **Fallback:** if SSE wiring proves genuinely fiddly/uncertain (the `eventSourceInit` header nuance), ship **HTTP-only in v1** and explicitly defer SSE — do not ship a shaky SSE path.

**D2 — Config schema (backward-compatible union).** Replace `McpServerConfigSchema` with a `z.union` of three `.strict()` variants:
- `stdio`: `type: z.literal('stdio').default('stdio')` + `command` (required) + `args?/env?/cwd?` — **legacy `{command,...}` configs (no `type`) parse unchanged** and round-trip with `type:'stdio'`.
- `http`: `type: z.literal('http')` + `url` (`.url()`) + `headers?` + `bearerToken?` + `apiKey?`.
- `sse`: `type: z.literal('sse')` + same remote fields.
Union member order: **http, sse, stdio** (type-required variants first; the permissive stdio variant — optional `type` — last). Disambiguation is by required-key presence (`command` vs `url`) reinforced by `.strict()` + the literal `type`. Add a `superRefine` (or pre-check) for a friendly error when a server has `url` but no `type` ("set `type:'http'` or `type:'sse'`"). Mirror the union in the `McpServerConfig` type (`src/mcp/types.ts:15-23`) and update the stale "deferred" comment (`types.ts:6-8`). `mcpServers` stays `.optional()`; **test empty + legacy-only config** to defeat the nested-default gotcha.

**D3 — Auth (env-first).** Remote variants accept `headers?: Record<string,string>` plus convenience `bearerToken?` / `apiKey?`. New `src/mcp/auth.ts`:
- `resolveMcpHeaders(alias, cfg, env)` — **injectable `env`** (pure, for tests). Precedence env > config, trimmed, empty→absent. Builds the final headers: start from `cfg.headers`; `token = env[SOV_MCP_<A>_TOKEN] ?? cfg.bearerToken` → `Authorization: Bearer <token>` **only if `Authorization` not already set**; `apiKey = env[SOV_MCP_<A>_API_KEY] ?? cfg.apiKey` → `X-API-Key: <apiKey>` if not already set.
- `normalizeAliasForEnv(alias)` — uppercase, non-alphanumeric → `_` (e.g. `github-remote` → `SOV_MCP_GITHUB_REMOTE_TOKEN`).
- `redactUrlAuth(url)` — origin-only / strip query + userinfo, for status + error surfaces.
Tokens/headers **never logged**. Document: supply secrets via `SOV_MCP_*` env in shared repos, never commit.

**D4 — `connectOne` transport wiring.** Extract `buildTransport(name, cfg): Transport` branching on `cfg.type ?? 'stdio'`: stdio → `StdioClientTransport` (unchanged); http → `new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } })`; sse → `new SSEClientTransport(new URL(url), { requestInit: { headers }, eventSourceInit: { fetch: custom-with-headers } })` (setting `eventSourceInit` suppresses the SDK's auto Authorization header, so pass headers explicitly via a `fetch` override). Widen `ActiveConnection.transport` to the base `Transport` interface (`shared/transport.js`) — `shutdown` only calls `client.close()`, never a stdio method. Keep the existing `Promise.race` connect-timeout and the log-and-skip failure path **unchanged** (a remote 401/timeout/DNS failure flows through the same path). **Sanitize the connect-error log** (`:55-58`): rethrow alias + HTTP status, never header values.

**D5 — Status serializer fix** (`src/server/runtime.ts:664-678`, required). Branch on `cfg.type`: remote → `{ transport: cfg.type, url: redactUrlAuth(cfg.url) }` (**origin-only, never headers**); stdio → `{ transport: 'stdio', command, args: args ?? [] }`.

**D6 — Tool exposure unchanged.** Remote tools are wrapped/deferred/permissioned identically (`mcp__<server>__<tool>`). No changes to `toolWrapper.ts` or the permission layer. Confirm with a mixed stdio+http pool test.

**D7 — Security.** **Warn (don't block)** when `url` is non-`https` or a loopback/private-IP host (SSRF note; URL is operator-config, not end-user input → lower risk; a hard https-only rule would break local dev). No `insecureSkipVerify` escape hatch (footgun). Rely on undici's default same-origin header-stripping on cross-origin redirect; document the cross-origin-redirect header-leak as a known limitation.

## File changes

**Modify:** `src/config/settings.ts` (the union, `:48-55`); `src/mcp/types.ts` (union type `:15-23` + comment `:6-8`); `src/mcp/client.ts` (`buildTransport`, widen transport type, sanitize error); `src/server/runtime.ts` (status serializer `:664-678`).
**Create:** `src/mcp/auth.ts` (resolveMcpHeaders/normalizeAliasForEnv/redactUrlAuth); `tests/mcp/auth.test.ts`; `tests/mcp/fixtures/http-echo-server.ts` (in-process Streamable HTTP MCP server — SDK's `WebStandardStreamableHTTPServerTransport` via `Bun.serve`, or a tiny Hono app since Hono is already a dep); `tests/mcp/remoteClient.test.ts`; extend `tests/config/settings.test.ts`.

## Test plan (TDD, no live remote server)

In-process Bun HTTP fixture for a **real** transport round-trip (mirrors the existing stdio subprocess fixture philosophy):
- **Schema back-compat** (`settings.test.ts`): legacy `{command}` → `type:'stdio'` unchanged; empty config + no-`mcpServers` → `{}`; `{type:'http',url}` parses; `{type:'http'}` (no url) throws; `{command,url}` throws (strict); `{url}` (no type) throws with the friendly message; dup-alias still throws; unknown key still throws.
- **Auth resolver** (`auth.test.ts`): env beats config; config when env absent; trimmed/empty→absent; alias normalization; explicit `headers.Authorization` not overwritten; `redactUrlAuth` strips query/userinfo.
- **Remote pool** (`remoteClient.test.ts`): connect + list + `pool.call` text + `isError`; the fixture asserts inbound `Authorization: Bearer <v>` (set via env and via config); dead-URL → logged-and-skipped + a co-configured good server still connects + **the log does not contain the token**; mixed stdio+http pool spans both; connect-timeout fires on a non-responding endpoint.
- **Status serializer** (`runtime.mcp.test.ts` or existing): remote → `{transport,url}` with no `command`, no headers; stdio unchanged.

## Scope / non-goals (v1)

OAuth (follow-on), WebSocket, insecure-TLS escape hatch, registry/marketplace auto-discovery (D-adjacent), per-server custom API-key header name (default `X-API-Key`).

## Ship

TDD; full gate (`bun run lint && bun run typecheck && bun run test`); update `docs/03-cli-reference/usage.md` (MCP section — remote http/sse server config + the `SOV_MCP_*` auth env vars), `docs/02-architecture/runtime-architecture.md` (transport note), the stale `src/mcp/types.ts:6-8` comment, and the `harness-build-plan.md` Phase-12 note (HTTP/SSE shipped); append `docs/06-testing/testing-log.md`; one **manual** smoke against a known public Streamable HTTP server before release (kept out of CI); atomic commits; push; `sov upgrade`; cut a release.

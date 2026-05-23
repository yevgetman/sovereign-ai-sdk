# State of the build — 2026-05-23: Phase 18 OpenAI-compatible HTTP API server

**HEAD:** to be filled by the close-out commit.

**Chain since the Phase 17 close-out (`b598eb4`, 2026-05-22 evening):**
phase-17-cron close-out → Phase 17 T10 docs (CLAUDE/AGENTS pointer flip, testing-log entry) → v0.3.3 release bump → cron polish (`1c928d2` permission non-null fix, `e77e5ee` stale-lock recovery via PID liveness, `fa00144` v0.3.2 release bump, `a083d66` cron boot-time cleanup sweep) → `356c35d` v0.3.3 release bump → Phase 18 T1 bearer auth + module skeleton (`8892304`) → T2 chat completions non-streaming with mock provider (`f04bd68`) → T3 `sov serve` subcommand (`67abfa6`) → v0.3.4 release bump (`ee517eb`) → Phase 18 plan committed (`82c75c2`) → T4 text-delta streaming translator (`4efdb0f`) → T5 SSE streaming on chat completions (`9468c7d`) → T6 tool-use chunks + hermes.tool.progress events (`ae6f7c5`) → T7 GET /v1/models (`f872388`) → T8 X-Session-Id header + DB persistence (`b8b1a8a`) → T9 per-request provider resolution from req.model (`063635e`) → T10 abort in-flight turn on client disconnect (`22e20f5`) → audit fix H1 namespace X-Session-Id (`7303e96`) → audit fix H2 wrap non-streaming drain in catch + return OpenAI error envelope (`573a45b`) → audit fix H3 collapse non-standard finish_reason values to 'stop' (`ad74f0c`) → (this close-out, TBD).

**Suite:** TS — **2192/0/14** (+117 from morning Phase 17 close-out's 2075 baseline; +196 from the prior session's 1996 baseline at the start of Phase 17 T1). Breakdown of the +117 over the day: T1 auth + health (+8), T2 non-streaming chat completions (+25), T3 `sov serve` CLI (+2), T4 text-delta translator (+9), T5 SSE streaming integration (+4), T6 tool-use chunks + progress events (+26), T7 /v1/models (+5), T8 X-Session-Id + persistence (+5), T9 per-request provider resolution (+7), T10 abort on client disconnect (+2), H1/H2/H3 audit fixes (+12 across session.test.ts namespace tests + non-streaming-drain error envelope tests + finishReason.test.ts type-level coverage), plus the +12 incremental adjustments for the cron polish chain (stale-lock recovery + boot cleanup sweep tests). Go untouched from morning. Lint+typecheck clean (the 2 pre-existing warnings in `src/permissions/shellSemantics.ts` are unrelated to Phase 18).

**ADRs:** none new. Phase 18 is purely additive; all design decisions captured inline in the plan at `docs/plans/2026-05-23-phase-18-openai-api-server.md` (D1-D14 + OQ1-OQ5 in the "Locked design decisions" table at the top of the plan). No surface removal, no foreground refactor, no architectural pivot — none of the inflection points that warrant ADR-level capture.

**Phase status:** **Phase 18 closed.** Phase 16.1 stays closed; Phase 17 stays closed; Phase 21 M1 stays closed; Phase 21 M2 stays backlogged (#48). Next concretely-specced phases per the build plan: 16.5 (Telegram channel), 19 (MCP server surface), 20 (Slack channel) — all "demand-gated" per the build plan (build when a real consumer arrives). T12 (cut v0.4.0 release) is the follow-up to this close-out.

## Where we are

Phase 18 ships a **drop-in OpenAI HTTP backend** that lets any tool speaking OpenAI's HTTP API (Open WebUI, LibreChat, AnythingLLM, the official `openai` Python/JS SDKs with a custom `base_url`) drive the harness without code changes. A new `sov serve` subcommand boots the runtime + a Hono app on a stable port (default 8765); the wire surface is fully stateless per request (each call carries its own `messages[]`); the harness owns tool execution end-to-end (no client round-trips); tool invocations surface to clients as `tool_calls` in the assistant chunks for observability but `finish_reason` is always `"stop"` or `"length"`, never `"tool_calls"` (D9).

The architecture is purely additive. A new `src/openai/` top-level subsystem (sibling of `src/cron/`) carries the translation surface, mounted via `buildOpenAIApp()` and bound via `createOpenAIServer()` — both reused by both the CLI and the test harness. The TUI / drive / dispatch Hono server is **untouched**; both servers share the same `buildRuntime()` factory but each owns its own Bun.serve binding. `query()` (not `AgentRunner`) drives the chat-completions loop — the request body carries full message history natively, so the cron path's `AgentRunner.run(prompt: string)` shape doesn't fit.

The user kicked off Phase 18 at the start of this session asking to build out the OpenAI API server per the harness plan. Subagent-driven development per T1 → T10; an Opus parity audit at the end surfaced 3 HIGH findings (cross-surface session pollution via verbatim X-Session-Id passthrough, swallowed provider errors on the non-streaming drain, non-spec `finish_reason: 'error'` value) — all three fixed inline before this close-out. T11 (this docs close-out) follows; T12 (cut v0.4.0) is the next session's lead.

## What shipped

### New `src/openai/` subsystem (~1700 LoC across nine files + nested submodules)

- **`src/openai/server.ts`** — `createOpenAIServer(opts)`. Boots `Bun.serve({ port, hostname, fetch: app.fetch, idleTimeout: 0 })`. Returns `{ port, host, stop }`. `idleTimeout: 0` mirrors the TUI server pattern so long-running SSE streams aren't killed by an idle timer.
- **`src/openai/app.ts`** — `buildOpenAIApp(opts)`. Constructs the Hono router. `/health` mounts unauthenticated (probe-friendly); `bearerAuth(opts.apiKey)` gates `/v1/*` (every sub-route registered after the middleware mount). Routes are factored into `routes/{health,chatCompletions,models}.ts`.
- **`src/openai/auth.ts`** — `bearerAuth(expectedKey)`. Returns 401 with an OpenAI-shaped error body (`{ error: { message, type: 'invalid_api_key', code } }`) on missing/malformed/mismatched header. Constant-time compare prevents timing attacks on the key length boundary.
- **`src/openai/routes/health.ts`** — `GET /health`. Returns `{ ok: true, version }`. Auth-exempt; used by container liveness probes and `sov serve` smoke.
- **`src/openai/routes/chatCompletions.ts`** — `POST /v1/chat/completions`. Validates the body (Zod), resolves the model (T2/T9), maps OpenAI messages → internal `Message[]`, mints/reuses the SessionDb row (T8), builds a request-scoped `canUseTool` (`mode: 'default'` + auto-deny `ask`), filters the tool pool against `SUBAGENT_EXCLUDED_TOOLS`, bridges the client `AbortSignal` → request `AbortController` → `query()` (T10), then either drains the generator (non-streaming) or wraps it in `streamSSE` (streaming, T5). The streaming branch uses the T4 translator to emit OpenAI-shaped chunks + the T6 `hermes.tool.progress` side-channel for tool execution observability. H1/H2/H3 audit fixes layered in: client X-Session-Id values are prefixed with `openai:` before use as the row PK; the non-streaming drain is wrapped in catch and the classifier `buildProviderErrorResponse` produces OpenAI-shaped error envelopes; `mapTerminalToFinishReason` collapses non-spec terminal reasons to `'stop'`.
- **`src/openai/routes/models.ts`** — `GET /v1/models`. Projects `SUPPORTED_MODELS` (the canonical catalog defined in `modelResolution.ts`) into OpenAI's `{ object: 'list', data: [{ id, object: 'model', created, owned_by }, ...] }` shape. Mounted under `/v1/*` so it auth-gates with the rest.
- **`src/openai/modelResolution.ts`** — `resolveModelForRequest(runtime, requestedModel, harnessHome)`. `harness-default` (or empty) → runtime's bootstrapped transport + model (the cheap-and-fast path). Known explicit name (e.g., `claude-haiku-4-5-20251001`, `gpt-4o`) → `resolveProvider(family, model, { harnessHome })` for a per-request transport with fresh rate-guard state. Unknown → `InvalidModelError` (the route surfaces as 400 with the full catalog in the message — D6/OQ2 strict, no aliasing).
- **`src/openai/mapping/schema.ts`** — Zod schemas. `ChatRequestSchema` (discriminated union on `role` for messages), `ChatMessageSchema`, `ToolCallSchema`. `.passthrough()` on the request so SDK-specific fields don't reject (OpenAI clients sometimes send `user`, `n`, `top_p`, etc.).
- **`src/openai/mapping/requestToMessages.ts`** — Pure mapping. OpenAI messages[] → internal `Message[]`. `system` → `extraSystemSegments` (appended as `cacheable: false` to the runtime's pre-marked frozen prompt). `user`/`assistant`/`tool` → Anthropic-style `ContentBlock[]`. The `tool` role becomes a USER-role message with a `tool_result` block (Anthropic convention; tool_result is only valid on user side).
- **`src/openai/mapping/blocksToOpenAI.ts`** — Pure mapping. `ContentBlock[]` → `{ content: string | null, tool_calls? }`. `content` is `null` when only `tool_use` blocks are present (OpenAI's strict-typed assistant-only-tools shape); empty string when no blocks at all.
- **`src/openai/streaming/chunks.ts`** — Pure builders. `buildRoleChunk` (first chunk's `delta.role = 'assistant'`), `buildDeltaChunk(text, ctx)` (content delta), `buildFinalChunk(reason, ctx)` (empty delta + `finish_reason: 'stop' | 'length'`), `buildToolCallsChunk(toolCalls, ctx)` (D8 — whole `arguments` JSON in one chunk; no partial streaming), `buildProgressPayload({ tool_use_id, output?, is_error? })` (JSON payload portion of `event: hermes.tool.progress`). `DONE_MARKER` constant for the `[DONE]` terminator.
- **`src/openai/streaming/sseTranslator.ts`** — Generator-driven translator. Consumes `query()`'s `AsyncGenerator<StreamEvent | Message, Terminal>`; emits OpenAI-shaped SSE lines via a `WriteFn` injected by the route. Type guards (`isAssistantMessageEvent`, `isUserMessage`) narrow events; `ensureRoleEmitted` closure guarantees the role chunk lands before the first content/tool_calls chunk; `normalizeToolResultContent` defensively coerces structured `tool_result.content` arrays into strings so the wire stays well-formed.

### `sov serve` CLI surface (`src/main.ts:282-375`)

- `program.command('serve')`. Description: "Run the OpenAI-compatible HTTP API server (Phase 18). Long-lived; SIGINT/SIGTERM trigger graceful shutdown."
- Flags: `--port <n>` / `--host <addr>` / `--provider <name>` / `-m, --model <name>` / `--max-tokens <n>` / `--permission-mode <mode>` / `--no-cron` / `-b, --bundle <path>` / `--no-preflight`.
- API key resolution: `process.env.SOV_OPENAI_API_KEY ?? config.openaiServer?.apiKey ?? undefined`. Missing/empty → stderr error message with the exact `sov config set openaiServer.apiKey <key>` remediation line + `process.exit(1)` before any side effects (D5/OQ1).
- Port resolution: flag > env (`SOV_OPENAI_PORT`) > config (`openaiServer.port`) > default 8765. Host resolution: flag > env (`SOV_OPENAI_HOST`) > config (`openaiServer.host`) > default `127.0.0.1`.
- Boot banner (three stdout lines): `listening on http://${host}:${port}` → `provider=... model=...` → `cron=on|off harnessHome=...`. Tests grep for the port number to detect boot.
- Shutdown: idempotent `shutdown(signal)` (the `shuttingDown` flag prevents double-fire on rapid Ctrl-C-Ctrl-C). Calls `server.stop()` then `runtime.dispose()`, each guarded so a failure in one doesn't mask the other; logs to stdout/stderr. Exits 0.
- Parks via `await new Promise<never>(() => {})` so the only legal exit paths are the signal handlers above.

### Config schema (`src/config/schema.ts:281-294`)

New optional `openaiServer` block: `{ apiKey?: string; port?: number; host?: string }`. Strict (unknown keys rejected). Port range validated 1..65535; host min-length 1; apiKey min-length 1. All fields optional — env vars / flags can substitute.

### SessionDb (`src/agent/sessionDb.ts`) — small additive extension

- `CreateSessionInput` gains an optional `sessionId?: string` field. When omitted, falls back to `randomUUID()` (unchanged behavior for all existing callers).
- New `upsertSession(input)` helper: calls `getSession(input.sessionId)` first and returns the existing id if found; otherwise delegates to `createSession`. Used by the OpenAI route so a client reusing the same `X-Session-Id` lands on the existing row rather than crashing on duplicate-PK insert.

### MockProvider extensions (`src/providers/mock.ts`)

- `MockProvider.lastSignal: AbortSignal | undefined` — snapshots `req.signal` on every `stream()` call so the T10 abort-bridge test can assert `lastSignal.aborted === true` after triggering a client-side abort.
- `slowMode: boolean` + `slowModeDelayMs: number` — gates per-yield sleeps in `streamHelloWorld` so the SSE stream stays open long enough for the abort test to fire mid-flight. `maybeDelay()` respects the signal during sleeps so the mock throws `AbortError` on cancellation (mimics real provider behavior).
- `MockProvider.throwOnNext: Error | undefined` — auto-resets after one throw. Lets the H2 catch-path tests deterministically exercise the provider-error path without a real network call.

### Tests (~2900 LoC across 16 test files)

- `tests/openai/auth.test.ts` (5) — 401 cases + match + OpenAI error shape.
- `tests/openai/health.test.ts` (1) — auth-exempt liveness probe.
- `tests/openai/chatCompletions.nonstreaming.test.ts` (14) — request validation, model resolution, message mapping, mock-provider full round-trip, OpenAI response shape.
- `tests/openai/chatCompletions.streaming.test.ts` (4) — SSE wire format (role + content deltas + final stop + DONE), stream:false JSON fallback, omitted stream defaults to non-streaming, 401 fires before the streaming switch.
- `tests/openai/chatCompletions.tools.test.ts` (5) — streaming tool_calls + hermes.tool.progress + preamble + continuation + exactly-one final-stop + DONE; wire ordering; arguments JSON; progress payload shape; non-streaming D9 invariant.
- `tests/openai/streaming/chunks.test.ts` (11) — pure unit tests for all six chunk builders.
- `tests/openai/streaming/sseTranslator.test.ts` (9) — translator emits role lazily, text-delta passthrough, R2 invariant (suppress text content of `assistant_message`), DONE terminator placement.
- `tests/openai/streaming/toolUse.test.ts` (12) — tool_calls chunk emission, tool-only turns, multi-call same-message, multi-turn single-request flow.
- `tests/openai/models.test.ts` (5) — list shape + canonical model presence + per-entry shape + 401 on missing auth.
- `tests/openai/modelResolution.test.ts` (5) — harness-default + unknown name + empty + InvalidModelError catalog in message.
- `tests/openai/modelResolution.real.test.ts` (7) — explicit-name branch fires resolveProvider for `claude-*` / `gpt-*` families; runtime state unchanged; CredentialUnavailableError path proves the branch ran.
- `tests/openai/session.test.ts` (7) — UUID minting without header, custom id with header, user+assistant message persistence, idempotent reuse, streaming-branch persistence, H1 namespace guarantee, wire id echo.
- `tests/openai/abort.test.ts` (2) — client-disconnect → AbortSignal propagation through query() (streaming + non-streaming).
- `tests/openai/serve.cli.test.ts` (2) — real `Bun.spawn` of `sov serve`: boots / `/health` / `/v1/chat/completions` / SIGTERM cleanly; refuses to boot when API key is missing.
- `tests/openai/finishReason.test.ts` (7) — every Terminal reason value collapses to `'stop' | 'length'`; static-type guarantee on the return shape.
- `tests/openai/mapping/blocksToOpenAI.test.ts` (8) + `tests/openai/mapping/requestToMessages.test.ts` (15) — pure mapping unit tests.

## Behavioral notes worth knowing next session

1. **Deployment pattern: long-lived `sov serve`.** No standalone daemon; same constraint as Phase 17's cron tick loop. The `sov serve` process IS the cron host when `cron` defaults to on (which it does). v0 expectation: keep `sov serve` running in a long-lived terminal pane / launchd plist / systemd service. If `sov serve` exits, both the OpenAI surface and any cron jobs go silent. Per-request lifecycle is fully synchronous — no background workers spawned per call.
2. **API key is mandatory at boot.** No "anonymous mode" — `sov serve` refuses to bind the socket without one. Resolution order: env (`SOV_OPENAI_API_KEY`) > config (`openaiServer.apiKey`) > error. The error message includes the exact remediation command (`sov config set openaiServer.apiKey <key>`).
3. **Session-ID namespacing (post-H1 fix).** Client-supplied `X-Session-Id` values are prefixed with `openai:` before use as the SessionDb row PK. The wire response (`chatcmpl-<id>`) echoes the CLIENT's unprefixed view. This guarantees the openai-api keyspace is structurally disjoint from TUI / cron / drive sessions — a client cannot pollute another surface's transcript by sending `X-Session-Id` matching an existing UUID. The client's supplied id is also preserved in `metadata.clientSessionId` for observability. Defensive 256-char cap on the incoming header value.
4. **Per-request provider routing (T9).** `req.model = 'harness-default'` (or empty) takes the cheap path — runtime's bootstrapped transport + model. Explicit names (`claude-*` / `gpt-*` from the SUPPORTED_MODELS catalog) call `resolveProvider(family, model, { harnessHome })` per request, yielding fresh rate-guard state. Each call is cheap (pool / guard files lazily opened), but it's a meaningful per-call cost — see M5 in the follow-ups below for an LRU layer if profiling shows a hot path.
5. **Tool execution policy.** `mode: 'default'` with an auto-deny `ask` fall-through (matches cron's headless policy). The runtime's layered permission rules fire normally; only when a tool's self-check returns `ask` does the auto-deny kick in. Tool pool filtered against `SUBAGENT_EXCLUDED_TOOLS` (D12) so AgentTool / cron CRUD / task_stop never appear on the OpenAI surface.
6. **Tool execution invariant (D9).** The harness runs tools internally inside a single `/v1/chat/completions` call. Clients see `tool_calls` in the assistant chunks for observability + `hermes.tool.progress` events on the SSE side-channel — but `finish_reason` is ALWAYS `'stop'` or `'length'`, NEVER `'tool_calls'`. This means standard OpenAI clients (Open WebUI, LibreChat, openai-python) never re-enter the request to "satisfy" a tool call; the harness drives the tool loop end-to-end and returns the final assistant text. Post-H3 fix: any non-spec terminal reason (`error`, `interrupted`, `checkin`) collapses to `'stop'` so SDK clients don't choke on validation.
7. **Abort-on-disconnect (T10).** `c.req.raw.signal` (the Web Fetch `Request.signal` exposed by Hono on Bun.serve) bridges to a request-scoped `AbortController` whose signal flows into `query()`. Client closes its fetch context → controller aborts → `query()` sees `signal.aborted === true` → returns `{ reason: 'interrupted' }` → the route disposes the session in `finally`. No wasted provider tokens after the client gives up. Fast-fail when `clientSignal.aborted === true` at handler entry (definitely-cancelled request).
8. **Error envelope semantics (post-H2 fix).** The route used to return 200 OK with an empty assistant message when `query()` surfaced a `Terminal{reason: 'error', error}`. Now: a single classifier `buildProviderErrorResponse` invoked from both streaming and non-streaming paths produces a consistent OpenAI-shaped envelope. `CredentialUnavailableError` / `ProviderHttpError 401|403` / credential-related message heuristic → 401 + `invalid_api_key` (SDK clients surface `AuthenticationError`). `ProviderHttpError` / SDK-shaped errors with a `.status` field → mirror upstream status + `upstream_error`. Everything else → 500 + `api_error` generic. **Streaming branch caveat**: errors thrown AFTER the wire has opened still surface as a best-effort final-stop chunk + `[DONE]` rather than a JSON envelope (SSE wire shape doesn't allow mid-stream status changes), but the `finally` block always disposes the session.
9. **`hermes.tool.progress` side-channel.** Tool executions running mid-stream emit `event: hermes.tool.progress\ndata: {"tool_use_id":"...", "output":"...", "is_error":false}\n\n` alongside the standard OpenAI `data: {...}\n\n` chunks. Standard OpenAI clients ignore unknown event types per SSE spec, so this is harness-aware UIs' progressive-disclosure hook without breaking SDK compatibility. The payload omits `output` when undefined and `is_error` when false (absence signals success — minimizes wire bytes).
10. **Statelessness invariant (D10).** The OpenAI route does NOT hydrate prior history from the SessionDb. Each `/v1/chat/completions` call uses ONLY the request body's `messages[]`. The SessionDb row exists purely for trace + learning observability (the trajectory + cost wiring + per-session subsystems all key off the row, but the conversation history is client-managed). Repeat invocations against the same `X-Session-Id` APPEND new messages to the row but the model still sees only what the current request carries.
11. **/v1/models catalog vs. routable models.** The `/v1/models` endpoint advertises the full SUPPORTED_MODELS catalog (`harness-default`, `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`, `gpt-4o`, `gpt-4o-mini`). T9 wired the explicit-name branch — these names are all routable as of this close-out. If the harness's credentials are missing for a family, `resolveModelForRequest` throws `CredentialUnavailableError` which surfaces through the H2 error envelope as a 401 / `invalid_api_key`. Open WebUI / LibreChat populate their model pickers from this list directly.
12. **Bundle scope.** Single bundle per server in v0 (`runtime.cwd` is fixed at boot — D6/OQ3). A per-request `X-Bundle-Root` header is out of scope for this phase; if you need bundle switching, fork multiple `sov serve` processes on different ports.

## Open follow-ups

(From the post-T10 Opus parity audit. The 3 HIGH issues were fixed inline before this close-out as `7303e96` / `573a45b` / `ad74f0c`. These are the remaining MEDIUM/LOW items the audit flagged.)

1. **M5 — `resolveProvider` LRU cache.** Per-request provider resolution for explicit-name routing yields fresh rate-guard state (the v0 safer default), but it does spin up fresh `Transport` instances per call. Profile under load; if the resolver becomes a hot path, add a small LRU (key: `${family}:${model}`) at `src/openai/modelResolution.ts`. Skip until profiling justifies it.
2. **M2 — incoming `tools[]` field handling.** OpenAI's API accepts a per-request `tools[]` field for client-defined functions. The harness owns tool execution end-to-end (D8/D9), so this field is meaningless to us. Today the Zod `.passthrough()` silently accepts it; we should either reject it explicitly with a 400 ("tools[] is server-managed in sov; remove the field") OR document it as "ignored" in the route docstring. Pick one; ambiguity is the bug.
3. **M1 — non-loopback host warning.** `sov serve --host 0.0.0.0` binds globally with no TLS. The CLI should warn on stderr ("Warning: binding to a non-loopback host without TLS exposes the API key on the wire — put a reverse proxy in front"). Don't refuse to boot (the user might be testing on a LAN), but make the risk loud.
4. **M3 — `max_tokens` runtime ceiling.** The Zod schema accepts any positive integer for `max_tokens`. The route currently passes it through to `query()` which passes it through to the provider. Providers cap at their own limits (Anthropic max 8192 for most models, OpenAI 4096 for gpt-4o-mini etc.). A bogus client value (e.g., 1000000) wastes the validation cycle before the provider's own rejection. Cap at `runtime.maxTokens` (the bootstrapped ceiling) and document the cap on the error.
5. **M6 — partial-history persistence semantics test.** T8 persists the last user message + final assistant message per request. The audit flagged a missing test for what happens when the request carries N user messages + N-1 assistant messages (client-side history continuation): only the LAST user message should be persisted, the prior ones are client-supplied history that we shouldn't re-record on every turn. The behavior is correct in code; the test gap is cosmetic but worth pinning.
6. **Manual smoke deferred.** The plan's T11 Step 4 called for a real-Anthropic Haiku smoke via `sov serve` + Python `openai` client. Skipped for this docs close-out (the existing `tests/openai/serve.cli.test.ts` exercises the full curl-equivalent against the mock provider; T12 will do the real-API smoke as part of the v0.4.0 release verification).

## Postmortem-rule compliance check

The Phase 16.1 revert's Rules 1–4 (`docs/postmortems/2026-05-12-phase-16-revert.md`) apply primarily to foreground-surface refactors. Phase 18 is purely additive — no existing surface removed, no behavioral change to existing flows — so most rules don't engage:

- **Rule 1 (deprecation soak)** — Waived. Nothing deprecated; nothing replaced. The TUI / drive / dispatch / cron surfaces are unaffected.
- **Rule 2 (no helper deletion)** — Satisfied trivially. All changes are additive: new files under `src/openai/`, new optional fields on `CreateSessionInput`, new optional `upsertSession` helper, new optional fields on `RuntimeOptions` (none — `sov serve` reuses existing options), one new top-level CLI subcommand.
- **Rule 3 (audit before claiming done)** — Satisfied. Layered test suites (auth → mapping → model resolution → translator → integration → CLI smoke) pin contracts at each layer. The post-T10 Opus parity audit surfaced 3 HIGH issues which were fixed inline before this close-out (`7303e96` + `573a45b` + `ad74f0c`); the remaining MEDIUM/LOW items are documented in follow-ups above.
- **Rule 4 (escape hatch)** — Satisfied. `sov serve` is a new opt-in subcommand. Users who don't run it see zero behavioral change to existing surfaces. The TUI / drive / dispatch / cron surfaces continue to work identically.

## How it works now

```bash
# 1) Set the API key (one-shot per machine)
export SOV_OPENAI_API_KEY=$(openssl rand -hex 32)
# OR: sov config set openaiServer.apiKey <key>

# 2) Boot the server
sov serve
# listening on http://127.0.0.1:8765
#   provider=anthropic  model=claude-haiku-4-5-20251001
#   cron=on  harnessHome=/Users/julie/.harness

# 3) Drive it with anything that speaks OpenAI's HTTP API
```

Bash + curl (non-streaming):

```bash
curl -s -H "Authorization: Bearer $SOV_OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -X POST http://localhost:8765/v1/chat/completions \
  -d '{
    "model": "harness-default",
    "messages": [{"role": "user", "content": "What files live in src/openai/?"}]
  }'
```

Bash + curl (streaming):

```bash
curl -N -s -H "Authorization: Bearer $SOV_OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -X POST http://localhost:8765/v1/chat/completions \
  -d '{
    "model": "harness-default",
    "messages": [{"role": "user", "content": "What files live in src/openai/?"}],
    "stream": true
  }'
```

Python `openai` SDK:

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8765/v1",
    api_key=os.environ["SOV_OPENAI_API_KEY"],
)
resp = client.chat.completions.create(
    model="harness-default",
    messages=[{"role": "user", "content": "what files are in src/openai/?"}],
    stream=True,
    extra_headers={"X-Session-Id": "my-trace-1234"},  # optional observability
)
for chunk in resp:
    print(chunk.choices[0].delta.content or "", end="")
```

Open WebUI quickstart:

1. Settings → Connections → OpenAI API → add a new connection.
2. API Base URL: `http://localhost:8765/v1`
3. API Key: paste your `SOV_OPENAI_API_KEY` value
4. The model picker lists everything from `GET /v1/models` — pick `harness-default` for the runtime's bootstrap, or an explicit name like `claude-haiku-4-5-20251001` to drive that family.

Outbox lands at `<harnessHome>/sessions.db` (per-session row tagged `metadata.kind='openai-api'`, namespaced PK `openai:<id>`); transcripts surface via `sov trace show <session-id>` (strip the `openai:` prefix to get the trace id from `chatcmpl-<id>` responses).

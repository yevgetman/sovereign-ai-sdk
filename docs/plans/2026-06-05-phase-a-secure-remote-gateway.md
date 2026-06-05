# Phase A — Secure Remote Gateway · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Steps use checkbox (`- [ ]`) syntax. Executes per `docs/conventions/autonomous-feature-builds.md` — no approval gates.

**Goal:** Ship a long-lived authenticated `sov gateway` entrypoint that exposes the native HTTP+SSE protocol off-loopback safely, per `docs/specs/2026-06-05-phase-a-secure-remote-gateway-design.md`.

**Architecture:** Reuse the existing native Hono server (`src/server/`) + the proven `sov serve` auth/host/lifecycle patterns (`src/openai/`). Add: a `gateway` config block, a host-configurable bind, bearer-auth + CORS middleware (mountable, off by default so the TUI path is unchanged), a refuse-to-boot-when-exposed-without-auth guard, and the `sov gateway` command.

**Tech Stack:** TypeScript on Bun, Hono, Zod. MockProvider for the end-to-end test.

---

## Investigation findings (verify against code before/while implementing)

1. **Native bind is hardcoded:** `src/server/index.ts` (`Bun.serve({ hostname: '127.0.0.1' })`) and `src/server/port.ts` (`findFreePort` pinned to `127.0.0.1`). Make `hostname` a parameter threaded from `startServer`/the gateway entrypoint (default `127.0.0.1`).
2. **The auth pattern to mirror:** `src/openai/auth.ts` (`bearerAuth(apiKey)` Hono middleware, constant-time compare) + `src/openai/app.ts` (`app.use('/v1/*', bearerAuth(...))`). Phase A's `src/server/auth.ts` mirrors this for `/sessions/*`.
3. **The lifecycle to mirror:** the `sov serve` command (`src/main.ts`, ~the `serve` action) + `src/openai/server.ts` — resolve host/port/key (flag > env > config > default), build runtime, `Bun.serve({ idleTimeout: 0 })`, SIGINT/SIGTERM → graceful `stop()` + `runtime.dispose()`, park forever. `sov gateway` mirrors this but serves the **native** app (`buildAppWithRuntime`) instead of the OpenAI app.
4. **Where to mount middleware:** `src/server/app.ts` `buildAppWithRuntime(runtime)`. Add an options arg `{ auth?: string; corsOrigins?: string[] }`; when present, `app.use('/sessions/*', bearerAuth(auth))` and the CORS middleware. Default (no options) = today's behavior, so the TUI launcher path is byte-unchanged.
5. **The config pattern to mirror:** the `openaiServer` block in `src/config/schema.ts` (`{ apiKey?, host?, port? }`, `.strict().optional()`). The `gateway` block mirrors it + `corsOrigins`.
6. **Loopback detection:** treat `127.0.0.1`, `::1`, `localhost` as loopback for the refuse-to-boot guard.

## File structure

**Create:** `src/server/auth.ts`, `src/server/cors.ts`, `src/cli/gatewayCommand.ts`; tests `tests/server/auth.test.ts`, `tests/server/cors.test.ts`, `tests/cli/gatewayRefuseBoot.test.ts`, `tests/server/gatewayEndToEnd.test.ts`.
**Modify:** `src/server/index.ts`, `src/server/port.ts`, `src/server/app.ts`, `src/config/schema.ts`, `src/main.ts`, `docs/usage.md`, `docs/architecture.md`, `package.json` (version).

## Conventions (every task)
`.js` import extensions; one-line header per new file; `readonly`/no-mutation; bun:test; constant-time token compare; never log the token. Pre-commit gate `bun run lint && bun run typecheck && bun run test` (no new failures beyond the known env-only set). Atomic commits. **Do NOT cut a release until the final task** (the whole phase ships as one release).

---

## Tasks

### T1 — `gateway` config schema (~10 min · Opus)
**Files:** Modify `src/config/schema.ts`; extend `tests/config/schema.test.ts`.
- [ ] Write failing tests: `SettingsSchema.parse({ gateway: { host:'0.0.0.0', port:8766, token:'t', corsOrigins:['https://x'] } })` succeeds; `{}` leaves `gateway` undefined; unknown key in `gateway` rejected (`.strict()`).
- [ ] Run red.
- [ ] Implement: add `gateway: z.object({ host: z.string().min(1).optional(), port: z.number().int().positive().optional(), token: z.string().min(1).optional(), corsOrigins: z.array(z.string()).optional() }).strict().optional()` (mirror `openaiServer`). Add a config-catalog entry if `openaiServer` has one.
- [ ] Run green; gate; commit `feat(gateway): config schema block`.

### T2 — host-configurable native bind (~15 min · Opus)
**Files:** Modify `src/server/index.ts`, `src/server/port.ts`; test `tests/server/bind.test.ts` (or extend an existing server test).
- [ ] Write failing test: `startServer` honors a passed `hostname` (assert the bound host, or that the option is threaded — inspect via a unit on the option plumbing; binding `127.0.0.1` stays the default when unspecified).
- [ ] Run red.
- [ ] Implement: thread an optional `hostname` (default `'127.0.0.1'`) through `startServer` → `Bun.serve({ hostname })`; keep `findFreePort` default loopback but allow the caller to specify host. The TUI launcher path passes nothing → unchanged.
- [ ] Green; gate; commit `feat(gateway): configurable native server bind host`.

### T3 — bearer auth middleware (~20 min · Opus)
**Files:** Create `src/server/auth.ts`; modify `src/server/app.ts`; test `tests/server/auth.test.ts`.
- [ ] First read `src/openai/auth.ts` to mirror its constant-time compare + Hono middleware shape.
- [ ] Write failing tests against an app built with `buildAppWithRuntime(runtime, { auth: 'secret' })`: `/sessions` → 401 with no `Authorization`, 401 with wrong token, 200/202 with `Authorization: Bearer secret`; `/health` → 200 unauth; an app built with NO options → no auth (today's behavior).
- [ ] Run red.
- [ ] Implement `bearerAuth(token)` in `src/server/auth.ts` (mirror openai); add the `{ auth?, corsOrigins? }` options arg to `buildAppWithRuntime`; when `auth` set, `app.use('/sessions/*', bearerAuth(auth))`. `/health` excluded.
- [ ] Green; gate; commit `feat(gateway): bearer auth middleware for the native protocol`.

### T4 — CORS middleware (~20 min · Opus)
**Files:** Create `src/server/cors.ts`; modify `src/server/app.ts`; test `tests/server/cors.test.ts`.
- [ ] Write failing tests: app built with `{ corsOrigins: ['https://app.example'] }` → preflight `OPTIONS /sessions` from that Origin returns `Access-Control-Allow-Origin: https://app.example` (+ allowed methods/headers); a non-listed Origin gets no ACAO; no `corsOrigins` → no CORS headers.
- [ ] Run red.
- [ ] Implement `cors(origins)` middleware (echo matching Origin only; handle preflight `OPTIONS`; allow the methods/headers the protocol uses incl. `Authorization`, `Content-Type`, `Last-Event-ID`). Wire into `buildAppWithRuntime` when `corsOrigins` set.
- [ ] Green; gate; commit `feat(gateway): configurable CORS for browser clients`.

### T5 — refuse-to-boot guard (~15 min · Opus)
**Files:** Create the guard (in `src/cli/gatewayCommand.ts` helper or `src/server/auth.ts`); test `tests/cli/gatewayRefuseBoot.test.ts`.
- [ ] Write failing test: a pure `assertGatewaySafe({ host, token })` helper throws when `host` is non-loopback AND `!token`; passes for loopback (any token) and for non-loopback WITH a token.
- [ ] Run red.
- [ ] Implement `assertGatewaySafe` (loopback set = `127.0.0.1`/`::1`/`localhost`). Used by the entrypoint before binding.
- [ ] Green; gate; commit `feat(gateway): refuse to boot when exposed without auth`.

### T6 — `sov gateway` entrypoint (~25 min · Opus)
**Files:** Create `src/cli/gatewayCommand.ts`; modify `src/main.ts`.
- [ ] First read the `sov serve` action in `src/main.ts` + `src/openai/server.ts` to mirror the lifecycle.
- [ ] Implement `runGateway(opts)`: resolve host (`--host` > `SOV_GATEWAY_HOST` > `config.gateway.host` > `127.0.0.1`), port (`--port` > `SOV_GATEWAY_PORT` > `config.gateway.port` > `8766`), token (`SOV_GATEWAY_TOKEN` > `config.gateway.token`), corsOrigins (config); call `assertGatewaySafe`; `buildRuntime`; `startServer({ runtime, hostname: host, port })` with the app built via `buildAppWithRuntime(runtime, { auth: token, corsOrigins })`; print `gateway listening on http://host:port`; SIGINT/SIGTERM → graceful stop + `runtime.dispose()`; park. Register `sov gateway` in `src/main.ts` with `--host`/`--port` flags.
- [ ] Manual smoke (note in testing-log): `SOV_GATEWAY_TOKEN=t sov gateway --host 127.0.0.1 --port 8766` boots; `curl localhost:8766/health` 200; `curl -H 'Authorization: Bearer t' -XPOST localhost:8766/sessions` 201; without the header 401.
- [ ] Gate; commit `feat(gateway): sov gateway long-lived entrypoint`.

### T7 — end-to-end authenticated turn (~20 min · Opus)
**Files:** `tests/server/gatewayEndToEnd.test.ts`.
- [ ] Build a runtime with MockProvider, app via `buildAppWithRuntime(runtime, { auth: 'secret' })`, served on loopback. Drive a full turn with the token: `POST /sessions` → subscribe `GET /sessions/:id/events` → `POST /sessions/:id/turns` → assert streamed events arrive → if a `permission_request` is scripted, `POST /sessions/:id/approvals/:id` and assert the turn completes. Assert the SAME flow without the token is 401 at every `/sessions/*` call. (Reuse the `tests/server/turns.*.test.ts` harness patterns.)
- [ ] Green; gate; commit `test(gateway): end-to-end authenticated turn over the native protocol`.

### T8 — docs + close-out + release (~20 min · Opus; version bump Sonnet-eligible)
**Files:** `docs/usage.md`, `docs/architecture.md`, `docs/testing-log.md`, `package.json`, `docs/state/<today>-phase-a-gateway.md`, `CLAUDE.md`+`AGENTS.md` (state pointer).
- [ ] `docs/usage.md`: a "Remote gateway (`sov gateway`)" section — config (`gateway.{host,port,token,corsOrigins}`), env vars, the loopback-default + refuse-when-exposed security note, the auth + CORS behavior.
- [ ] `docs/architecture.md`: note the new long-lived native gateway surface alongside the TUI/serve/drive surfaces.
- [ ] State snapshot + testing-log entry; update the state pointer in `CLAUDE.md`+`AGENTS.md` (keep byte-identical; `diff` empty).
- [ ] Bump `package.json` (next patch), gate green, `sov upgrade`, **cut the release** per `docs/conventions/cutting-releases.md`, verify `~/.sov/bin/sov --version`.
- [ ] Commit + push.

---

## Self-review
Spec coverage: D1 (`sov gateway`)→T6; D2 (host/port)→T2,T6; D3 (auth)→T3,T6; D4 (refuse-boot)→T5,T6; D5 (CORS)→T4; D6 (reuse server, TUI path unchanged)→T3,T4 (options-gated); D7 (single-token)→T3,T6; D8 (session model unchanged)→T7. Security posture (X1) → T3/T4/T5 + the usage-doc note (T8). No placeholders; pure helpers (auth/cors/assertGatewaySafe) are unit-tested; the entrypoint + end-to-end are integration-tested. Type names (`buildAppWithRuntime` options, `assertGatewaySafe`, `bearerAuth`, `cors`) are consistent across tasks.

## Execution
Per the autonomous-feature-builds convention: execute T1→T8 with subagent-driven development, no approval gates; review at checkpoints; fix issues with judgment; ship (release v-next) at T8.

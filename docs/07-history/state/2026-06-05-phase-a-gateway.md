# State of the build — Phase A: Secure Remote Gateway (shipped; SECURE-TO-SHIP; hardened)

**HEAD:** the `chore(release): bump version 0.6.17 -> 0.6.18` commit (the gateway-hardening + browser-docs run). **Release:** **v0.6.18** (2026-06-05) — Phase A shipped at v0.6.17; v0.6.18 is the hardening + browser-client-docs increment. See the "Hardening pass (2026-06-05)" section at the foot of this file.

**Predecessor:** [`docs/07-history/state/2026-06-04-learning-loop-spike-phase-1.md`](2026-06-04-learning-loop-spike-phase-1.md) (Learning-Loop Spike Phase 1 — loop closed, Q1 PASS; recall ON by default as of v0.6.16).

## What this snapshot is

The **first phase (Phase A / module M1) of the run-anywhere, persistent, multi-channel harness roadmap** — a real phase, not a hardening run. It makes the harness's **native HTTP+SSE protocol** reachable off-loopback, **safely**, via a long-lived authenticated **`sov gateway`** entrypoint, so any remote UI (a web app, an iOS app, a custom client) can drive the *rich interactive* protocol over the network — turns, streaming, tool events, **permission prompts**, slash commands, skills — not just the stateless OpenAI completion surface.

Authoritative implementation docs in this repo:
- **Roadmap:** [`specs/2026-06-05-run-anywhere-harness-roadmap-design.md`](specs/2026-06-05-run-anywhere-harness-roadmap-design.md) (the program; A–F; A now marked shipped)
- **Spec:** [`specs/2026-06-05-phase-a-secure-remote-gateway-design.md`](specs/2026-06-05-phase-a-secure-remote-gateway-design.md) (decisions D1–D8)
- **Plan:** [`plans/2026-06-05-phase-a-secure-remote-gateway.md`](plans/2026-06-05-phase-a-secure-remote-gateway.md) (T1–T8)

The roadmap + decision record (ADR H-0010, the multi-channel-gateway differentiator) stay canonical in `~/code/sovereign-ai-docs`; this repo owns the code and the implementation docs. **No new ADRs in this repo** — Phase A is purely additive, all decisions captured in the spec (D1–D8) + the plan (T1–T8) + commit messages.

## Where this sits in the roadmap

Phase A is **piece 1 of 6** (the root unlock). The roadmap is dependency-ordered:

```
A ──> B ──> C            (browser UI on a secure, robust transport)
 \     \
  \     └─> D ──> E ──> F   (persistent supervisor → multi-user → channels)
   └────────> D
```

- **A — Secure remote gateway (M1) — ✅ shipped (this snapshot, v0.6.17).**
- B — Multi-client session transport (multi-subscriber bus + reconnect-with-replay). **Remaining.**
- C — Reference web UI. **Remaining.**
- D — Persistent multi-session supervisor / service install. **Remaining.**
- E — Multi-user identity + state scoping (security-reviewed). **Remaining.**
- F — Channel framework + Slack/Telegram/webhook adapters. **Remaining.**

Each phase is independently shippable; the program can pause after any phase with a coherent released increment.

## What shipped (Phase A)

1. **`gateway` config block** (`src/config/schema.ts`, `.strict().optional()`) — `{ host?, port?, token?, corsOrigins? }`, mirroring the `openaiServer` block. All optional; defaults documented at the call site.

2. **Host-configurable native bind (D2).** `src/server/index.ts` + `src/server/port.ts` thread an optional `hostname` (default `127.0.0.1`) through `startServer` → `Bun.serve({ hostname })` and `findFreePort`. The TUI launcher / `sov serve` / `sov drive` callers pass nothing → byte-unchanged loopback bind.

3. **Bearer auth middleware (D3)** — `src/server/auth.ts` (`bearerAuth(token)`, constant-time compare; mirrors `src/openai/auth.ts`). Mounted on `/sessions/*` (incl. the SSE event stream) when a token is configured; `/health` stays unauthenticated for liveness probes. The token is never logged.

4. **CORS middleware (D5)** — `src/server/cors.ts` (`cors(origins)`). Echoes `Access-Control-Allow-Origin` for an allow-listed `Origin` **only**, handles preflight `OPTIONS`, and permits the methods/headers the protocol uses (incl. `Authorization`, `Content-Type`, `Last-Event-ID`). Closed by default (`corsOrigins: []`). Needed for the Phase-C web UI.

5. **Refuse-to-boot-when-exposed-without-auth guard (D4)** — `src/server/gatewaySafety.ts` (`assertGatewaySafe` + the `isLoopbackHost` predicate). Hard-exits (exit 1) with an actionable message — never binding — when the resolved host is **not** loopback (`127.0.0.1` / `::1` / `localhost` / the `127/8` block) AND no token is set. On loopback, auth is optional (back-compat). There is no anonymous off-loopback mode.

6. **The `sov gateway` entrypoint (D1)** — `src/cli/gatewayCommand.ts` (`runGateway`), registered in `src/main.ts` with `--host` / `--port` flags. Resolves host (`--host` > `SOV_GATEWAY_HOST` > `gateway.host` > `127.0.0.1`), port (`--port` > `SOV_GATEWAY_PORT` > `gateway.port` > `8766`, distinct from `sov serve`'s 8765), token (`SOV_GATEWAY_TOKEN` > `gateway.token`, trimmed; empty → none), corsOrigins (config); calls `assertGatewaySafe`; `buildRuntime`; `startServer` with the app built via the new `{ auth?, corsOrigins? }` options; prints a boot banner (`auth=on/off  cors=on/off`, token never printed); SIGINT/SIGTERM → graceful `server.stop()` + `runtime.dispose()`; parks forever. Mirrors the `sov serve` lifecycle but serves the **native** app instead of the OpenAI app.

7. **Options-gated middleware (D6) — the TUI path is byte-unchanged.** `startServer` and `buildAppWithRuntime` gained backward-compatible optional `auth?` / `corsOrigins?` params; absent them (the existing TUI / `sov serve` / `sov drive` callers), the app is built + bound exactly as before. Auth + CORS apply only on the gateway path. **Session model unchanged (D8)** — the gateway serves the existing per-turn-resubscribe session routes; the multi-subscriber bus + reconnect/replay is Phase B. **Single-user / single-token (D7)** — per-principal authz is Phase E.

8. **End-to-end test (T7)** — `tests/server/gatewayEndToEnd.test.ts`: a MockProvider-backed runtime, app built via `buildAppWithRuntime(runtime, { auth: 'secret' })`, drives a full turn over the gateway WITH the token (open session → SSE events → turn → assert streamed events) and asserts the same flow WITHOUT the token is 401 at every `/sessions/*` call. Plus the unit suites: `tests/server/auth.test.ts`, `tests/server/cors.test.ts`, `tests/server/gatewaySafety.test.ts`.

## Security review verdict — SECURE-TO-SHIP

Phase A was security-reviewed (the surface is, by design, the central risk of the whole roadmap — exposing a tool-running agent remotely). **Verdict: secure-to-ship.** The X1 posture for this phase: default loopback; refuse-to-boot off-loopback without a token; constant-time token compare; token never logged; CORS closed by default; and a documented trust model — **one token = one full-access principal**, so the usage doc tells operators to expose the gateway only behind a constrained permission policy (a tightened `settings.local.json`, ideally a dedicated bundle) and TLS, never a dev machine's broad `allow Bash(*)`. Per-principal/per-channel policy is deferred to Phases E/F (Phase E gets its own adversarial review).

## Tests

- **TS suite — 2753 pass / 0 fail / 14 skip** (324 files, ~77s) in a clean run. Up from the post-Phase-1 ~2708 baseline, from the Phase-A auth / cors / gatewaySafety / end-to-end suites. Gate criterion unchanged: "no new failures beyond the known env-only set" (the 3 ambient-config learning-observer tests pass on a clean `HARNESS_HOME` / in CI; this run was clean).
- **Live smoke** (logged in `docs/06-testing/testing-log.md`): refuse-boot off-loopback without a token → exit 1 + actionable message (token not printed); live loopback boot → `/health` 200, `POST /sessions` no-auth → 401, with `Authorization: Bearer <token>` → 201; SIGINT → graceful shutdown.
- **Go suite** — unchanged by this phase (no `packages/tui/` change).
- **Lint + typecheck** — clean (`biome check`, `tsc --noEmit`).

## Notes

- **No bundle changes** — the Phase-A surface is entirely in `src/` (`config/`, `server/`, `cli/`), `tests/`, and `docs/`. No `packages/tui/` change.
- **Default surfaces unchanged.** The default `sov` (TUI), `sov serve` (OpenAI API), and `sov drive` (headless) experiences are byte-identical; the gateway is a new, opt-in, headless surface.
- **Learning-loop soak continues in parallel — untouched.** Recall is still **ON by default** (`learning.recall.enabled`, since v0.6.16) and capture + synthesis stay on; the gateway work did not disable recall or learning (a roadmap execution requirement — the learning layer rides above the protocol seam unchanged). The `## ⚠️ ACTIVE FOCUS — Learning-loop soak` banner in `CLAUDE.md`/`AGENTS.md` stays the standing #1 focus; this gateway phase is a separate, parallel track.

## Cross-repo record-keeping (flag for a docs-repo session)

The roadmap + decision record are canonical in `~/code/sovereign-ai-docs` and this repo can't commit there. A docs-repo session should reflect **Phase A shipped (v0.6.17), hardened + validated browser-drivable (v0.6.18)** against the multi-channel-gateway differentiator (ADR H-0010) and the run-anywhere program tracker.

---

## Hardening pass (2026-06-05) — v0.6.18

After v0.6.17 shipped, Phase A got a **deep correctness review** plus a **live, cross-origin, real-model browser E2E test**. The gateway came through robust; the review + the live test together surfaced three fixes (all committed, all TDD) and a set of browser-client realities now documented in `docs/03-cli-reference/usage.md`. Released as **v0.6.18**.

### The deep correctness review

A focused review of the gateway surface (the central risk of the whole roadmap — a tool-running agent over the network). The verdict was **robust**; the review found three sharp edges worth fixing and one stale report:

1. **Malformed JSON body → 500 (should be 400)** on `POST /sessions/:id/turns` and `POST /sessions/:id/approvals/:requestId` — both read the body via an unguarded `await c.req.json()` while every other body-reading route (`commands`, `skills`, `chatCompletions`) already guards it.
2. **Resolved gateway port unvalidated** — `SOV_GATEWAY_PORT` / `gateway.port` flowed into `Bun.serve` unchecked, so `0` / `70000` / `-1` / `8080x` silently bound a random or clamped port.
3. **In-flight buses not aborted on dispose** — on SIGINT during an active turn, `runtime.dispose()` closed `sessionDb` but never aborted in-flight turns / their SSE buses, so a running `query()` kept writing to a closed DB handle until `process.exit`.
4. **Stale report (no change):** the review's "port has no upper bound" note was wrong — `gateway.port` and `openaiServer.port` in `src/config/schema.ts` already carry `.int().min(1).max(65535)`. The new fix adds a *resolved-value* check (env/flag don't pass through the schema); the schema itself was already correct.

### The live browser E2E test

Drove the gateway **from a real browser, cross-origin, against a real model** — the first proof that the rich interactive protocol is genuinely browser-drivable, not just curl-drivable. Result: **it works end to end.** The model's output **streamed over SSE cross-origin**; **CORS was clean** (preflight + the bearer + `Last-Event-ID` headers all handled, exact-origin echo); and a **tool-use → `permission_request` → approval → completion round-trip worked** over the network. The test also surfaced the key client-author realities, now written into the usage doc:

- **The browser `EventSource` API can't consume the SSE stream** — it can't set an `Authorization` header, and `GET /sessions/:id/events` is bearer-gated, so `EventSource` just gets a **401**. The working pattern is **`fetch()` + a `ReadableStream` reader** with the bearer header, parsing the `event:`/`id:`/`data:` frames manually. This is the single biggest gotcha and is now documented with a copy-pasteable ~40-line canonical client snippet.
- **Status codes:** `POST /sessions` → 201, `/turns` → 202, approvals → 200; clients must use `res.ok`, not `=== 200`.
- **Re-subscribe per turn:** the SSE stream ends on `turn_complete`/`turn_error`; a multi-turn client opens a fresh stream per turn (single-stream reconnect-with-replay is Phase B).
- **Permission modes:** under `default` mode the read-only shell allow-list (`echo`, `ls`, `cat`, …) auto-resolves as virtual reads, so not every command prompts — operators must reason about the effective policy (mode + rule layer), not the prompt stream alone.

### The three fixes (committed, TDD)

1. **`fix(gateway): return 400 (not 500) on malformed JSON body for turns + approvals`** (`adba2c6`) — wrapped both body reads in try/catch → structured `{ error: 'invalid JSON body' }` 400, mirroring the other routes. Auth + id/session guards still run first; the approvals 404-before-parse guard for unknown requestIds is unchanged. `tests/server/malformedBody.test.ts` (5 cases).
2. **`fix(gateway): validate resolved port is in [1,65535], fail fast on bad values`** (`3cae86e`) — extracted pure `resolveGatewayPort(flag, env, configPort)` in `src/cli/gatewayCommand.ts` (precedence flag > env > config > default 8766; integer-in-`[1,65535]` check; env parsed with `Number()` so `8080x` is rejected not truncated; top-level `main()` catch → stderr + exit 1). `tests/cli/gatewayPort.test.ts` (18 cases).
3. **`fix(runtime): abort in-flight session buses before closing the DB on dispose`** (`b5dbbee`) — new `abortAllBuses()` in `src/server/eventBus.ts` (closes every live bus without clearing the map — distinct from `__test_resetAllBuses` / per-session `disposeBus`); `dispose()` calls it FIRST, then yields one `await Promise.resolve()` tick before `sessionDb.close()` so the abort propagates through the parked generators. Idempotent. Shared path → improves `sov gateway` + `sov serve`. `tests/server/disposeAbortsBuses.test.ts` (2 cases: ordering proof + behavioral mid-turn dispose).

### Docs updated

- **`docs/03-cli-reference/usage.md`** — the "Remote gateway (`sov gateway`)" section expanded: port-range-validation notes; a complete endpoints table (verb / path / auth / **success status** / description, incl. `messages`, `compact`, `commands`, `skills`, with the structured-error note); a `corsOrigins`-is-config-only callout; and a **new "Driving the gateway from a browser" subsection** — the EventSource-can't-auth reality, the `fetch()` + `ReadableStream` canonical client snippet, `res.ok` vs `=== 200`, re-subscribe-per-turn, CORS setup, and the effective-permission-policy note.
- **`docs/02-architecture/runtime-architecture.md`** — the Native Gateway section gained a browser-transport note (fetch-streaming because SSE is bearer-gated) + a hardening bullet (the three fixes + the live-browser-E2E validation).

### Tests + release

- **TS suite — 2778 pass / 0 fail / 14 skip** (327 files, ~68s), +25 from the v0.6.17 baseline of ~2753 (5 malformedBody + 18 gatewayPort + 2 disposeAbortsBuses). No new failures, no timeouts. Gate criterion unchanged.
- **Lint + typecheck** clean (`biome check` 640 files; `tsc --noEmit`).
- **No bundle / `packages/tui/` changes** — the surface is `src/server/routes/{turns,approvals}.ts`, `src/server/eventBus.ts`, `src/server/runtime.ts`, `src/cli/gatewayCommand.ts`, their tests, and docs. No new ADRs (purely additive hardening; decisions captured in commit messages + the testing-log entry).
- **Release: v0.6.18** (CI-driven tag-push per `docs/05-conventions/cutting-releases.md`).

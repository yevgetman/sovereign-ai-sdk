# State of the build — Phase A: Secure Remote Gateway (shipped; SECURE-TO-SHIP)

**HEAD:** the `chore(release): bump version 0.6.16 -> 0.6.17` commit (docs + the gateway feature run). **Release:** **v0.6.17** (2026-06-05) — the first run-anywhere increment.

**Predecessor:** [`docs/state/2026-06-04-learning-loop-spike-phase-1.md`](2026-06-04-learning-loop-spike-phase-1.md) (Learning-Loop Spike Phase 1 — loop closed, Q1 PASS; recall ON by default as of v0.6.16).

## What this snapshot is

The **first phase (Phase A / module M1) of the run-anywhere, persistent, multi-channel harness roadmap** — a real phase, not a hardening run. It makes the harness's **native HTTP+SSE protocol** reachable off-loopback, **safely**, via a long-lived authenticated **`sov gateway`** entrypoint, so any remote UI (a web app, an iOS app, a custom client) can drive the *rich interactive* protocol over the network — turns, streaming, tool events, **permission prompts**, slash commands, skills — not just the stateless OpenAI completion surface.

Authoritative implementation docs in this repo:
- **Roadmap:** [`docs/specs/2026-06-05-run-anywhere-harness-roadmap-design.md`](../specs/2026-06-05-run-anywhere-harness-roadmap-design.md) (the program; A–F; A now marked shipped)
- **Spec:** [`docs/specs/2026-06-05-phase-a-secure-remote-gateway-design.md`](../specs/2026-06-05-phase-a-secure-remote-gateway-design.md) (decisions D1–D8)
- **Plan:** [`docs/plans/2026-06-05-phase-a-secure-remote-gateway.md`](../plans/2026-06-05-phase-a-secure-remote-gateway.md) (T1–T8)

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
- **Live smoke** (logged in `docs/testing-log.md`): refuse-boot off-loopback without a token → exit 1 + actionable message (token not printed); live loopback boot → `/health` 200, `POST /sessions` no-auth → 401, with `Authorization: Bearer <token>` → 201; SIGINT → graceful shutdown.
- **Go suite** — unchanged by this phase (no `packages/tui/` change).
- **Lint + typecheck** — clean (`biome check`, `tsc --noEmit`).

## Notes

- **No bundle changes** — the Phase-A surface is entirely in `src/` (`config/`, `server/`, `cli/`), `tests/`, and `docs/`. No `packages/tui/` change.
- **Default surfaces unchanged.** The default `sov` (TUI), `sov serve` (OpenAI API), and `sov drive` (headless) experiences are byte-identical; the gateway is a new, opt-in, headless surface.
- **Learning-loop soak continues in parallel — untouched.** Recall is still **ON by default** (`learning.recall.enabled`, since v0.6.16) and capture + synthesis stay on; the gateway work did not disable recall or learning (a roadmap execution requirement — the learning layer rides above the protocol seam unchanged). The `## ⚠️ ACTIVE FOCUS — Learning-loop soak` banner in `CLAUDE.md`/`AGENTS.md` stays the standing #1 focus; this gateway phase is a separate, parallel track.

## Cross-repo record-keeping (flag for a docs-repo session)

The roadmap + decision record are canonical in `~/code/sovereign-ai-docs` and this repo can't commit there. A docs-repo session should reflect **Phase A shipped (v0.6.17)** against the multi-channel-gateway differentiator (ADR H-0010) and the run-anywhere program tracker.

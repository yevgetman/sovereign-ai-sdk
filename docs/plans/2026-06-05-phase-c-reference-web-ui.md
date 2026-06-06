# Phase C — Reference Web UI · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Checkbox steps. Executes per `docs/conventions/autonomous-feature-builds.md` — no approval gates. The UI task applies the `frontend-design` skill's intent (distinctive, production-grade, not generic-AI).

**Goal:** Ship a polished single-file browser chat client served by the gateway, per `docs/specs/2026-06-05-phase-c-reference-web-ui-design.md`.

**Architecture:** A single self-contained `webui.html` (inline CSS+JS, vanilla) embedded into the binary and served (open) at `GET /` + `/ui` by the native app; it drives the Phase A/B protocol (token-prompt auth → `POST /sessions` → `?follow` SSE via `fetch()`+ReadableStream with `Authorization` + `Last-Event-ID` reconnect → `POST /turns`; tool cards; permission approve/deny → `POST /approvals`). Same-origin ⇒ no CORS.

**Tech Stack:** TypeScript on Bun + Hono (serve route); vanilla HTML/CSS/JS (UI); Playwright (e2e).

---

## Investigation findings (verify while implementing)
1. **Serve route mounting:** `src/server/app.ts` `buildAppWithRuntime(runtime, opts?)` mounts `/health` (open) then, when `opts.auth`, `app.use('/sessions/*', bearerAuth)`. The web-UI route MUST be mounted **before** the `/sessions/*` auth (so it's open) — alongside `/health`.
2. **Binary embedding:** the HTML must ship in the `bun build --compile` binary. Prefer a co-located text import — `import webUiHtml from './webui.html' with { type: 'text' }` in `src/server/webui.ts` (verify Bun inlines it under `--compile`; if not, inline the HTML as a string constant). Co-locating the HTML in `src/server/` (not `packages/web/`) keeps the text-import binary-safe — this refines the spec's `packages/web/` suggestion.
3. **Client protocol** = exactly the documented browser pattern now in `docs/usage.md` (Phase A/B gateway section): `fetch()`+ReadableStream SSE with `Authorization` (EventSource can't auth), `?follow=true`, capture `id` per frame, reconnect with `Last-Event-ID`. Base the client JS on that.
4. **Event types to render** (`src/server/schema.ts`): `text_delta`, `thinking_delta`, `tool_use_start`, `tool_use_done`, `tool_result`, `status_update`, `permission_request`, `turn_complete`, `turn_error` (+ ignore/relay others gracefully). `permission_request` carries `requestId`, `tool`, `input`, `reason?`.
5. **Playwright** via MCP (ToolSearch: "playwright browser navigate snapshot type click evaluate console"); same approach as the Phase-A live test.

## File structure
**Create:** `src/server/webui.html` (the client), `src/server/webui.ts` (embed+serve helper), `src/server/routes/webui.ts` (or inline in app.ts) the open route; `tests/server/webui.test.ts`; `tests/e2e/webui.playwright.md` (a documented e2e script/test).
**Modify:** `src/server/app.ts` (mount the open route), `docs/usage.md`, `docs/architecture.md`, `package.json`.

## Conventions
`.js` imports; one-line headers; no mutation; bun:test; the UI route is OPEN (no auth) + carries no secret; never embed the token in the served HTML. Gate (`bun run lint && bun run typecheck && bun run test`, ~2810/0, no new failures). Atomic commits. **NO release until the final task.**

---

## Tasks

### T1 — serve mechanism: embed + open route (~20 min · Opus)
**Files:** Create `src/server/webui.ts` + `src/server/webui.html` (minimal placeholder for now: `<!doctype html><title>Sovereign AI</title><div id=app>loading…</div>` — real UI lands in T2); route in `src/server/app.ts` (or `routes/webui.ts`); test `tests/server/webui.test.ts`.
- [ ] Write failing test: `buildAppWithRuntime(runtime, { auth: 'secret' })` → `GET /` returns 200 `text/html` WITHOUT a token (open), body contains a known marker (e.g. `id="app"`); `GET /ui` likewise; and the `/sessions/*` auth is unaffected (still 401 without token).
- [ ] Run red.
- [ ] Implement: `webui.ts` embeds the HTML (co-located text import `with { type: 'text' }`, or inline string if needed) + exports it; mount `GET /` and `GET /ui` returning `c.html(webUiHtml)` BEFORE the auth middleware in `buildAppWithRuntime`. Open route.
- [ ] Run green; gate; **if feasible, smoke that a compiled binary still serves it** (or note to verify at release). Commit `feat(webui): serve an embedded web UI shell (open route) from the gateway`.

### T2 — the reference web client (the UI) (~45 min · Opus; apply frontend-design)
**Files:** Replace `src/server/webui.html` with the full client.
- [ ] Build a **single self-contained, polished** chat client (inline CSS+JS, vanilla, no framework). Apply frontend-design discipline — distinctive, production-grade: considered type scale, spacing, color, a real streaming feel; NOT a generic chatbox. Features (spec D5–D7 v1 scope):
  - **Connect screen:** base URL (default the page's origin) + bearer token input → stored in `localStorage`; a health check (`GET /health`); a "disconnect / change token" control. (Token-less works on a no-auth loopback gateway.)
  - **Chat:** `POST /sessions` (Bearer) on connect/new-session; open the **`?follow=true`** SSE stream via `fetch()`+ReadableStream with `Authorization`, parse `event:`/`id:`/`data:` frames, capture the last `id`; an input box → `POST /sessions/:id/turns {text}`.
  - **Render:** streaming `text_delta` (live), `thinking_delta` (collapsible/dim), **tool cards** (`tool_use_start`+`tool_use_done` → a card; `tool_result` → its output, error-styled on `is_error`), `status_update` (subtle), `turn_complete`/`turn_error` (finalize). Basic safe formatting (escape HTML; simple line breaks). 
  - **Permission UI:** on `permission_request`, render an inline **Approve / Deny** affordance showing tool + input + reason → `POST /sessions/:id/approvals/:requestId {approved}` (+ optional "always").
  - **Reconnect:** on stream drop (fetch reader ends/errs unexpectedly mid-session), reconnect the `?follow` stream with `Last-Event-ID: <last id>` (capped retries + backoff so a dead gateway doesn't busy-loop).
  - **New session / cancel** (cancel optional if cheap: `POST /sessions/:id/cancel`).
  - Escape all server-provided text to avoid XSS from tool output / model text.
- [ ] Manual self-check the HTML is well-formed + the JS has no syntax errors (`bun -e` parse or open-and-snapshot in T3). Gate (typecheck/lint unaffected — it's an .html asset; ensure the text-import still compiles). Commit `feat(webui): polished single-file reference chat client`.

### T3 — real-browser e2e (Playwright) (~30 min · Opus)
**Files:** `tests/e2e/webui.playwright.md` (a documented, re-runnable script) — or a test if the harness supports it.
- [ ] Boot `sov gateway` on loopback with a token, against an isolated temp `HARNESS_HOME` (copy the real config for the provider key; export `ANTHROPIC_API_KEY`; DO NOT mutate the user's real config). Since the UI is served same-origin by the gateway, navigate Playwright to `http://127.0.0.1:<port>/` (no separate static server, no CORS).
- [ ] Drive via Playwright (MCP): enter the token on the connect screen, send `reply with exactly: pong` → assert the streamed reply renders. Then a tool-use prompt (e.g. `run the bash command: echo hello-webui and report the output`) → assert the tool card + the `permission_request` Approve UI appears, click Approve → assert the `tool_result` + final answer render. Screenshot both. Capture console for errors.
- [ ] (If feasible) kill the gateway mid-turn-idle and confirm the UI reconnects (or at least surfaces a clear disconnected state) — note the result honestly.
- [ ] Clean up (kill gateway, close browser, temp home in /tmp). Record results in `docs/testing-log.md`. Address any UI bug found (loop back to T2 if needed). Commit `test(webui): real-browser e2e of the reference client against a live gateway`.

### T4 — docs + close-out + release (~20 min · Opus; bump Sonnet-eligible)
**Files:** `docs/usage.md`, `docs/architecture.md`, `docs/testing-log.md`, `docs/state/<today>-phase-c-webui.md`, roadmap spec (mark Phase C shipped), `CLAUDE.md`+`AGENTS.md` (state pointer; DON'T touch the soak banner; `diff` empty), `package.json`.
- [ ] `docs/usage.md`: "Open the web UI" — run `sov gateway`, browse to `http://host:port/`, paste the token; what it supports (streaming, tool cards, permission prompts, reconnect).
- [ ] `docs/architecture.md`: the bundled reference web client surface (served open by the native app, drives the protocol).
- [ ] State snapshot + testing-log entry + roadmap "✅ Shipped vX" marker on Phase C. Update the state pointer in `CLAUDE.md`+`AGENTS.md` (byte-identical; soak banner untouched).
- [ ] Bump `package.json` (next patch, v0.6.20), gate green, `sov upgrade`, **verify the installed binary serves the UI** (`curl -s ~/.sov... or http://127.0.0.1:<port>/` after booting the upgraded `sov gateway`), cut the release per `docs/conventions/cutting-releases.md`, verify `~/.sov/bin/sov --version`.
- [ ] Commit + push.

---

## Self-review
Spec coverage: D1 single-file→T2; D2 served-open+embedded→T1; D3 same-origin/no-CORS→T1/T3 (navigate to the gateway origin); D4 token-prompt→T2; D5 protocol+?follow+reconnect→T2; D6 permission UI→T2; D7 v1 scope→T2 (stretch noted); D8 e2e→T3 + serve-route test→T1. No placeholders; the embedding mechanism (T1) + the XSS-escaping + reconnect-backoff (T2) are the load-bearing correctness points. The HTML route is open (verified in T1) and carries no secret.

## Execution
Per the autonomous convention: T1→T4 subagent-driven, no approval gates; the UI (T2) applies frontend-design; ship (release v0.6.20) at T4.

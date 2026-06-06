# Phase C — Reference Web UI — Design Spec

**Date:** 2026-06-05
**Status:** Draft (pre-implementation)
**Parent roadmap:** `docs/specs/2026-06-05-run-anywhere-harness-roadmap-design.md` (Phase C / module M8). **Depends on Phase A** (gateway, v0.6.18) **+ Phase B** (multi-client transport / `?follow` / reconnect, v0.6.19).

## Goal

Ship a **real, polished browser chat UI**, served by the gateway, that drives the harness's rich native protocol — proving "run the harness anywhere, drive it from any UI" with a tangible artifact, and giving the project a dogfood web client. It turns the throwaway HTML client validated in the Phase-A pass into a first-class, maintained reference client.

## Design principles for the UI

Apply strong frontend-design discipline (the `frontend-design` skill's intent): a **distinctive, production-grade** chat interface — considered typography, spacing, and color; a real streaming feel; clear tool/permission affordances — NOT a generic-AI-looking box. It should feel like a polished product, within a dependency-free, single-file constraint.

## Locked design decisions

| ID | Decision |
|---|---|
| **D1** | **Single self-contained `index.html`** — inline CSS + vanilla JS, **no framework, no build pipeline.** The most copyable, deployable, maintainable form of a "static client," and it ships trivially in the compiled binary. (A framework/build SPA is explicitly out of scope — revisit only if the reference client outgrows one file.) |
| **D2** | **Served by the gateway.** A new **open (unauthenticated)** route `GET /` (and `/ui`) on the native app returns the embedded HTML — it's just the shell; the API stays bearer-gated. Embedded as a compiled-in asset (Bun `--compile`-safe import / `Bun.file` from a binary-resolvable path) so it ships with the binary — NO separate asset-packaging step. Added to `buildAppWithRuntime` so any native server (gateway especially) serves it; `/health` + `/sessions/*` unchanged. |
| **D3** | **Same-origin → no CORS needed** for the bundled UI (it's served by the gateway it calls). External/third-party UIs still use Phase A's `corsOrigins`. |
| **D4** | **Token UX.** The gateway requires a bearer token for the API, which the UI can't know — so the UI **prompts for the token** (a connect screen), stores it in `localStorage`, sends it as `Authorization: Bearer` on every API call, and offers a "disconnect / change token" control. (The token is the user's; the UI is a client.) On a loopback gateway with no token, the UI works token-less too. |
| **D5** | **Protocol = Phase A/B native.** `POST /sessions` → open a **`?follow=true`** SSE stream via `fetch()`+`ReadableStream` with `Authorization` (per the documented browser pattern — `EventSource` can't auth) → `POST /sessions/:id/turns`. Capture each frame's `id` (seq) and **reconnect with `Last-Event-ID`** on a dropped stream (Phase B). Render: streaming `text_delta`, `thinking_delta` (collapsible), **tool cards** (`tool_use_start`/`tool_use_done` + `tool_result`), `status_update`, and `turn_complete`/`turn_error`. |
| **D6** | **Permission prompts as first-class UI.** A `permission_request` event renders an inline **approve / deny** affordance (showing tool + input + reason); the choice `POST`s to `/sessions/:id/approvals/:requestId` `{approved, always?}`. |
| **D7** | **Scope v1 (keep it focused):** connect (token) → new session → multi-turn chat with streaming + tool cards + permission prompts + reconnect-on-drop. **Stretch / out of scope v1:** slash-command UI, skills management, a session list / resume-by-id picker, markdown rendering beyond basic formatting, cancel button (nice-to-have — include if cheap). Note what's deferred. |
| **D8** | **Testing = a real-browser e2e** (Playwright) driving the SHIPPED UI against a real `sov gateway` + real model: a turn streams into the UI, a tool-use → permission → approve round-trip works, and a reconnect replays — plus a unit/integration test that the gateway serves the HTML (200, open, contains the app). (Inline JS isn't unit-testable in isolation; the e2e is the behavioral proof, mirroring the Phase-A live test but against the real client.) |

## Components

**Create:**
- `packages/web/index.html` — the single self-contained reference client (inline CSS+JS). The deliverable UI.
- `src/server/webui.ts` — embeds + serves the HTML (compiled-in asset; a helper returning the HTML string).
- A route in `src/server/app.ts` (or a small `routes/webui.ts`) — `GET /` + `GET /ui` → the HTML, open (mounted BEFORE the `/sessions/*` auth so it's unauthenticated; `/health` stays).
- `tests/server/webui.test.ts` — the route serves the HTML (200, open without token, contains a known marker).
- `tests/e2e/webui.playwright.test.ts` (or a documented Playwright script) — the real-browser e2e (boot gateway + real model + drive the UI).

**Modify:**
- `src/server/app.ts` — mount the web-UI route (open).
- `docs/usage.md` — "Open the web UI" (run `sov gateway`, browse to `http://host:port/`, paste the token).
- `docs/architecture.md` — note the bundled reference web client surface.

## Security / correctness notes

- The UI HTML route is **open by design** (it's a static shell; it contains NO secret). All capability stays behind the bearer-gated API. The token lives only client-side (`localStorage`) + travels as the `Authorization` header — never embedded in the served HTML.
- Served same-origin → the bundled UI needs no CORS; this does not change the API's auth (every `/sessions/*` call from the UI carries the token).
- The UI is a client only — it cannot do anything the token-holder couldn't already do via the API. Exposing the gateway is governed by Phase A's security model (loopback default, refuse-boot, permission policy) — unchanged.
- Reconnect uses Phase B's `Last-Event-ID`; the UI should cap reconnect attempts / back off so a dead gateway doesn't busy-loop.

## Out of scope

Slash-command/skills UI, session-list/resume picker, rich markdown, theming, a build-tooled SPA, native mobile apps (Phase C is the in-repo browser proof; the gateway already makes a separate iOS/web app buildable). Multi-user is Phase E (the UI's single-token connect is fine until then).

## Testing + ship

TDD where it applies (the serve route); the e2e is the behavioral proof. Full gate green. Update `docs/usage.md` + `docs/architecture.md` + state snapshot + `CLAUDE.md`/`AGENTS.md` pointer (don't touch the soak banner) + testing-log. Commit/push; `sov upgrade`; cut a release (the binary now serves the UI). Per `docs/conventions/autonomous-feature-builds.md`, executes immediately into the plan with no approval gate.

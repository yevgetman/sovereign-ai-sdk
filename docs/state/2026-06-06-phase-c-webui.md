# State of the build — Phase C: Reference Web UI (shipped; embedded single-file browser client, served by the gateway)

**HEAD:** the `chore(release): bump version 0.6.19 -> 0.6.20` commit (the Phase C reference-web-UI run). **Release:** **v0.6.20** (2026-06-06).

**Predecessor:** [`docs/state/2026-06-05-phase-b-transport.md`](2026-06-05-phase-b-transport.md) (Phase B — Multi-Client Session Transport shipped + hardened; v0.6.19).

## What this snapshot is

The **third phase (Phase C / module M8) of the run-anywhere, persistent, multi-channel harness roadmap** — a real phase, not a hardening run. It ships a **real, polished browser chat client served by the gateway**, driving the harness's rich native HTTP+SSE protocol — the first visible "run the harness anywhere, drive it from any UI" milestone with a tangible artifact. The throwaway HTML client validated in the Phase-A live pass is now a first-class, maintained, embedded reference client: a **single self-contained page** (inline CSS + vanilla JS, no framework, no build pipeline) compiled into the binary and served OPEN at `GET /` + `/ui` by `sov gateway`.

Authoritative implementation docs in this repo:
- **Roadmap:** [`docs/specs/2026-06-05-run-anywhere-harness-roadmap-design.md`](../specs/2026-06-05-run-anywhere-harness-roadmap-design.md) (the program; A–F; A + B + C now marked shipped)
- **Spec:** [`docs/specs/2026-06-05-phase-c-reference-web-ui-design.md`](../specs/2026-06-05-phase-c-reference-web-ui-design.md) (decisions D1–D8)
- **Plan:** [`docs/plans/2026-06-05-phase-c-reference-web-ui.md`](../plans/2026-06-05-phase-c-reference-web-ui.md)

The roadmap + decision record (ADR H-0010, the multi-channel-gateway differentiator) stay canonical in `~/code/sovereign-ai-docs`; this repo owns the code and the implementation docs. **No new ADRs in this repo** — Phase C is purely additive (a new open HTML route + an embedded asset + a client), all decisions captured in the spec (D1–D8) + commit messages. The default `sov` / `sov serve` / `sov drive` surfaces are byte-unchanged; the UI route is open-by-design (a static shell with no secret) and the API stays bearer-gated.

## Where this sits in the roadmap

Phase C is **piece 3 of 6**. The roadmap is dependency-ordered:

```
A ──> B ──> C            (browser UI on a secure, robust transport)
 \     \
  \     └─> D ──> E ──> F   (persistent supervisor → multi-user → channels)
   └────────> D
```

- A — Secure remote gateway (M1) — ✅ shipped (v0.6.17 + v0.6.18 hardening).
- B — Multi-client session transport (M2) — ✅ shipped (v0.6.19).
- **C — Reference web UI (M8) — ✅ shipped (this snapshot, v0.6.20).**
- D — Persistent multi-session supervisor / service install. **Remaining.**
- E — Multi-user identity + state scoping (security-reviewed). **Remaining.**
- F — Channel framework + Slack/Telegram/webhook adapters. **Remaining.**

Each phase is independently shippable; the program can pause after any phase with a coherent released increment. **A→B→C is the first complete "run-anywhere from a browser" arc** — a remote-reachable, authenticated, multi-client gateway with a real client on top.

## What shipped (Phase C)

1. **Single self-contained client (D1).** `src/server/webui.html` — inline CSS + vanilla JS, **no framework, no build pipeline.** Polished, distinctive chat UI (considered typography/spacing/color; real streaming feel; clear tool/permission affordances) within a dependency-free single-file constraint. The most copyable/deployable form of a static client, and it ships trivially in the compiled binary.

2. **Served by the gateway, embedded in the binary (D2).** `src/server/webui.ts` exports `WEB_UI_HTML` via a co-located `import ./webui.html with { type: 'text' }` — the same `--compile`-safe inlining mechanism `version.ts` uses for `with { type: 'json' }` (proven inlined into `bun build --compile` output in T1; no runtime FS read). Two routes — `app.get('/', …)` + `app.get('/ui', …)` — mounted in `src/server/app.ts` **BEFORE** the `app.use('/sessions/*', bearerAuth(...))` line, so the shell is **open** (like `/health`) while every API route stays bearer-gated. `buildAppWithRuntime` serves it, so any native server (the gateway especially) does; `/health` + `/sessions/*` are unchanged.

3. **Same-origin → no CORS (D3).** The bundled UI is served by the gateway it calls, so it needs no `gateway.corsOrigins` entry. External/third-party UIs still use Phase A's `corsOrigins` allow-list.

4. **Token UX (D4).** The UI prompts for the bearer token on a connect screen, stores it in `localStorage`, sends it as `Authorization: Bearer …` on every API call, and offers a disconnect / forget-saved-token control. The token is **never embedded in the served HTML** — it's the user's, the UI is a client. On a loopback gateway with no token, the UI connects token-less.

5. **Protocol = Phase A/B native (D5).** `POST /sessions` (201) → open a **`?follow=true`** SSE stream via `fetch()` + a `ReadableStream` reader with the `Authorization` header (per the documented browser pattern — `EventSource` can't auth) → `POST /sessions/:id/turns` (202). Captures each frame's `id` (seq) and **reconnects with `Last-Event-ID`** on a dropped stream (Phase B). Renders streaming `text_delta`, collapsible `thinking_delta`, **tool cards** (`tool_use_start` / `tool_use_done` + `tool_result`), `status_update`, and `turn_complete` / `turn_error`.

6. **Permission prompts as first-class UI (D6).** A `permission_request` event renders an inline **Approve / Deny** card (tool + input + reason, with an optional "always allow"); the choice `POST`s to `/sessions/:id/approvals/:requestId` `{approved, always?}`.

7. **Scope v1 (D7).** Connect (token) → new session → multi-turn chat with streaming + tool cards + permission prompts + reconnect-on-drop, plus **new chat** and **cancel** (the cheap nice-to-haves). Deferred (out of scope v1): slash-command UI, skills management, session list / resume-by-id picker, rich markdown beyond basic formatting.

## The browser e2e + the reconnect bug found & fixed

**Testing = a real-browser e2e (D8).** Phase C's behavioral proof is a Playwright e2e driving the SHIPPED UI (`src/server/webui.html`, served by `sov gateway` at `GET /`) against a live gateway + the **real Anthropic model**, plus a unit/integration test that the route serves the HTML (200, open without token, contains the `id="app"` marker — `tests/server/webui.test.ts`). Isolated `HARNESS_HOME` (`mktemp -d`, the real `~/.harness/config.json` copied in for the API key only — the user's real config was NOT mutated); gateway on `127.0.0.1:8770` with `SOV_GATEWAY_TOKEN=webuitok`. Three legs, all **PASS**:

- **Connect + simple turn.** Connect screen (origin pre-filled, bearer field) → health probe → `POST /sessions` → `?follow` stream → chat view (`live` dot + short session id + version). `reply with exactly the word: pong` streamed **pong** into the bubble; metrics rendered.
- **Tool-use → permission Approve → tool_result.** With the isolated config switched to `permissionMode: "default"` and a writer command (a `>` redirect makes it ask), a **tool card** (`⚒ Bash`, spinner) appeared, then a gold **PERMISSION REQUIRED** card (full command + "always allow" + Deny/Approve). **Approve** → verdict flipped to **✓ approved**, the card went `✓ Bash · done` with output, the final answer rendered, and the marker file was confirmed written on disk (genuine execution, not a rendered illusion). (Note: `echo` is on the read-only Bash allowlist so a plain `echo` auto-approves — correct harness behavior, not a UI defect.)
- **Reconnect — PASS after fixing a real bug.** Killing the gateway flipped the UI to a gold `reconnecting` dot with capped exponential backoff (`reconnect N/6`); exhausting all 6 retries reached a clean terminal `disconnected` + "Reconnect now". A quick kill+reboot recovers to `live` + "Ready.".

**The SSE header-flush bug (`fix(webui)`, commit `a77ed32`).** Initially the auto-reconnect **WEDGED** at "Reconnecting… (3/6)" forever after a quick kill+reboot. Root cause was server-side, proven in the browser: the SSE handler (`GET /sessions/:id/events`) wrote nothing until the first event, and **Bun does not flush HTTP response headers until the first body write** — so a browser `fetch()` opening a `?follow` stream on an *idle* session (no queued events — exactly the post-reconnect-to-fresh-session case) stayed pending on the headers indefinitely (an in-page probe measured the fetch hanging >4s pre-fix vs **~3ms** after). The client's reader promise never resolved, its `connecting` flag stayed set, and the retry timer's `openStream()` no-opped (single-flight) → permanent freeze. **Fix:** write a leading **`: connected`** SSE comment frame on connect (`src/server/routes/events.ts`) to flush the headers immediately — the leading `:` makes it a comment the SSE spec + the client parser ignore; `tests/server/events.test.ts` updated to drop comment frames. The client reconnect lifecycle was also hardened so it can never wedge even if the server stalls again (single-flight `connecting` guard, `onAttemptSettled()` supersede re-arm, idempotent `scheduleReconnect()`, full state reset in the manual "Reconnect now" handler). Re-verified in the browser post-fix: quick kill+reboot auto-recovers to `live`+"Ready."; long outage → exhausted retries → "Reconnect now" → reboot → click recovers; post-reconnect turns stream correctly every time.

## The XSS / correctness review — SECURE + CORRECT

A focused security + correctness review of the client and the serve route returned **SECURE + CORRECT**:
- **XSS-clean.** No `innerHTML` injection of model/tool/user content; dynamic text goes through `textContent` / safe DOM construction (no `eval`, no template-string HTML from untrusted data). No JS exceptions, CORS errors, or CSP violations across the whole browser session (the only benign console noise was a `favicon.ico` 404 and the deliberate-kill connection errors during the reconnect tests).
- **Token-safe.** The token is never embedded in the served HTML; it lives only in `localStorage` and travels as the `Authorization` header. The HTML route is open by design but exposes no secret and grants no capability — all capability stays behind the bearer-gated API. The UI is a client only: it can do nothing the token-holder couldn't already do via the API.
- **Reconnect correct.** `Last-Event-ID` replay + capped backoff is correct (no busy-loop; bounded retries; clean terminal state) — verified live.

## Two known-minor LOW follow-ups (non-blocking)

Both are cosmetic / theoretical and were judged non-blocking for ship; recorded here for a future polish pass:

1. **Duplicate permission card on a mid-turn reconnect-replay.** If a client reconnects mid-turn and the replay window re-includes a `permission_request` for a prompt already answered (or rendered), a second permission card can render. It's **cosmetic** — answering the duplicate is a no-op (the second answer hits an already-resolved request and is ignored server-side). De-duping rendered requests by `requestId` on replay is the fix.
2. **SSE parser splits on `\n\n` (LF only).** The client frame parser splits on `\n\n` (LF), which is correct against this gateway (its encoder emits LF-delimited frames — `src/server/sseStream.ts`). A third-party CRLF-emitting gateway proxy would leave a stray `\r` on parsed fields. Splitting on `\r\n\r\n|\n\n` is the robust fix; not needed against the harness's own server.

## Tests

- **TS suite — ~2814 pass / 0 fail / 14 skip** in a clean run. Up from the Phase-B v0.6.19 baseline of ~2810, from the new `tests/server/webui.test.ts` (open route serves the HTML; auth/health unaffected) + the `tests/server/events.test.ts` update for the `: connected` comment frame. Gate criterion unchanged: "no new failures beyond the known env-only set" (the 3 ambient-config learning-observer tests pass on a clean `HARNESS_HOME` / in CI; the e2e + close-out runs were clean). Existing `tests/server/*` (turns, gateway e2e, reconnect, drive) still pass.
- **Lint + typecheck** — clean (`biome check` 644 files; `tsc --noEmit`).
- **Go suite** — unchanged by this phase (no `packages/tui/` change).
- **Real-browser e2e** — Playwright against a live gateway + real model, 3 legs PASS (above). Logged in `docs/testing-log.md`.

## Notes

- **No bundle changes** — the Phase-C surface is entirely in `src/` (`server/webui.html`, `server/webui.ts`, `server/app.ts`, `server/routes/events.ts`), `tests/`, and `docs/`. No `packages/tui/` change, no `bundle-default/` change.
- **Default surfaces unchanged.** The default `sov` (TUI), `sov serve` (OpenAI API), and `sov drive` (headless) experiences are byte-identical; the web UI is an additive open route + an embedded asset served by the same `buildAppWithRuntime` every native server already uses.
- **Engine-agnostic by construction.** The client sits above the HTTP+SSE protocol seam (`src/server/schema.ts` + the routes), never the runtime's internals — so it survives a future agent-core swap, exactly like the rest of the gateway program. **The protocol is the seam.**
- **Learning-loop soak continues in parallel — untouched.** Recall is still **ON by default** (`learning.recall.enabled`, since v0.6.16) and capture + synthesis stay on; Phase C did not disable recall or learning (a roadmap execution requirement — the learning layer rides above the protocol seam unchanged). The `## ⚠️ ACTIVE FOCUS — Learning-loop soak` banner in `CLAUDE.md`/`AGENTS.md` stays the standing #1 focus; this gateway phase is a separate, parallel track.

## Known Phase-D item (still pending — carried from Phase B)

**Interactive-session buses accumulate until shutdown.** Phase B disposes a session's bus on session disposal and reclaims all buses at full shutdown, but a long-lived gateway with many never-disposed interactive sessions accumulates one bus per session for the process lifetime. **Per-session memory is bounded by the ring** (`eventBufferSize` events/session), so this is a bounded leak, not an unbounded one — but the count of live buses is not capped. **Idle/TTL eviction or an explicit `DELETE /sessions/:id`** is the persistent supervisor's job — **Phase D** (M3), which owns session lifecycle (create/resume/evict). Carried forward, not solved in Phase C (the reference UI is a client; lifecycle ownership is the supervisor's).

## Cross-repo record-keeping (flag for a docs-repo session)

The roadmap + decision record are canonical in `~/code/sovereign-ai-docs` and this repo can't commit there. A docs-repo session should reflect **Phase C shipped (v0.6.20)** against the multi-channel-gateway differentiator (ADR H-0010) and the run-anywhere program tracker (A + B + C done; D–F remain).

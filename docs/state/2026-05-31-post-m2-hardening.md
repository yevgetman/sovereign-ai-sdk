# State of the build — post-M2 hardening run (v0.6.1 → v0.6.13)

**HEAD:** `bb8240e` (release bump `0.6.12 -> 0.6.13`). **Latest release:** v0.6.13.

**Predecessor:** [`docs/state/2026-05-25-phase-21-m2.md`](2026-05-25-phase-21-m2.md) (Phase 21 M2 — release automation, v0.6.0).

## What this snapshot is

A **hardening / UX-polish run, not a new phase.** No phase opened or closed between Phase 21 M2 (2026-05-25, v0.6.0) and now. 57 commits and 13 patch releases (v0.6.1 → v0.6.13) shipped through the M2 CI tag-push pipeline — which doubled as ongoing validation that the automation works end-to-end. This file exists so `ls docs/state/*.md | sort -r | head -1` surfaces the real runtime tip (v0.6.13) rather than the v0.6.0 M2 snapshot.

**Open backlog unchanged in spirit:** #17 (eval-gated auto-promote, P4) remains the sole product backlog item; this sweep added #49 (Node-20 GitHub Actions deprecation, P3 — a CI-maintenance follow-up, see backlog).

## What shipped (v0.6.1 → v0.6.13), grouped

- **TUI global style guide + routing-color fix (v0.6.3 → v0.6.4).** New `packages/tui/internal/style/style.go` (`style.S.*`) layer separating immutable layout/spacing/glyph/brand-color tokens from theme-switchable colors (`bf38e92`, v0.6.4) — now a HARD rule (see `docs/conventions/tui-style-guide.md`). The same morning replaced `t.Primary` "basic blue" with the fixed sky-300 `#7dd3fc` in delegator/routing output (`6bff455`, v0.6.3).
- **UX fix rounds + end-of-turn gap tuning (v0.6.5 → v0.6.8).** Screenshot-driven fixes (user-echo spacing, live task-router status bar, turn-separator breathing room via `Separator.TrailingGap` / `Echo.TrailingGap`, trailing-newline-after-markdown).
- **Visual TUI QA / VHS loop (v0.6.9 → v0.6.10) — new capability.** Agent-driven screenshot harness: `bun run visual [name]` drives `sov-tui` under VHS+ttyd and writes PNGs the agent can `Read`. Multi-screenshot scenarios (tool/edit/permission scenes), Terminal.app color calibration. Convention: `docs/conventions/visual-tui-qa.md`.
- **Deep bug-hunt audit (v0.6.12, 2026-05-28).** Conservative whole-codebase audit (14 subsystem finders → 2 adversarial verifiers per candidate) surfaced **21 objective, function-breaking bugs** (1 critical / 11 high / 8 medium / 1 low); all fixed test-first across 18 atomic commits (`eaee313..0400255`). Touched core (`tool.validateInput` wired into dispatch — revived WebFetch's dead SSRF guard), tools (Glob ordering, WebFetch SSRF), permissions (shell output-redirect treated as a write), providers (Anthropic error normalization, openai/openrouter token-usage reporting), cron (tick lock), daemon (EPERM lock-holder), persistence (`writeWithRetry`), openai (streaming-bus disposal), context (`@file`/`@folder` never throw), skills (verbatim arg insert), eval (callIndex correlation), server (404 a turn to a nonexistent session), config (profile-name validation), review (multi-line round-trip), TUI (SSE scanner cap, SSE reconnect on `/clear`/`/rollback` session pivot).
- **Markdown heading color (v0.6.13, 2026-05-29).** `Brand.HeadingColor` sky-200 `#bae6fd` → sky-100 `#e0f2fe` so markdown headings read as clearly lighter than the sky-300 `#7dd3fc` bold/inline-code emphasis. Theme-independent fixed hex. From an annotated-screenshot UX report; root cause of the report itself was a stale `sov-tui` Go binary (see `docs/conventions/tui-color-rendering.md` diagnostic).

## Tests

- **TS suite ~2660 tests** — ~2646 pass in a clean CI env / 14 skip. 3 server learning-observer tests (`turns.learning` M7 T5, `m7Full`, `m8Full`) fail only under this machine's ambient `~/.harness/config.json` (`learning.disabled`); they pass in CI and on a clean `HARNESS_HOME`. Gate criterion: "no new failures beyond that known set." (Grew from the M2 baseline of 2558, mostly from the bug-hunt's per-fix regression tests + style-guide/visual Go tests.)
- **Go suite** — all packages green (style snapshot, render, transport, app, components).

## Notes

- No bundle changes across the run (surface entirely in `src/`, `tests/`, `packages/tui/`, `docs/`).
- No new ADRs — the run is fixes + a brand-color token change, all decisions captured in commit messages, the testing log, and `docs/conventions/tui-color-rendering.md`.
- **2026-05-31 — doc-consistency sweep (this snapshot).** Brought the living docs current with v0.6.13: re-pointed README + CLAUDE.md/AGENTS.md boot to this file, closed backlog #48 framing, fixed the user-marker glyph (`»`→`❯`) + heading color (`sky-200`→`sky-100`) + removed-surface (`--ui`/REPL-fallback) references in conventions, refreshed the usage themes/config sections, and added an architecture Cron section. No runtime change.
</content>
</invoke>

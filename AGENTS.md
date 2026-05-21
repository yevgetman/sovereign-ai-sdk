# Instructions for Claude Code sessions developing this repo

You are working on the **Sovereign AI agent runtime** — TypeScript code, not documents. This repo is a Claude-Code-style harness (per ADR H-0003 in the sister `sovereign-ai-docs` repo) that reads a *harness bundle* (the docs repo, or a client's extracted bundle) and drives an LLM conversation against it.

Business context lives in `~/code/sovereign-ai-docs/`. This repo contains code and code conventions only.

This file is a **lean index** — a table of contents into the deeper docs. Read only what your current task requires. Don't try to load it all at boot.

## Session boot

1. **This file** (`CLAUDE.md`) — index and standing rules
2. **`README.md`** — repo intro, install, layout
3. **`docs/state/2026-05-21-ux-fixes-r5.md`** — most recent close-out snapshot (ux-fixes rounds 3-5 shipped 2026-05-21 — **inline-mode refactor: dropped `tea.WithAltScreen()` and mouse capture so the terminal owns scrollback (wheel + trackpad scroll) and text selection natively.** All committed history flows via `tea.Println` into terminal scrollback; the in-TUI View() shrinks to a bottom-anchored live region (streaming card + spinner + running-command indicator) plus prompt + status footer. New `LiveRegion` component at `packages/tui/internal/components/liveregion.go`. Round 3 also fixed textbox auto-grow (textarea), splash polish, spinner alignment, markdown bullet + table wrap. Round 4 added paste abstraction (`[Pasted text #N +M lines]`), ESC turn-cancel (POST `/sessions/:id/cancel`), prompt prefix first-line-only. Round 5 dropped the round-4 PgUp scroll bindings (terminal owns scroll), tool-card click-to-expand (cards print fully expanded), and the round-3 `--mouse` opt-in. Suite **1955/1955** TS green; Go all packages green; lint+typecheck clean. Phase 16.1 stays closed.) Predecessor: `docs/state/2026-05-20-m13.md` (Phase 16.1 M13 close-out — terminalRepl removal complete, Phase 16.1 closed). Read this BEFORE the build plan. Replaced each session — find the latest via `ls docs/state/*.md | sort -r | head -1`. The M11 audit report at `docs/state/2026-05-17-m11-parity-audit.md` and the M10 audit at `docs/state/2026-05-16-tui-parity-audit.md` both remain canonical.
4. **`docs/backlog/post-phase-13-4.md`** — open backlog items not in the canonical build plan.
5. **`~/code/sovereign-ai-docs/harness/docs/runtime/runtime-scaffold-plan.md`** — Phase-0/1 scaffold contract this repo was seeded against.
6. **`~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md`** — canonical remaining phased plan.
7. **`~/code/sovereign-ai-docs/harness/docs/reference/agent-harness-design-lessons.md`** — unifying design principles and Claude Code reference lessons.

`~/code/claude-code/src/` is the architectural reference. Look up specific patterns there when a design question comes up.

## Doc index

Each link is a chapter loaded on demand. Don't pre-read.

### Standing rules — operating conventions

| File | When to read |
|---|---|
| [`docs/conventions/lint-and-commit.md`](docs/conventions/lint-and-commit.md) | Before any commit — `lint`, `typecheck`, `test` all required; atomic commits; push autonomously |
| [`docs/conventions/sov-upgrade.md`](docs/conventions/sov-upgrade.md) | After any `src/` or `bundle-default/` or `packages/tui/` change — keep global binary current |
| [`docs/conventions/testing-log.md`](docs/conventions/testing-log.md) | Before testing — append-only log obligation |
| [`docs/conventions/semantic-tests.md`](docs/conventions/semantic-tests.md) | When triaging whether to run `bun run test:semantic` |
| [`docs/conventions/subagent-policy.md`](docs/conventions/subagent-policy.md) | Before dispatching any subagent — HARD RULE on Opus / Sonnet / never-Haiku |
| [`docs/conventions/estimation.md`](docs/conventions/estimation.md) | Before quoting effort/timeline — sessions/dispatches/wall-minutes, never weeks |
| [`docs/conventions/repo-layout.md`](docs/conventions/repo-layout.md) | Before adding files in `src/`, naming a plan/spec, or moving things |
| [`docs/conventions/tui-color-rendering.md`](docs/conventions/tui-color-rendering.md) | Before adjusting any text color in `packages/tui/` — body text MUST inherit terminal default; never assume a "bright" hex/ANSI value renders bright |
| [`docs/conventions/tui-ux-patterns.md`](docs/conventions/tui-ux-patterns.md) | Before changing TUI layout, chrome, or visual behavior — flow layout, splash, spinner, separator, tool events, file-ref auto-wrap, prompt/status styling |

### Design reference

| File | What's in it |
|---|---|
| [`docs/design-principles.md`](docs/design-principles.md) | The 9 locked design principles. Don't relitigate. |
| [`docs/architecture.md`](docs/architecture.md) | Current runtime flow — request lifecycle, system prompt, tools, permissions, persistence, sub-agents, microcompaction, REPL UX layers, learning + review pipelines, trajectory capture |
| [`docs/usage.md`](docs/usage.md) | Day-to-day operation — CLI flags, subcommands, slash commands, eval suite, local-model router, profiles, providers, themes, web tools |
| [`docs/extending.md`](docs/extending.md) | Recipes for adding extension points — tools, providers, slash commands, skills, hooks, MCP servers, agents, permission rules, trajectory redaction |
| [`docs/semantic-testing.md`](docs/semantic-testing.md) | Semantic test framework — judge backends, suites, coverage inventory |

### Current state

| File | What's in it |
|---|---|
| [`docs/state/2026-05-21-ux-fixes-r5.md`](docs/state/2026-05-21-ux-fixes-r5.md) | **Canonical current-state snapshot — ux-fixes rounds 3-5 shipped 2026-05-21.** Round 5 is the architectural pivot: drop `tea.WithAltScreen()` + mouse capture → terminal owns scrollback (wheel + trackpad scroll) and text selection natively. Committed history flows via `tea.Println`; View() is just a bottom live region (`LiveRegion` at `packages/tui/internal/components/liveregion.go`) + prompt + status. Round 3 fixed textbox auto-grow / splash polish / spinner alignment / markdown wrap. Round 4 added paste abstraction (`[Pasted text #N +M lines]`) + ESC turn-cancel (POST `/sessions/:id/cancel`) + prompt prefix first-line-only. TS suite green at **1955/1955**; Go all packages green; lint+typecheck clean. Phase 16.1 stays closed; backlog at **2 items** (#17 P4 + new #47 P4 transcript.go cleanup). |
| [`docs/state/2026-05-20-m13.md`](docs/state/2026-05-20-m13.md) | Prior M13 close-out snapshot — **Phase 16.1 M13 shipped; Phase 16.1 closed.** terminalRepl removal complete: deleted `src/ui/terminalRepl.ts` (2334 LoC) + 9 REPL-only `src/ui/*` modules + their tests + M12 deprecation infra + M11 surface resolver + readline asker bits from `permissions/prompt.ts`. Dropped `--ui` flag + `SOV_UI` env + `ui.surface` config field. main.ts boot flow collapsed ~65 → ~13 lines. Missing binary = hard error (no fallback surface). **4 ADRs M13-01..04; suite green at 1949/1949**; 4/4 smoke pass; 4-Opus parity audit clean. |
| [`docs/state/2026-05-20-m13-smoke/`](docs/state/2026-05-20-m13-smoke/) | M13 smoke output — 4 boot-decision scenarios (default-TUI boot / missing-binary hard error / Commander rejects unknown `--ui` flag / `sov dispatch` headless round-trip). |
| [`docs/state/2026-05-19-m12.md`](docs/state/2026-05-19-m12.md) | Prior M12 close-out — Phase 16.1 M12 shipped (REPL deprecation warning: stderr line on explicit `--ui repl` / `SOV_UI=repl` / `ui.surface=repl`; silent on missing-binary fallback; `SOV_NO_DEPRECATION_WARNING=1` suppresses; **2 ADRs M12-01..02; suite green at 2073/2073**; 6/6 boot smoke pass). |
| [`docs/state/2026-05-19-m12-smoke/`](docs/state/2026-05-19-m12-smoke/) | M12 smoke output — 6 boot-decision scenarios asserting deprecation presence/absence across opt-in sources, suppression flag, missing-binary fallback, default-TUI. |
| [`docs/state/2026-05-19-m11-5.md`](docs/state/2026-05-19-m11-5.md) | Prior M11.5 close-out — Phase 16.1 M11.5 shipped (inline picker card: `pickerOpen` side-effect protocol; new `PickerCard` Go component; `/model`, `/resume`, `/export` migrated; T8 spacing fix; **3 ADRs M11.5-01..03; suite green at 2061/2061**; real-Anthropic smoke 2/2 pass). |
| [`docs/state/2026-05-19-m11-5-smoke/`](docs/state/2026-05-19-m11-5-smoke/) | M11.5 smoke output — 2 real-Anthropic picker round-trip scenarios + README summary. |
| [`docs/state/2026-05-17-m11.md`](docs/state/2026-05-17-m11.md) | Prior M11 close-out — Phase 16.1 M11 shipped (default-flip: `--ui` defaults to `'tui'`; new surface resolver with CLI > env > config > default precedence; auto-fallback to REPL when sov-tui missing; **3 ADRs M11-01..03; suite green at 2033/2033**; audit PASS-with-followups). |
| [`docs/state/2026-05-17-m11-parity-audit.md`](docs/state/2026-05-17-m11-parity-audit.md) | The M11 audit report — Opus subagent re-audit per Postmortem Rule 3 verifying M10 HIGH gaps remain closed and M11 code surface introduces no new HIGH/CRITICAL/MEDIUM gaps. PASS-with-followups (1 LOW fixed inline). |
| [`docs/state/2026-05-17-m11-smoke/`](docs/state/2026-05-17-m11-smoke/) | M11 smoke output — 13 boot-decision scenarios (`run-smoke.ts`) + 1 real-Anthropic dispatcher rerun + README summary. |
| [`docs/state/2026-05-16-m10-5.md`](docs/state/2026-05-16-m10-5.md) | Prior M10.5 close-out (predecessor to M11): slash-command dispatcher route + Go TUI slash router; closed #40; unblocked M11. |
| [`docs/state/2026-05-16-m10.md`](docs/state/2026-05-16-m10.md) | M10 close-out: parity audit by 4 parallel Opus subagents; 2 HIGH gaps fixed inline (HarnessInfoTool + repair-missing-tool-results); 1 HIGH scope-bounded (mission CLI-only); 1 HIGH deferred (closed by M10.5); 4 ADRs M10-01..04. |
| [`docs/state/2026-05-16-tui-parity-audit.md`](docs/state/2026-05-16-tui-parity-audit.md) | The M10 audit report itself — slice-by-slice findings, severity classification, fixes-applied, M11 disposition. Postmortem Rule 3 attestation. |
| [`docs/state/archive/`](docs/state/archive/) | Historical snapshots: `2026-05-07.md` (Phase 13.4), `2026-05-11.md` (Phase 16.0a), `2026-05-12.md` (Phase 16 revert), `2026-05-13.md` (Phase 16.1 M0–M3), `2026-05-14.md` (Phase 16.1 M4 + M5 + M5.1), `2026-05-14-pm.md` (Phase 16.1 M6 close-out + 2026-05-15 hardening + autonomous M6 smoke + PM #32/#37), `2026-05-15.md` (Phase 16.1 M7 close-out + post-close-out hardening + autonomous M7 smoke), `2026-05-16.md` (Phase 16.1 M8 close-out), `2026-05-16-m9.md` (Phase 16.1 M9 close-out), `2026-05-16-m9-5.md` (Phase 16.1 M9.5 close-out), `2026-05-16.md` again (Phase 16.1 M9.6 close-out). |

### Forward-looking

| File | What's in it |
|---|---|
| [`docs/backlog/post-phase-13-4.md`](docs/backlog/post-phase-13-4.md) | Open backlog (1 item): **#17 eval-gated auto-promote (P4, conditional)**. #40 closed M10.5; #41 + #43 + #44 + #45 + #46 closed 2026-05-19; #29 / #38 / #39 closed 2026-05-19 (audit + small inline fix). **Phase 16.1 closed with M13 (2026-05-20).** |
| [`docs/backlog/phase-16-rebuild-prereqs.md`](docs/backlog/phase-16-rebuild-prereqs.md) | 24 subsystems any Phase 16.1 foreground refactor must re-wire — **24/24 complete after M8; M9 visual polish landed 2026-05-16; M10 audit verified independently with caveat that slash-command-stack composition (#40) was not covered by the original prereq methodology** |
| [`docs/specs/2026-05-13-phase-16-1-tui-rebuild-design.md`](docs/specs/2026-05-13-phase-16-1-tui-rebuild-design.md) | Active design spec for the Phase 16.1 TUI rebuild |
| [`docs/specs/2026-05-13-production-harness-roadmap-design.md`](docs/specs/2026-05-13-production-harness-roadmap-design.md) | Umbrella production polish roadmap |
| [`docs/specs/2026-05-16-phase-16-1-m10-parity-audit-design.md`](docs/specs/2026-05-16-phase-16-1-m10-parity-audit-design.md) | M10 audit design spec |
| [`docs/specs/2026-05-16-phase-16-1-m10-5-slash-dispatcher-design.md`](docs/specs/2026-05-16-phase-16-1-m10-5-slash-dispatcher-design.md) | M10.5 slash-dispatcher design spec |
| [`docs/specs/2026-05-17-phase-16-1-m11-default-flip-design.md`](docs/specs/2026-05-17-phase-16-1-m11-default-flip-design.md) | M11 default-flip design spec |
| [`docs/specs/2026-05-19-phase-16-1-m11-5-inline-picker-card-design.md`](docs/specs/2026-05-19-phase-16-1-m11-5-inline-picker-card-design.md) | M11.5 inline picker card design spec |
| [`docs/specs/2026-05-19-phase-16-1-m12-repl-deprecation-design.md`](docs/specs/2026-05-19-phase-16-1-m12-repl-deprecation-design.md) | M12 REPL deprecation design spec |
| [`docs/specs/2026-05-19-phase-16-1-m13-terminalrepl-removal-design.md`](docs/specs/2026-05-19-phase-16-1-m13-terminalrepl-removal-design.md) | M13 terminalRepl removal design spec (just shipped — Phase 16.1 closed) |
| [`docs/specs/2026-05-21-binary-distribution-design.md`](docs/specs/2026-05-21-binary-distribution-design.md) | Phase 21 binary distribution design — `bun build --compile` + Go cross-compile + public `sov-releases` repo + one-line installer script; M1 manual pipeline, M2 GitHub Actions automation |
| [`docs/plans/`](docs/plans/) | Implementation plans (executed; left as record). Latest: `2026-05-19-phase-16-1-m13-terminalrepl-removal.md` |

### Postmortems — required reading before similar work

| File | When to read |
|---|---|
| [`docs/postmortems/2026-05-12-phase-16-revert.md`](docs/postmortems/2026-05-12-phase-16-revert.md) | **Before any future foreground-surface refactor.** Rules 1–4. |
| [`docs/postmortems/loop-detector-orphaned-tool-use.md`](docs/postmortems/loop-detector-orphaned-tool-use.md) | When debugging tool_use/tool_result lifecycle bugs |

### Operational log

| File | What's in it |
|---|---|
| [`docs/testing-log.md`](docs/testing-log.md) | Append-only testing log (newest-first). Per the testing-log rule, every testing pass must be logged here |

### Source-adjacent

A few `src/` and `bundle-default/` subdirectories carry their own README — `src/bundle/README.md`, `src/learning/README.md` — for surface-specific context that doesn't belong in the top-level docs.

## Hard rules

These apply every session and override defaults:

- **Subagent model policy** — Opus 4.7 default; Sonnet 4.6 only for trivially mechanical fully-specified tasks; **never Haiku**. Details: [`docs/conventions/subagent-policy.md`](docs/conventions/subagent-policy.md).
- **Pre-commit gate** — `bun run lint && bun run typecheck && bun run test`. All three. Details: [`docs/conventions/lint-and-commit.md`](docs/conventions/lint-and-commit.md).
- **Atomic commits + autonomous push** — one logical change per commit; push `origin/master` without asking. Same rule as the docs repo.
- **`sov upgrade` after runtime changes** — any `src/`, `bundle-default/`, or `packages/tui/` change. Details: [`docs/conventions/sov-upgrade.md`](docs/conventions/sov-upgrade.md).
- **Testing log obligation** — append to `docs/testing-log.md` for every testing pass. Details: [`docs/conventions/testing-log.md`](docs/conventions/testing-log.md).
- **No week-based estimates** — sessions / dispatches / wall-minutes only. Details: [`docs/conventions/estimation.md`](docs/conventions/estimation.md).
- **Plans and specs paths** — `docs/plans/YYYY-MM-DD-<feature>.md`, `docs/specs/YYYY-MM-DD-<topic>-design.md`. Never `docs/superpowers/`.
- **AGENTS.md ≡ CLAUDE.md** — byte-identical mirror. Verify with `diff` before commit.

## Don't

- Don't relitigate the 9 locked design principles ([`docs/design-principles.md`](docs/design-principles.md)).
- Don't put product-specific content under `src/` — Sovereign-AI-specific content belongs in the bundle.
- Don't delete empty `src/` subdirectories — they mark phase landing zones.
- Don't bypass the pre-commit gate with `--no-verify` unless you can name why.
- Don't dump content into `CLAUDE.md` — extend a conventions file and link to it.

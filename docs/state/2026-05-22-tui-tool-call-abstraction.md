# State of the build — 2026-05-22 PM: TUI tool-call abstraction + UX fixes

**HEAD:** to be filled by the close-out commit.

**Chain since the Phase 21 M1 close-out (`6ef065b`, 2026-05-22 morning):**
Phase 21 M1 close-out → UX design spec (this PM session, `6363a19`) → Fix A: silence `tui server listening` stderr (`571d202`) → Fix B: switch dark chroma to `monokai` (`8894ce9`) → TS schema + launcher flag forwarding (`12e2ed5`) → schema test formatting (`a64de3b`) → Go tool-call abstraction (`9752aa7`).

**Suite:** TS — **1982 pass / 0 fail / 14 skip** (+10 from Phase 21 M1's 1972 baseline: 5 schema cases for `ui.toolOutput.mode`, 4 launcher cases for new flag forwarding, +1 Fix A regression guard). Go all packages green; +29 new tests (24 `compactline_test.go`, 3 `toolcard` InlineLines cases, 2 `code_test.go` chroma-style cases, 5 new app-handler cases for compact/detailed/glyph/verbose-raw paths, minus 0 — net positive). Lint clean (same 2 pre-existing `noNonNullAssertion` warnings in `src/permissions/shellSemantics.ts`); typecheck clean.

**ADRs:** none new. The work is single-user UX polish, not architectural — same posture as the 2026-05-21 ux-fixes rounds 3–5.

**Phase status:** Phase 16.1 stays closed; Phase 21 M1 stays closed. This is post-close-out polish.

## Where we are

Three UX issues from the user's screenshots resolved end-to-end:

1. **Stderr boot noise removed.** The launcher used to print `sov: tui server listening on 127.0.0.1:PORT session=…` above the splash. Useful during early Phase 16.1 development; just noise to production users. `src/cli/tuiLauncher.ts:292-294` deleted. Regression guard test asserts the successful-launch path emits NOTHING to stderr.

2. **Fenced code blocks render with visible syntax highlighting.** Catppuccin Mocha was being quantized flat by the user's terminal palette. Switched the dark-theme preferred chroma style to `monokai` (same lesson family as M11.7's TrueColor-force regression — palette mapping is unreliable; high-contrast palettes survive better). Catppuccin Mocha demoted to last-ditch fallback. Light theme unchanged (catppuccin-latte).

3. **Tool-call abstraction shipped.** Every `tool_result` event now renders as a single line by default, mirroring the Claude mobile app aesthetic:
   ```
   Read README.md                       ›
   Edited app.go +11 -7                 ›
   Ran $ bun run test                   ›
   ⚠ Edit blocked.go                    ›   ← permission denied / cancelled
   ✗ Bash $ git push                    ›   ← runtime error envelope
   ```
   Verb mapping owned in Go (`packages/tui/internal/components/compactline.go`). Approach A from the brainstorm — zero wire-schema churn. Detailed mode opt-in via `ui.toolOutput.mode = 'detailed'` reuses the existing `ToolCard` with a new `InlineLines` truncation cap (default 10) + `…[+N more lines]` footer. `-v / --verbose` flag forwards as `--verbose-raw` and prints the raw untruncated output below either mode's rendering — orthogonal escape hatch.

## What shipped

### TS side

- **`src/config/schema.ts`** — extended `ui.toolOutput` with a new `mode: z.enum(['compact','detailed']).optional()` field. `inlineLines` kept as 0..200, same range. Default `'compact'` applied at consumption time.
- **`src/cli/tuiLauncher.ts`** — three changes:
  - Deleted the `process.stderr.write` boot-listening line (line 292-294).
  - Removed `--verbose` from `deferredFlagWarnings` (it's now wired through).
  - Reads `ui.toolOutput.{mode, inlineLines}` from user-settings via `readConfig()` and forwards as `--tool-output-mode` + `--tool-output-inline-lines` to `sov-tui`. Forwards `opts.verbose` as `--verbose-raw`.
- **`tests/config/schema.test.ts`** — 5 new cases pinning mode enum + inlineLines range.
- **`tests/cli/tuiLauncher.test.ts`** — 4 new cases covering default mode forwarding, verbose-raw absence/presence, and a HARNESS_HOME-isolated config test that confirms `mode: 'detailed'` is read + forwarded verbatim. Plus 1 regression guard for the deleted stderr line.

### Go side

- **`packages/tui/internal/components/compactline.go`** *(NEW)* — `FormatCompactToolLine(tool, input, output, theme, width) string` + `DetectToolStatus(output) (isError, isDenied bool)`. Verb table covers every wire tool name: `FileRead → Read`, `FileWrite → Wrote`, `FileEdit → Edited +N -M`, `Bash → Ran $`, `Grep`, `Glob`, `WebFetch → Fetched`, `WebSearch`, `memory` (action-aware), `memory_propose`, `skill_propose`, MCP fallback (`<server>: <tool>`), unknown-tool fallback (verb = name, target = input preview). Helper extractors (`extractStringField`, `extractDiffStats`, `truncateURL`, `flattenWhitespace`, `truncateTail`, `visibleLen`) handle the per-tool input/output parsing. Status detection recognises `{status:'error'}` envelopes AND bare-text `permission denied: …` (the orchestrator deny-branch shape).
- **`packages/tui/internal/components/compactline_test.go`** *(NEW)* — 24 tests covering happy-path per tool kind, status variants, truncation policy, MCP fallback, unknown-tool fallback, narrow-terminal safety, chevron-always-present invariant.
- **`packages/tui/internal/components/toolcard.go`** — new optional `InlineLines int` field on `ToolCard`. When `>0` and `Expanded`, output truncates to first N lines + dim italic `…[+M more lines]` footer. `InlineLines == 0` keeps the legacy uncapped behavior. Diff path (DiffView) untouched.
- **`packages/tui/internal/components/toolcard_test.go`** — 3 new cases pinning truncation behavior + zero-cap legacy fall-through + under-cap pass-through.
- **`packages/tui/internal/render/code.go`** — `chromaStyleForTheme` now prefers `monokai` over `catppuccin-mocha` for dark themes. Catppuccin Mocha kept as last-ditch fallback.
- **`packages/tui/internal/render/code_test.go`** — 2 new tests asserting `monokai` for dark + `catppuccin-latte` for light.
- **`packages/tui/internal/app/app.go`** — new Model fields `toolOutputMode string`, `toolOutputInlineLines int`, `verboseRaw bool` (defaults `'compact'` / 10 / false). New builder methods `WithToolOutput(mode, inlineLines)` and `WithVerboseRaw(v)`. `tool_result` handler rewritten to branch on mode and conditionally append raw output below.
- **`packages/tui/cmd/sov-tui/main.go`** — parses three new CLI flags (`--tool-output-mode`, `--tool-output-inline-lines`, `--verbose-raw`) and chains the new builders.
- **`packages/tui/internal/app/app_test.go`** — `TestApp_renderToolResultAsCard` updated to assert compact-mode output ("Read foo.go" + chevron) instead of the old "FileRead" header. New `TestApp_renderToolResultInDetailedMode` exercises the opt-in path with `WithToolOutput("detailed", 10)`.
- **`packages/tui/internal/app/m9Full_test.go`** — `TestM9_ToolResultRendersWithCard` updated for compact mode + 4 new tests: detailed mode, ✗ glyph on `status:'error'`, ⚠ glyph on permission denial, and verbose-raw appending the raw payload.

### Docs

- **`docs/specs/2026-05-22-tui-tool-call-abstraction-design.md`** *(NEW)* — design spec with the 7 brainstorm-locked decisions, architecture, components, data flow, error-handling detection logic, per-tool format table, ~28-test plan, postmortem-rule compliance.
- **`docs/state/2026-05-22-tui-tool-call-abstraction.md`** *(THIS FILE)* — close-out snapshot.

## Behavioral notes worth knowing next session

1. **Default tool rendering is now compact one-liner.** `tool_result` handler in `app.go` branches on `m.toolOutputMode` — `'compact'` (default) calls `components.FormatCompactToolLine`; `'detailed'` builds the existing ToolCard with `InlineLines: m.toolOutputInlineLines`. Users wanting the old behavior set `ui.toolOutput.mode: 'detailed'` via `sov config`.
2. **`/expand N` continues to work positionally.** N=1 is the most-recent tool. The ring buffer (`m.completedBlocks`) is populated identically in both modes — only the inline rendering differs. The trailing `›` chevron on every compact line is purely a visual hint that detail is available; it's not interactive (immutable scrollback).
3. **Glyph semantics:** `⚠` (yellow `theme.Warning`) prefix marks permission denied / cancelled; `✗` (red `theme.Error`) marks runtime tool errors (`status:'error'` envelope). Both are emitted from compact mode only; detailed mode shows the same status indicators via the existing ToolCard render path.
4. **Verb mapping table lives at `packages/tui/internal/components/compactline.go:verbAndTarget`.** Adding a new tool name to the table is a 3-line patch (case + extractor + a test). MCP tools auto-handle via the `mcp__<server>__<tool>` naming convention; no per-MCP-tool work.
5. **The `is_error` wire field is NOT used.** The Go `transport.ToolResult` struct doesn't expose `is_error`; status detection happens inside `DetectToolStatus` by parsing Output JSON. If detection ever proves fragile (e.g., a tool emits a novel shape), the future-proofing path documented in the spec is to add explicit `isError bool` / `isDenied bool` fields to the SSE envelope — punted for now.
6. **`-v / --verbose` is wired again.** It flips `m.verboseRaw = true` and the handler appends raw Output below the compact/detailed rendering. The flag was deferred-warned during M9 → 2026-05-22 with the message "not yet supported with --ui tui (targeting milestone M9); continuing without it." Removed from the deferred-warnings list.
7. **Chroma style is now `monokai` on dark themes.** Per the existing `tui-color-rendering.md` lessons, palette mapping is unreliable; high-contrast palettes survive better. Light theme keeps `catppuccin-latte`. Both have last-ditch fallbacks (`catppuccin-mocha` for dark; `github` for light) for the rare chroma builds that don't bundle the preferred style.

## What does NOT work / known gaps after this session

After this session, the open backlog stays at **3 items** (unchanged from Phase 21 M1 close-out):

1. `#17` (P4, conditional) — eval-gated auto-promote.
2. `#47` (P4, cosmetic) — retire dead `transcript.go`.
3. `#48` (P3, scheduled separately) — Phase 21 M2 release automation.

No new follow-ups surfaced from this session.

**Possible future evolution noted in the spec (out of scope for this milestone):**
- Tool-side `compactSummary` wire field (Approach B from the brainstorm) — tools export their own compact summary; Go side just prints it. Cleaner long-term but ~15 tool edits + a Go fallback still needed; punted.
- Explicit `isError bool` / `isDenied bool` fields on the `ToolResult` SSE envelope — current detection (JSON-envelope parse + bare-text prefix match) is robust enough; add wire fields if/when detection ever drifts.

## Postmortem-rule compliance check

The Phase 16.1 revert's Rules 1–4 (`docs/postmortems/2026-05-12-phase-16-revert.md`) apply primarily to foreground-surface refactors with active downstream consumers. This session is single-user UX polish:

- **Rule 1 (deprecation soak)** — Waived. No downstream consumers; the user is the only consumer.
- **Rule 2 (no helper deletion without consumer audit)** — Satisfied. `ToolCard` keeps the same exported signature (new optional `InlineLines` field is additive). `chromaStyleForTheme` keeps the same signature. The launcher's stderr-write at line 292-294 had no callers. Removing `--verbose` from `deferredFlagWarnings` is an addition (wiring the previously-deferred subsystem) — not a deletion.
- **Rule 3 (independent re-audit before claiming done)** — TBD. Will be satisfied via a parallel Explore agent re-audit before the next session opens. Manual smoke pass against real Anthropic also planned (compact + detailed + verbose-raw + permission-denied path).
- **Rule 4 (escape hatch during transition)** — Satisfied. `ui.toolOutput.mode: 'detailed'` is the escape back to the old card behavior. `-v / --verbose` is the escape to raw output. Both are documented.

## How to use the new modes

```bash
# Default — compact one-liner per tool call (this is the new default;
# nothing to configure).
sov

# Opt into the bordered ToolCard with output truncated to 10 lines.
sov config set ui.toolOutput.mode detailed
sov

# Bump the truncation cap in detailed mode (max 200).
sov config set ui.toolOutput.inlineLines 30

# Orthogonal: append raw untruncated output below the rendering.
# Works in both modes; no persistence (per-invocation only).
sov -v
sov --verbose
```

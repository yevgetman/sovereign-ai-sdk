# Phase 16.1 M9.5 — Theme Polish · Design Spec

Status: **draft** — written 2026-05-16, ready for implementation plan
Supersedes: nothing (refines M9's ADR M9-03 deferral of the TOML loader)
Authority: enforces Rules 1–4 of `docs/07-history/postmortems/2026-05-12-phase-16-revert.md`

---

## 1. Purpose

Complete the theme system started in M9 T1. M9 shipped 2 built-in palettes (Catppuccin Mocha + Latte) with constructor injection, no global, no persistence, no TOML loader. M9.5 closes the three remaining gaps from that work: it adds a TOML loader so users can ship their own themes from `~/.harness/themes/*.toml`, adds 2 more bundled palettes (Tokyo Night Storm + a new Sovereign brand-aligned palette), and adds boot-time + write-time persistence so `/theme <name>` survives a restart.

Out of scope per the user-confirmed M9.5 narrowing: mouse click handling, `--no-mouse` opt-out flag, `stall_detected` visual badge, `/skills reload` slash, autocomplete cache invalidation on `compaction_complete`, real-Anthropic visual smoke. Those tracked for a later cleanup pass (M9.6 or similar).

## 2. Goal

When M9.5 completes:

1. **TOML loader.** `~/.harness/themes/<name>.toml` files load via `LoadFromFile(name, dir)`. Schema is flat snake_case; partial files fall back to `Dark()` palette per missing field.
2. **Four built-in palettes** total: `dark` (Catppuccin Mocha — default), `light` (Catppuccin Latte), `tokyo-night` (Tokyo Night Storm), `sovereign` (cool slate + cyan, AI-tooling aesthetic).
3. **Persistence.** `~/.harness/config.json` `theme` field is read at app boot and written synchronously on every `/theme <name>` switch. Best-effort write — log on failure, don't block UX.
4. **Precedence.** Built-ins always win by name. TOML can't override a built-in; user-custom themes must be named something else (e.g., `dark-custom.toml`).
5. **Integration smoke.** Round-trip test: write a TOML file → boot model with config pointing at it → assert loaded theme matches.

**Done =**

- All 4 tasks (T1–T4) landed,
- Go suite green on all 5 theme tests (existing) + 4+ new tests per task,
- Lint + typecheck clean,
- `sov --version` resolves to the new HEAD,
- A user setting `theme: "tokyo-night"` in `~/.harness/config.json` boots the TUI with the Tokyo Night palette active,
- A user writing `~/.harness/themes/my-vapor.toml` and running `/theme my-vapor` sees the custom palette take effect.

**Explicitly NOT done in M9.5:** mouse click handling, stall badge, `/skills reload`, real-Anthropic smoke. M10 parity audit + M11 default flip still ahead.

## 3. Architecture

### 3.1 Two new files + extensions

```
packages/tui/internal/theme/
├── theme.go              EXTEND — Resolve still pure (built-ins only).
│                                  New LoadFromFile(name, dir) for TOML.
├── dark.go               UNTOUCHED — Catppuccin Mocha
├── light.go              UNTOUCHED — Catppuccin Latte
├── tokyo-night.go        ← NEW palette (Tokyo Night Storm)
├── sovereign.go          ← NEW palette (cool slate + cyan)
├── loader.go             ← NEW — TOML parser + filesystem lookup
├── theme_test.go         EXTEND — 4 built-ins resolve
├── tokyo_night_test.go   ← NEW
├── sovereign_test.go     ← NEW
├── loader_test.go        ← NEW
└── integration_test.go   ← NEW (T4 close-out smoke)

packages/tui/internal/app/
└── app.go                EXTEND — boot reads ~/.harness/config.json `theme`
                                   field via theme.Resolve + LoadFromFile
                                   fallback. /theme writes back to config.
```

### 3.2 TOML schema

Flat, snake_case in TOML — maps to camelCase Go fields:

```toml
name = "my-theme"

[colors]
background      = "#1e1e2e"
foreground      = "#cdd6f4"
dim             = "#6c7086"
border          = "#45475a"
primary         = "#89b4fa"
success         = "#a6e3a1"
warning         = "#f9e2af"
error           = "#f38ba8"
info            = "#7f849c"
code_background = "#181825"
diff_added      = "#a6e3a1"
diff_removed    = "#f38ba8"
diff_context    = "#6c7086"
```

All 13 colors are optional; missing ones fall back to `Dark()` palette's value (ADR M9.5-03). The `name` field is mandatory.

### 3.3 Precedence on `/theme <name>`

1. **Built-ins win.** `Resolve(name)` returns the built-in palette + `true` if `name` is `dark` / `light` / `tokyo-night` / `sovereign`.
2. **TOML fallback.** On `Resolve` miss, try `LoadFromFile(name, harnessHome/themes/)`. Return the parsed Theme + `nil` error.
3. **Final fallback.** If neither resolves, return `Dark()` + an error. App layer logs + renders an error marker.

User-side: to customize an existing built-in, save the TOML under a NEW name (e.g., `dark-pastel.toml`). The TOML can't override the literal `dark` name.

### 3.4 Persistence flow

**Boot read (in `app.New`):**

```
themeName := readThemeFromConfig(harnessHome)  // "dark" if missing
if t, ok := theme.Resolve(themeName); ok {
    m.theme = t
} else if t, err := theme.LoadFromFile(themeName, themesDir(harnessHome)); err == nil {
    m.theme = t
} else {
    m.theme = theme.Dark()  // final fallback
    // log + render error marker on first frame
}
```

**Write on `/theme <name>` (in slash handler):**

```
// After Resolve/LoadFromFile success:
m.theme = newTheme
writeThemeToConfig(harnessHome, name)  // best-effort
```

The `writeThemeToConfig` helper reads the existing config.json (preserves other fields), patches the `theme` field, writes atomically (write-temp + rename). Failure logs to debug + dim-message in transcript; doesn't block the in-memory switch.

### 3.5 Sovereign palette (locked in spec)

| Token | Color |
|---|---|
| Background | `#0d1117` |
| Foreground | `#e6edf3` |
| Dim | `#7d8590` |
| Border | `#30363d` |
| Primary | `#58a6ff` |
| Success | `#3fb950` |
| Warning | `#d29922` |
| Error | `#f85149` |
| Info | `#6e7681` |
| CodeBackground | `#161b22` |
| DiffAdded | `#3fb950` |
| DiffRemoved | `#f85149` |
| DiffContext | `#7d8590` |

GitHub Dark inspired with a cooler cyan primary. AI-tooling aesthetic.

### 3.6 Tokyo Night palette (locked in spec)

| Token | Color |
|---|---|
| Background | `#1a1b26` |
| Foreground | `#c0caf5` |
| Dim | `#565f89` |
| Border | `#2f334d` |
| Primary | `#7aa2f7` |
| Success | `#9ece6a` |
| Warning | `#e0af68` |
| Error | `#f7768e` |
| Info | `#565f89` |
| CodeBackground | `#16161e` |
| DiffAdded | `#9ece6a` |
| DiffRemoved | `#f7768e` |
| DiffContext | `#565f89` |

Tokyo Night Storm variant. Widely recognized; free-to-use.

## 4. Decisions Locked In This Spec

Three ADRs land at close-out:

1. **M9.5-01** — TOML loader schema is flat, snake_case in TOML → camelCase in Go. Built-ins always win over TOML by name (no override semantics). Rationale: simpler than override resolution; users can fork built-ins by saving under a new name. Avoids name-collision edge cases.

2. **M9.5-02** — Theme persistence writes synchronously on `/theme` switch; best-effort (log on failure, don't block UX). Read at app boot. Rationale: synchronous matches user mental model ("switch is immediate"); best-effort matches the M6/M8 "TUI never crashes on filesystem hiccups" policy.

3. **M9.5-03** — Partial TOML files use `Dark()` per-field fallback. A user can ship a 3-color TOML and still get a working theme. Rationale: aligns with the M9.5-01 "users customize by forking" pattern — they tweak the few colors they care about; the rest stays sensible.

## 5. Task Decomposition

| # | Task | Tests |
|---|---|---|
| **T1** | TOML loader foundation (`loader.go` + add `BurntSushi/toml` dep) | Round-trip full schema; partial TOML with Dark fallback; malformed; missing file; bad hex |
| **T2** | Tokyo Night + Sovereign palettes (`tokyo-night.go` + `sovereign.go`; extend `Resolve`) | Each palette resolves by name; all 13 fields populated; styles work |
| **T3** | Persistence — boot read + `/theme` write | Boot with `theme: "tokyo-night"` config produces tokyo-night; `/theme light` writes `"light"`; missing config defaults to dark; temp-HARNESS_HOME isolation |
| **T4** | Integration smoke + close-out | Round-trip TOML→config→boot→assert; ADRs M9.5-01..03; state snapshot; CLAUDE.md/AGENTS.md pointer; testing-log; `sov upgrade` |

## 6. Error Handling

- **TOML parse error** (malformed file): `LoadFromFile` returns an error wrapping the parser's error. App layer logs + renders a dim error marker on the first frame.
- **Missing TOML file**: `LoadFromFile` returns `os.ErrNotExist`. App layer treats this as "unknown theme" — same as Resolve miss.
- **Invalid hex code in TOML**: lipgloss accepts the color verbatim and may render incorrectly; we don't pre-validate hex strings. (TODO for M9.6: hex validation.)
- **Config read failure**: app boot falls back to `Dark()`; no marker (config may legitimately not exist on first run).
- **Config write failure**: log to debug + dim transcript marker "could not persist theme: <err>". Theme switch still applies in-memory.

## 7. Testing Strategy

- **Go unit** (`go test`): every new file gets a `_test.go` peer. Existing `theme_test.go` extends to assert all 4 built-ins resolve.
- **Integration smoke**: `theme/integration_test.go` round-trip — write TOML to a temp dir, point `HARNESS_HOME` at it, boot a Model, assert the theme name + a sample color field.
- **No TS-side changes** so no new TS tests.
- **`sov upgrade`** after every `packages/tui/` change. Final upgrade verifies binary builds.

## 8. Postmortem-Rule Compliance Check

Verified at close-out:

- **Rule 1** — `src/ui/terminalRepl.ts` untouched: `git diff master -- src/ui/terminalRepl.ts` returns empty.
- **Rule 2** — no helper module deletion: `git diff master --diff-filter=D -- src/` returns empty.
- **Rule 3** — parity audit: NOT done in M9.5. That's M10's job.
- **Rule 4** — `--ui tui` stays opt-in through M11: `src/main.ts` default still `repl`.

## 9. Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| `BurntSushi/toml` adds binary size | low | Pure Go, well-maintained; ~50KB. Acceptable. |
| Config write race with concurrent `/theme` switches | very low | TUI is single-threaded through tea.Model.Update; can't race itself. |
| User config.json has unexpected schema | low | Theme write merges by reading-then-patching; preserves unknown fields. |
| TOML lexer changes break old themes | low | Schema is flat; future schema versions can add `version` field. v1 has no version field — assume current. |
| Atomic write fails partway | low | Write-temp + rename pattern; even on partial failure the original config stays valid. |

## 10. Self-Review

Spec checked against the brainstorming-skill checklist 2026-05-16-pre-commit:

- **Placeholder scan:** No "TBD" / "TODO" / vague items.
- **Internal consistency:** Architecture (§3) matches Tasks (§5). TOML schema (§3.2) matches palette tables (§3.5, §3.6) field set.
- **Scope check:** 4 tasks, all touching the same Go package + minimal app.go extensions. Single implementation plan.
- **Ambiguity check:** Precedence (§3.3) order is explicit. Fallback (§3.4) order is explicit. Sovereign + Tokyo Night palettes locked with hex codes.

## 11. Next Steps

1. Write implementation plan at `plans/2026-05-16-phase-16-1-m9-5-theme-polish.md`.
2. Execute T1–T4.
3. Close-out per the template (M8/M9 precedent): state snapshot + CLAUDE.md/AGENTS.md update + ADRs M9.5-01..03 in DECISIONS.md + testing-log entry.
4. Push to origin/master after each commit per `docs/05-conventions/lint-and-commit.md`.

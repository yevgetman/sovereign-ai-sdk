# Visual TUI QA — agent-driven screenshot loop

**When to read:** When you (the agent) need to look at a TUI state visually — assessing layout, color, glyph rendering, spacing, or any UX concern that doesn't fall out of unit tests. Also: when adding new visual scenarios, modifying the runner, or tuning the preamble.

This file is the **record of truth** for the visual QA feature. Configuration values, scenario conventions, and runner semantics all live here. The in-tree `.harness/visual/README.md` is intentionally minimal and points back to this document.

## Why this exists

The sov TUI is a Go Bubble Tea app whose output depends on terminal rendering (ANSI escapes, font fallback, color palette, glyph support). Three classes of regression slip through code-level tests:

1. **Layout regressions** — a token change in `style.S.*` reflows components.
2. **Color regressions** — a theme palette quantizes a "bright" hex to a dim shade in some terminals (see `tui-color-rendering.md`).
3. **Glyph regressions** — a Unicode character renders as a tofu box because the chosen font lacks the glyph.

Unit tests assert on the *string* the model emits. They cannot see how the terminal renders it. Visual QA closes that gap.

The user-as-screenshot-taker workflow (the loop we replaced) cost a session interruption per visual check and produced no reusable artifact. The VHS-based loop is fully agent-drivable: I write a `.tape`, run `bun run visual <name>`, `Read` the PNG, and judge the result. The `.tape` scripts become durable scenario assets that any future session can re-run.

## How it works

The pipeline:

```
.tape script
   ↓ (vhs CLI)
ttyd (terminal in a process)
   ↓ (spawns)
sov-tui (the real binary, no mocking)
   ↓ (renders ANSI)
ttyd captures terminal state
   ↓ (Screenshot directive)
PNG file at .harness/visual/output/<name>.png
   ↓ (Read tool)
Agent looks at the image
```

VHS is the [Charmbracelet](https://github.com/charmbracelet/vhs) tool that drives ttyd via a scripting DSL. It supports `Type`, `Enter`, `Sleep`, `Down`, `Up`, `Escape`, `Ctrl+...`, `Screenshot`, `Hide`/`Show`, and more — see the [VHS command reference](https://github.com/charmbracelet/vhs#vhs-command-reference) for the full list.

The `sov-tui` process under the recording is the **real binary**, not a mock. The same code that produces what the user sees on their terminal produces what VHS captures. The only difference: VHS pins font + size + theme so output is reproducible across hosts.

## Setup

### Prerequisites

| Tool | Install |
|------|---------|
| VHS  | `brew install vhs` (macOS), or [release downloads](https://github.com/charmbracelet/vhs/releases) on Linux |
| ttyd | Installed automatically as a VHS dependency on Homebrew |
| JetBrains Mono font | `brew install --cask font-jetbrains-mono` (macOS) — or change `FontFamily` in the preamble to an installed font |

### Verify

```bash
vhs --version          # should print "vhs version 0.11.0" or higher
which ttyd             # should print the ttyd binary path
bun run visual splash  # should produce .harness/visual/output/splash.png
```

If `bun run visual splash` succeeds but produces a stretched/wrong-font image, the font is the issue — change `FontFamily` in `.harness/visual/scenarios/_preamble.tape` to a font the host actually has.

## Configuration

### The preamble

Every scenario starts with `Source .harness/visual/scenarios/_preamble.tape`. The preamble pins the values that govern output reproducibility:

```tape
Set Shell "zsh"
Set FontFamily "JetBrains Mono"
Set FontSize 14
Set Width 1400
Set Height 900
Set Padding 20
Set Theme "GitHub Dark"
Set TypingSpeed 30ms

Hide
Type "mkdir -p /tmp/sov-visual && cd /tmp/sov-visual && clear"
Enter
Sleep 500ms
Show
```

| Setting | Value | Rationale |
|---------|-------|-----------|
| `Shell` | `"zsh"` | Match the user's shell so prompt + completion behavior are realistic. Bash works too — just change the value. |
| `FontFamily` | `"JetBrains Mono"` | Wide glyph coverage (covers `❯`, `›`, `⚠`, `✓`, `✗`, `◇`, `◆`, `→` — every glyph in `style.S.Glyph.*`). Free and ubiquitous. |
| `FontSize` | `14` | Comfortable read-size in a 1400×900 PNG. Smaller fits more rows; larger reads better in side-by-side comparison. |
| `Width` × `Height` | `1400 × 900` | Wide enough that the prompt + status line don't wrap on most scenarios; tall enough to fit a multi-block assistant turn + status. Roughly the rendered size of a 14" laptop terminal at the user's defaults. |
| `Padding` | `20` | Inner padding inside the PNG frame. Prevents glyphs from touching the edge — important for readability when reviewing inline. |
| `Theme` | `"GitHub Dark"` | A widely-recognized dark theme. Matches the sov "sovereign" theme's brightness profile closely enough that color regressions reproduce. To test a specific TUI theme, set the sov theme via `sov config set theme <name>` before running the scenario (or via a `Type "/theme <name>"` step). |
| `TypingSpeed` | `30ms` | Fast enough that scenarios don't drag; slow enough that the textinput doesn't drop keystrokes. Lower this only if you see lost characters. |
| `Hide`/`Show` block | clean-tempdir setup | Runs `cd /tmp/sov-visual` off-camera so the sov context-loader doesn't flag this repo's `AGENTS.md` (which contains a `curl ... \| bash` installer line that trips the security pattern). |

### Output destinations

| Path | Purpose |
|------|---------|
| `.harness/visual/output/<name>.png` | Canonical capture for scenario `<name>`. **What the agent reads.** Gitignored. |
| `.harness/visual/output/_trash/<name>.gif` | The full-recording GIF VHS produces because `Output` is required. Throwaway. Gitignored. |

The `_trash` GIFs are an artifact of how VHS works: the `Output` directive is mandatory, but we only care about the single-frame `Screenshot` outputs. Pointing `Output` at `_trash/` keeps the GIF out of the way without disabling it.

### Runner

`scripts/visual.ts` is a thin Bun script that:

1. Lists `.tape` files in `.harness/visual/scenarios/` (skips any starting with `_` — those are preamble fragments).
2. Either renders all of them (`bun run visual`) or filters by name (`bun run visual splash`).
3. Shells out to `vhs <tape>` for each.
4. Reports per-scenario success + wall time.

The script intentionally has minimal logic so it doesn't need its own tests beyond the regression checks below.

## Scenarios

Each scenario captures a specific TUI state. Add new ones liberally — the cost is one `.tape` file and ~10s of render time. Below are the canonical scenarios:

| Scenario | What it captures | API call? |
|----------|------------------|-----------|
| `splash` | Boot screen: SOV logo, version card, provider/model display, tips line, boot notices, empty prompt, status line. | No |
| `prompt-input` | Prompt with text typed (cursor mid-line, before Enter). Useful for textinput rendering and the input box border. | No |
| `config-menu` | `/config` root menu picker open. Used to verify root-menu layout + group ordering. | No |
| `config-router` | `/config router` subgroup with rows showing per-field `valueColumn` + badge. Verifies the picker drill-in + the "Phase X" name stripping (UX2 fix). | No |
| `turn-complete` | Full turn lifecycle: user echo (`❯`), assistant response, turn separator, trailing spacing before the next prompt. Confirms the chain of gaps from `Echo.LeadingGap` + `EndAssistantCard` trailing newline + `Separator.TrailingGap` + the View()'s implicit padding. | Yes (short prompt) |

### When a scenario needs an API call

`turn-complete` is the only canonical scenario that requires a working `ANTHROPIC_API_KEY`. It uses a tiny prompt (`"say hi in 5 words or less"`) so wall-time stays under 15s. If the API is unavailable, the screenshot still captures the spinner state — useful for spinner alignment / color but not for end-of-turn spacing.

To make API-dependent scenarios more robust, consider:

- Using a deterministic mock provider (sov has `MockProvider` internally — not currently CLI-exposed; an env-var-driven mock mode would be a future improvement).
- Pre-recording a session into a fixture and replaying via sov's eval replay path. Out of scope for the v0 visual runner.

### Adding a scenario

1. Create `.harness/visual/scenarios/<name>.tape`.
2. First line should be `Source .harness/visual/scenarios/_preamble.tape`.
3. Second line: `Output .harness/visual/output/_trash/<name>.gif` (required by VHS, contents not read by agent).
4. Drive the TUI to the target state with VHS commands.
5. `Screenshot .harness/visual/output/<name>.png` at the capture moment.
6. **Immediately add `Sleep 500ms` after the Screenshot.** VHS' Screenshot directive is fast but not strictly synchronous — without a buffer, the screenshot can capture the start of the next keystroke. The 500ms is enforced by the regression tests (minimum 200ms).
7. After the buffer, finish with `Type "/quit"` + `Enter` so sov exits cleanly. (Saves wall-time vs. waiting for a SIGINT.) `sov config` scenarios use `Escape` instead.
8. Run `bun run visual <name>` and `Read` the PNG.

Tape skeleton:

```tape
Source .harness/visual/scenarios/_preamble.tape
Output .harness/visual/output/_trash/<name>.gif

Type "sov"
Enter
Sleep 4s        # wait for splash + bundle load

# ... drive to target state ...

Screenshot .harness/visual/output/<name>.png
Sleep 500ms     # buffer — see test enforcement below

Type "/quit"
Enter
Sleep 500ms
```

### Sleep durations

VHS doesn't wait for the TUI to be ready — it sends keystrokes on a fixed schedule. Sleep before each interaction with the TUI:

| State transition | Reasonable sleep |
|------------------|------------------|
| Shell → `sov` boot complete (splash + bundle scan) | `Sleep 4s` (no bundle) to `Sleep 6s` (with bundle) |
| Submit prompt → first model response token | `Sleep 3s` (typical) to `Sleep 10s` (cold cache + long prompt) |
| Submit prompt → full turn complete (with `Sleep` after) | `Sleep 12s` for short prompts; longer for complex ones |
| `/config` open → picker rendered | `Sleep 1500ms` |
| Picker `Enter` → submenu rendered | `Sleep 1500ms` |
| Escape → modal closed | `Sleep 500ms` |

If a scenario flakes (sometimes captures the wrong state), increase the sleep before the `Screenshot` line.

## Regression tests

The runner and scenarios have lightweight regression tests under `tests/visual/`:

- **`runner.test.ts`** — verifies `scripts/visual.ts` correctly discovers `.tape` files, skips preamble files (`_*.tape`), and filters by name.
- **`scenarios.test.ts`** — for each `.tape` file in `scenarios/`:
  - It sources the preamble.
  - It declares an `Output` to the `_trash/` directory.
  - It captures a `Screenshot` at exactly the expected output path.
  - Every `Screenshot` is followed by a `Sleep` of at least 200ms (buffer against capturing the next keystroke).
  - It has an explicit exit (`/quit` or `Escape` for `sov config` scenarios).

These run as part of the standard `bun run test` gate. They do NOT actually run VHS (that's a 10-30s per scenario cost we don't want in unit tests); they just validate that the scenario files are well-formed.

PNG-level regression is intentionally NOT automated — pixel diffs flake on font/AA/palette differences across machines. Treat visual QA as agent-driven inspection, not CI-tier assertion.

## Workflow patterns

### "Show me state X"

User asks: *"how does the config menu look right now?"*

```bash
bun run visual config-menu
# then Read .harness/visual/output/config-menu.png
```

### Before/after on a UX tweak

You make a change to a `style.S.*` token. Render the relevant scenario before and after the change:

```bash
# before
bun run visual turn-complete
cp .harness/visual/output/turn-complete.png /tmp/before.png

# make the code change, rebuild TUI (sov upgrade if needed)

# after
bun run visual turn-complete
# Read both /tmp/before.png and .harness/visual/output/turn-complete.png
```

VHS uses the `sov-tui` binary on `$PATH`, which is whatever the user's source-mode install last published. If you've changed `packages/tui/` code, run `sov upgrade` (or rebuild via `bun run tui:build` + `bun link`) before rendering — otherwise you'll be re-rendering the OLD binary.

### Capturing a new state to debug

You're investigating a UX complaint. Spin up a scenario that reproduces the conditions:

1. Copy an existing scenario as a starting point.
2. Modify the input sequence to reach the reported state.
3. Render + read the PNG.
4. Iterate on the `.tape` until you're capturing the right state.
5. Commit the scenario as a canonical reproduction if it's likely to recur.

## Limitations

- **Wall-time**: ~10s per scenario at the low end, ~30s for API-dependent ones. Full suite (5 scenarios) is roughly 60-90s.
- **Determinism**: VHS itself is deterministic given the same `.tape`. But scenarios that involve API calls inherit the API's non-determinism (response text, latency). Don't assert on response content in visual QA — assert on layout/color/spacing only.
- **Font dependency**: PNG output depends on the host's fonts. If the agent renders on a host without JetBrains Mono, characters fall back. Pin the font in the preamble; if it's unavailable, install it or switch the preamble.
- **Letter spacing**: VHS+ttyd renders with wider letter-spacing than real terminals. This is cosmetic — it doesn't affect color/layout judgments. Don't size text by pixel count in the PNG.
- **No interactive driving**: Each `.tape` is a fixed script. You can't "play" the TUI freely the way a human can. To explore, write a new scenario.

## Maintenance

- Keep scenario count manageable (~5-10). Each new scenario costs render time and ongoing maintenance.
- If the TUI introduces a state worth capturing for the long term (a new screen, a new modal), add a canonical scenario for it.
- Delete scenarios that no longer reflect supported UI paths.
- When the preamble changes (font, theme, dimensions), re-render all scenarios so the on-disk PNGs match the canonical pipeline. (Or accept that PNGs are ephemeral; the `.tape` is the durable artifact.)

## See also

- [`tui-style-guide.md`](tui-style-guide.md) — the layout tokens that visual QA evaluates.
- [`tui-color-rendering.md`](tui-color-rendering.md) — the color rules visual QA verifies.
- [`tui-ux-patterns.md`](tui-ux-patterns.md) — the UX patterns visual QA inspects.
- [VHS command reference](https://github.com/charmbracelet/vhs#vhs-command-reference) — full directive list for writing `.tape` files.
- `.harness/visual/README.md` — short in-tree pointer back to this doc.

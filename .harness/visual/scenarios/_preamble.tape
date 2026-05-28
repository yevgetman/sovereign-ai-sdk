# Shared preamble for all scenarios. Sourced via VHS's `Source` directive.
# Pins font, theme, and terminal dimensions so PNG output is deterministic
# across runs.

# Calibrated to match the operator's actual terminal:
#   Apple Terminal.app, "Basic" profile, SF Mono Regular 11pt.
# SF Mono itself isn't visible to fontconfig (it's a hidden ".SF NS Mono"
# system font on macOS), so VHS silently falls back to Verdana —
# producing artificially wide letter-spacing. Menlo is Apple's pre-SF
# Mono system monospace with very similar metrics, and IS visible to
# fontconfig. Renders much closer to real Terminal.app density.
Set Shell "zsh"
Set FontFamily "Menlo"
Set FontSize 11
Set Width 1400
Set Height 900
Set Padding 20
Set Theme "GitHub Dark"
Set TypingSpeed 30ms

# Run from a clean tempdir so context-loader security warnings from the
# real repo's AGENTS.md don't leak into the recording. `Hide`/`Show`
# brackets keep the cd+clear off-camera.
Hide
Type "mkdir -p /tmp/sov-visual && cd /tmp/sov-visual && clear"
Enter
Sleep 500ms
Show

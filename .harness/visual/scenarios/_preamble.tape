# Shared preamble for all scenarios. Sourced via VHS's `Source` directive.
# Pins font, theme, and terminal dimensions so PNG output is deterministic
# across runs.

Set Shell "zsh"
Set FontFamily "JetBrains Mono"
Set FontSize 14
Set Width 1400
Set Height 1500
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

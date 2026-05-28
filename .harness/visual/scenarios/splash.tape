# Boot splash — the SOV logo, version, provider/model card, tips line,
# any boot notices (home-dir warning, no-bundle warning), and the empty
# prompt with status line.

Source .harness/visual/scenarios/_preamble.tape
Output .harness/visual/output/_trash/splash.gif

Type "sov"
Enter
Sleep 4s

Screenshot .harness/visual/output/splash.png
Sleep 500ms

# Quit cleanly so the binary's exit-handling code paths run.
Type "/quit"
Enter
Sleep 500ms

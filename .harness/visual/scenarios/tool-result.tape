# Tool-result rendering — asks the model to run a simple read-only tool
# (Glob or Read) and captures the compact tool line ("Verb target ›").
# Used to verify compact-line indent, verb color (Brand.VerbColor),
# chevron glyph, and the gap between assistant text and the tool line.
#
# Requires a working ANTHROPIC_API_KEY in env.

Source .harness/visual/scenarios/_preamble.tape
Output .harness/visual/output/_trash/tool-result.gif

# Drop a small file into the working dir for the model to act on.
Hide
Type "echo 'hello from visual qa' > sample.txt"
Enter
Sleep 300ms
Show

Type "sov"
Enter
Sleep 5s

Type "list the files in this directory, then read sample.txt"
Enter
Sleep 20s

Screenshot .harness/visual/output/tool-result.png
Sleep 500ms

Type "/quit"
Enter
Sleep 500ms

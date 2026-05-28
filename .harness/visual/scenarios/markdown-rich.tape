# Markdown rendering — submits a prompt that asks the model to produce a
# rich-formatted response (heading, list, inline code, code block). Used
# to verify the glamour markdown style configuration: heading colors,
# bullet glyphs, code-block background, inline-code accent.
#
# Requires a working ANTHROPIC_API_KEY in env. Non-deterministic content;
# the assertion is layout/color, never specific words.

Source .harness/visual/scenarios/_preamble.tape
Output .harness/visual/output/_trash/markdown-rich.gif

Type "sov"
Enter
Sleep 5s

Type "respond with: a short H2 heading, a 3-item bulleted list with one inline code span, and a fenced bash code block with a single one-liner. nothing else."
Enter
Sleep 18s

Screenshot .harness/visual/output/markdown-rich.png
Sleep 500ms

Type "/quit"
Enter
Sleep 500ms

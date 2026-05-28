# Prompt input — what the user sees while typing, BEFORE submitting.
# Shows the prompt box, cursor, hint line, and status line in their
# resting state.

Source .harness/visual/scenarios/_preamble.tape
Output .harness/visual/output/_trash/prompt-input.gif

Type "sov"
Enter
Sleep 5s

# Type a few words but do NOT press Enter — capture the typing state.
Type "how do I configure task routing"
Sleep 1500ms

Screenshot .harness/visual/output/prompt-input.png
Sleep 500ms

Ctrl+U
Sleep 200ms
Type "/quit"
Enter
Sleep 500ms

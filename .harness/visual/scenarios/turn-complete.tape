# End-of-turn — submits a short prompt and waits for the assistant
# response + turn separator. Captures the user echo (❯), assistant
# text, turn separator, and the gap before the next prompt.
#
# Requires a working ANTHROPIC_API_KEY in env. The prompt is short
# ("say hi in 5 words or less") so wall-time stays under 10s. If
# the API is unavailable, the screenshot will show the spinner
# state — still useful for spacing checks.

Source .harness/visual/scenarios/_preamble.tape
Output .harness/visual/output/_trash/turn-complete.gif

Type "sov"
Enter
Sleep 5s

Type "say hi in 5 words or less"
Enter

# Wait for the response to land + turn_complete to fire.
Sleep 12s

Screenshot .harness/visual/output/turn-complete.png
Sleep 500ms

Type "/quit"
Enter
Sleep 500ms

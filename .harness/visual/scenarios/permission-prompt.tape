# Permission prompt — captures the modal overlay that appears when a
# tool requires explicit user approval. Boots sov with
# --permission-mode ask so even tools the user has globally bypassed
# still prompt.
#
# Multi-shot scenario:
#   01-prompt-up   the permission modal centered, awaiting decision
#   02-after-deny  scrollback after the user denied the request
#
# Requires a working ANTHROPIC_API_KEY in env.

Source .harness/visual/scenarios/_preamble.tape
Output .harness/visual/output/_trash/permission-prompt.gif

Type "sov chat --permission-mode ask"
Enter
Sleep 5s

# Ask for a tool call that will trigger the prompt. FileWrite is a
# good candidate — it always needs permission under 'ask' mode.
Type "write a one-line file called demo.txt containing the word hello"
Enter

# Wait for the model to dispatch + the prompt modal to appear.
Sleep 12s
Screenshot .harness/visual/output/permission-prompt-01-prompt-up.png
Sleep 500ms

# Deny the request (Esc / 'n' depending on the prompt's bindings).
# The prompt's default binding is 'n' for deny, 'y' for allow.
Type "n"
Sleep 3s
Screenshot .harness/visual/output/permission-prompt-02-after-deny.png
Sleep 500ms

Type "/quit"
Enter
Sleep 500ms

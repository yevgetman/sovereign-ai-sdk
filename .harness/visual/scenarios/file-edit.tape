# File edit lifecycle — captures the DiffView renderer in action.
#
# Multi-shot scenario:
#   01-baseline    after seeding sample.py, before agent acts
#   02-after-edit  after the agent edits the file (shows the diff card)
#   03-final       after the agent confirms / explains the change
#
# Requires a working ANTHROPIC_API_KEY in env. Permission prompts are
# auto-allowed via sov's default headless behavior — the model is told
# to act directly.

Source .harness/visual/scenarios/_preamble.tape
Output .harness/visual/output/_trash/file-edit.gif

# Seed a small Python file the agent will edit. Hide/Show keeps the
# seeding off-camera. printf is used instead of a heredoc — heredocs
# emit a `heredoc>` continuation prompt that Hide doesn't suppress on
# every shell.
Hide
Type `printf 'def greet(name):\n    return f"Hello, {name}!"\n' > sample.py && clear`
Enter
Sleep 300ms
Show

Type "sov"
Enter
Sleep 5s

# Step 01 — baseline: show the prompt + working dir before any action.
Screenshot .harness/visual/output/file-edit-01-baseline.png
Sleep 500ms

# Step 02 — drive the edit. Ask the agent to add a goodbye function.
# This should trigger a FileEdit tool call which renders as a diff.
Type "add a function goodbye(name) to sample.py that returns 'Goodbye, name!'. just do it, no questions."
Enter
Sleep 25s
Screenshot .harness/visual/output/file-edit-02-after-edit.png
Sleep 500ms

# Step 03 — read it back to confirm + capture the assistant's final
# explanation alongside the diff.
Type "now show me the file contents"
Enter
Sleep 15s
Screenshot .harness/visual/output/file-edit-03-final.png
Sleep 500ms

Type "/quit"
Enter
Sleep 500ms

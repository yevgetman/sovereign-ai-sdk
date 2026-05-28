# Multi-tool flow — captures a sequence of tool dispatches in one
# turn. Useful to see how compact tool lines stack and how the
# assistant's narration interleaves with tool results.
#
# Multi-shot scenario:
#   01-mid-flow    captured during the tool sequence (early state)
#   02-flow-done   after the agent has run several tools and finishes
#
# Requires a working ANTHROPIC_API_KEY in env. Permission prompts are
# auto-allowed by sov's default permission mode for the seed dir.

Source .harness/visual/scenarios/_preamble.tape
Output .harness/visual/output/_trash/multi-tool.gif

# Seed a few files so the agent has things to discover.
Hide
Type "printf 'hello\nworld\n' > a.txt && printf 'goodbye\nworld\n' > b.txt && mkdir -p sub && printf 'nested\n' > sub/c.txt && clear"
Enter
Sleep 300ms
Show

Type "sov"
Enter
Sleep 5s

# Shorter, more focused prompt so the turn fits in the 900px viewport.
# Two tools: Glob then Read.
Type "list the .txt files here using glob, then read a.txt"
Enter

# Snapshot ~6s in — likely catches the first tool call.
Sleep 6s
Screenshot .harness/visual/output/multi-tool-01-first-tool.png
Sleep 500ms

# Snapshot at ~14s — catches both tools + final summary.
Sleep 8s
Screenshot .harness/visual/output/multi-tool-02-flow-done.png
Sleep 500ms

Type "/quit"
Enter
Sleep 500ms

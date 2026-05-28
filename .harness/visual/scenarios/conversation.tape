# Multi-turn conversation — captures three back-to-back turns to surface
# UX issues that only show up across turn boundaries: separator weight,
# turn-to-turn gap, accumulation of trailing whitespace, scroll behavior.

Source .harness/visual/scenarios/_preamble.tape
Output .harness/visual/output/_trash/conversation.gif

Type "sov"
Enter
Sleep 5s

# Turn 1: simple greeting
Type "hi"
Enter
Sleep 8s

# Turn 2: short factual
Type "what is 7 times 8"
Enter
Sleep 8s

# Turn 3: a request with markdown
Type "list 3 popular programming languages with a one-line description each"
Enter
Sleep 14s

Screenshot .harness/visual/output/conversation.png
Sleep 500ms

Type "/quit"
Enter
Sleep 500ms

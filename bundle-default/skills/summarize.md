---
name: summarize
description: Read a file or directory and produce a tight, accurate summary — what it is, what it does, and what its main moving parts are. No fluff.
whenToUse: |
  Trigger when the user asks "what is this?", "what does this do?",
  "summarize this file/directory/repo", "give me a quick read on this
  codebase", or any prompt asking for an overview of unfamiliar code
  or content. Don't trigger for specific questions ("does X handle
  Y?") or for requests to make changes.
---

# /summarize

Produce a tight, accurate summary of a file, directory, or repo. The goal is to give a reader who hasn't seen the code enough information to navigate it, in as few words as possible.

## Process

1. **Identify the target.** If the user pointed at a specific file or path, use it. Otherwise summarize the current directory.
2. **Read with intent.** For a single file: read the whole thing if it's under ~500 lines, otherwise read the first 100 + last 50. For a directory: `Glob` for all source files, `Read` the obvious entry points (README, index, main, package.json equivalent).
3. **Extract the load-bearing facts:**
   - What is this thing? (one sentence)
   - What does it do? (one paragraph)
   - What are its main moving parts? (a short bullet list — file or function names + one-line role)
   - What does it depend on? (other modules, external services, config)
   - What's notable / non-obvious about it?

## Output

Format:

```
**<target>** — <one-sentence "what is it">

<one-paragraph "what it does">

**Main parts:**
- `<name>` — <one-line role>
- `<name>` — <one-line role>
...

**Depends on:** <list>

**Notable:** <one paragraph if anything is non-obvious; otherwise omit>
```

Don't pad. If a section is empty, omit it. If the answer is one sentence, the answer is one sentence.

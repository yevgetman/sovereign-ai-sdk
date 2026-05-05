---
name: review
description: Walk a codebase and surface the highest-priority issues — bugs, security concerns, design smells, and missing tests — in a prioritized list.
whenToUse: |
  Trigger when the user asks for a code review, a security review, a
  general "what's wrong with this code?" pass, a "give me feedback on
  this", or any prompt asking you to evaluate the quality / safety /
  design of a codebase. Don't trigger when the user asks a specific
  question about behavior or wants help making a specific change.
---

# /review

You are doing a code review of the current project. Be thorough but pragmatic — the goal is to surface the issues a senior engineer would care about most, not to inventory every possible nitpick.

## Process

1. **Skim the project structure** with `Glob` and `Read` to understand what kind of codebase this is (language, framework, layout). Don't assume.
2. **Identify the highest-leverage files** — entry points, core logic, anything that touches data persistence or external boundaries.
3. **Look for, in priority order:**
   - **Correctness bugs** — logic errors, race conditions, off-by-one, null-handling lapses, TODO comments that flag known issues.
   - **Security risks** — input validation gaps, command injection, path traversal, hardcoded secrets, unsafe deserialization, missing authn/authz checks at boundaries.
   - **Design smells** — leaky abstractions, hidden coupling, god functions, duplicated logic that should be unified.
   - **Test coverage gaps** — load-bearing logic with no tests, error paths that aren't exercised, integration boundaries that are only covered by unit tests.
4. **Skip the cosmetic stuff** — formatter-style tabs vs. spaces, single vs. double quotes, etc. The user can run a linter for that.

## Output

Group findings by severity (critical / high / medium / low). For each finding:

- File path + line number(s).
- One-sentence problem statement.
- One-sentence fix suggestion.

End with a short "headline" paragraph: the 1–3 issues you'd address first if this were your code.

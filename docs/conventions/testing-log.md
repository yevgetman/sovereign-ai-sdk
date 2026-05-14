# Testing log

Append an entry to `docs/testing-log.md` whenever harness testing is performed.

This applies whether the testing is automated (`bun run test`, lint/typecheck gates, targeted unit tests) or semantic/manual (CLI checks, REPL smoke tests, provider/tool behavior checks).

## What to record

Each entry should capture:

- **Scope** — what's being tested (single tool, single subsystem, full suite, etc.)
- **Environment** — relevant version pins, provider, model, OS quirks
- **Commands** — exact invocations so a future reader can reproduce
- **Manual coverage** — anything not exercised by the automated suite
- **Result** — pass/fail/partial, with counts
- **Regressions or follow-ups** — anything surfaced that needs a separate fix

## Ordering

Newest entries go at the top. The log is append-only — older entries are not edited or compacted.

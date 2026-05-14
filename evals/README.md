# Goldens

Declarative end-to-end tests run by `sov eval run`. Each golden lives at `evals/goldens/*.golden.ts` and exports a `GoldenSpec` const (any export name works — the loader picks up every export that matches the spec shape).

## Run

```bash
# All goldens, default budget at evals/budget.json:
sov eval run

# Filter by id/name/category substring:
sov eval run --filter edit

# Custom binary, longer timeout:
sov eval run --binary ./build/sov --timeout 120000

# Keep sandboxes for debugging:
sov eval run --keep-sandbox

# Compare providers (grid output: rows = goldens, cols = providers):
sov eval run --compare anthropic,ollama

# Capture once with a live LLM, then replay forever in CI without an API key:
sov eval run --capture /tmp/golden-fixtures
sov eval run --replay  /tmp/golden-fixtures
```

Exit code is non-zero when any assertion fails, any run aborts (timeout/spawn error), or the budget is violated.

**Capture/replay.** `--capture <dir>` records a `ReplayFixture` per golden at `<dir>/<id>.fixture.json` while running live. `--replay <dir>` runs each golden against its captured fixture using `ReplayProvider` + `wrapToolsForReplay` — no LLM calls, no API keys needed. Goldens whose fixture is missing during replay are reported as aborted. Mutually exclusive with `--capture`.

**Compare mode.** `--compare provider1,provider2,...` runs each golden once per provider (in order) and prints a grid (rows = goldens, cols = providers). Per-provider model selection falls through to each provider's configured default. The aggregate budget applies across the cross-product totals.

## Format

```ts
import type { GoldenSpec } from '../../src/eval/types.js';

export const myGolden: GoldenSpec = {
  id: 'my-golden',                 // stable; also the filter substring
  name: 'Short human-readable name',
  description: 'What this exercises and why.',
  category: 'tools',                // optional grouping tag
  seed: {                           // optional sandbox files (relative paths)
    'README.md': '# fixture\n',
  },
  prompt: 'Single-turn user prompt.',  // or string[] for multi-turn
  assertions: [
    { type: 'agentResponseContains', text: 'fixture' },
    { type: 'fileExists', path: 'README.md' },
    { type: 'noToolErrors' },
  ],
  // optional:
  timeoutMs: 60_000,
  extraArgs: ['--permission-mode', 'bypass'],
  slow: false,
};
```

## Assertion kinds

| Type | Checks |
|---|---|
| `fileExists` | A path exists in the sandbox cwd. |
| `fileNotExists` | A path is absent. |
| `fileContains` | A path's contents contain a substring. |
| `fileMatches` | A path's contents match a regex (with optional flags). |
| `fileEquals` | A path's contents exactly equal a string. |
| `agentResponseContains` | Captured transcript contains a substring. |
| `agentResponseMatches` | Transcript matches a regex. |
| `agentResponseLacks` | Transcript does NOT contain a substring (e.g. injection-defense checks). |
| `noToolErrors` | The session-summary footer reports zero tool errors. |
| `minToolCalls` / `maxToolCalls` | Total tool-call count ≥ / ≤ a threshold. |
| `exitCode` | The subprocess exit code matches. |

## Budget

`evals/budget.json` is opt-in. When present, the runner checks the totals against:

```json
{
  "maxWallSeconds": 300,
  "maxCostUsd": 1.5,
  "maxToolErrors": 2,
  "minPassCount": 3
}
```

Each field is independent — omit any to skip that check. A budget violation fails the run.

## Cost

Goldens spawn `sov` against your configured provider. Each run costs whatever the agent's model + token usage runs to (typically $0.05-$0.20 per golden against claude-haiku). A full run of the four seed goldens is roughly $0.25-$0.50 against Haiku, $1-$2 against Sonnet. The budget exists so a regression in token efficiency surfaces as a CI fail rather than a quiet bill increase.

## When to extend

Add a new golden when shipping:
- A new tool surface that needs deterministic-ish coverage.
- A bug fix that should never regress (write the golden first, ship it failing alongside the fix that makes it pass).
- A new permission rule, hook, or skill that has a behavioral check.

Goldens are **end-to-end against a live LLM**. For pure-logic regressions, prefer a unit test in `tests/`. For LLM-judged fuzzy assertions, prefer a semantic test in `tests/semantic/`.

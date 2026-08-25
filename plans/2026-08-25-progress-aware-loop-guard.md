# Progress-aware loop guard — implementation plan

Spec: `specs/2026-08-25-progress-aware-loop-guard-design.md` (green-lit 2026-08-25).
Quality gate (repo): `bun run typecheck && bun test && bun run lint`.
Tests are `bun:test`; imports use `@yevgetman/sov-sdk/...` (see `tests/loop/*.test.ts`).
Every task: tests first (RED), then implementation (GREEN), then a spec-compliance +
code-quality review before the next task starts.

## Shared contract (fixed up front so T1 and T2 can run in parallel)

`packages/sdk/src/loop/detector.ts` exports:

```ts
export type LoopMode = 'enforce' | 'warn' | 'off';
export type LoopOptions = {
  mode?: LoopMode;                       // default 'enforce'
  consecutiveIdenticalThreshold?: number; // default 4
  noProgressWindow?: number;              // default 8
  contentChunkSize?: number;              // default 200
  contentRepeatThreshold?: number;        // default 8
  contentWindowMultiplier?: number;       // default 1.5
  sideEffectTools?: readonly string[];    // ADDITIVE to the built-in set
  maxStrikes?: number;                    // default 2
};
export type LoopDetection = {
  detector: 'consecutive-identical' | 'no-progress' | 'content-loop';
  hash: string;
  repetitionCount: number;
  /** Human-readable, one sentence, names what repeated (tool + first 80 chars of input, counts). */
  reason: string;
  /** Only for no-progress: window size and how many of the last calls were unproductive. */
  window?: { size: number; unproductive: number };
};
export class LoopDetectorState {
  constructor(opts?: LoopOptions);
  /** Pre-dispatch. Unchanged position in query(). */
  addAndCheck(turn: TurnSnapshot): LoopDetection | null;
  /** Post-dispatch. Feeds the productivity ledger; never fires. */
  observeResults(results: ReadonlyArray<{ name: string; input: unknown; text: string; isError: boolean }>): void;
  readonly mode: LoopMode;
  readonly maxStrikes: number;
}
```

`LoopOptions` is the ONE type reused by `config/schema.ts` (Zod mirror, strict),
`core/types.ts` (`QueryParams.loop?: LoopOptions`), and `agent/createAgent.ts`
(`AgentConfig.loop?`, `PerTurn.loop?`).

## Tasks

- [ ] **T1 — Detector core** (`packages/sdk/src/loop/detector.ts`, `tests/loop/detector.test.ts`)
  - Remove `action-stagnation` (+ its opts, exclude set, and every test for it).
  - Add the productivity ledger: `inputHash` (`name:canonicalJson(input)`, whitespace in
    strings collapsed, digits kept), `resultHash` (`ok|error` + first 64 KiB of text),
    `seenResults` (LRU, cap 2 000), built-in side-effect set
    `FileEdit, FileWrite, memory, memory_propose` ∪ `opts.sideEffectTools`.
  - Productive ⇔ resultHash unseen OR (sideEffect && !isError).
  - `no-progress` fires in `addAndCheck` when the last `noProgressWindow` observed calls
    are all unproductive; the ledger's recent-run resets after a fire (fresh K needed).
  - Priority: identical > no-progress > content. `mode: 'off'` and
    `HARNESS_LOOP_DETECTOR=off` ⇒ `addAndCheck` returns null and `observeResults` is a no-op.
  - `reason` strings per spec §3.4 (group repeated inputs, show counts; errors show the
    first 80 chars of the error text).
  - Tests (spec §4 "Unit"): all listed cases, table-driven where natural.
- [ ] **T2 — Config + types plumbing** (`config/schema.ts`, `core/types.ts`,
  `agent/createAgent.ts`, tests under `tests/config/` and `tests/agent/`)
  - `LoopSchema` (Zod, `.strict()`, all optional, positive ints, `mode` enum) as top-level
    `loop: LoopSchema.optional()` in the settings schema.
  - `QueryParams.loop?: LoopOptions`; `AgentConfig.loop?`, `PerTurn.loop?`;
    `perTurn.loop ?? config.loop`, conditional spread (absent ⇒ absent).
  - Tests: schema accepts / rejects unknown key / rejects `noProgressWindow: 0`;
    createAgent threads per-turn over standing (mirror the `maxToolCallsBeforeCheckin` test).
- [ ] **T3 — query() wiring + events** (`core/query.ts`, `core/types.ts`
  `LoopDetectionInfo`, `trace/types.ts`, `src/cli/traceShow.ts`, `tests/loop/wiring.test.ts`,
  `tests/loop/fixtures/tailor-009343da.json`)
  - `new LoopDetectorState(params.loop)`. Post-dispatch `observeResults(...)` right where
    the stall summary is built (has the tool_result message); wrap detector calls in
    try/catch → `loop_detector_error` trace event, no detection.
  - Escalation by mode: `enforce` = guidance while `occurrence < maxStrikes`, abort at
    `maxStrikes`; `warn` = guidance every time, never abort; `off` = nothing.
  - Guidance text = `Loop guard: ${reason} Change what you send, verify the earlier
    result, or stop and report.`; abort error = `aborted by loop guard (${detector}): ${reason}`.
  - `LoopDetectionInfo` + trace `loop_detected` gain `reason`, `action`
    (`'guidance'|'abort'|'warn'`), `mode`, optional `window`; detector union updated.
    `traceShow` prints the reason.
  - Wiring tests per spec §4; orphaned-`tool_use` regression kept.
  - Replay fixture: a synthetic sequence shaped from the killed run — 24 `Bash` calls,
    24 distinct inputs (`resume show <section>/<slug-n>`), 24 distinct results, no errors
    — driven through `query()` with a scripted provider: zero `loop_detected` events.
- [ ] **T4 — Gateway** (`src/server/runtime.ts`, `src/server/routes/turns.ts`, a test in
  `tests/server/`)
  - `ServerRuntime.loop?: LoopOptions` assembled from `userSettings.loop` (defensive `?.`
    like `effort`); `createAgent({ ..., ...(runtime.loop !== undefined ? { loop: runtime.loop } : {}) })`.
  - Test: a runtime built with `settings.loop = { mode: 'off' }` exposes it; absent ⇒ absent.
- [ ] **T5 — Docs**: `CHANGELOG.md` "harness 0.6.70" entry (behaviour change called out);
  `docs/02-architecture/runtime-architecture.md` §"Operational traces + loop detection"
  rewritten (it still says threshold 7); `docs/03-cli-reference/usage.md` gets a `loop`
  config block next to the other config blocks; `packages/sdk/src/loop/detector.ts` header.
- [ ] **T6 — Quality gate**: `bun run typecheck && bun test && bun run lint` green.
- [ ] **T7 — Ship**: commit per task (conventional messages), push `master`.
  Build `linux-arm64` via `scripts/release-build-target.ts`; copy into
  `resume-as-code-platform/vendor/sov/sov-local` with `SOURCE.txt` (commit sha); platform
  `docker compose build app --build-arg SOV_LOCAL_BIN=sov-local` → `up -d app`; verify
  `/opt/sov/sov --version` and that a tailor trace shows no `loop_detected`.
  **Stage for the CEO:** cut release v0.6.70 to `sov-releases` (outward-facing), then
  bump the platform `SOV_VERSION` and retire the local override.

## Reviews (between tasks)
Per task: one reviewer pass for spec compliance (§3 contract, §4 tests present) and
code quality (immutability, small functions, no swallowed errors except the documented
advisory catch). Fix before moving on.

# Progress-aware loop guard — design

**Status:** DRAFT — awaiting CEO green-light (org:build-a-codebase: spec → green-light → autonomous build)
**Date:** 2026-08-25
**Author:** the Kernel agent, appleo node, for a sovereign-ai-sdk session
**Origin:** production tailor runs on app.appleo.ai killed by `action-stagnation`
(session `009343da`, run `a0a7dc89`, 2026-08-25 18:53 UTC; 16 tailor sessions since
2026-08-05 show the same abort). CEO direction, same day: *"if a long turn keeps using
the same tool calls, it's ok as long as it's making progress — it's not the tool call
that's the problem, it's how the tool call is used, what details are sent. There should
be some way to determine progress. The guard should be tunable, and there should be a
way to turn it off."*

---

## 0. TL;DR

The `action-stagnation` detector counts **consecutive calls of the same tool name** and
treats the count as the signal. For any turn whose tool scope is one tool (the tailor
skill is `Bash(resume **)` only), every step has the same name, so the guard measures
**length**, not **stuckness**. Twelve distinct, productive reads look identical to
twelve identical retries.

Replace it with a **no-progress** detector that measures what the CEO named: whether
each call **sends something new and gets something new back**. A call is *productive*
when its **result** is new to the session (or it is a side-effect tool that succeeded).
The guard fires only when the last *K* calls were **all** unproductive — the model is
re-reading, re-running, or re-failing with nothing new coming back — **regardless of
which tool it used or how many calls the turn has made**.

Also: make the whole guard **configurable** (config block + per-turn override), keep
the existing env **kill switch**, and add a **warn-only mode**. Trace and stream events
gain a human-readable *reason* so a kill is explainable from the log.

Replay check against the killing run: 24 `resume show …` calls, 24 distinct results →
**never fires**. Against a genuine stuck loop (same failing edit retried): fires at 4
(identical) or 8 (varied inputs, same error), exactly as intended.

---

## 1. Evidence

| Fact | Source |
|---|---|
| `action-stagnation` = same tool **name** ≥ 12 in a row; Read/Grep/Glob excluded; Bash counted. Strike 1 injects guidance, strike 2 aborts. History resets after a strike, so a turn dies at ~12 + 12 calls of one tool. | `packages/sdk/src/loop/detector.ts`, `core/query.ts` L374–455 |
| Not host-configurable: `query.ts` does `new LoopDetectorState()` with no options. Only knob is `HARNESS_LOOP_DETECTOR=off` (env, whole process). | `query.ts` L99, `detector.ts` L104 |
| The tailor skill's whole tool scope is `Bash(resume **)` + `Read`; the résumé is read and edited through the CLI, so every step is `Bash`. | appleo `deploy/agent-skills/…/tailor-run.md` |
| Every glm-5.2 tailor session on record tripped strike 1; 16 hit strike 2 (traces under `<HARNESS_HOME>/traces/`). Sonnet-5 / kimi-k2.7 make fewer calls and never trip it. | appleo data volume, 2026-08-25 survey |
| The killed run: 24 tool calls, 24 **distinct** commands (`resume show work/x`, `skills/1-…`, `skills/2-…`, …), 24 distinct results, zero errors. Trace ends `loop_detected {action-stagnation, repetitionCount 12}` → `tool call interrupted by loop detector`. | `traces/009343da….jsonl` |
| Detection runs **before** tool dispatch (inputs only); the Phase 13.3 stall detector already reads `tool_result` blocks **after** dispatch from `history[last]`. | `query.ts` L374, L573–617 |

The appleo node has already shipped a workaround (read the résumé in one command). It
reduces exposure; it does not fix the guard, and a large résumé can still hit 12
consecutive edits.

---

## 2. Goals / non-goals

**Goals**
1. Stuckness, not length: a run of distinct, productive calls never fires, at any length.
2. A real loop still dies: identical retries, varied retries of the same failure, and
   re-reads that return nothing new.
3. Tunable per deployment and per turn; **off** and **warn-only** are first-class.
4. Every fire is explainable: the event says *what* repeated, in words.
5. Byte-identical behaviour for hosts that set nothing — except that the name-count
   detector is gone (§3.5 — the one intentional behaviour change).

**Non-goals**
- Semantic progress judgement by an LLM (cost, latency, and it is the thing that is looping).
- Changing `content-loop` (assistant text repetition) or the advisory stall detector.
- Per-skill frontmatter policy. Deferred; the per-turn override covers the need and a
  host can map skill → policy itself.

---

## 3. Design

### 3.1 Detectors after this change

| Detector | Signal | Default | Status |
|---|---|---|---|
| `consecutive-identical` | same tool **name + input** N times in a row | 4 | kept, now configurable |
| `no-progress` | last K tool calls **all unproductive** (§3.2) | K = 8 | **new** |
| `content-loop` | assistant text chunk repeats in a window | 8 | kept, configurable |
| `action-stagnation` | same tool **name** N in a row | 12 | **removed** (§3.5) |

Priority when several fire: identical > no-progress > content.

### 3.2 What "productive" means

For each dispatched tool call the detector records:

- `inputHash` — `sha256(name + ':' + canonical(input))`. Canonical = stable-key JSON;
  for string fields, whitespace collapsed. Digits are **not** stripped (`skills/2-…` and
  `skills/3-…` are different reads, on purpose).
- `resultHash` — `sha256(kind + ':' + text)` over the `tool_result` content (text
  blocks concatenated; first 64 KiB), `kind` = `ok` | `error` (`is_error`).
- `sideEffect` — true for tools in the side-effect set (`FileEdit`, `FileWrite`,
  `memory`, `memory_propose`, plus any tool the host adds via config) when the result is
  not an error.

A call is **productive** iff `resultHash` has never been seen in this session, **or**
`sideEffect` is true. Rationale: a new result means the model learned or changed
something, whatever it typed; a repeated result — same listing, same error, same
`changed:false` — means it did not. Input novelty alone is *not* progress (rewording a
failing command is the classic varied retry).

`no-progress` fires when the most recent **K** calls are all unproductive. The session
result set is unbounded in principle; cap it at the last 2 000 hashes (LRU) — a
session that long is not what the guard is for.

### 3.3 Where detection runs

Today: one check **before** dispatch. After: two steps around dispatch, same per-turn
loop.

1. **Pre-dispatch** `check(turn)` — unchanged position. Evaluates the state as of the
   previous turn's results. This is where `consecutive-identical` (inputs) and
   `content-loop` already run; `no-progress` reads the productive/unproductive ledger
   built in step 2 plus this turn's inputs.
2. **Post-dispatch** `observeResults(toolUseBlocks, resultMessage)` — new; called where
   the stall summary is built (`query.ts` ~L573), which already has the `tool_result`
   message. Appends to the ledger; never fires by itself.

So a no-progress verdict lands **one turn late** (at the next pre-dispatch check). That
is deliberate: the existing strike-1 guidance path merges guidance into the next
`tool_result` user message and the strike-2 abort synthesises `tool_result`s for the
pending `tool_use`s (postmortem 2026-05-07). Neither path changes. One extra tool call
in a stuck loop costs one round trip; it buys zero change to the message-ordering
invariants.

### 3.4 Policy and escalation

```
loop: {
  mode: 'enforce' | 'warn' | 'off'      // default 'enforce'
  consecutiveIdenticalThreshold: 4
  noProgressWindow: 8
  contentRepeatThreshold: 8
  sideEffectTools: string[]              // additive to the built-in set
  maxStrikes: 2                          // strike < max → guidance; strike == max → abort
}
```

- `enforce` — today's escalation: guidance on strike 1, abort on strike `maxStrikes`.
- `warn` — emits every `loop_detected` event and injects the guidance, **never aborts**.
- `off` — no detection at all (same as `HARNESS_LOOP_DETECTOR=off`, which stays and wins).

Guidance text becomes specific. Instead of *"the same action is repeating"*, the message
names the pattern from the ledger, e.g.:

> Loop guard: your last 8 tool calls returned nothing new — `Bash resume show
> work/icims-inc` (result already seen, 3×), `Bash resume edit skills/1-… --field …`
> (same error 5×: "expected array, received string"). Change what you send, verify the
> earlier result, or stop and report.

### 3.5 Removing `action-stagnation`

It is the false-positive source and it carries no signal `no-progress` does not: an
identical-input loop is caught at 4; a varied-input loop is caught at K=8 by its
repeated results; a productive run is not a loop. Keeping it opt-in would preserve the
exact trap this spec removes, so it goes. Documented in CHANGELOG as a behaviour change.
(**CEO may overrule** — see §7 Q1.)

### 3.6 Configuration plumbing

Mirror `behavior.maxToolCallsBeforeCheckin`, which already flows config → `createAgent`
→ `PerTurn` → `QueryParams`:

- `config/schema.ts` — new top-level `loop: LoopSchema.optional()` (strict).
- `core/types.ts` `QueryParams.loop?: LoopOptions`; `agent/createAgent.ts`
  `perTurn.loop ?? config.loop` with the same conditional-spread pattern.
- `core/query.ts` — `new LoopDetectorState(params.loop)`; mode gates the actions.
- Gateway turn route (`src/server/routes/turns.ts`) — no new body field now. A host
  that needs per-turn policy passes it through the embedded API (`PerTurn.loop`); the
  HTTP body stays locked. (Add `loop` to `PostTurnRequest` later if a host needs it.)

Hosts set nothing → defaults → §3.1 behaviour.

### 3.7 Observability

- `loop_detected` (stream + trace) gains `reason: string` (the guidance sentence),
  `action: 'guidance' | 'abort' | 'warn'`, `mode`, and `window: { size, unproductive }`.
  Existing fields (`detector`, `hash`, `repetitionCount`, `occurrence`) stay.
- Abort error text: `aborted by loop guard (no-progress): <reason>` — the platform
  surfaces this instead of a bare "stopped before it finished".
- `sov trace show` renders the reason.

### 3.8 Error handling

The detector is advisory infrastructure: any exception inside `observeResults` /
`check` is caught, recorded as a `loop_detector_error` trace event, and treated as "no
detection" for that turn. Hashing uses bounded inputs (64 KiB). Config is validated by
the strict Zod schema at load; an invalid `loop` block fails config load like any other
bad block.

---

## 4. Testing

**Unit — `tests/loop/detector.test.ts`** (replace the stagnation cases)
- 30 distinct calls with distinct results, same tool name → never fires.
- 8 calls with results already seen → fires `no-progress` at exactly 8; 7 → no fire.
- Varied inputs, identical error text → fires at 8; identical inputs → `consecutive-identical` at 4 first.
- Side-effect tool with an already-seen result → productive; with `is_error` → not.
- Ledger resets after a strike (a fresh 8 is needed to fire again).
- `mode: off` → never fires; `mode: warn` → fires but `action: 'warn'`.
- Canonicalisation: whitespace-only input differences hash equal; digit differences do not.
- 64 KiB result truncation is stable.

**Wiring — `tests/loop/wiring.test.ts`**
- Post-dispatch observe → next-turn fire; guidance is merged into the tool_result user
  message (no orphaned `tool_use`); second strike still synthesises `tool_result`s
  (regression from postmortem `loop-detector-orphaned-tool-use.md`).
- `warn` never returns `reason: 'error'`; `off` constructs no ledger.
- `HARNESS_LOOP_DETECTOR=off` still wins over `mode: enforce`.

**Replay fixture — `tests/loop/fixtures/tailor-009343da.jsonl`** (anonymised turn log of
the killed run): must complete with **zero** detections under defaults. This is the
acceptance test for goal 1.

**Config** — schema accepts the block, rejects unknown keys, `createAgent` threads
`perTurn.loop` over `config.loop`.

Quality gate: repo's full `typecheck + test` green; biome clean.

---

## 5. Rollout

1. Land in sovereign-ai-sdk; CHANGELOG entry; `docs/02-architecture/runtime-architecture.md`
   §"loop detection" rewritten (it still says threshold 7 — stale twice over).
2. Cut **v0.6.70** via the existing release scripts (`scripts/release*.ts`) — the publish to
   `sov-releases` is outward-facing: **staged for the CEO**, not executed by the agent.
3. appleo: bump `SOV_VERSION`, rebuild, deploy (pre-authorised). No config change needed
   for the default policy. Verify with one glm-5.2 tailor run and read its trace.
4. Keep the appleo "read the résumé in one command" rule — it is good hygiene regardless.

Estimate: **~150K tokens** end to end (SDK change + tests + docs + release + platform pin).

---

## 6. Alternatives considered

- **Raise the threshold** (12 → 40). Still measures length; a big résumé or a long audit
  still dies; the CEO rejected this explicitly.
- **Exclude the skill's allowedTools from stagnation.** Fixes the tailor case only; any
  single-tool workload elsewhere keeps the trap.
- **Per-turn `loop.mode: off` for the tailor turn.** Removes protection where the model
  most needs a guard (unattended, untrusted input). Kept as an available knob, not the fix.
- **LLM-judged progress.** Adds a model call per tool call to decide whether the model
  is stuck. Expensive, slow, and circular.

---

## 7. Decisions for the CEO

- **Q1.** Remove `action-stagnation` outright (recommended) — or keep it opt-in, default off?
- **Q2.** Default `mode` stays `enforce` with a 2-strike abort (recommended) — or ship
  `warn` as the default for one release and watch the traces first?
- **Q3.** Defaults `K = 8` and identical = 4 — any reason to start looser?

Unrelated but still open from 2026-08-24/25: the tailor lane's model (glm-5.2 vs
sonnet-5 / kimi), and Studio-vs-tailor gateway collisions on a posted turn.

# Subscription Executor — opt-in headless Claude Code sub-agent executor (SPIKE)

**Date:** 2026-06-08
**Status:** SPIKE shipped (off by default). Not a productized feature. ADR-INPUT, not an ADR.
**Scope:** personal / dogfood use only — wired into the sub-agent delegation seam ONLY. NOT cron, channels, the gateway, or any client surface.

---

## What this proves

The harness can drive a **headless Claude Code session as a task-delegating
sub-agent executor**: instead of the harness's own agent loop calling an API
LLM provider, a delegated task is handed to a spawned `claude -p` subprocess
that runs **its own** agentic loop (its own tools, its own permission system)
and returns a summary, round-tripping through the **unchanged scheduler tail**.

It is **opt-in and off by default** (`subscriptionExecutor.enabled: false`).
When disabled — which includes an empty config — the harness is byte-identical
to today: the lane is hidden from the model, the scheduler branch is inert, and
every delegation takes the normal `AgentRunner` path. The existing
`tests/runtime/scheduler.test.ts` passes unchanged — that is the proof the
normal path is untouched.

---

## The seam (verified against the code)

Claude Code is an **AGENT, not a completion endpoint**. So this is NOT an
`LLMProvider` swap. The right seam is a sub-agent **EXECUTOR** selected by
`role`, via the existing `AgentTool` → `SubagentScheduler.delegate()` path.

The single branch is the **executor construction** inside `delegate()`
(`src/runtime/scheduler.ts`). Today that block is:

```ts
const runner = new AgentRunner({ provider, model, systemPrompt, tools, ... });
const gen = runner.run(input.prompt);
result = await drainRunner(gen);   // { terminal, finalAssistant, iterationsUsed,
                                   //   toolCallCount, distinctToolNames, messages }
```

The spike branches **only the executor**:

```ts
const useSubprocessExecutor =
  this.opts.subscriptionExecutor?.enabled === true &&
  agent.role === 'subscription-executor';

if (useSubprocessExecutor) {
  result = await runSubprocessExecutor({
    prompt: input.prompt,
    cwd: input.parentToolContext.cwd,   // constrained to the runtime cwd
    config: this.opts.subscriptionExecutor!,
    signal: composed,                   // parent signal ∧ per-child timeout
  });
} else {
  // ... the existing AgentRunner path, byte-unchanged ...
}
```

### Result-shape compatibility (why downstream is unchanged)

`runSubprocessExecutor` returns the **EXACT shape `drainRunner` returns**:

```ts
type SubprocessExecutorResult = {
  terminal: Terminal;
  finalAssistant?: AssistantMessage;
  iterationsUsed: number;
  toolCallCount: number;
  distinctToolNames: string[];
  messages: Message[];
};
```

Because the shape matches, everything **downstream** of the branch in
`delegate()` is byte-unchanged:

- `extractSummary(result.finalAssistant)` → the `summary`;
- per-child **trajectory** write (`tryWriteTrajectory` over `result.messages`);
- the **`on_delegation` memory hook** (`memoryManager.onDelegation(task, summary)`),
  fired on `completed` / `max_turns`;
- the **review-fork notify** (`reviewManager.onChildCompletion(...)`);
- the **delegation lifecycle** SSE events (`delegation_completed` etc.);
- the `DelegateResult` the `AgentTool` renders back to the parent.

A subprocess **error terminal** is returned **in-band** (the executor never
throws), so it flows through the same success tail — a non-success terminal
simply skips the memory/review hooks, exactly like a normal child that errored.

The resolved `(provider, model)` for the `subscription-executor` role are still
computed and returned for shape/telemetry compatibility, but the subprocess
does not use them — `claude` picks its own model from the operator's login.

---

## `runSubprocessExecutor` (`src/runtime/subprocessExecutor.ts`)

**Spawn pattern** — copied from `src/hooks/runner.ts`: piped stdio, a
**capped reader** (`MAX_STDOUT_BYTES`), and an `AbortSignal` composed from the
caller's signal (`AbortSignal.any([parentSignal, AbortSignal.timeout(timeoutMs)])`).
The `spawn` fn is **injectable** (default a thin `Bun.spawn` wrapper) so tests
feed canned JSONL with no real subprocess. On abort the subprocess is killed
**and** the stdio readers are cancelled, so a pipe that does not close on kill
cannot wedge the drain (a robustness fix over the naive `hooks/runner.ts`
shape, exercised by a timeout test).

**The invocation** (`buildSubprocessArgs`, unit-tested for the safe posture):

```
claude -p "<prompt>" --output-format stream-json --verbose --permission-mode <safe> [--max-turns N]
```

`--verbose` is **required** — without it `claude -p` emits only the final result
line, not the per-event stream. `cwd` is the runtime cwd (the subprocess never
roams outside the runtime root).

**Failure handling** → `terminal: { reason: 'error', error }`:
- non-zero exit (with captured stderr in the message);
- the `result` event has `is_error: true`;
- a timeout / parent-cancel abort;
- a truncated stream with **no terminal `result` event**;
- a spawn throw.

### The real stream-json shape (captured live, not from memory)

Verified with the installed `claude` (v2.1.162) via
`claude -p "What is 2+2? Answer in one word." --output-format stream-json --max-turns 1 --verbose`.
The JSONL the parser is grounded on:

- `{"type":"system","subtype":"init","session_id":"…","model":"…","permissionMode":"…","apiKeySource":"none",…}`
  — the init frame (carries `session_id`; **`apiKeySource:"none"` ⇒ the local
  install was logged in via SUBSCRIPTION, not an API key — see the ToS section**).
- `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text",…},{"type":"tool_use","id":…,"name":…,"input":…}],…}}`
  — accumulate text → `finalAssistant`; count `tool_use` → `toolCallCount` /
  `distinctToolNames`; reconstruct into `messages[]`.
- `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":…,"content":…}]}}`
  — tool-result frames, reconstructed into `messages[]`.
- `{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"Four.","terminal_reason":"completed","usage":{…},…}`
  — the terminal frame: `is_error` → success/error; `num_turns` →
  `iterationsUsed`; `result` → a fallback `finalAssistant` text if no assistant
  frame carried it.
- **Noise frames skipped:** `system/hook_started`, `system/hook_response`,
  `rate_limit_event`, and any unknown `type`. A non-JSON line is skipped too
  (the terminal `result` event is the source of truth).

Content-block coercion keeps only the kinds the harness models internally
(`text`, `thinking`, `tool_use`, `tool_result`); unknown block kinds are dropped.

---

## Config + the safe permission translation

New strict, optional block in `src/config/schema.ts`:

```ts
subscriptionExecutor: z.object({
  enabled: z.boolean().optional(),                 // default: absent ⇒ false
  engine: z.enum(['claude-code']).optional(),
  binary: z.string().optional(),                   // default 'claude'
  permissionMode: z.enum(['plan','acceptEdits','default']).optional(),  // default 'plan'
  timeoutMs: z.number().int().positive().optional(),
  maxTurns: z.number().int().positive().optional(),
}).strict().optional()
```

**Off-by-default / the absent-parent gotcha.** `enabled` is a bare optional
`boolean` (no nested `.default(true)`), and the runtime treats **absent block**
and **`enabled !== true`** identically as disabled. A test asserts an **empty
config** (`SettingsSchema.parse({})`) carries no enabled executor — the documented
"nested `.default()` is a silent no-op unless the runtime gates on absent parent"
trap is sidestepped by not relying on a nested default at all.

**The safe permission translation (security-load-bearing).** The subprocess
runs its **OWN** permission system. We translate the operator's intent to
`--permission-mode <safe>` and **NEVER** pass a bypass / dangerous flag. The
`permissionMode` enum is the gate: it admits only `plan` | `acceptEdits` |
`default` and **rejects `bypassPermissions`** at parse time (a remote/automated
permission bypass of a spawned agent is RCE). `buildSubprocessArgs` has no code
path that emits `bypassPermissions` or `--dangerously-skip-permissions`; unit
tests assert the safe flag is present and the dangerous strings never appear.
Default `permissionMode` is `plan` (the safest, read-only-ish posture).

This mirrors the safe non-interactive posture recipe from `src/cron/wiring.ts`
and `src/channels/pipeline.ts` (auto-deny, never inherit the dev's allow-rules),
translated to the **subprocess's own flags** — the subprocess does not see the
harness's permission layers at all; it enforces its own under the constrained mode.

---

## Off-by-default gating (registration)

The `subscription-executor` agent ships in `bundle-default/agents/`. It is
**loaded** by `src/agents/loader.js` but only **usable** when the config enables
it: `computeToolVisibleAgents(...)` in `src/server/runtime.ts` excludes the
`subscription-executor` role from the **model-visible AgentTool enum** unless
`subscriptionExecutor.enabled === true` (the same mechanism that hides the
task-routing lane roles when `taskRouting` is off). The full registry stays on
the runtime for `/agent` dispatch; only the enum the model sees narrows. So an
off-by-default install never exposes the headless-subprocess delegation surface
to the model, AND the scheduler branch is inert even if it were invoked.

---

## IMPLEMENTED (2026-06-08): stream-json → `learningObserver` + trace replay

> **Status: shipped.** This was the "NEXT increment" below; it now closes the
> per-step learning gap so delegated headless-Claude-Code turns **feed the
> active learning-loop soak** instead of going dark.

On the normal `AgentRunner` path, each tool call is observed in
`src/core/orchestrator.ts` (~601–623: `ctx.learningObserver.observe({ toolName,
toolInput, status, durationMs, traceId, … })` after PostToolUse) and bracketed
with `tool_start` + (`tool_end` | `tool_error`) trace events (~521/543/552). The
subprocess path bypasses the orchestrator entirely — so before this increment a
delegated task was **dark to per-step learning** (only task-boundary learning via
`memoryManager.onDelegation` fired).

**What landed.** `runSubprocessExecutor` now accepts optional `learningObserver?`
+ `traceRecorder?`. As it parses the stream-json it captures each `tool_use`
block (in stream order) and indexes each `tool_result` by `tool_use_id`. On a
**completed** run (a failed/garbled run replays nothing — parity with a native
child that errored skipping its hooks) it walks the captured pairs and, per tool:

- constructs a `LearningObservation` **field-for-field identical** to the
  orchestrator's (`toolName` = the **canonicalized** tool name — see below;
  `toolInput` = the **canonicalized** tool input; `status` =
  `tool_result.is_error ? 'error' : 'success'`; `traceId` = the tool_use `id` =
  tool_use_id) and calls `observe(...)`;
- records the matching `tool_start` then `tool_end` (with `outputBytes` = byte
  length of the result content, mirroring the orchestrator) XOR `tool_error`
  (the result content as the message). **The trace brackets carry Claude's
  VERBATIM tool name** (not the canonicalized one) — the trace is a fidelity
  record of what Claude actually ran.

**Tool-vocabulary canonicalization (corpus co-clustering).** Claude Code's tool
NAMES + input field names diverge from the harness's native vocabulary, so an
un-normalized replay made the synthesizer treat a delegated file-read and a
native file-read as *different tools*, splitting cross-surface evidence. A small
pure function `canonicalizeToolForObservation(name, input)` at the replay
boundary in `subprocessExecutor.ts` maps the divergences **for the observation
ONLY** (confirmed live against `claude` v2.1.168; native names/keys are the
authoritative ones declared on the harness tools in `src/tools/`):

| Operation | Claude (replayed) | Harness native (the target) | Canonicalization |
|---|---|---|---|
| Read  | `Read` / `{ file_path, offset?, limit? }`  | `FileRead` / `{ path, … }`     | name `Read→FileRead`, key `file_path→path` |
| Write | `Write` / `{ file_path, content }`         | `FileWrite` / `{ path, content }` | name `Write→FileWrite`, key `file_path→path` |
| Edit  | `Edit` / `{ file_path, old_string, … }`    | `FileEdit` / `{ path, … }`     | name `Edit→FileEdit`, key `file_path→path` |
| Bash  | `Bash` / `{ command, description?, … }`    | `Bash` / `{ command, … }`      | name unchanged; drop Claude-only `description` (keep `command`) |
| Grep  | `Grep` / `{ pattern, … }`                  | `Grep` / `{ pattern, … }`      | unchanged (already matches) |
| Glob  | `Glob` / `{ pattern, … }`                  | `Glob` / `{ pattern, … }`      | unchanged (already matches) |

An **UNMAPPED** tool (Claude's `Task`, `WebFetch`, MCP tools, … — no native
equivalent) passes through **unchanged**: rewriting it would corrupt the corpus.
The function is immutable (returns a new `{ name, input }`, never mutates the
input). `distinctToolNames` in the result also reports the canonical names (so a
delegated `Read` co-counts with a native `FileRead`); `toolCallCount` is
naming-agnostic. **`messages[]` and the trace stay byte-for-byte verbatim** —
they record what Claude actually did; only the observation + the
`distinctToolNames` metric are canonicalized.

`messages[]` was already faithful (the spike reconstructs the assistant
`tool_use` messages + the `tool_result` user messages + the final text, not just
the final text) — the replay reuses those same captured blocks.

**Where the observations land (same destination as a native delegation).** The
scheduler threads the **child ToolContext's `learningObserver`** (the very object
the native `AgentRunner` reads off `toolContext` — inherited from the parent
context, sessionId-bound) and its **`wrappedTraceRecorder`** (which tags every
event with the child sessionId and forks to BOTH the parent recorder and the
child's per-session `TraceWriter`) into `runSubprocessExecutor`. So a delegated
subscription-executor task writes to the **same corpus + trace files** a native
child would, and the synthesizer cannot tell a replayed observation from a native
one. Both sinks are optional — learning disabled / no trace sink ⇒ a clean no-op
(the spike's original tests stay green).

**Tool identity now co-clusters (closed gap).** Previously a residual gap: the
replay recorded Claude's tool names/keys verbatim, so the synthesizer split a
delegated file-read from a native one. With `canonicalizeToolForObservation`
(above) the **parity claim now holds for tool identity too** — a replayed
`Read`/`Write`/`Edit`/`Bash` observation co-identifies with the native
`FileRead`/`FileWrite`/`FileEdit`/`Bash` on both name and input hash. Unmapped
tools (no native equivalent) stay verbatim by design.

**Residual fidelity gaps (what's recovered vs not).**
- **Per-tool timing is not recoverable.** The stream-json carries only an
  *aggregate* `duration_ms` on the terminal `result` event — no per-tool timing.
  Replayed observations + trace brackets use `durationMs: 0` (honest; the schema
  requires nonnegative). Native observations carry the real `tool.call()`
  duration.
- **No `denied` / `cancelled` status.** Claude Code resolves its own permission
  prompts and cancellations *inside* the subprocess; the stream only surfaces a
  tool_result that is either ok or `is_error`. So replayed status is `success` |
  `error` only — never `denied` / `cancelled` (which the native orchestrator can
  emit from its own gates).
- **No harness `ToolObservation` envelope.** The structured envelope
  (`observation_envelope`) is a harness-tool construct; Claude Code's tool
  results don't carry one, so it is omitted (the native path also omits it for
  tools that return no observation).
- **Turn structure differs.** Claude Code's internal turn/iteration shape is its
  own; we recover the per-tool sequence (the load-bearing learning signal), not a
  one-to-one mapping of its turns onto the harness's turn loop.
- **No per-event "from subprocess" marker.** The `TraceEvent` schema has no
  source/origin field, so replayed brackets are indistinguishable from native
  child brackets except by the child sessionId tag (which is exactly how native
  child events are attributed too).

**Proven (live).** Drove `SubagentScheduler.delegate()` with the **real**
`runSubprocessExecutor` (default `Bun.spawn`) against the installed `claude`
(v2.1.168) and a **real** `LearningObserver` pointed at a temp harness home: a
read-only tool-using task (`"List the files … and tell me how many there are"`)
completed, Claude chose `Bash: ls -la`, and **one observation landed in
`<harnessHome>/learning/<projectId>/observations.jsonl`** — `tool=Bash
status=success duration_ms=0` with the real command captured in
`tool_input_summary`. The parent trace recorder saw `tool_start:Bash` +
`tool_end:Bash`. Per-tool learning from a delegated headless turn now reaches the
corpus.

---

## The ToS boundary (front and center)

**Personal / attended / dogfood use of the official `claude` binary on your own
subscription is the only defensible mode.** The live smoke confirmed the local
install authenticates via **subscription** (`apiKeySource: "none"` in the init
frame), i.e. a Claude Pro/Max login — not an API key.

**Client / automated / multi-tenant / unattended use of the official binary is
ToS-prohibited** (the early-2026 enforcement against driving the consumer
subscription as a programmatic backend for others). That path **stays on the
per-token API** (the harness's existing `AgentRunner` + `LLMProvider`).

This is **why the spike is wired into the personal sub-agent delegation seam
ONLY** and explicitly **NOT** into cron, channels, the gateway, or any client
surface: those are exactly the automated/remote/multi-tenant contexts where
driving the subscription binary would cross the line. The off-by-default gate
keeps the capability invisible until an operator opts in for their own attended
use.

---

## Strategic alignment (decides nothing)

This is an **input** to several founder-reserved decisions, and resolves none of
them:

- **H-0010 "rent the engine."** A subscription-executor is the most literal form
  of renting the engine: hand a task to a fully-formed agent (Claude Code) and
  consume its result. The spike shows the harness's sub-agent seam can host a
  rented engine behind the SAME result contract the native loop produces.
- **Rent-vs-build / TS-vs-Python (the Phase-2 "rented engine" decision).** This
  demonstrates the *rent* end is mechanically cheap to integrate on the TS side
  via the existing scheduler seam — a data point, not a verdict.
- **Learning Phase 2.** The "dark to per-step learning" gap above is a concrete
  constraint any rented-engine direction inherits until the replay shim lands.

Keep this an ADR-input / spike doc. No ADR; no productization; no release.

---

## Files

- `src/config/schema.ts` — `subscriptionExecutor` block + `SubscriptionExecutorConfig` type.
- `src/runtime/subprocessExecutor.ts` — `runSubprocessExecutor`, `buildSubprocessArgs`, the parser;
  **+ the learning replay** (`LearningSink` / `TraceSink` opts, the `tool_use`/`tool_result` pairing,
  and `replayToolEvents` constructing orchestrator-parity observations + trace brackets);
  **+ `canonicalizeToolForObservation`** (the pure Claude→native tool-vocabulary map applied to the
  OBSERVATION + `distinctToolNames` only — trace/messages stay verbatim).
- `src/runtime/scheduler.ts` — the executor branch + the two new `SubagentSchedulerOpts` fields;
  **+ threading the child `learningObserver` + `wrappedTraceRecorder` into `runSubprocessExecutor`**
  (same destination as a native delegation).
- `src/server/runtime.ts` — `computeToolVisibleAgents` gating + threading the config into the scheduler.
- `bundle-default/agents/subscription-executor.md` — the agent def (role `subscription-executor`).
- Tests: `tests/config/subscriptionExecutor.test.ts`, `tests/runtime/subprocessExecutor.test.ts`
  (**+ 5 replay tests** — per-tool observation parity, faithful `messages[]`, no-op without sinks,
  orphan tool_use, no-replay-on-error; **+ 11 canonicalization tests** — the pure name/key map across
  Read/Write/Edit/Bash/Grep/Glob + unmapped pass-through + immutability, an end-to-end unmapped-tool
  replay, and the co-clustering assertions that observations canonicalize while messages/trace stay
  verbatim), `tests/runtime/scheduler.subscriptionExecutor.test.ts`
  (**+ 2 threading tests** — child observer/trace threaded to the same destination; none threaded
  when the parent context has no observer), `tests/server/computeToolVisibleAgents.test.ts`;
  `tests/runtime/scheduler.test.ts` unchanged-green (the normal-path proof);
  `tests/agents/bundleDefault.test.ts` updated for the new agent def.

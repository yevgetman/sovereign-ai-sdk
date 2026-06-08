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

## NEXT increment (not in this spike): stream-json → `learningObserver` replay

This spike does **not** replay the subprocess's per-step tool use into the
harness's learning observer. On the normal `AgentRunner` path, each tool call is
observed in `src/core/orchestrator.ts` (~601–623: `ctx.learningObserver.observe({
toolName, status, durationMs, … })` after PostToolUse). The subprocess path
bypasses the orchestrator entirely — the harness only sees the final summary,
not the intermediate `tool_use` / `tool_result` events.

**Consequence (bears on the active learning-loop soak):** delegated turns are
**dark to per-step learning**. The instinct corpus would accrue nothing from a
subscription-executor delegation beyond what the parent's own turn observes.
The captured stream-json already contains every `tool_use` / `tool_result`
(the parser reconstructs them into `messages[]`), so the next increment is a
**replay shim**: walk the parsed events and call `learningObserver.observe(...)`
per tool step (mapping `is_error` → `ObservationStatus`), so a subprocess
delegation participates in the learning loop like a native child. Deferred
deliberately — it is additive and out of scope for proving the mechanism.

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
- `src/runtime/subprocessExecutor.ts` — `runSubprocessExecutor`, `buildSubprocessArgs`, the parser.
- `src/runtime/scheduler.ts` — the executor branch + the two new `SubagentSchedulerOpts` fields.
- `src/server/runtime.ts` — `computeToolVisibleAgents` gating + threading the config into the scheduler.
- `bundle-default/agents/subscription-executor.md` — the agent def (role `subscription-executor`).
- Tests: `tests/config/subscriptionExecutor.test.ts`, `tests/runtime/subprocessExecutor.test.ts`,
  `tests/runtime/scheduler.subscriptionExecutor.test.ts`, `tests/server/computeToolVisibleAgents.test.ts`;
  `tests/runtime/scheduler.test.ts` unchanged-green (the normal-path proof);
  `tests/agents/bundleDefault.test.ts` updated for the new agent def.

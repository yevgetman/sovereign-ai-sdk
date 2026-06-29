// SPIKE (off by default) — headless Claude Code sub-agent executor.
//
// `runSubprocessExecutor` is the alternative to `new AgentRunner(...)` +
// `drainRunner(gen)` inside SubagentScheduler.delegate(): instead of driving
// the harness's own turn loop against an API LLMProvider, it spawns a
// `claude -p` subprocess that runs its OWN agentic loop and returns a summary.
// It returns the EXACT shape `drainRunner` returns ({ terminal, finalAssistant,
// iterationsUsed, toolCallCount, distinctToolNames, messages }) so everything
// downstream in delegate() (summary extraction, trajectory, memory hook,
// review, SSE) is byte-unchanged.
//
// The seam is gated by config `subscriptionExecutor.enabled: false` — when off,
// the scheduler never calls this and the normal AgentRunner path is untouched.
//
// PERMISSIONS: `permissionMode` translates to the subprocess's posture and
// DEFAULTS to `bypass` → `--dangerously-skip-permissions`. A headless
// `claude -p` has no interactive approver, so a prompt would otherwise
// auto-deny and stall real work. This is acceptable ONLY because the executor
// is reachable solely from the INTERACTIVE sub-agent seam (NOT cron / channels
// / gateway — those keep their own bypass rejection): the operator is attended,
// delegating to their own logged-in Claude Code. `plan` | `acceptEdits` |
// `default` map to `--permission-mode <mode>` as safer opt-in alternatives.
//
// Spawn / capped-reader / AbortSignal-timeout pattern mirrors
// src/hooks/runner.ts (Bun.spawn, piped stdio, AbortSignal.timeout). The
// stream-json parser is grounded on the REAL `claude -p ... --output-format
// stream-json --verbose` event shape (see the spike doc for a captured
// transcript): system/init, assistant messages (text + tool_use content
// blocks), a terminal `result` event (is_error + num_turns + result text),
// plus noise frames (system/hook_*, rate_limit_event, user tool_result).

import type { SubscriptionExecutorConfig } from '../config/schema.js';
import type { AssistantMessage, ContentBlock, Message, Terminal } from '../core/types.js';
import type { ObserveInput } from '../learning/observer.js';
import type { ObservationStatus } from '../learning/types.js';
import type { TraceEvent } from '../trace/types.js';
// Task 1.5 — the port contract moved to the OPEN `./executorPort.ts` so the open
// scheduler stops value-importing this proprietary module. We import the two
// shapes for local use and re-export them so historical importers that
// referenced them from here keep working.
import type { RunSubprocessExecutorOpts, SubprocessExecutorResult } from './executorPort.js';

export type { RunSubprocessExecutorOpts, SubprocessExecutorResult } from './executorPort.js';

/** Cap on the RETAINED subprocess stdout — we keep the most recent
 *  ≤ MAX_STDOUT_BYTES (the TAIL, see readCapped) so the terminal stream-json
 *  `result` frame always survives even for a verbose multi-MB transcript. */
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;

/** Default headless engine binary. Overridable via `config.binary`. */
const DEFAULT_BINARY = 'claude';

/** Default permission mode — `bypass` (→ `--dangerously-skip-permissions`).
 *  A headless `claude -p` can't answer permission prompts, so the safe modes
 *  stall real agentic work; bypass is the useful default for the attended,
 *  interactive-only executor. Override with `plan` | `acceptEdits` | `default`
 *  for a constrained posture. */
const DEFAULT_PERMISSION_MODE: SubscriptionExecutorConfig['permissionMode'] = 'bypass';

/** The minimal subprocess handle surface this module needs. Bun.spawn's
 *  return value structurally satisfies it; tests inject a fake. */
export type SpawnedProc = {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  stdin: { write: (data: string | Uint8Array) => number; end: () => void };
  exited: Promise<number>;
  kill: (signal?: number) => void;
};

export type SpawnOpts = {
  cwd: string;
  signal?: AbortSignal;
};

/** Injectable spawn fn. Defaults to a thin Bun.spawn wrapper; tests pass a
 *  fake that emits canned JSONL on stdout. */
export type SpawnFn = (argv: string[], opts: SpawnOpts) => SpawnedProc;

/** The minimal learning sink this module needs — structurally satisfied by
 *  `LearningObserver` (its `observe(input)` method). The replay constructs an
 *  `ObserveInput` per tool call IDENTICAL in shape to what the orchestrator
 *  builds in `src/core/orchestrator.ts`, so the synthesizer can't tell a
 *  replayed observation from a native one. */
export type LearningSink = { observe: (input: ObserveInput) => void };

/** The minimal trace sink this module needs — a `(event) => void` recorder.
 *  The scheduler passes its `wrappedTraceRecorder` (the closure that tags the
 *  event with the child sessionId and forks to BOTH the parent recorder and the
 *  child's per-session TraceWriter), so replayed tool brackets land in the same
 *  destination(s) a native child's would. */
export type TraceSink = (event: TraceEvent) => void;

// --- Tool-vocabulary canonicalization (corpus co-clustering) ---------------
//
// Claude Code's tool NAMES + input field names diverge from the harness's
// native vocabulary. Left un-normalized, the synthesizer treats a delegated
// (replayed) file-read and a native file-read as DIFFERENT tools, splitting
// cross-surface learning evidence. We canonicalize the divergent ones to the
// harness's native names/keys — but ONLY for the LearningObservation. The
// `messages[]` and the trace stay verbatim (those are fidelity/operational
// records of what Claude actually did).
//
// Grounding (claude v2.1.168, captured live):
//   Read   name='Read'  input={ file_path, offset?, limit? }   (native: FileRead / { path, … })
//   Write  name='Write' input={ file_path, content }           (native: FileWrite / { path, content })
//   Edit   name='Edit'  input={ file_path, old_string, … }     (native: FileEdit / { path, … })
//   Bash   name='Bash'  input={ command, description?, … }      (native: Bash / { command, … } — no description)
//   Grep   name='Grep'  input={ pattern, … }                    (native: Grep — matches)
//   Glob   name='Glob'  input={ pattern, … }                    (native: Glob — matches)
// The native names/keys are the AUTHORITATIVE ones declared on the harness
// tools in src/tools/ (FileReadTool has `name:'FileRead', aliases:['Read']`,
// input key `path`; etc.). An UNMAPPED tool (Task, WebFetch, MCP tools, …)
// has no native equivalent and passes through unchanged.

/** Claude tool name → harness native name. Tools absent from this map keep
 *  their Claude name (Bash/Grep/Glob already match; Task/WebFetch/MCP have no
 *  native equivalent). */
const CLAUDE_TO_NATIVE_TOOL_NAME: Readonly<Record<string, string>> = {
  Read: 'FileRead',
  Write: 'FileWrite',
  Edit: 'FileEdit',
};

/** Per-canonical-tool top-level input-key renames (Claude key → native key).
 *  Keyed by the CANONICAL (post-rename) tool name. */
const INPUT_KEY_RENAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  FileRead: { file_path: 'path' },
  FileWrite: { file_path: 'path' },
  FileEdit: { file_path: 'path' },
};

/** Per-canonical-tool top-level input keys to DROP from the observation — a
 *  Claude-only noise field with no native counterpart that would otherwise
 *  split the input hash from an equivalent native call. Load-bearing values are
 *  never dropped. Keyed by the CANONICAL tool name. */
const INPUT_KEYS_TO_DROP: Readonly<Record<string, readonly string[]>> = {
  // A native Bash carries no `description`; Claude adds one. Drop it so a
  // delegated Bash co-identifies with a native Bash on the same command.
  Bash: ['description'],
};

/** Canonicalize a replayed Claude Code tool call to the harness's native tool
 *  vocabulary FOR OBSERVATION PURPOSES ONLY. Pure + immutable: returns a new
 *  `{ name, input }` and never mutates the caller's input.
 *
 *  - Maps the divergent tool NAMES (Read→FileRead, Write→FileWrite, Edit→FileEdit).
 *  - Renames the divergent top-level input KEYS (file_path→path) under the
 *    mapped tool, leaving every other key verbatim.
 *  - Drops confirmed Claude-only noise keys (Bash `description`).
 *  - Leaves an UNMAPPED tool (and any non-object input) entirely unchanged
 *    apart from the name lookup (which is a no-op for unmapped names). */
export function canonicalizeToolForObservation(
  name: string,
  input: unknown,
): { name: string; input: unknown } {
  const canonicalName = CLAUDE_TO_NATIVE_TOOL_NAME[name] ?? name;
  // Only object inputs can have keys renamed/dropped. Non-objects (null,
  // strings, arrays) pass through — only the name is mapped.
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { name: canonicalName, input };
  }
  const renames = INPUT_KEY_RENAMES[canonicalName];
  const drops = INPUT_KEYS_TO_DROP[canonicalName];
  if (renames === undefined && drops === undefined) {
    // Name may have changed, but the input shape needs no rewrite.
    return { name: canonicalName, input };
  }
  const dropSet = drops !== undefined ? new Set(drops) : undefined;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (dropSet?.has(key)) continue;
    const mappedKey = renames?.[key] ?? key;
    next[mappedKey] = value;
  }
  return { name: canonicalName, input: next };
}

/** Build the ARGS (excluding the binary) for the headless `claude` invocation.
 *  Exported so a unit test can assert the posture without spawning.
 *
 *  PERMISSIONS: `bypass` (the default — see DEFAULT_PERMISSION_MODE) emits
 *  `--dangerously-skip-permissions` so the headless subprocess can act without
 *  an interactive approver. `plan` | `acceptEdits` | `default` emit
 *  `--permission-mode <mode>` instead. This bypass is bounded to the attended,
 *  interactive-only executor seam; the remote channel surfaces keep their own
 *  bypass rejection (src/channels/permission.ts). */
export function buildSubprocessArgs(opts: {
  prompt: string;
  config: SubscriptionExecutorConfig;
}): string[] {
  const permissionMode = opts.config.permissionMode ?? DEFAULT_PERMISSION_MODE;
  const args: string[] = [
    '-p',
    opts.prompt,
    '--output-format',
    'stream-json',
    // `--verbose` is REQUIRED for `claude -p` to emit the full per-event
    // stream-json (without it, -p emits only the final result line).
    '--verbose',
  ];
  if (permissionMode === 'bypass') {
    // The operator's default for this attended, interactive-only executor:
    // skip the subprocess's own permission prompts (it has no approver).
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-mode', permissionMode as string);
  }
  if (opts.config.maxTurns !== undefined) {
    args.push('--max-turns', String(opts.config.maxTurns));
  }
  return args;
}

/** Default spawn: a thin Bun.spawn wrapper with piped stdio. */
const defaultSpawn: SpawnFn = (argv, opts) => {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return {
    stdout: proc.stdout as ReadableStream<Uint8Array>,
    stderr: proc.stderr as ReadableStream<Uint8Array>,
    stdin: proc.stdin as { write: (d: string | Uint8Array) => number; end: () => void },
    exited: proc.exited,
    kill: (signal?: number) => proc.kill(signal),
  };
};

export async function runSubprocessExecutor(
  opts: RunSubprocessExecutorOpts,
): Promise<SubprocessExecutorResult> {
  const spawn = opts.spawn ?? defaultSpawn;
  const binary = opts.config.binary ?? DEFAULT_BINARY;

  const args = buildSubprocessArgs({ prompt: opts.prompt, config: opts.config });
  const argv = [binary, ...args];

  // FIX 3a — the SCHEDULER's per-child timeout is the authoritative deadline
  // (it composes parentSignal ∧ AbortSignal.timeout(perChildTimeout) before
  // calling us). We therefore build our OWN internal timeout ONLY when
  // `config.timeoutMs` is explicitly set — an operator opt-in to a tighter,
  // executor-local bound. When it's unset we rely solely on `opts.signal`, so
  // the scheduler's timeout actually wins instead of being shadowed by a
  // hard-coded 120 s floor (the old always-on `AbortSignal.timeout(120000)`
  // took the MIN of the two, contradicting the contract). We also track WHICH
  // source aborted so the error distinguishes a self-timeout from a cancel.
  const timeoutMs = opts.config.timeoutMs;
  const timeoutSignal = timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : undefined;
  const composed: AbortSignal =
    opts.signal !== undefined && timeoutSignal !== undefined
      ? AbortSignal.any([opts.signal, timeoutSignal])
      : (opts.signal ?? timeoutSignal ?? new AbortController().signal);
  // FINDING #31 — capture which signal aborted FIRST, at the instant onAbort
  // fires, rather than re-reading `timeoutSignal.aborted` after the drain.
  // When the parent-cancel (opts.signal) fires first but the internal
  // AbortSignal.timeout also elapses during the kill/drain, the post-drain
  // re-read would misattribute the cancel as a self-timeout. Snapshotting the
  // first cause makes the attribution reflect the true initial trigger.
  let abortWasTimeout = false;

  let proc: SpawnedProc;
  try {
    proc = spawn(argv, { cwd: opts.cwd, signal: composed });
  } catch (err) {
    return errorResult(err instanceof Error ? err : new Error(String(err)));
  }

  // Close stdin immediately — the prompt rides on `-p`, not stdin.
  try {
    proc.stdin.end();
  } catch {
    // Best-effort; some fakes have no real stdin.
  }

  // Kill the subprocess if the composed signal aborts (timeout or parent
  // cancel). We listen rather than rely solely on the spawn-time signal so a
  // fake spawn (tests) is also torn down deterministically. On abort we both
  // kill the process AND cancel the stdio readers so the drain below resolves
  // promptly even if the OS pipes don't close on kill.
  let aborted = composed.aborted;
  const stdoutReader = proc.stdout.getReader() as unknown as StreamReader;
  const stderrReader = proc.stderr.getReader() as unknown as StreamReader;
  const onAbort = (): void => {
    aborted = true;
    // Snapshot the first cause: if the internal timeout has ALREADY fired at the
    // instant of this abort, it is the trigger; otherwise the scheduler's signal
    // (parent cancel) fired first. Reading it here — not after the drain — keeps
    // the attribution from flipping when the timeout elapses during teardown.
    abortWasTimeout = timeoutSignal?.aborted === true;
    try {
      proc.kill();
    } catch {
      // ignore
    }
    // Cancel the readers so readCapped() returns instead of hanging on a pipe
    // that never closes.
    void stdoutReader.cancel().catch(() => {});
    void stderrReader.cancel().catch(() => {});
  };
  if (composed.aborted) onAbort();
  else composed.addEventListener('abort', onAbort, { once: true });

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readCapped(stdoutReader),
      readCapped(stderrReader),
      proc.exited,
    ]);

    if (aborted) {
      // FIX 3a / FINDING #31 — distinguish a self-timeout (our internal
      // AbortSignal.timeout) from a scheduler-initiated cancellation
      // (opts.signal) by the FIRST cause snapshotted in onAbort, not by
      // re-reading both signals here (where the timeout may have since elapsed
      // during the kill/drain and would mask the true cancel). When no internal
      // timeout was configured, an abort is always a scheduler cancel.
      return errorResult(
        abortWasTimeout
          ? new Error(`subscription-executor timed out after ${timeoutMs}ms`)
          : new Error('subscription-executor cancelled by scheduler signal'),
      );
    }

    if (exitCode !== 0) {
      const detail = stderr.trim().slice(0, 2048);
      return errorResult(
        new Error(`subscription-executor exited ${exitCode}${detail ? `: ${detail}` : ''}`),
      );
    }

    return parseStreamJson(stdout, {
      ...(opts.learningObserver !== undefined ? { learningObserver: opts.learningObserver } : {}),
      ...(opts.traceRecorder !== undefined ? { traceRecorder: opts.traceRecorder } : {}),
    });
  } catch (err) {
    return errorResult(err instanceof Error ? err : new Error(String(err)));
  } finally {
    composed.removeEventListener('abort', onAbort);
  }
}

/** A tool_use block captured from an assistant frame, in stream order — the
 *  unit the replay walks to build observations + trace brackets. */
type CapturedToolUse = { id: string; name: string; input: unknown };

/** A tool_result block captured from a user frame, indexed by tool_use_id —
 *  paired with its CapturedToolUse during the replay. */
type CapturedToolResult = { content: string; isError: boolean };

type ParseStreamJsonOpts = {
  learningObserver?: LearningSink;
  traceRecorder?: TraceSink;
};

/** Parse the `claude -p ... --output-format stream-json --verbose` JSONL into
 *  the drainRunner result shape. Unknown / noise frames (system/hook_*,
 *  rate_limit_event) are skipped. A missing terminal `result` event (truncated
 *  stream) is an error terminal.
 *
 *  Learning replay: when `opts.learningObserver` / `opts.traceRecorder` are
 *  present AND the run completed, each `tool_use` (in stream order) is paired
 *  with its matching `tool_result` and replayed as a `LearningObservation` +
 *  trace bracket IDENTICAL in shape to what `src/core/orchestrator.ts` builds
 *  for a native tool call — so a delegated subprocess turn feeds the learning
 *  loop like a native child. Absent sinks ⇒ a clean no-op (byte-identical to
 *  the spike). */
function parseStreamJson(stdout: string, opts: ParseStreamJsonOpts = {}): SubprocessExecutorResult {
  const lines = stdout.split('\n');
  const messages: Message[] = [];
  let finalAssistant: AssistantMessage | undefined;
  let toolCallCount = 0;
  const distinctTools = new Set<string>();
  let terminal: Terminal | undefined;
  let iterationsUsed = 0;
  // Replay accumulators — populated as we walk assistant/user frames, drained
  // once (after we know the run completed) so a failed run replays nothing.
  const toolUses: CapturedToolUse[] = [];
  const toolResults = new Map<string, CapturedToolResult>();

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed === null || typeof parsed !== 'object') continue;
      event = parsed as Record<string, unknown>;
    } catch {
      // A non-JSON line is noise (or a partial flush) — skip it rather than
      // failing the whole parse. The terminal `result` event is the source of
      // truth for success/failure.
      continue;
    }

    const type = event.type;

    if (type === 'assistant') {
      const assistant = toAssistantMessage(event.message);
      if (assistant !== undefined) {
        messages.push(assistant);
        finalAssistant = assistant;
        for (const block of assistant.content) {
          if (block.type === 'tool_use') {
            toolCallCount++;
            // distinctToolNames reports the CANONICAL name so a delegated Read
            // co-counts with a native FileRead (consistent with the observation
            // co-clustering). The captured tool_use keeps the VERBATIM name +
            // input for the trace brackets (fidelity record of what Claude did).
            distinctTools.add(canonicalizeToolForObservation(block.name, block.input).name);
            toolUses.push({ id: block.id, name: block.name, input: block.input });
          }
        }
      }
      continue;
    }

    if (type === 'user') {
      // Tool-result-carrying user frames — reconstruct so the trajectory has
      // the full conversation (matches AgentRunner's messages[] semantics).
      const user = toUserMessage(event.message);
      if (user !== undefined) {
        messages.push(user);
        for (const block of user.content) {
          if (block.type === 'tool_result') {
            toolResults.set(block.tool_use_id, {
              content: block.content,
              isError: block.is_error === true,
            });
          }
        }
      }
      continue;
    }

    if (type === 'result') {
      const isError = event.is_error === true;
      const numTurns = typeof event.num_turns === 'number' ? event.num_turns : iterationsUsed;
      iterationsUsed = numTurns;
      if (isError) {
        const subtype = typeof event.subtype === 'string' ? event.subtype : 'error';
        const text = typeof event.result === 'string' ? event.result : '';
        terminal = {
          reason: 'error',
          error: new Error(
            `subscription-executor result error (${subtype})${text ? `: ${text}` : ''}`,
          ),
        };
      } else {
        terminal = { reason: 'completed' };
        // If no assistant frame carried the final text (rare), synthesize one
        // from the result.result string so extractSummary has something.
        if (finalAssistant === undefined && typeof event.result === 'string') {
          finalAssistant = { role: 'assistant', content: [{ type: 'text', text: event.result }] };
        }
      }
      // Fall through — result is the last meaningful event; the loop ends.
    }

    // system/init, system/hook_started, system/hook_response,
    // rate_limit_event, and any future type — noise to the result shape.
  }

  if (terminal === undefined) {
    // No terminal result event — the stream was truncated (subprocess died or
    // produced nothing parseable). Surface as an error terminal. No replay: a
    // failed/garbled run is not a faithful learning signal.
    return {
      terminal: {
        reason: 'error',
        error: new Error('subscription-executor produced no terminal result event'),
      },
      iterationsUsed,
      toolCallCount,
      distinctToolNames: Array.from(distinctTools).sort(),
      messages,
    };
  }

  // Learning replay — only on a completed run, so a failed delegation doesn't
  // pollute the corpus with half-finished tool use. Mirrors how a native child
  // that errored skips the downstream memory/review hooks.
  if (terminal.reason === 'completed') {
    replayToolEvents(toolUses, toolResults, opts);
  }

  return {
    terminal,
    ...(finalAssistant !== undefined ? { finalAssistant } : {}),
    iterationsUsed,
    toolCallCount,
    distinctToolNames: Array.from(distinctTools).sort(),
    messages,
  };
}

/** Replay the captured tool_use/tool_result pairs into the learning observer +
 *  trace recorder, IDENTICAL in shape to what `src/core/orchestrator.ts` emits
 *  for a native tool call. Called once, after the run is known to have
 *  completed. Both sinks are optional and independent — either may be absent.
 *
 *  Fidelity map (vs. the orchestrator's `ctx.learningObserver.observe(...)` at
 *  orchestrator.ts ~601-623 and its `recordTrace(...)` brackets ~521/543/552):
 *   - `toolName`  = the CANONICALIZED tool name    (orchestrator: `tool.name`)
 *                   Claude's name → the harness's native name (Read→FileRead,
 *                   …) via `canonicalizeToolForObservation`, so a replayed tool
 *                   co-clusters with the equivalent native one. Unmapped tools
 *                   keep their name. The TRACE brackets stay VERBATIM.
 *   - `toolInput` = the CANONICALIZED tool input   (orchestrator: `callInput`)
 *                   divergent top-level keys renamed (file_path→path) + Claude-
 *                   only noise dropped (Bash `description`); all else verbatim.
 *   - `status`    = `tool_result.is_error` → 'error' else 'success'
 *                   (orchestrator's success/error branch for the non-throw
 *                    path; 'denied'/'cancelled' are not recoverable post-hoc —
 *                    Claude Code resolved permission/cancel internally)
 *   - `traceId`   = the tool_use `id` = tool_use_id (orchestrator: `block.id`)
 *   - `durationMs`= 0 — the stream-json carries NO per-tool timing (only an
 *                   aggregate `duration_ms` on the terminal `result`); 0 is
 *                   honest (the schema requires nonnegative). RESIDUAL GAP.
 *   - `observationEnvelope` = omitted — the harness `ToolObservation` envelope
 *                   is a harness-tool construct; Claude Code's tool_results
 *                   don't carry one. The native path also omits it for tools
 *                   that return no observation.
 *
 *  Trace bracket per tool: `tool_start`, then `tool_end` (success, with
 *  `outputBytes` = byte length of the result content, mirroring the
 *  orchestrator) XOR `tool_error` (the result content as the message). The
 *  scheduler's wrapped recorder tags every event with the child sessionId, so
 *  these are attributed to the delegated child exactly as native child events
 *  are (the trace schema has no per-event "from subprocess" marker). */
function replayToolEvents(
  toolUses: CapturedToolUse[],
  toolResults: Map<string, CapturedToolResult>,
  opts: ParseStreamJsonOpts,
): void {
  const { learningObserver, traceRecorder } = opts;
  if (learningObserver === undefined && traceRecorder === undefined) return;

  for (const use of toolUses) {
    const res = toolResults.get(use.id);
    // No matching tool_result (truncated/odd stream): the orchestrator always
    // produces one, but a subprocess stream can drop it. Treat a missing result
    // as a non-error attempt so the corpus still sees the tool was used.
    const isError = res?.isError === true;
    const status: ObservationStatus = isError ? 'error' : 'success';
    const content = res?.content ?? '';

    // The OBSERVATION is canonicalized to the harness's native vocabulary so a
    // replayed Claude tool co-clusters with the equivalent native tool. The
    // TRACE brackets below stay VERBATIM (`use.name`) — a fidelity record of
    // what Claude actually ran. An unmapped tool canonicalizes to itself.
    const canonical = canonicalizeToolForObservation(use.name, use.input);

    traceRecorder?.({ type: 'tool_start', tool: use.name, toolUseId: use.id, iso: nowIso() });

    learningObserver?.observe({
      toolName: canonical.name,
      toolInput: canonical.input,
      status,
      // No per-tool timing in the stream-json — see the fidelity note above.
      durationMs: 0,
      traceId: use.id,
    });

    if (isError) {
      traceRecorder?.({
        type: 'tool_error',
        tool: use.name,
        toolUseId: use.id,
        durationMs: 0,
        message: content,
        iso: nowIso(),
      });
    } else {
      traceRecorder?.({
        type: 'tool_end',
        tool: use.name,
        toolUseId: use.id,
        durationMs: 0,
        outputBytes: Buffer.byteLength(content, 'utf8'),
        iso: nowIso(),
      });
    }
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Coerce a stream-json `message` object into an AssistantMessage, keeping only
 *  the content-block kinds the harness models internally (text, thinking,
 *  tool_use). Unknown block kinds are dropped. Returns undefined when the shape
 *  is unusable. */
function toAssistantMessage(message: unknown): AssistantMessage | undefined {
  if (message === null || typeof message !== 'object') return undefined;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const blocks: ContentBlock[] = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') {
      blocks.push({ type: 'text', text: b.text });
    } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
      blocks.push({ type: 'thinking', thinking: b.thinking });
    } else if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
      blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
    }
  }
  return { role: 'assistant', content: blocks };
}

/** Coerce a stream-json `message` object into a UserMessage carrying its
 *  tool_result blocks (the only block kind a -p user frame carries). */
function toUserMessage(message: unknown): Message | undefined {
  if (message === null || typeof message !== 'object') return undefined;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const blocks: ContentBlock[] = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      blocks.push({
        type: 'tool_result',
        tool_use_id: b.tool_use_id,
        content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? ''),
        ...(b.is_error === true ? { is_error: true } : {}),
      });
    } else if (b.type === 'text' && typeof b.text === 'string') {
      blocks.push({ type: 'text', text: b.text });
    }
  }
  if (blocks.length === 0) return undefined;
  return { role: 'user', content: blocks };
}

function errorResult(error: Error): SubprocessExecutorResult {
  return {
    terminal: { reason: 'error', error },
    iterationsUsed: 0,
    toolCallCount: 0,
    distinctToolNames: [],
    messages: [],
  };
}

/** Read a stream reader to a string, capping total bytes. Mirrors
 *  hooks/runner.ts's readCapped, but takes an already-acquired reader so the
 *  abort handler can cancel the SAME reader (preventing a hang on a pipe that
 *  doesn't close on kill). A cancelled reader surfaces as `done` or a thrown
 *  read — both terminate the loop and return whatever was buffered. */
/** Minimal reader surface — decouples from Bun's polymorphic ReadableStream
 *  reader type (whose `read()` overloads + value union fight strict DOM lib
 *  types). The getReader() results are cast to this at the call sites. */
type StreamReader = {
  read: () => Promise<{ done: boolean; value?: Uint8Array | undefined }>;
  cancel: () => Promise<void>;
};

async function readCapped(reader: StreamReader): Promise<string> {
  // FIX 3b — retain a bounded TAIL (the most recent ≤ MAX_STDOUT_BYTES) rather
  // than the head. The stream-json terminal `result` frame is the LAST line, so
  // a long run (e.g. `claude -p --verbose` echoing full tool_result payloads)
  // must keep its end to be parsed as success — the old head-only truncation
  // dropped the result frame and turned an exit-0 success into a parse 'error'.
  // A leading partial line introduced by trimming is harmless: parseStreamJson
  // skips any non-JSON line. Memory stays bounded: we keep at most one cap's
  // worth of chunk bytes, evicting the oldest as new data arrives.
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let chunk: { done: boolean; value?: Uint8Array | undefined };
    try {
      chunk = await reader.read();
    } catch {
      // Reader was cancelled (abort path) — stop and return the buffer.
      break;
    }
    const { done, value } = chunk;
    if (done) break;
    if (value === undefined || value.byteLength === 0) continue;
    chunks.push(value);
    total += value.byteLength;
    // Evict whole chunks from the front while the buffered tail exceeds the cap.
    while (total > MAX_STDOUT_BYTES && chunks.length > 1) {
      const dropped = chunks.shift();
      if (dropped !== undefined) total -= dropped.byteLength;
    }
    // A single chunk larger than the cap: keep only its trailing cap bytes so
    // memory stays bounded regardless of chunk size. The terminal `result`
    // frame is at the very end, so the tail always retains it.
    if (total > MAX_STDOUT_BYTES && chunks.length === 1) {
      const only = chunks[0];
      if (only !== undefined && only.byteLength > MAX_STDOUT_BYTES) {
        chunks[0] = only.subarray(only.byteLength - MAX_STDOUT_BYTES);
        total = MAX_STDOUT_BYTES;
      }
    }
  }
  // Decode the retained tail in one pass (no streaming state needed since we
  // have all retained bytes). A partial first line is skipped by the parser.
  const decoder = new TextDecoder();
  let text = '';
  for (const c of chunks) text += decoder.decode(c, { stream: true });
  text += decoder.decode();
  return text;
}

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
// SECURITY: the subprocess runs its OWN permission system. We translate the
// operator's intent to `--permission-mode <safe>` and NEVER pass a bypass /
// dangerous flag — the config enum (plan | acceptEdits | default) is the gate.
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

/** Default cap on captured subprocess stdout — mirrors hooks/runner.ts. The
 *  stream-json transcript of a bounded task stays well under this. */
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;

/** Default per-call wall-clock timeout. The config's `timeoutMs` (or the
 *  scheduler's per-child timeout) wins; this is the fallback when neither
 *  is set. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Default headless engine binary. Overridable via `config.binary`. */
const DEFAULT_BINARY = 'claude';

/** Default permission mode — `plan` is the safest (read-only-ish) posture.
 *  NEVER widened to a bypass mode; the config enum excludes those. */
const DEFAULT_PERMISSION_MODE: SubscriptionExecutorConfig['permissionMode'] = 'plan';

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

export type RunSubprocessExecutorOpts = {
  /** The task prompt handed to `claude -p`. */
  prompt: string;
  /** Working directory the subprocess runs in — constrained to the runtime cwd
   *  by the caller (the scheduler). */
  cwd: string;
  config: SubscriptionExecutorConfig;
  /** Composed abort signal (parent signal ∧ per-child timeout) from the
   *  scheduler. When it fires, the subprocess is killed and an error terminal
   *  is returned. */
  signal?: AbortSignal;
  /** Injected for tests. Defaults to the real Bun.spawn wrapper. */
  spawn?: SpawnFn;
};

/** The exact shape SubagentScheduler.delegate() consumes from `drainRunner`. */
export type SubprocessExecutorResult = {
  terminal: Terminal;
  finalAssistant?: AssistantMessage;
  iterationsUsed: number;
  toolCallCount: number;
  distinctToolNames: string[];
  messages: Message[];
};

/** Build the ARGS (excluding the binary) for the headless `claude` invocation.
 *  Exported so a unit test can assert the safe posture without spawning.
 *
 *  SECURITY: `--permission-mode` is always one of the three safe modes from
 *  the config enum. There is no code path that emits a bypass / dangerous
 *  flag. */
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
    '--permission-mode',
    permissionMode as string,
  ];
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
  const timeoutMs = opts.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const args = buildSubprocessArgs({ prompt: opts.prompt, config: opts.config });
  const argv = [binary, ...args];

  // Compose the caller's signal with a per-call timeout — mirrors the
  // hooks/runner.ts pattern. Either firing kills the subprocess.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const composed: AbortSignal =
    opts.signal !== undefined ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;

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
      return errorResult(new Error(`subscription-executor timed out after ${timeoutMs}ms`));
    }

    if (exitCode !== 0) {
      const detail = stderr.trim().slice(0, 2048);
      return errorResult(
        new Error(`subscription-executor exited ${exitCode}${detail ? `: ${detail}` : ''}`),
      );
    }

    return parseStreamJson(stdout);
  } catch (err) {
    return errorResult(err instanceof Error ? err : new Error(String(err)));
  } finally {
    composed.removeEventListener('abort', onAbort);
  }
}

/** Parse the `claude -p ... --output-format stream-json --verbose` JSONL into
 *  the drainRunner result shape. Unknown / noise frames (system/hook_*,
 *  rate_limit_event) are skipped. A missing terminal `result` event (truncated
 *  stream) is an error terminal. */
function parseStreamJson(stdout: string): SubprocessExecutorResult {
  const lines = stdout.split('\n');
  const messages: Message[] = [];
  let finalAssistant: AssistantMessage | undefined;
  let toolCallCount = 0;
  const distinctTools = new Set<string>();
  let terminal: Terminal | undefined;
  let iterationsUsed = 0;

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
            distinctTools.add(block.name);
          }
        }
      }
      continue;
    }

    if (type === 'user') {
      // Tool-result-carrying user frames — reconstruct so the trajectory has
      // the full conversation (matches AgentRunner's messages[] semantics).
      const user = toUserMessage(event.message);
      if (user !== undefined) messages.push(user);
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
    // produced nothing parseable). Surface as an error terminal.
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

  return {
    terminal,
    ...(finalAssistant !== undefined ? { finalAssistant } : {}),
    iterationsUsed,
    toolCallCount,
    distinctToolNames: Array.from(distinctTools).sort(),
    messages,
  };
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
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  let truncated = false;
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
    if (truncated || value === undefined) continue;
    total += value.byteLength;
    if (total > MAX_STDOUT_BYTES) {
      const room = MAX_STDOUT_BYTES - (total - value.byteLength);
      if (room > 0) text += decoder.decode(value.subarray(0, room), { stream: false });
      truncated = true;
    } else {
      text += decoder.decode(value, { stream: true });
    }
  }
  text += decoder.decode();
  return text;
}

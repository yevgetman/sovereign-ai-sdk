// Hook runner — finds matching hooks for an event, gates each through the
// first-use consent check, spawns it with shell:false (Invariant #13), pipes
// the event JSON to stdin, parses stdout JSON, and aggregates outputs into a
// single HookResult.
//
// Failure model:
//   exit code 0: read stdout JSON; missing/invalid → soft-fail, no block
//   exit code 2: block (regardless of stdout); stderr → user-visible reason
//   exit other:  soft-fail (log stderr, do not block)
//   spawn error / timeout: soft-fail
//   denied by consent allowlist: hook is inert (this is intentional, not a fail)
//
// "Soft-fail" means the runtime proceeds as if the hook hadn't fired. This
// keeps a misconfigured hook from breaking the harness — the user sees the
// stderr in the next user-prompt cycle (stderr is logged to console.error
// when a hook misbehaves) but their work isn't blocked.

import { argvSplit } from './argvSplit.js';
import type { HookConsentChecker } from './consent.js';
import { matchesHook } from './matcher.js';
import type {
  HookCommandSpec,
  HookConfig,
  HookEvent,
  HookEventName,
  HookEventOf,
  HookOutput,
  HookResult,
  HookRunner,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_STDIO_BYTES = 1_000_000;

export type BuildHookRunnerOpts = {
  /** Hooks indexed by event name. Multiple HookConfig entries may register
   *  the same shell command under different matchers — the runner walks them
   *  in registration order and aggregates outputs. */
  hooksByEvent: Record<HookEventName, HookConfig[]>;
  /** First-use consent gate. Required: the runner refuses to spawn an
   *  unverified hook. Tests pass a stub that always returns 'allow'. */
  consent: HookConsentChecker;
  /** Default home directory for ~/ expansion in command strings. */
  home?: string | undefined;
  /** Logger for stderr from misbehaving hooks. Defaults to console.error.
   *  Tests pass a sink to assert on logged output. */
  logStderr?: ((msg: string) => void) | undefined;
};

export function buildHookRunner(opts: BuildHookRunnerOpts): HookRunner {
  const log = opts.logStderr ?? ((msg: string) => console.error(msg));
  const home = opts.home;

  return async function run<N extends HookEventName>(
    event: N,
    payload: HookEventOf<N>,
    signal?: AbortSignal,
  ): Promise<HookResult> {
    const matching = (opts.hooksByEvent[event] ?? []).flatMap((cfg) =>
      matchesHook(cfg, payload as HookEvent) ? cfg.hooks.map((h) => ({ cfg, spec: h })) : [],
    );
    if (matching.length === 0) return { block: false };

    const aggregate: HookResult = { block: false };
    const additionalContexts: string[] = [];

    for (const { spec } of matching) {
      if (signal?.aborted) break;
      const decision = await opts.consent(event, spec.command, signal);
      if (decision === 'deny') continue; // user-denied hook is inert

      const result = await runOne(spec, payload as HookEvent, { home, signal });

      // Stderr always logged when present, regardless of exit status.
      if (result.stderr) log(`[hook ${event} ${spec.command}] ${result.stderr.trimEnd()}`);

      if (result.spawnError) {
        // Spawn-level failure is a soft-fail; surfaced via log only.
        continue;
      }

      if (result.exitCode === 2) {
        aggregate.block = true;
        aggregate.reason = combineReasons(
          aggregate.reason,
          result.parsed?.reason ?? result.stderr ?? `hook exit 2: ${spec.command}`,
        );
        // Block short-circuits remaining hooks for this event.
        return aggregate;
      }

      if (result.exitCode !== 0) {
        // Soft-fail: log already emitted; do not consume parsed output.
        continue;
      }

      // Successful exit — interpret parsed output by event type.
      const parsed = result.parsed;
      if (!parsed) continue;

      if (event === 'PreToolUse') {
        if (parsed.permissionDecision === 'deny' || parsed.permissionDecision === 'ask') {
          // 'ask' deferred — treat as deny with the hook's reason. Decision
          // documented in DECISIONS.md (Phase 11 design decision #3).
          aggregate.block = true;
          aggregate.reason = combineReasons(
            aggregate.reason,
            parsed.reason ??
              (parsed.permissionDecision === 'ask'
                ? `hook requested 'ask' (not yet supported): ${spec.command}`
                : `hook denied: ${spec.command}`),
          );
          return aggregate;
        }
        if (parsed.updatedInput !== undefined) {
          aggregate.updatedInput = parsed.updatedInput;
        }
      } else if (event === 'PostToolUse') {
        if (parsed.additionalContext) additionalContexts.push(parsed.additionalContext);
      } else if (event === 'UserPromptSubmit') {
        if (parsed.permissionDecision === 'deny') {
          aggregate.block = true;
          aggregate.reason = combineReasons(
            aggregate.reason,
            parsed.reason ?? `prompt rejected by hook: ${spec.command}`,
          );
          return aggregate;
        }
        if (typeof parsed.rewrittenPrompt === 'string') {
          aggregate.rewrittenPrompt = parsed.rewrittenPrompt;
        }
      }
      // Stop hooks: nothing to consume from stdout.
    }

    if (additionalContexts.length > 0) {
      aggregate.additionalContext = additionalContexts.join('\n\n---\n');
    }
    return aggregate;
  };
}

type RunOneResult = {
  exitCode: number;
  stderr: string;
  parsed?: HookOutput;
  spawnError?: Error;
};

async function runOne(
  spec: HookCommandSpec,
  payload: HookEvent,
  opts: { home?: string | undefined; signal?: AbortSignal | undefined },
): Promise<RunOneResult> {
  let argv: string[];
  try {
    argv = argvSplit(spec.command, opts.home ? { home: opts.home } : {});
  } catch (err) {
    return {
      exitCode: -1,
      stderr: '',
      spawnError: err instanceof Error ? err : new Error(String(err)),
    };
  }
  if (argv.length === 0) {
    return { exitCode: -1, stderr: '', spawnError: new Error('empty hook command') };
  }

  const timeoutMs = spec.timeout ?? DEFAULT_TIMEOUT_MS;
  const timeoutCtl = new AbortController();
  const timer = setTimeout(() => timeoutCtl.abort(), timeoutMs);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutCtl.signal])
    : timeoutCtl.signal;

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      signal,
    });
  } catch (err) {
    clearTimeout(timer);
    return {
      exitCode: -1,
      stderr: '',
      spawnError: err instanceof Error ? err : new Error(String(err)),
    };
  }

  try {
    // Write payload to stdin. With stdin: 'pipe', Bun returns a FileSink
    // (write/end API), not a WritableStream.
    const stdin = proc.stdin as { write: (data: string | Uint8Array) => number; end: () => void };
    stdin.write(JSON.stringify(payload));
    stdin.end();

    const [stdout, stderr, exitCode] = await Promise.all([
      readCapped(proc.stdout as ReadableStream<Uint8Array>),
      readCapped(proc.stderr as ReadableStream<Uint8Array>),
      proc.exited,
    ]);

    let parsed: HookOutput | undefined;
    if (stdout.trim().length > 0) {
      try {
        const obj = JSON.parse(stdout) as unknown;
        if (obj && typeof obj === 'object') parsed = obj as HookOutput;
      } catch {
        // Invalid JSON → no parsed output. Caller treats as no-op when exit 0.
      }
    }

    return { exitCode, stderr, ...(parsed ? { parsed } : {}) };
  } catch (err) {
    return {
      exitCode: -1,
      stderr: '',
      spawnError: err instanceof Error ? err : new Error(String(err)),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (truncated) continue;
    total += value.byteLength;
    if (total > MAX_STDIO_BYTES) {
      const room = MAX_STDIO_BYTES - (total - value.byteLength);
      if (room > 0) text += decoder.decode(value.subarray(0, room), { stream: false });
      truncated = true;
    } else {
      text += decoder.decode(value, { stream: true });
    }
  }
  text += decoder.decode();
  return text;
}

function combineReasons(prev: string | undefined, next: string): string {
  return prev ? `${prev}\n${next}` : next;
}

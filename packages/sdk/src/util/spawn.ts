// src/util/spawn.ts
// Cross-runtime subprocess spawn shim — the ONE shared replacement for the
// direct `Bun.spawn` call sites in the open SDK file set, backed by
// `node:child_process` so the same code runs under Node ≥20 and Bun.
//
// Returns the `SpawnedProc` shape the executor port already defines (and that
// Bun.spawn structurally satisfies): genuine WEB streams for stdout/stderr —
// consumers do `new Response(proc.stdout).text()` and getReader() loops, which
// a Node `Readable` would break at runtime with no compile error — plus a
// FileSink-style stdin, an `exited` promise that RESOLVES (never rejects,
// matching Bun.spawn semantics, including on abort/kill), and `kill()`.

import { spawn as nodeSpawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { PROVIDER_REGISTRY } from '../providers/models.js';
import type { SpawnedProc } from '../runtime/executorPort.js';

export type { SpawnedProc } from '../runtime/executorPort.js';

/** Credential env-var names that MUST NOT reach a tool subprocess (bash / grep /
 *  node / hook / skill children). SECURITY: the parent makes the provider HTTP
 *  call IN-PROCESS, so a tool child never needs the model-provider credential or
 *  the gateway's own bearer — yet `nodeSpawn` inherits the full parent env by
 *  default, so an auto-allowed read-only command like `echo $ANTHROPIC_API_KEY`
 *  (or `printenv`) would print the owner's live key straight into the tool
 *  result, defeating any "the key never touches disk" protection. We scrub:
 *    - every provider auth var in the registry (covers the key however it entered
 *      the env — harness-injected OR the launching shell's own export),
 *    - the gateway bearer `SOV_GATEWAY_TOKEN`,
 *    - per-server MCP secrets (`SOV_MCP_<ALIAS>_TOKEN` / `_API_KEY`),
 *  and NOTHING else — a user's unrelated env (PATH, HOME, their own vars) is left
 *  intact so tools behave exactly as before. */
const PROVIDER_AUTH_VARS: ReadonlySet<string> = new Set(
  Object.values(PROVIDER_REGISTRY)
    .map((p) => p.authEnvVar)
    .filter((v): v is string => v !== undefined),
);
const MCP_SECRET_RE = /^SOV_MCP_.+_(TOKEN|API_KEY)$/;

/** The environment a tool subprocess runs with: the parent env minus the
 *  credentials above. Exported so the scrub is unit-testable without spawning. */
export function toolSubprocessEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (PROVIDER_AUTH_VARS.has(key) || key === 'SOV_GATEWAY_TOKEN' || MCP_SECRET_RE.test(key)) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

/** Exit code reported when the process could not be spawned at all (ENOENT
 *  etc.) — the shell's "command not found" convention. Distinct from 1 so a
 *  missing binary can't be mistaken for a normal failure exit (ripgrep, for
 *  one, uses exit 1 to mean "no matches"). Exported so call sites that used
 *  to catch Bun.spawn's SYNCHRONOUS throw (node:child_process reports spawn
 *  failures asynchronously instead) can keep their actionable messages. */
export const SPAWN_FAILURE_EXIT_CODE = 127;

/** Exit code reported when the child died on a signal (abort/kill) and Node
 *  therefore reports a `null` exit code. `143` = POSIX 128+SIGTERM, matching
 *  the original `Bun.spawn` semantics a signal death produced. Crucially it is
 *  distinct from ripgrep's 0/1/2 codes: GrepTool treats exit `1` as its
 *  "no matches, not an error" sentinel, so a bare `1` here would let a
 *  signal-killed rg (OOM/SIGKILL/turn-cancel) be silently reported to the model
 *  as an authoritative "no matches". Exported so callers (and the pre-aborted-
 *  signal short-circuit's tests) can assert against it directly. */
export const KILLED_EXIT_CODE = 143;

/** Options accepted by `spawnProc` — a drop-in superset of what the Bun.spawn
 *  call sites passed. Stdout/stderr are ALWAYS piped (the `SpawnedProc`
 *  contract exposes them as streams; the optional 'pipe' members are accepted
 *  so call sites read naturally). Stdin follows Bun.spawn's default — IGNORED
 *  (the child sees EOF) unless `stdin: 'pipe'` is passed; node:child_process's
 *  own default is an open pipe, which makes stdin-sniffing children (rg
 *  without a path arg, `cat`) block forever. `cwd` is optional here (the
 *  executor port's `SpawnOpts` requires it; a function taking this wider shape
 *  still satisfies `SpawnFn`). */
export type SpawnProcOpts = {
  cwd?: string;
  stdin?: 'pipe';
  stdout?: 'pipe';
  stderr?: 'pipe';
  signal?: AbortSignal;
};

/**
 * Spawn `argv` with piped stdio and return a `SpawnedProc`.
 *
 * - `signal` is passed through to `node:child_process.spawn`, which SIGTERMs
 *   the child natively when it aborts.
 * - `exited` resolves with the exit code; killed-by-signal (`null` code)
 *   resolves non-zero, and spawn failures resolve 127 — it never rejects and
 *   never hangs, so `await proc.exited` stays safe at every call site.
 *
 * Throws synchronously on an empty argv (mirroring Bun.spawn).
 */
export function spawnProc(argv: string[], opts: SpawnProcOpts = {}): SpawnedProc {
  const [command, ...args] = argv;
  if (!command) throw new Error('spawnProc: argv must contain at least a command');

  // A signal that is ALREADY aborted before we ever call spawn is a runtime
  // divergence otherwise: under Node, node:child_process.spawn refuses to
  // spawn a pre-aborted signal and reports it via the async 'error' path,
  // which this shim's 'error' handler maps to SPAWN_FAILURE_EXIT_CODE (127) —
  // a misleading "command not found" for a command that was never looked up.
  // Under Bun, Bun.spawn ignores a pre-aborted signal and the child runs to
  // completion. Neither matches "this call was already cancelled" — short-
  // circuit deterministically instead of spawning at all.
  if (opts.signal?.aborted) {
    return {
      stdout: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
      stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
      stdin: {
        write: (data: string | Uint8Array): number => Buffer.byteLength(data),
        end: (): void => {},
      },
      exited: Promise.resolve(KILLED_EXIT_CODE),
      // No real child ran, so there is no OS signal name — but the aborted
      // upstream signal is the caller's own detectable "this was cancelled".
      signalCode: null,
      kill: (): void => {},
    };
  }

  const child = nodeSpawn(command, args, {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    // SECURITY: run tool children with provider/gateway/MCP credentials scrubbed
    // (see toolSubprocessEnv) so an auto-allowed `echo $ANTHROPIC_API_KEY` cannot
    // read the owner's key out of the inherited environment.
    env: toolSubprocessEnv(),
    stdio: [opts.stdin === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  const { stdin: childStdin, stdout: childStdout, stderr: childStderr } = child;
  if (!childStdout || !childStderr) {
    // Unreachable with the piped stdio above; guards the nullable typing honestly.
    child.kill();
    throw new Error('spawnProc: piped stdout/stderr missing on spawned child');
  }

  // The signal name the child died on ('SIGKILL', 'SIGTERM', …), captured from
  // the 'close' event and readable via the `signalCode` getter below by the
  // time `exited` resolves (both are set in the same 'close' callback). Lets
  // GrepTool distinguish a signal kill from a genuine exit code.
  let signalCode: NodeJS.Signals | null = null;

  // Without an 'error' listener a spawn failure (ENOENT) or an abort would
  // crash the process as an unhandled EventEmitter error. When the process
  // never spawned (`pid` undefined) 'close' is not guaranteed — resolve here;
  // otherwise 'close' carries the real exit code and wins the (idempotent)
  // resolve race.
  const exited = new Promise<number>((resolve) => {
    child.on('close', (code, signal) => {
      if (signal) signalCode = signal;
      resolve(code ?? KILLED_EXIT_CODE);
    });
    child.on('error', () => {
      if (child.pid === undefined) resolve(SPAWN_FAILURE_EXIT_CODE);
    });
  });

  // A write racing the child's death would otherwise surface as an unhandled
  // async EPIPE 'error' event and crash — Bun's FileSink just drops it.
  childStdin?.on('error', () => {});

  return {
    stdout: toWebStream(childStdout),
    stderr: toWebStream(childStderr),
    stdin: childStdin
      ? {
          // Node's Writable.write returns a backpressure boolean; the contract
          // (Bun's FileSink) reports bytes accepted — report the honest byte count.
          write: (data: string | Uint8Array): number => {
            childStdin.write(data);
            return Buffer.byteLength(data);
          },
          end: (): void => {
            childStdin.end();
          },
        }
      : {
          // Parity with Bun.spawn's un-piped stdin (undefined there): writing
          // without `stdin: 'pipe'` is a caller bug — fail loudly, not silently.
          write: (): number => {
            throw new Error("spawnProc: stdin is not piped (pass stdin: 'pipe')");
          },
          end: (): void => {},
        },
    exited,
    // Getter so the value stays live (set in the 'close' callback) yet the
    // property is read-only to callers — no external mutation.
    get signalCode(): NodeJS.Signals | null {
      return signalCode;
    },
    kill: (signal?: number): void => {
      child.kill(signal);
    },
  };
}

/** Convert a child stdio Readable to a genuine Web stream. When the spawn
 *  itself failed, Bun destroys the stdio Readables SYNCHRONOUSLY (Node leaves
 *  them alive and empty) and `Readable.toWeb` on a destroyed stream yields an
 *  unusable one ("ReadableStream has already been used") — present an empty,
 *  closed stream instead so consumers read '' and rely on the exit code. */
function toWebStream(src: Readable): ReadableStream<Uint8Array> {
  if (src.destroyed) {
    return new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
  }
  return Readable.toWeb(src) as ReadableStream<Uint8Array>;
}

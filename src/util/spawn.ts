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
import type { SpawnedProc } from '../runtime/executorPort.js';

export type { SpawnedProc } from '../runtime/executorPort.js';

/** Exit code reported when the process could not be spawned at all (ENOENT
 *  etc.) — the shell's "command not found" convention. Distinct from 1 so a
 *  missing binary can't be mistaken for a normal failure exit (ripgrep, for
 *  one, uses exit 1 to mean "no matches"). Exported so call sites that used
 *  to catch Bun.spawn's SYNCHRONOUS throw (node:child_process reports spawn
 *  failures asynchronously instead) can keep their actionable messages. */
export const SPAWN_FAILURE_EXIT_CODE = 127;

/** Exit code reported when the child died on a signal (abort/kill) and Node
 *  therefore reports a `null` exit code. */
const KILLED_EXIT_CODE = 1;

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

  const child = nodeSpawn(command, args, {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    stdio: [opts.stdin === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  const { stdin: childStdin, stdout: childStdout, stderr: childStderr } = child;
  if (!childStdout || !childStderr) {
    // Unreachable with the piped stdio above; guards the nullable typing honestly.
    child.kill();
    throw new Error('spawnProc: piped stdout/stderr missing on spawned child');
  }

  // Without an 'error' listener a spawn failure (ENOENT) or an abort would
  // crash the process as an unhandled EventEmitter error. When the process
  // never spawned (`pid` undefined) 'close' is not guaranteed — resolve here;
  // otherwise 'close' carries the real exit code and wins the (idempotent)
  // resolve race.
  const exited = new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(code ?? KILLED_EXIT_CODE));
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

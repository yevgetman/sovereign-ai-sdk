// A private, OS-account-scoped mutex shared by login, refresh and logout.
// Profile/HARNESS_HOME overrides do not split one Keychain identity's lock.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CredentialStoreUnavailableError } from '../errors.js';
import type { SubscriptionCredentialPort } from './port.js';
import { abortError, sleep } from './retry.js';

export type LockOptions = { signal?: AbortSignal; timeoutMs?: number };
const tails = new Map<string, Promise<void>>();

export async function withCredentialLock<T>(
  service: string,
  port: SubscriptionCredentialPort,
  fn: () => Promise<T>,
  opts: LockOptions = {},
): Promise<T> {
  const key = `${port.lockDirectory ?? 'in-process'}:${port.lockIdentity ?? ''}:${service}`;
  const previous = tails.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  tails.set(key, tail);
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  let unlock: (() => Promise<void>) | undefined;
  try {
    await until(previous, service, deadline, opts.signal);
    if (port.lockDirectory) {
      unlock = await acquireFileLock(service, port, deadline, opts.signal);
    }
    check(service, deadline, opts.signal);
    return await fn();
  } finally {
    try {
      await unlock?.();
    } finally {
      // Even a cancelled queued waiter must remain behind its predecessor.
      void previous.finally(() => {
        release();
        if (tails.get(key) === tail) tails.delete(key);
      });
    }
  }
}

function check(service: string, deadline: number, signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
  if (Date.now() >= deadline) throw new CredentialStoreUnavailableError(service, 'lock_timeout');
}

async function until(done: Promise<void>, service: string, deadline: number, signal?: AbortSignal) {
  let finished = false;
  void done.then(() => {
    finished = true;
  });
  while (!finished) {
    check(service, deadline, signal);
    await sleep(Math.min(25, Math.max(1, deadline - Date.now())), signal);
  }
}

type Ticket = { pid: number; start: string; choosing: boolean; ticket: number };
const execAsync = promisify(execFile);
let ownStart: Promise<string> | undefined;
/** Lamport's bakery mutex over atomic file replacements. Every contender has
 * a unique path, so recovery/release never remove a newly acquired shared lock.
 * Choosing records are published WITH their PID, without an ownerless window.
 */
async function acquireFileLock(
  service: string,
  port: SubscriptionCredentialPort,
  deadline: number,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  const digest = createHash('sha256')
    .update(`${port.lockIdentity ?? ''}:${service}`)
    .digest('hex');
  const dir = join(port.lockDirectory as string, digest);
  const name = `${process.pid}-${randomUUID()}.json`;
  const own = join(dir, name);
  let published = false;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    ownStart ??= processStart(process.pid);
    const start = await ownStart;
    await publishTicket(own, { pid: process.pid, start, choosing: true, ticket: 0 });
    published = true;
    const existing = await readTickets(dir);
    const ticket = Math.max(0, ...existing.map((record) => record.value.ticket)) + 1;
    await publishTicket(own, { pid: process.pid, start, choosing: false, ticket });
    for (;;) {
      check(service, deadline, signal);
      const owners = await readTickets(dir);
      const blocked = owners.some(
        (other) =>
          other.name !== name &&
          (other.value.choosing ||
            other.value.ticket < ticket ||
            (other.value.ticket === ticket && other.name < name)),
      );
      if (!blocked)
        return async () => {
          await rm(own, { force: true });
        };
      await sleep(25, signal);
    }
  } catch (err) {
    if (published) await rm(own, { force: true });
    if (signal?.aborted) throw abortError(signal);
    if (err instanceof CredentialStoreUnavailableError) throw err;
    throw new CredentialStoreUnavailableError(service, 'lock_timeout');
  }
}
async function publishTicket(path: string, value: Ticket): Promise<void> {
  const temp = `${path}.${randomUUID()}.candidate`;
  try {
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
async function readTickets(dir: string): Promise<{ name: string; value: Ticket }[]> {
  const values: { name: string; value: Ticket }[] = [];
  for (const name of await readdir(dir)) {
    if (!/^\d+-[a-f0-9-]+\.json$/.test(name)) continue;
    const path = join(dir, name);
    let value: Ticket;
    try {
      value = JSON.parse(await readFile(path, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    if (
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.start !== 'string' ||
      value.start.length === 0 ||
      typeof value.choosing !== 'boolean' ||
      !Number.isSafeInteger(value.ticket) ||
      value.ticket < 0
    )
      throw new Error('invalid credential lock ticket');
    if (!(await isAlive(value.pid, value.start))) {
      await rm(path, { force: true });
      continue;
    }
    values.push({ name, value });
  }
  return values;
}
async function processStart(pid: number): Promise<string> {
  // Linux exposes a precise boot-relative process generation. macOS exposes
  // the kernel process start through ps. Never trust PID liveness alone.
  if (process.platform === 'linux') {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    const start = fields[19];
    if (!start) throw new Error('process start unavailable');
    return `linux:${start}`;
  }
  const { stdout } = await execAsync('ps', ['-p', String(pid), '-o', 'lstart='], {
    timeout: 1000,
    maxBuffer: 1024,
  });
  const start = stdout.trim();
  if (!start) throw new Error('process start unavailable');
  return start;
}
async function isAlive(pid: number, expectedStart: string): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
  }
  try {
    return (await processStart(pid)) === expectedStart;
  } catch {
    // A temporary process-inspection failure must not evict a live owner.
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  }
}

const generations = new WeakMap<SubscriptionCredentialPort, Map<string, number>>();
function generationPath(port: SubscriptionCredentialPort, service: string): string | undefined {
  if (!port.lockDirectory) return undefined;
  const digest = createHash('sha256')
    .update(`${port.lockIdentity ?? ''}:${service}`)
    .digest('hex');
  return join(port.lockDirectory, `${digest}.generation`);
}
/** Call only while holding the identity mutex. No credential data is stored. */
export async function credentialGeneration(
  port: SubscriptionCredentialPort,
  service: string,
): Promise<number> {
  const path = generationPath(port, service);
  if (!path) return generations.get(port)?.get(service) ?? 0;
  try {
    const value = Number(await readFile(path, 'utf8'));
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid generation');
    return value;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw new CredentialStoreUnavailableError(service, 'read_failed');
  }
}
export async function advanceCredentialGeneration(
  port: SubscriptionCredentialPort,
  service: string,
): Promise<void> {
  const next = (await credentialGeneration(port, service)) + 1;
  const path = generationPath(port, service);
  if (!path) {
    const records = generations.get(port) ?? new Map<string, number>();
    records.set(service, next);
    generations.set(port, records);
    return;
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, String(next), { mode: 0o600 });
    await rename(temp, path);
  } catch {
    throw new CredentialStoreUnavailableError(service, 'write_failed');
  } finally {
    await rm(temp, { force: true });
  }
}

// Queued readline prompt adapter for preserving pasted multi-line input.

import type { Interface as ReadlineInterface } from 'node:readline/promises';

export type ReadlineQuestion = (
  prompt: string,
  options?: { signal?: AbortSignal },
) => Promise<string>;

export function createQueuedQuestion(
  rl: ReadlineInterface,
  write: (text: string) => void = (text) => {
    process.stdout.write(text);
  },
): ReadlineQuestion {
  const pendingLines: string[] = [];
  const waiters: Waiter[] = [];
  let closed = false;

  rl.on('line', (line: string) => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter.resolve(line);
      return;
    }
    pendingLines.push(line);
  });

  rl.on('close', () => {
    closed = true;
    const err = new Error('readline closed');
    while (waiters.length > 0) waiters.shift()?.reject(err);
  });

  return async (prompt, options = {}) => {
    if (options.signal?.aborted) throw abortError();
    if (closed) throw new Error('readline closed');
    write(prompt);
    const queued = pendingLines.shift();
    if (queued !== undefined) return queued;

    return await new Promise<string>((resolve, reject) => {
      const waiter = createWaiter(resolve, reject, waiters, options.signal);
      waiters.push(waiter);
      if (options.signal?.aborted) waiter.reject(abortError());
    });
  };
}

type Waiter = {
  resolve: (line: string) => void;
  reject: (err: Error) => void;
};

function createWaiter(
  resolve: (line: string) => void,
  reject: (err: Error) => void,
  waiters: Waiter[],
  signal?: AbortSignal,
): Waiter {
  let settled = false;
  const waiter: Waiter = {
    resolve: (line) => settle(() => resolve(line)),
    reject: (err) => settle(() => reject(err)),
  };
  function cleanup() {
    signal?.removeEventListener('abort', onAbort);
  }
  function settle(fn: () => void) {
    if (settled) return;
    settled = true;
    cleanup();
    fn();
  }
  function onAbort() {
    const index = waiters.indexOf(waiter);
    if (index !== -1) waiters.splice(index, 1);
    settle(() => reject(abortError()));
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  return waiter;
}

function abortError(): Error {
  const err = new Error('readline question aborted');
  err.name = 'AbortError';
  return err;
}
